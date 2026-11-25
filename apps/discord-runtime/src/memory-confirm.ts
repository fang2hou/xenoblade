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
import type {
  GuildMemoryApplyResponse,
  GuildMemoryCategory,
  GuildMemoryProposal,
} from "@xenoblade/contracts";

import { applyGuildMemoryProposals } from "./ai-client";
import type { EnvConfig } from "./env";
import { messages, type Messages } from "./i18n";
import { resolveUiLanguageBounded } from "./language";
import { MAX_MESSAGE_LENGTH } from "./output";

/** How long a confirmation card stays actionable. */
export const MEMORY_CONFIRM_WINDOW_MS = 5 * 60 * 1000;

/** Cap on tracked confirmations; the oldest entry is evicted beyond this. */
const MAX_TRACKED_CONFIRMS = 128;

/** Family prefix of every memory-confirmation customId: `xbl:gmem:<choice>:<cardId>`. */
const CUSTOM_ID_FAMILY = "xbl:gmem";

/** File name of the full proposal list when it does not fit in the card's message. */
export const GUILD_MEMORY_ATTACHMENT_NAME = "guild-memory-proposal.txt";

/**
 * Mentions are never parsed on a confirmation card. Keys and values are
 * model-written text and may contain `@everyone` or a role mention.
 */
const NO_MENTIONS = { parse: [] };

/** Strings the confirmation flow renders (from the i18n table). */
export type MemoryConfirmTexts = Messages["memoryConfirm"];

export type MemoryConfirmChoice = "yes" | "no";

/** Registry entry for one posted confirmation card, keyed by card id. */
export interface MemoryConfirmEntry {
  /** Id the card's buttons carry; the registry keys the entry by it. */
  cardId: string;
  /** Only this user's clicks act: the user who asked for the change. */
  userId: string;
  /** The card's message id once posted; a button must fire on that message. */
  messageId: string | null;
  /** Every change the card lists; 是 applies them all, 不是 drops them all. */
  proposals: GuildMemoryProposal[];
  texts: MemoryConfirmTexts;
  /** True while the confirmed apply call is in flight (double-click guard). */
  busy: boolean;
  /** Wall-clock end of the window: a click at or after it is expired, whether or not the timer has fired. */
  expiresAt: number;
  /** Expiry timer; cleared once the entry settles. */
  timer: NodeJS.Timeout | undefined;
}

/**
 * In-memory index of pending guild memory confirmations, keyed by card id —
 * the id is minted before the card is posted, so its buttons can carry it
 * from the start. Bounded and FIFO, like the reply registry. Entries vanish
 * on restart: the buttons then fail closed with an ephemeral notice, and
 * nothing reaches `guild_memory` without a live confirmation.
 */
export class MemoryConfirmRegistry {
  private readonly entries = new Map<string, MemoryConfirmEntry>();

  register(cardId: string, entry: MemoryConfirmEntry): void {
    this.entries.set(cardId, entry);
    if (this.entries.size > MAX_TRACKED_CONFIRMS) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
  }

  get(cardId: string): MemoryConfirmEntry | undefined {
    return this.entries.get(cardId);
  }

  remove(cardId: string): void {
    this.entries.delete(cardId);
  }
}

/** Build a card button's customId: `xbl:gmem:<choice>:<cardId>`. */
export function memoryCustomId(choice: MemoryConfirmChoice, cardId: string): string {
  return `${CUSTOM_ID_FAMILY}:${choice}:${cardId}`;
}

/** True for any button of the memory-confirmation family, well-formed or not. */
export function isMemoryConfirmCustomId(customId: string): boolean {
  return customId.startsWith(`${CUSTOM_ID_FAMILY}:`);
}

/**
 * Parse a memory-confirmation customId into its choice and card id. Null for
 * anything outside the scheme: another button family, a foreign verb, or a
 * missing id.
 */
export function parseMemoryCustomId(
  customId: string,
): { choice: MemoryConfirmChoice; cardId: string } | null {
  const [family, verb, choice, cardId, ...rest] = customId.split(":");
  if (family !== "xbl" || verb !== "gmem" || rest.length > 0) return null;
  if (cardId === undefined || cardId === "") return null;
  if (choice !== "yes" && choice !== "no") return null;
  return { choice, cardId };
}

/** A confirmation card ready to post. */
export interface MemoryConfirmCard {
  /** The question, and either the full list of changes or a pointer to `attachment`. */
  content: string;
  /** The full list of changes as a UTF-8 file, when it does not fit in the message. */
  attachment: AttachmentBuilder | undefined;
}

function categoryLabel(
  category: GuildMemoryCategory | undefined,
  texts: MemoryConfirmTexts,
): string {
  if (category === undefined) return texts.labelBothCategories;
  return category === "preference" ? texts.labelPreference : texts.labelFact;
}

/**
 * Characters of a key or value that would break the card's line structure or
 * reorder and hide what follows: control characters (`\p{Cc}` — line breaks
 * and tabs among them), format characters (`\p{Cf}` — bidi controls,
 * zero-width characters, and the like), the line and paragraph separators,
 * and the backslash that escapes them.
 */
const ESCAPED_CHARACTERS = /[\p{Cc}\p{Cf}\u2028\u2029\\]/gu;

/** How the escapes that occur in ordinary text are spelled. */
const ESCAPE_BY_CHARACTER: Record<string, string> = {
  "\\": "\\\\",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

/** A key or value on one card line, with everything that would start, reorder, or hide a line shown as an escape. */
function escapeField(text: string): string {
  return text.replace(ESCAPED_CHARACTERS, (character) => {
    const escape = ESCAPE_BY_CHARACTER[character];
    if (escape !== undefined) return escape;
    return `\\u{${(character.codePointAt(0) ?? 0).toString(16)}}`;
  });
}

/**
 * The card's list of changes: one numbered block of labeled lines per
 * proposal. A block's first line names the action and category, then each
 * field gets its own line that starts with the block's number and its label,
 * so a bullet or a colon inside a key or value reads as part of that field.
 */
function proposalLines(
  proposals: readonly GuildMemoryProposal[],
  texts: MemoryConfirmTexts,
): { lines: string[]; escaped: boolean } {
  const lines: string[] = [];
  let escaped = false;
  for (const [offset, proposal] of proposals.entries()) {
    const index = offset + 1;
    const key = escapeField(proposal.key);
    escaped ||= key !== proposal.key;
    const action = proposal.action === "save" ? texts.actionSave : texts.actionDelete;
    lines.push(texts.entry(index, action, categoryLabel(proposal.category, texts)));
    lines.push(texts.key(index, key));
    if (proposal.action !== "save") continue;
    const value = escapeField(proposal.value);
    escaped ||= value !== proposal.value;
    lines.push(texts.value(index, value));
  }
  return { lines, escaped };
}

/** The list in a code block that no line of it can close. */
function listCodeBlock(lines: readonly string[]): string {
  const longestRun = (lines.join("\n").match(/`+/g) ?? []).reduce(
    (longest, run) => Math.max(longest, run.length),
    0,
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${lines.join("\n")}\n${fence}`;
}

/**
 * Build the confirmation card for a generation's guild memory proposals.
 *
 * Every proposed save and delete gets its own numbered block of labeled
 * lines, so the user confirms exactly which key and value will be stored or
 * removed: the header states how many changes follow, and each line break,
 * invisible character, or backslash in a key or value appears as an escape
 * the card explains. The list sits in a code block no line of it can close,
 * so model-written keys and values render raw and cannot pass for card
 * chrome. When the list does not fit in one message, it travels as a UTF-8
 * file holding the same lines, and the message says so.
 */
export function buildMemoryConfirmCard(
  texts: MemoryConfirmTexts,
  proposals: readonly GuildMemoryProposal[],
): MemoryConfirmCard {
  const header = (
    proposals.some((proposal) => proposal.action === "save") ? texts.header : texts.headerDelete
  )(proposals.length);
  const { lines, escaped } = proposalLines(proposals, texts);
  const notes = escaped ? [texts.escapeNote, ""] : [];
  const inline = [header, "", listCodeBlock(lines), "", ...notes, texts.footer].join("\n");
  if (inline.length <= MAX_MESSAGE_LENGTH) {
    return { content: inline, attachment: undefined };
  }
  return {
    content: [header, "", texts.attachmentNote, "", ...notes, texts.footer].join("\n"),
    attachment: new AttachmentBuilder(Buffer.from(lines.join("\n"), "utf8"), {
      name: GUILD_MEMORY_ATTACHMENT_NAME,
    }),
  };
}

/** Build the card's button row: 是 (Primary) confirms, 不是 (Secondary) declines. */
export function buildMemoryConfirmRow(
  texts: MemoryConfirmTexts,
  cardId: string,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(memoryCustomId("yes", cardId))
      .setLabel(texts.yes)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(memoryCustomId("no", cardId))
      .setLabel(texts.no)
      .setStyle(ButtonStyle.Secondary),
  );
}

/**
 * Message edit that settles a card: replaces its text and removes the
 * buttons. `SuppressEmbeds` is re-asserted on every edit because Discord
 * re-scans edited content for link preview cards, and a key or value may
 * quote a URL; mention parsing stays off for the same kind of reason — it
 * may also quote a mention.
 */
export function memoryConfirmEdit(content: string): MessageEditOptions {
  return {
    content,
    components: [],
    flags: MessageFlags.SuppressEmbeds,
    allowedMentions: NO_MENTIONS,
  };
}

/** Render the outcome text from the Worker's per-proposal results. */
export function renderConfirmOutcome(
  response: GuildMemoryApplyResponse | null,
  total: number,
  texts: MemoryConfirmTexts,
): string {
  if (response === null || response.status === "error") return texts.failed;
  const { results } = response;
  // A delete that matched nothing reached its end state, so it is no
  // failure — but it changed nothing either.
  const changed = results.filter((result) => result.ok && result.code !== "not_found").length;
  const failed = results.filter((result) => !result.ok).length;
  if (changed === 0) {
    if (results.some((result) => result.code === "memory_full")) return texts.full;
    if (failed > 0) return texts.failed;
    return texts.nothingToDelete;
  }
  if (failed === 0) return texts.saved;
  return texts.savedPartial(results.length - failed, total);
}

/** What a memory-confirmation click should do, as decided by {@link resolveMemoryConfirmAction}. */
export type MemoryConfirmDecision =
  | { action: "confirm" }
  | { action: "cancel" }
  | { action: "rejected"; reason: "expired" | "not-owner" | "busy" };

/**
 * Decide what a memory-confirmation click should do against a tracked card.
 * `null` when the customId belongs to another button family; callers treat
 * that like every other button that is not theirs. A family customId this
 * process cannot act on — unknown card (restart, eviction, settled), a
 * button that fires on a message other than its own card, a malformed id, or
 * a card past its deadline — is rejected as expired, so it fails closed with
 * an ephemeral notice and no action. The deadline is checked on the clock,
 * not left to the expiry timer: a click that arrives after the window but
 * before the timer runs is still too late.
 */
export function resolveMemoryConfirmAction(
  entry: MemoryConfirmEntry | undefined,
  customId: string,
  messageId: string,
  userId: string,
): MemoryConfirmDecision | null {
  const parsed = parseMemoryCustomId(customId);
  if (parsed === null) {
    return isMemoryConfirmCustomId(customId) ? { action: "rejected", reason: "expired" } : null;
  }
  if (entry === undefined || entry.messageId !== messageId || Date.now() >= entry.expiresAt) {
    return { action: "rejected", reason: "expired" };
  }
  if (userId !== entry.userId) return { action: "rejected", reason: "not-owner" };
  if (entry.busy) return { action: "rejected", reason: "busy" };
  return parsed.choice === "yes" ? { action: "confirm" } : { action: "cancel" };
}

/** Consume a pending confirmation: stop its expiry timer and forget it. */
function settle(registry: MemoryConfirmRegistry, entry: MemoryConfirmEntry): void {
  clearTimeout(entry.timer);
  registry.remove(entry.cardId);
}

/** Edit the card to its outcome text without buttons. A failure is logged, never thrown. */
async function retireCard(message: Message, content: string): Promise<void> {
  await message.edit(memoryConfirmEdit(content)).catch((error) => {
    console.log(
      JSON.stringify({
        event: "memory_confirm_edit_error",
        messageId: message.id,
        error: String(error),
      }),
    );
  });
}

/** The window's end for a card nobody acted on: forget it and retire its buttons. */
function expire(
  message: Message,
  entry: MemoryConfirmEntry,
  registry: MemoryConfirmRegistry,
): void {
  registry.remove(entry.cardId);
  // An apply still in flight settles the card itself.
  if (entry.busy) return;
  console.log(
    JSON.stringify({
      event: "memory_confirm_expired",
      messageId: message.id,
      userId: entry.userId,
    }),
  );
  void retireCard(message, entry.texts.expired);
}

/**
 * Post the confirmation card for a generation's guild memory proposals —
 * the question, every proposed change with its full key and value, and the
 * 是 / 不是 buttons — and arm the expiry timer. Best-effort: a failed post is
 * logged and never breaks the already-delivered reply. The entry is
 * registered before the send, so a click that races the send fails closed
 * (the card's message id is not known yet) instead of meeting a card nobody
 * tracks.
 */
export async function postMemoryConfirmation(
  channel: SendableChannels,
  userId: string,
  proposals: readonly GuildMemoryProposal[],
  texts: MemoryConfirmTexts,
  registry: MemoryConfirmRegistry,
): Promise<void> {
  if (proposals.length === 0) return;
  const cardId = crypto.randomUUID();
  const entry: MemoryConfirmEntry = {
    cardId,
    userId,
    messageId: null,
    proposals: [...proposals],
    texts,
    busy: false,
    // The window opens before the send: a card that took long to post does
    // not get that time back.
    expiresAt: Date.now() + MEMORY_CONFIRM_WINDOW_MS,
    timer: undefined,
  };
  registry.register(cardId, entry);

  const card = buildMemoryConfirmCard(texts, proposals);
  let message: Message;
  try {
    message = await channel.send({
      content: card.content,
      flags: MessageFlags.SuppressEmbeds,
      allowedMentions: NO_MENTIONS,
      components: [buildMemoryConfirmRow(texts, cardId)],
      ...(card.attachment === undefined ? {} : { files: [card.attachment] }),
    });
  } catch (error) {
    registry.remove(cardId);
    console.log(
      JSON.stringify({
        event: "memory_confirm_post_error",
        userId,
        cardId,
        error: String(error),
      }),
    );
    return;
  }
  entry.messageId = message.id;
  entry.timer = setTimeout(
    () => expire(message, entry, registry),
    Math.max(0, entry.expiresAt - Date.now()),
  );
  entry.timer.unref();
}

/** Acknowledge the click inside Discord's 3-second window; the card is edited separately. */
async function acknowledge(interaction: MessageComponentInteraction): Promise<void> {
  await interaction.deferUpdate().catch((error) => {
    console.log(
      JSON.stringify({
        event: "memory_confirm_ack_error",
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
  ).memoryConfirm;
  const content =
    reason === "not-owner" ? texts.notOwner : reason === "busy" ? texts.busy : texts.expiredNotice;
  await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch((error) => {
    console.log(
      JSON.stringify({
        event: "memory_confirm_refuse_error",
        messageId: interaction.message.id,
        error: String(error),
      }),
    );
  });
}

/**
 * interactionCreate path for the memory-confirmation buttons: 是 applies
 * every listed proposal on the Worker and retires the card, 不是 drops them.
 *
 * Only the user who asked for the change may click; anyone else gets an
 * ephemeral refusal. A card this process no longer tracks — restart,
 * eviction, settled — fails closed the same way: no crash, no Worker call, no
 * write. Each click is acknowledged first, so the Worker call never risks
 * Discord's 3-second interaction window; the outcome then edits the card in
 * place. Count-only logging — memory text never reaches the logs.
 */
export async function handleMemoryConfirmInteraction(
  interaction: MessageComponentInteraction,
  env: EnvConfig,
  registry: MemoryConfirmRegistry,
): Promise<void> {
  const { customId } = interaction;
  const messageId = interaction.message.id;
  const userId = interaction.user.id;
  const cardId = parseMemoryCustomId(customId)?.cardId;
  const entry = cardId === undefined ? undefined : registry.get(cardId);
  const decision = resolveMemoryConfirmAction(entry, customId, messageId, userId);
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
    console.log(JSON.stringify({ event: "memory_confirm_cancelled", messageId, userId }));
    return;
  }

  entry.busy = true;
  await acknowledge(interaction);
  let response: GuildMemoryApplyResponse | null = null;
  try {
    response = await applyGuildMemoryProposals(
      { proposals: entry.proposals, updatedBy: entry.userId },
      env.workerUrl,
      env.internalApiToken,
    );
  } catch (error) {
    console.log(
      JSON.stringify({ event: "memory_confirm_apply_error", messageId, error: String(error) }),
    );
  }
  settle(registry, entry);
  await retireCard(
    interaction.message,
    renderConfirmOutcome(response, entry.proposals.length, entry.texts),
  );
  console.log(
    JSON.stringify({
      event: "memory_confirm_applied",
      messageId,
      userId,
      proposals: entry.proposals.length,
      ok:
        response !== null && response.status === "ok"
          ? response.results.filter((result) => result.ok).length
          : 0,
    }),
  );
}
