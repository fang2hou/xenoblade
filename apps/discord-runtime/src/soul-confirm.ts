import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";
import type {
  Message,
  MessageComponentInteraction,
  MessageEditOptions,
  SendableChannels,
} from "discord.js";
import type { SoulApplyResponse, SoulProposal } from "@xenoblade/contracts";

import { applySoulProposal } from "./ai-client";
import type { EnvConfig } from "./env";
import { messages, type Messages } from "./i18n";
import { resolveUiLanguageBounded } from "./language";
import { replyPayload } from "./output";

/** How long a confirmation card stays actionable. */
export const SOUL_CONFIRM_WINDOW_MS = 5 * 60 * 1000;

/** Cap on tracked confirmations; the oldest entry is evicted beyond this. */
const MAX_TRACKED_CONFIRMS = 128;

/** Family prefix of every soul-confirmation customId: `xbl:soul:<choice>:<proposalId>`. */
const CUSTOM_ID_FAMILY = "xbl:soul";

/** Strings the confirmation flow renders (from the i18n table). */
export type SoulConfirmTexts = Messages["soulConfirm"];

export type SoulConfirmChoice = "yes" | "no";

/** Registry entry for one posted confirmation card, keyed by proposal id. */
export interface SoulConfirmEntry {
  /** Only this user's clicks act: the user who asked for the change. */
  userId: string;
  /** The card's message id once posted; a button must fire on that message. */
  messageId: string | null;
  proposal: SoulProposal;
  texts: SoulConfirmTexts;
  /** True while the confirmed apply call is in flight (double-click guard). */
  busy: boolean;
  /** Expiry timer; cleared once the entry settles. */
  timer: NodeJS.Timeout | undefined;
}

/**
 * In-memory index of pending soul confirmations, keyed by proposal id — the
 * id is known before the card is posted, so its buttons can carry it from the
 * start. Bounded and FIFO, like the reply registry. Entries vanish on
 * restart: the buttons then fail closed with an ephemeral notice, and nothing
 * reaches `bot_soul` without a live confirmation.
 */
export class SoulConfirmRegistry {
  private readonly entries = new Map<string, SoulConfirmEntry>();

  register(proposalId: string, entry: SoulConfirmEntry): void {
    this.entries.set(proposalId, entry);
    if (this.entries.size > MAX_TRACKED_CONFIRMS) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
  }

  get(proposalId: string): SoulConfirmEntry | undefined {
    return this.entries.get(proposalId);
  }

  remove(proposalId: string): void {
    this.entries.delete(proposalId);
  }
}

/** Build a card button's customId: `xbl:soul:<choice>:<proposalId>`. */
export function soulCustomId(choice: SoulConfirmChoice, proposalId: string): string {
  return `${CUSTOM_ID_FAMILY}:${choice}:${proposalId}`;
}

/** True for any button of the soul-confirmation family, well-formed or not. */
export function isSoulConfirmCustomId(customId: string): boolean {
  return customId.startsWith(`${CUSTOM_ID_FAMILY}:`);
}

/**
 * Parse a soul-confirmation customId into its choice and proposal id. Null for
 * anything outside the scheme: another button family, a foreign verb, or a
 * missing id.
 */
export function parseSoulCustomId(
  customId: string,
): { choice: SoulConfirmChoice; proposalId: string } | null {
  const [family, verb, choice, proposalId, ...rest] = customId.split(":");
  if (family !== "xbl" || verb !== "soul" || rest.length > 0) return null;
  if (proposalId === undefined || proposalId === "") return null;
  if (choice !== "yes" && choice !== "no") return null;
  return { choice, proposalId };
}

/** Render the card: the question, the proposed change, and what the buttons do. */
export function renderSoulConfirmation(texts: SoulConfirmTexts, proposal: SoulProposal): string {
  const summary = proposal.summary.trim();
  return [
    texts.header,
    ...(summary === "" ? [] : ["", texts.summary(summary)]),
    "",
    texts.footer,
  ].join("\n");
}

/** Build the card's button row: 是 (Primary) confirms, 不是 (Secondary) declines. */
export function buildSoulConfirmRow(
  texts: SoulConfirmTexts,
  proposalId: string,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(soulCustomId("yes", proposalId))
      .setLabel(texts.yes)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(soulCustomId("no", proposalId))
      .setLabel(texts.no)
      .setStyle(ButtonStyle.Secondary),
  );
}

/**
 * Message edit that settles a card: replaces its text and removes the
 * buttons. `SuppressEmbeds` is re-asserted on every edit because Discord
 * re-scans edited content for link preview cards, and a summary may quote a
 * URL.
 */
export function soulConfirmEdit(content: string): MessageEditOptions {
  return { content, components: [], flags: MessageFlags.SuppressEmbeds };
}

/** What a soul-confirmation click should do, as decided by {@link resolveSoulConfirmAction}. */
export type SoulConfirmDecision =
  | { action: "confirm" }
  | { action: "cancel" }
  | { action: "rejected"; reason: "expired" | "not-owner" | "busy" };

/**
 * Decide what a soul-confirmation click should do against a tracked card.
 * `null` when the customId belongs to another button family; callers treat that
 * like every other button that is not theirs. A family customId this process
 * cannot act on — unknown proposal (restart, eviction, settled), a button that
 * fires on a message other than its own card, a malformed id — is rejected as
 * expired, so it fails closed with an ephemeral notice and no action.
 */
export function resolveSoulConfirmAction(
  entry: SoulConfirmEntry | undefined,
  customId: string,
  messageId: string,
  userId: string,
): SoulConfirmDecision | null {
  const parsed = parseSoulCustomId(customId);
  if (parsed === null) {
    return isSoulConfirmCustomId(customId) ? { action: "rejected", reason: "expired" } : null;
  }
  if (entry === undefined || entry.messageId !== messageId) {
    return { action: "rejected", reason: "expired" };
  }
  if (userId !== entry.userId) return { action: "rejected", reason: "not-owner" };
  if (entry.busy) return { action: "rejected", reason: "busy" };
  return parsed.choice === "yes" ? { action: "confirm" } : { action: "cancel" };
}

/** Consume a pending confirmation: stop its expiry timer and forget it. */
function settle(registry: SoulConfirmRegistry, entry: SoulConfirmEntry): void {
  clearTimeout(entry.timer);
  registry.remove(entry.proposal.id);
}

/** Edit the card to its outcome text without buttons. A failure is logged, never thrown. */
async function retireCard(message: Message, content: string): Promise<void> {
  await message.edit(soulConfirmEdit(content)).catch((error) => {
    console.log(
      JSON.stringify({
        event: "soul_confirm_edit_error",
        messageId: message.id,
        error: String(error),
      }),
    );
  });
}

/** The window's end for a card nobody acted on: forget it and retire its buttons. */
function expire(message: Message, entry: SoulConfirmEntry, registry: SoulConfirmRegistry): void {
  registry.remove(entry.proposal.id);
  // An apply still in flight settles the card itself.
  if (entry.busy) return;
  console.log(
    JSON.stringify({ event: "soul_confirm_expired", messageId: message.id, userId: entry.userId }),
  );
  void retireCard(message, entry.texts.expired);
}

/**
 * Post the confirmation card for a generation's soul proposal — the question,
 * the proposed change, and the 是 / 不是 buttons — and arm the expiry timer.
 * Best-effort: a failed post is logged and never breaks the already-delivered
 * reply. The entry is registered before the send, so a click that races the
 * send fails closed (the card's message id is not known yet) instead of
 * meeting a proposal nobody tracks.
 */
export async function postSoulConfirmation(
  channel: SendableChannels,
  userId: string,
  proposal: SoulProposal,
  texts: SoulConfirmTexts,
  registry: SoulConfirmRegistry,
): Promise<void> {
  const entry: SoulConfirmEntry = {
    userId,
    messageId: null,
    proposal,
    texts,
    busy: false,
    timer: undefined,
  };
  registry.register(proposal.id, entry);

  let message: Message;
  try {
    message = await channel.send({
      ...replyPayload(renderSoulConfirmation(texts, proposal)),
      components: [buildSoulConfirmRow(texts, proposal.id)],
    });
  } catch (error) {
    registry.remove(proposal.id);
    console.log(
      JSON.stringify({
        event: "soul_confirm_post_error",
        userId,
        proposalId: proposal.id,
        error: String(error),
      }),
    );
    return;
  }
  entry.messageId = message.id;
  entry.timer = setTimeout(() => expire(message, entry, registry), SOUL_CONFIRM_WINDOW_MS);
  entry.timer.unref();
}

/** Acknowledge the click inside Discord's 3-second window; the card is edited separately. */
async function acknowledge(interaction: MessageComponentInteraction): Promise<void> {
  await interaction.deferUpdate().catch((error) => {
    console.log(
      JSON.stringify({
        event: "soul_confirm_ack_error",
        messageId: interaction.message.id,
        error: String(error),
      }),
    );
  });
}

/** Ephemeral refusal for a click that cannot act, in the clicker's own language. */
async function refuse(
  interaction: MessageComponentInteraction,
  reason: "expired" | "not-owner" | "busy",
  env: EnvConfig,
): Promise<void> {
  const texts = messages(
    await resolveUiLanguageBounded(interaction.user.id, env, 1_000),
  ).soulConfirm;
  const content =
    reason === "not-owner" ? texts.notOwner : reason === "busy" ? texts.busy : texts.expiredNotice;
  await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch((error) => {
    console.log(
      JSON.stringify({
        event: "soul_confirm_refuse_error",
        messageId: interaction.message.id,
        error: String(error),
      }),
    );
  });
}

/**
 * interactionCreate path for the soul-confirmation buttons: 是 applies the
 * proposal on the Worker and retires the card, 不是 drops it.
 *
 * Only the user who asked for the change may click; anyone else gets an
 * ephemeral refusal. A card this process no longer tracks — restart, eviction,
 * settled — fails closed the same way: no crash, no Worker call, no write.
 * Each click is acknowledged first, so the Worker call never risks Discord's
 * 3-second interaction window; the outcome then edits the card in place.
 */
export async function handleSoulConfirmInteraction(
  interaction: MessageComponentInteraction,
  env: EnvConfig,
  registry: SoulConfirmRegistry,
): Promise<void> {
  const { customId } = interaction;
  const messageId = interaction.message.id;
  const userId = interaction.user.id;
  const proposalId = parseSoulCustomId(customId)?.proposalId;
  const entry = proposalId === undefined ? undefined : registry.get(proposalId);
  const decision = resolveSoulConfirmAction(entry, customId, messageId, userId);
  if (decision === null) return;
  if (decision.action === "rejected") {
    await refuse(interaction, decision.reason, env);
    return;
  }
  // A decision to act implies the entry resolved above.
  if (entry === undefined) return;

  if (decision.action === "cancel") {
    settle(registry, entry);
    await acknowledge(interaction);
    await retireCard(interaction.message, entry.texts.cancelled);
    console.log(JSON.stringify({ event: "soul_confirm_cancelled", messageId, userId }));
    return;
  }

  entry.busy = true;
  await acknowledge(interaction);
  let response: SoulApplyResponse | null = null;
  try {
    response = await applySoulProposal(
      { proposal: entry.proposal, updatedBy: entry.userId },
      env.workerUrl,
      env.internalApiToken,
    );
  } catch (error) {
    console.log(
      JSON.stringify({ event: "soul_confirm_apply_error", messageId, error: String(error) }),
    );
  }
  settle(registry, entry);
  const applied = response !== null && response.status === "ok";
  await retireCard(interaction.message, applied ? entry.texts.applied : entry.texts.failed);
  console.log(JSON.stringify({ event: "soul_confirm_applied", messageId, userId, ok: applied }));
}
