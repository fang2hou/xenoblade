import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from "discord.js";
import type {
  Message,
  MessageComponentInteraction,
  MessageEditOptions,
  SendableChannels,
} from "discord.js";
import type { AdminActionPlan, AdminStepResult } from "@xenoblade/contracts";

import { executeAdminPlan, type AdminDiscordClient } from "./admin-executor";
import { cancelAdminPlan, claimAdminPlan, completeAdminPlan, getAdminPlan } from "./ai-client";
import type { EnvConfig } from "./env";
import { messages, type Messages } from "./i18n";
import { resolveUiLanguageBounded } from "./language";
import { MAX_MESSAGE_LENGTH } from "./output";

/** Cap on in-memory tracked approval cards; D1 still backs approvals across restarts. */
const MAX_TRACKED_PLANS = 128;

/** Family prefix of every admin-approval control: `xbl:admin:<approve|cancel>:<planId>`. */
const CUSTOM_ID_FAMILY = "xbl:admin";

/** Attachment filename when the full operation list exceeds 2000 characters. */
export const ADMIN_PLAN_ATTACHMENT_NAME = "admin-action-plan.txt";

const NO_MENTIONS = { parse: [] };

export type AdminConfirmTexts = Messages["adminConfirm"];

export type AdminButtonChoice = "approve" | "cancel";

export interface AdminConfirmEntry {
  plan: AdminActionPlan;
  message: Message | null;
  texts: AdminConfirmTexts;
  busy: boolean;
  timer: NodeJS.Timeout | undefined;
}

/**
 * In-memory index of posted server administration approval cards, keyed by
 * plan id. Backed by D1 `admin_action_plans` so approvals remain verifiable
 * and replay-safe even across Runtime restarts.
 */
export class AdminConfirmRegistry {
  private readonly entries = new Map<string, AdminConfirmEntry>();

  register(planId: string, entry: AdminConfirmEntry): void {
    this.entries.set(planId, entry);
    if (this.entries.size > MAX_TRACKED_PLANS) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
  }

  get(planId: string): AdminConfirmEntry | undefined {
    return this.entries.get(planId);
  }

  remove(planId: string): void {
    this.entries.delete(planId);
  }
}

export function adminButtonCustomId(choice: AdminButtonChoice, planId: string): string {
  return `${CUSTOM_ID_FAMILY}:${choice}:${planId}`;
}

export function isAdminConfirmCustomId(customId: string): boolean {
  return customId.startsWith(`${CUSTOM_ID_FAMILY}:`);
}

export function parseAdminButtonCustomId(
  customId: string,
): { choice: AdminButtonChoice; planId: string } | null {
  const [family, scope, choice, planId, ...rest] = customId.split(":");
  if (family !== "xbl" || scope !== "admin" || rest.length > 0) return null;
  if (planId === undefined || planId === "") return null;
  if (choice !== "approve" && choice !== "cancel") return null;
  return { choice, planId };
}

const ESCAPED_CHARACTERS = /[\p{Cc}\p{Cf}\u2028\u2029\\]/gu;
const ESCAPE_BY_CHARACTER: Record<string, string> = {
  "\\": "\\\\",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

function escapeField(text: string): string {
  return text.replace(ESCAPED_CHARACTERS, (character) => {
    const escape = ESCAPE_BY_CHARACTER[character];
    if (escape !== undefined) return escape;
    return `\\u{${(character.codePointAt(0) ?? 0).toString(16)}}`;
  });
}

function listCodeBlock(lines: readonly string[]): string {
  const longestRun = (lines.join("\n").match(/`+/g) ?? []).reduce(
    (longest, run) => Math.max(longest, run.length),
    0,
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${lines.join("\n")}\n${fence}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarizePermissionOverwrites(body: unknown): string | null {
  if (!isPlainRecord(body)) return null;
  const raw = body.permission_overwrites;
  if (!Array.isArray(raw)) return null;
  const parts: string[] = [];
  for (const item of raw) {
    if (!isPlainRecord(item)) continue;
    const kind = item.type === 1 ? "member" : "role";
    const id = typeof item.id === "string" ? item.id : "?";
    const allow = typeof item.allow === "string" ? item.allow : "0";
    const deny = typeof item.deny === "string" ? item.deny : "0";
    parts.push(`${kind}:${id}(+${allow}/-${deny})`);
  }
  return `${raw.length} entries${parts.length > 0 ? `: ${parts.join(", ")}` : ""}`;
}

function planLines(plan: AdminActionPlan): { lines: string[]; escaped: boolean } {
  const lines: string[] = [];
  let escaped = false;
  for (const [offset, op] of plan.operations.entries()) {
    const index = offset + 1;
    const riskTag = op.risk === "high" ? "HIGH" : "STD";
    const desc = escapeField(op.description);
    escaped ||= desc !== op.description;
    lines.push(`[${index}] [${riskTag}] ${op.actionType} · ${op.method} ${op.path}`);
    lines.push(`[${index}] ${desc}`);
    if (op.riskReasons && op.riskReasons.length > 0) {
      lines.push(`[${index}] risk: ${op.riskReasons.join(", ")}`);
    }
    const overwritesSummary = summarizePermissionOverwrites(op.body);
    if (overwritesSummary !== null) {
      const safeSummary = escapeField(overwritesSummary);
      escaped ||= safeSummary !== overwritesSummary;
      lines.push(`[${index}] permission_overwrites: ${safeSummary}`);
    }
    if (op.body !== undefined) {
      const rawBody = JSON.stringify(op.body);
      const bodyStr = escapeField(rawBody);
      escaped ||= bodyStr !== rawBody;
      lines.push(`[${index}] body: ${bodyStr}`);
    }
    if (op.auditReason !== undefined) {
      const reasonStr = escapeField(op.auditReason);
      escaped ||= reasonStr !== op.auditReason;
      lines.push(`[${index}] reason: ${reasonStr}`);
    }
  }
  lines.push(`planId: ${plan.id} | sha256: ${plan.payloadHash.slice(0, 12)}`);
  return { lines, escaped };
}

export interface AdminConfirmCard {
  content: string;
  attachment: AttachmentBuilder | undefined;
}

/**
 * Deterministically render the approval card directly from the frozen
 * `plan.operations` payload so the owner reviews the exact REST calls that
 * will run upon approval.
 */
export function buildAdminConfirmCard(
  texts: AdminConfirmTexts,
  plan: AdminActionPlan,
): AdminConfirmCard {
  const header =
    plan.risk === "high"
      ? texts.headerHighRisk(plan.operations.length)
      : texts.header(plan.operations.length);
  const { lines, escaped } = planLines(plan);
  const notes = escaped ? [texts.escapeNote, ""] : [];
  const inline = [header, "", listCodeBlock(lines), "", ...notes, texts.footer].join("\n");
  if (inline.length <= MAX_MESSAGE_LENGTH) {
    return { content: inline, attachment: undefined };
  }
  return {
    content: [header, "", texts.attachmentNote, "", ...notes, texts.footer].join("\n"),
    attachment: new AttachmentBuilder(Buffer.from(lines.join("\n"), "utf8"), {
      name: ADMIN_PLAN_ATTACHMENT_NAME,
    }),
  };
}

/**
 * Build the approval button row: Success (green) for standard plans, Danger
 * (red) for high-risk plans, Secondary for Cancel.
 */
export function buildAdminConfirmRow(
  texts: AdminConfirmTexts,
  plan: AdminActionPlan,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(adminButtonCustomId("approve", plan.id))
      .setLabel(plan.risk === "high" ? texts.approveHighRisk : texts.approve)
      .setStyle(plan.risk === "high" ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(adminButtonCustomId("cancel", plan.id))
      .setLabel(texts.cancel)
      .setStyle(ButtonStyle.Secondary),
  );
}

export function adminConfirmEdit(content: string): MessageEditOptions {
  return {
    content,
    components: [],
    flags: MessageFlags.SuppressEmbeds,
    allowedMentions: NO_MENTIONS,
  };
}

export function renderExecutionOutcome(
  plan: AdminActionPlan,
  outcome: "completed" | "failed",
  results: readonly AdminStepResult[],
  texts: AdminConfirmTexts,
): string {
  const succeeded = results.filter((r) => r.status === "succeeded").length;
  const headline =
    outcome === "completed"
      ? texts.succeeded(plan.operations.length)
      : succeeded > 0
        ? texts.partialFailed(succeeded, plan.operations.length)
        : texts.failed;
  const byId = new Map(results.map((r) => [r.id, r] as const));
  const detailLines = plan.operations.map((op, index) => {
    const r = byId.get(op.id);
    const status = r?.status ?? "skipped";
    const suffix = r?.error ? ` — ${escapeField(r.error)}` : "";
    return `[${index + 1}] ${status.toUpperCase()} · ${op.method} ${op.path}${suffix}`;
  });
  const body = [headline, "", listCodeBlock(detailLines)].join("\n");
  if (body.length <= MAX_MESSAGE_LENGTH) return body;

  // Keep as many detail lines as fit (always prioritizing any failed line).
  const failedIndex = detailLines.findIndex((line) => line.includes(" FAILED · "));
  const kept: string[] = [];
  for (const [idx, line] of detailLines.entries()) {
    const omitted = detailLines.length - (kept.length + 1);
    const tail =
      omitted > 0
        ? [...(failedIndex > idx ? [detailLines[failedIndex]!] : []), `... (+${omitted} more)`]
        : [];
    const candidate = [headline, "", listCodeBlock([...kept, line, ...tail])].join("\n");
    if (candidate.length > MAX_MESSAGE_LENGTH) break;
    kept.push(line);
  }
  if (kept.length === 0) return headline;
  const remaining = detailLines.length - kept.length;
  const extra: string[] = [];
  if (failedIndex >= kept.length && detailLines[failedIndex] !== undefined) {
    extra.push(detailLines[failedIndex]);
  }
  if (remaining > 0) {
    extra.push(`... (+${remaining} more)`);
  }
  const truncated = [headline, "", listCodeBlock([...kept, ...extra])].join("\n");
  return truncated.length <= MAX_MESSAGE_LENGTH ? truncated : headline;
}

function settle(registry: AdminConfirmRegistry, planId: string, entry?: AdminConfirmEntry): void {
  if (entry !== undefined) clearTimeout(entry.timer);
  registry.remove(planId);
}

async function retireCard(message: Message, content: string): Promise<void> {
  await message.edit(adminConfirmEdit(content)).catch((error) => {
    console.log(
      JSON.stringify({
        event: "admin_confirm_edit_error",
        messageId: message.id,
        error: String(error),
      }),
    );
  });
}

function expire(message: Message, entry: AdminConfirmEntry, registry: AdminConfirmRegistry): void {
  registry.remove(entry.plan.id);
  if (entry.busy) return;
  console.log(
    JSON.stringify({
      event: "admin_confirm_expired",
      planId: entry.plan.id,
      messageId: message.id,
    }),
  );
  void retireCard(message, entry.texts.expired);
}

/** Post the approval card for a frozen server administration plan and arm its expiry timer. */
export async function postAdminConfirmation(
  channel: SendableChannels,
  plan: AdminActionPlan,
  texts: AdminConfirmTexts,
  registry: AdminConfirmRegistry,
): Promise<void> {
  if (plan.operations.length === 0) return;
  const entry: AdminConfirmEntry = {
    plan,
    message: null,
    texts,
    busy: false,
    timer: undefined,
  };
  registry.register(plan.id, entry);

  const card = buildAdminConfirmCard(texts, plan);
  let message: Message;
  try {
    message = await channel.send({
      content: card.content,
      flags: MessageFlags.SuppressEmbeds,
      allowedMentions: NO_MENTIONS,
      components: [buildAdminConfirmRow(texts, plan)],
      ...(card.attachment === undefined ? {} : { files: [card.attachment] }),
    });
  } catch (error) {
    registry.remove(plan.id);
    console.log(
      JSON.stringify({
        event: "admin_confirm_post_error",
        planId: plan.id,
        error: String(error),
      }),
    );
    return;
  }
  entry.message = message;
  entry.timer = setTimeout(
    () => expire(message, entry, registry),
    Math.max(0, plan.expiresAt - Date.now()),
  );
  entry.timer.unref();
}

async function replyEphemeral(
  interaction: MessageComponentInteraction,
  content: string,
): Promise<void> {
  await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch((error) => {
    console.log(
      JSON.stringify({
        event: "admin_confirm_reply_error",
        error: String(error),
      }),
    );
  });
}

/** Resolve a plan from in-memory registry or D1 (supporting Runtime restarts within TTL). */
async function loadPendingPlan(
  planId: string,
  env: EnvConfig,
  registry: AdminConfirmRegistry,
): Promise<{ plan: AdminActionPlan; entry?: AdminConfirmEntry } | { error: "expired" | "busy" }> {
  const admin = env.admin;
  if (admin == null) return { error: "expired" };
  const entry = registry.get(planId);
  if (entry !== undefined) {
    if (entry.busy) return { error: "busy" };
    if (Date.now() >= entry.plan.expiresAt) return { error: "expired" };
    return { plan: entry.plan, entry };
  }
  try {
    const res = await getAdminPlan(
      { planId, guildId: admin.guildId, ownerUserId: admin.ownerUserId },
      env.workerUrl,
      env.internalApiToken,
    );
    if (res.status !== "ok" || res.planStatus !== "pending" || Date.now() >= res.plan.expiresAt) {
      return { error: "expired" };
    }
    return { plan: res.plan };
  } catch {
    return { error: "expired" };
  }
}

/**
 * Button click handler for `xbl:admin:<approve|cancel>:<planId>`.
 * Hard-verifies configured owner & target guild before taking any action;
 * claims the plan atomically in D1 via CAS before executing verbatim via
 * `client.rest`.
 */
export async function handleAdminConfirmInteraction(
  interaction: MessageComponentInteraction,
  client: AdminDiscordClient,
  env: EnvConfig,
  registry: AdminConfirmRegistry,
): Promise<void> {
  const parsed = parseAdminButtonCustomId(interaction.customId);
  const texts = messages(
    await resolveUiLanguageBounded(interaction.user.id, env, 1_000),
  ).adminConfirm;
  if (parsed === null) {
    if (isAdminConfirmCustomId(interaction.customId)) {
      await replyEphemeral(interaction, texts.expiredNotice);
    }
    return;
  }

  const admin = env.admin;
  if (
    admin == null ||
    interaction.guildId !== admin.guildId ||
    interaction.user.id !== admin.ownerUserId
  ) {
    await replyEphemeral(interaction, texts.notOwner);
    return;
  }

  const loaded = await loadPendingPlan(parsed.planId, env, registry);
  if ("error" in loaded) {
    await replyEphemeral(interaction, loaded.error === "busy" ? texts.busy : texts.expiredNotice);
    return;
  }
  const { plan, entry } = loaded;
  if (
    entry?.message !== null &&
    entry?.message !== undefined &&
    entry.message.id !== interaction.message.id
  ) {
    await replyEphemeral(interaction, texts.expiredNotice);
    return;
  }

  if (parsed.choice === "cancel") {
    settle(registry, plan.id, entry);
    await interaction.deferUpdate().catch(() => undefined);
    await cancelAdminPlan(
      { planId: plan.id, guildId: admin.guildId, ownerUserId: admin.ownerUserId },
      env.workerUrl,
      env.internalApiToken,
    ).catch(() => undefined);
    await retireCard(interaction.message, texts.cancelled);
    console.log(JSON.stringify({ event: "admin_plan_cancelled", planId: plan.id }));
    return;
  }

  if (entry !== undefined) entry.busy = true;
  await interaction.deferUpdate().catch(() => undefined);

  let claimedPlan: AdminActionPlan;
  try {
    const claim = await claimAdminPlan(
      {
        planId: plan.id,
        guildId: admin.guildId,
        ownerUserId: admin.ownerUserId,
        payloadHash: plan.payloadHash,
      },
      env.workerUrl,
      env.internalApiToken,
    );
    if (claim.status !== "ok") {
      settle(registry, plan.id, entry);
      if (claim.code === "expired") {
        await retireCard(interaction.message, texts.expired);
      } else {
        await retireCard(interaction.message, texts.expiredNotice);
      }
      return;
    }
    claimedPlan = claim.plan;
  } catch (error) {
    if (entry !== undefined) entry.busy = false;
    console.log(
      JSON.stringify({
        event: "admin_confirm_claim_error",
        planId: plan.id,
        error: String(error),
      }),
    );
    await retireCard(interaction.message, texts.failed);
    return;
  }

  const execution = await executeAdminPlan(client, admin, claimedPlan);
  try {
    await completeAdminPlan(
      {
        planId: claimedPlan.id,
        guildId: admin.guildId,
        ownerUserId: admin.ownerUserId,
        outcome: execution.outcome,
        results: execution.results,
      },
      env.workerUrl,
      env.internalApiToken,
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "admin_confirm_complete_error",
        planId: claimedPlan.id,
        error: String(error),
      }),
    );
  }

  settle(registry, claimedPlan.id, entry);
  const outcomeText = renderExecutionOutcome(
    claimedPlan,
    execution.outcome,
    execution.results,
    texts,
  );
  await retireCard(interaction.message, outcomeText);
  console.log(
    JSON.stringify({
      event: "admin_plan_executed",
      planId: claimedPlan.id,
      outcome: execution.outcome,
      steps: execution.results.length,
      succeeded: execution.results.filter((r) => r.status === "succeeded").length,
    }),
  );
}
