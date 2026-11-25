import {
  ActionRow,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonComponent,
  ButtonStyle,
  DiscordAPIError,
  MessageFlags,
  type Message,
  type MessageComponentInteraction,
  type MessageManager,
  type SendableChannels,
} from "discord.js";
import type {
  AskUserOption,
  AskUserPrompt,
  GenerationRequest,
  HistoryMessage,
  UiLanguage,
} from "@xenoblade/contracts";

import type { EnvConfig } from "./env";
import { authorDisplayName } from "./history";
import { DEFAULT_UI_LANGUAGE, messages, type Messages } from "./i18n";
import { resolveUiLanguageBounded } from "./language";
import { MAX_MESSAGE_LENGTH } from "./output";

/** How long a question card stays clickable. */
export const ASK_CARD_WINDOW_MS = 15 * 60 * 1000;

/** Cap on tracked questions; the oldest entry is evicted beyond this. */
const MAX_TRACKED_PROMPTS = 128;

/** Family prefix of every question-card customId: `xbl:ask:<promptId>:<optionId>`. */
const CUSTOM_ID_FAMILY = "xbl:ask";

/** Discord's code for a message that no longer exists: a card deleted twice is no failure. */
const UNKNOWN_MESSAGE_CODE = 10008;

/**
 * Mentions are never parsed on a question card. The question, its note, and
 * the option labels are model-written text and may contain `@everyone`.
 */
const NO_MENTIONS = { parse: [] };

/** Strings the question flow renders (from the i18n table). */
export type AskConfirmTexts = Messages["askConfirm"];

/** A channel whose messages can be read back and deleted — one the Runtime did not see only partially. */
export type ReadableChannel = Extract<SendableChannels, { messages: MessageManager }>;

/** Registry entry for one posted question card, keyed by prompt id. */
export interface AskEntry {
  prompt: AskUserPrompt;
  /** Only this user's click answers: the user the question was asked to. */
  userId: string;
  /** The generation the question stopped. Its scope, speaker, and attachments carry into the continuation. */
  request: GenerationRequest;
  /** Language of the card, and of the turn the user's choice becomes. */
  language: UiLanguage;
  /** The card's message once posted; a button must fire on that message. */
  message: Message | null;
  /** True while a click on the card is being carried out (double-click guard). */
  busy: boolean;
  /** Wall-clock end of the window: a click at or after it is expired, whether or not the timer has fired. */
  expiresAt: number;
  /** Expiry timer; cleared once the entry settles. */
  timer: NodeJS.Timeout | undefined;
}

/**
 * In-memory index of unanswered question cards, keyed by prompt id — the id
 * is known before the card is posted, so its buttons can carry it from the
 * start. Bounded and FIFO, like the other confirmation registries. The Worker
 * also records each card's message id in the thread's session, so a restart
 * loses neither the cleanup nor the answer: the buttons fail closed, and the
 * card still goes when the user replies in text.
 */
export class AskPromptRegistry {
  private readonly entries = new Map<string, AskEntry>();

  register(promptId: string, entry: AskEntry): void {
    this.entries.set(promptId, entry);
    if (this.entries.size > MAX_TRACKED_PROMPTS) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
  }

  get(promptId: string): AskEntry | undefined {
    return this.entries.get(promptId);
  }

  remove(promptId: string): void {
    this.entries.delete(promptId);
  }

  /** Every tracked card posted in a channel. */
  inChannel(channelId: string): AskEntry[] {
    return [...this.entries.values()].filter((entry) => entry.message?.channelId === channelId);
  }
}

/** Build a card button's customId: `xbl:ask:<promptId>:<optionId>`. */
export function askCustomId(promptId: string, optionId: string): string {
  return `${CUSTOM_ID_FAMILY}:${promptId}:${optionId}`;
}

/** True for any button of the question-card family, well-formed or not. */
export function isAskCustomId(customId: string): boolean {
  return customId.startsWith(`${CUSTOM_ID_FAMILY}:`);
}

/**
 * Parse a question-card customId into its prompt and option ids. Null for
 * anything outside the scheme: another button family, a foreign verb, or a
 * missing id.
 */
export function parseAskCustomId(customId: string): { promptId: string; optionId: string } | null {
  const [family, verb, promptId, optionId, ...rest] = customId.split(":");
  if (family !== "xbl" || verb !== "ask" || rest.length > 0) return null;
  if (promptId === undefined || promptId === "") return null;
  if (optionId === undefined || optionId === "") return null;
  return { promptId, optionId };
}

/**
 * Cut `text` to at most `max` UTF-16 code units — the unit message lengths
 * are counted in — without ever splitting a surrogate pair.
 */
function clamp(text: string, max: number): string {
  let result = "";
  for (const char of text) {
    if (result.length + char.length > max) break;
    result += char;
  }
  return result;
}

/**
 * Build the card of one question: what the model said before asking (when it
 * said anything), the question, its note, and how to answer. The lead-in
 * gives way first when the card would not fit — the question and its buttons
 * are what the card is for.
 */
export function buildAskCard(texts: AskConfirmTexts, reply: string, prompt: AskUserPrompt): string {
  const note = prompt.contextNote?.trim();
  const question = [
    prompt.question,
    ...(note === undefined || note === "" ? [] : ["", texts.contextNote(note)]),
    "",
    texts.footer,
  ].join("\n");
  const room = MAX_MESSAGE_LENGTH - question.length - 2;
  const leadIn = clamp(reply.trim(), Math.max(0, room));
  return leadIn === "" ? question : `${leadIn}\n\n${question}`;
}

/**
 * Build the card's button row: one button per option, the first — the
 * model's recommended answer — as the primary one.
 */
export function buildAskRow(prompt: AskUserPrompt): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...prompt.options.map((option, index) =>
      new ButtonBuilder()
        .setCustomId(askCustomId(prompt.id, option.id))
        .setLabel(option.label)
        .setStyle(index === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ),
  );
}

/** What a click on a question card should do, as decided by {@link resolveAskAction}. */
export type AskDecision =
  | { action: "choose"; option: AskUserOption }
  | { action: "rejected"; reason: "expired" | "not-owner" | "busy" };

/**
 * Decide what a question-card click should do against a tracked card.
 * `null` when the customId belongs to another button family; callers treat
 * that like every other button that is not theirs. A family customId this
 * process cannot act on — unknown question (restart, eviction, settled), a
 * button that fires on a message other than its own card, a malformed or
 * unknown option, a card past its deadline — is rejected as expired, so it
 * fails closed with an ephemeral notice and no action.
 */
export function resolveAskAction(
  entry: AskEntry | undefined,
  customId: string,
  messageId: string,
  userId: string,
  now: number,
): AskDecision | null {
  const parsed = parseAskCustomId(customId);
  if (parsed === null) {
    return isAskCustomId(customId) ? { action: "rejected", reason: "expired" } : null;
  }
  if (entry === undefined || entry.message === null || entry.message.id !== messageId) {
    return { action: "rejected", reason: "expired" };
  }
  if (now >= entry.expiresAt) return { action: "rejected", reason: "expired" };
  if (userId !== entry.userId) return { action: "rejected", reason: "not-owner" };
  if (entry.busy) return { action: "rejected", reason: "busy" };
  const option = entry.prompt.options.find((candidate) => candidate.id === parsed.optionId);
  return option === undefined
    ? { action: "rejected", reason: "expired" }
    : { action: "choose", option };
}

/** Consume a pending question: stop its expiry timer and forget it. */
function settle(registry: AskPromptRegistry, entry: AskEntry): void {
  clearTimeout(entry.timer);
  registry.remove(entry.prompt.id);
}

/** Acknowledge the click inside Discord's 3-second window; the card is deleted separately. */
async function acknowledge(interaction: MessageComponentInteraction): Promise<void> {
  await interaction.deferUpdate().catch((error) => {
    console.log(
      JSON.stringify({
        event: "ask_card_ack_error",
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
  ).askConfirm;
  const content =
    reason === "not-owner" ? texts.notOwner : reason === "busy" ? texts.busy : texts.expiredNotice;
  await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch((error) => {
    console.log(
      JSON.stringify({
        event: "ask_card_refuse_error",
        messageId: interaction.message.id,
        error: String(error),
      }),
    );
  });
}

/**
 * Delete a card from Discord. True once it is gone — deleted now, or already
 * gone when tried. False when the delete failed, so the caller keeps the card
 * on record and a later turn tries again.
 */
async function deleteCard(message: Message): Promise<boolean> {
  try {
    await message.delete();
    return true;
  } catch (error) {
    if (error instanceof DiscordAPIError && error.code === UNKNOWN_MESSAGE_CODE) return true;
    console.log(
      JSON.stringify({
        event: "ask_card_delete_error",
        messageId: message.id,
        error: String(error),
      }),
    );
    return false;
  }
}

/** A card the Runtime does not track, fetched from Discord so it can be deleted. */
type FetchedCard = Message | "gone" | "unavailable";

async function fetchCard(channel: ReadableChannel, messageId: string): Promise<FetchedCard> {
  try {
    return await channel.messages.fetch(messageId);
  } catch (error) {
    if (error instanceof DiscordAPIError && error.code === UNKNOWN_MESSAGE_CODE) return "gone";
    console.log(JSON.stringify({ event: "ask_card_fetch_error", messageId, error: String(error) }));
    return "unavailable";
  }
}

/** Drop a card's buttons, so an unanswered one reads as a question to answer in text. */
async function retireButtons(message: Message): Promise<void> {
  await message
    .edit({ components: [], flags: MessageFlags.SuppressEmbeds, allowedMentions: NO_MENTIONS })
    .catch((error) => {
      console.log(
        JSON.stringify({
          event: "ask_card_retire_error",
          messageId: message.id,
          error: String(error),
        }),
      );
    });
}

/** The window's end for a card nobody answered: forget it and drop its buttons. */
function expire(entry: AskEntry, registry: AskPromptRegistry): void {
  registry.remove(entry.prompt.id);
  // A click still being carried out deletes the card itself.
  if (entry.busy || entry.message === null) return;
  console.log(JSON.stringify({ event: "ask_card_expired", messageId: entry.message.id }));
  void retireButtons(entry.message);
}

/** The card of one question, ready to post. */
export interface AskCard {
  prompt: AskUserPrompt;
  /** What the model said before asking; shown as the card's lead-in when it is not empty. */
  reply: string;
  /** The generation that stopped on the question. */
  request: GenerationRequest;
  language: UiLanguage;
}

/**
 * Post the card of a question the generation stopped on, and arm the expiry
 * timer. Best-effort: a failed post is logged and answers null, so the
 * caller records no card. The entry is registered before the send, so a
 * click that races the send fails closed (the card's message id is not known
 * yet) instead of meeting a question nobody tracks.
 *
 * Returns the posted message.
 */
export async function postAskCard(
  channel: SendableChannels,
  card: AskCard,
  registry: AskPromptRegistry,
): Promise<Message | null> {
  const { prompt, request, language } = card;
  const entry: AskEntry = {
    prompt,
    userId: request.userId,
    request,
    language,
    message: null,
    busy: false,
    // The window opens before the send: a card that took long to post does
    // not get that time back.
    expiresAt: Date.now() + ASK_CARD_WINDOW_MS,
    timer: undefined,
  };
  registry.register(prompt.id, entry);

  let message: Message;
  try {
    message = await channel.send({
      content: buildAskCard(messages(language).askConfirm, card.reply, prompt),
      flags: MessageFlags.SuppressEmbeds,
      allowedMentions: NO_MENTIONS,
      components: [buildAskRow(prompt)],
    });
  } catch (error) {
    settle(registry, entry);
    console.log(
      JSON.stringify({ event: "ask_card_post_error", userId: entry.userId, error: String(error) }),
    );
    return null;
  }
  entry.message = message;
  entry.timer = setTimeout(
    () => expire(entry, registry),
    Math.max(0, entry.expiresAt - Date.now()),
  );
  entry.timer.unref();
  return message;
}

/**
 * The card as a turn of the bot's own, for the model to read the question by
 * once the card is gone from Discord. Its options are spelled out: they were
 * buttons, so the card's text alone does not say what was offered.
 */
function cardTurn(
  message: Message,
  labels: readonly string[],
  texts: AskConfirmTexts,
): HistoryMessage {
  const options = labels.length === 0 ? "" : `\n${texts.options(labels)}`;
  return {
    id: message.id,
    text: `${message.content}${options}`,
    authorId: message.author.id,
    authorName: authorDisplayName(message),
    isBot: true,
    createdAt: message.createdTimestamp,
  };
}

/** Labels of a card's option buttons, read off the message itself. */
function buttonLabels(message: Message): string[] {
  const labels: string[] = [];
  for (const component of message.components) {
    if (!(component instanceof ActionRow)) continue;
    for (const button of component.components) {
      if (
        button instanceof ButtonComponent &&
        button.customId !== null &&
        isAskCustomId(button.customId)
      ) {
        labels.push(button.label ?? "");
      }
    }
  }
  return labels;
}

/** What deleting a channel's waiting question cards came to. */
export interface DismissedCards {
  /** What each card said, as a turn of the bot's own. */
  turns: HistoryMessage[];
  /**
   * The cards that are gone from Discord — deleted now, or already gone. A
   * card whose delete failed is not among them, so its record stays and a
   * later turn tries again.
   */
  deletedIds: string[];
}

/**
 * Delete every question card still waiting in the channel, and hand back
 * what each said as a turn of the bot's own. The user answered in text
 * instead of clicking, so the cards go before the reply — and the reply
 * still sees the question it answers.
 *
 * `recordedIds` are the cards the Worker remembers for the thread: they
 * cover a card this process no longer tracks (a restart in between), whose
 * options are then read off the message. A card that is already gone counts
 * as deleted; one that cannot be reached is left on record.
 */
export async function dismissPendingCards(
  channel: ReadableChannel,
  registry: AskPromptRegistry,
  recordedIds: readonly string[],
): Promise<DismissedCards> {
  const tracked = new Map(
    registry.inChannel(channel.id).map((entry) => [entry.message?.id ?? "", entry] as const),
  );
  const ids = new Set([...recordedIds, ...tracked.keys()]);
  ids.delete("");

  const dismissed: DismissedCards = { turns: [], deletedIds: [] };
  for (const id of ids) {
    const entry = tracked.get(id);
    const fetched = entry?.message ?? (await fetchCard(channel, id));
    if (fetched === "gone") {
      dismissed.deletedIds.push(id);
      if (entry !== undefined) settle(registry, entry);
      continue;
    }
    // Left alone: it is not known to be gone, and it is still on record.
    if (fetched === "unavailable") continue;
    const texts = messages(entry?.language ?? DEFAULT_UI_LANGUAGE).askConfirm;
    dismissed.turns.push(
      cardTurn(
        fetched,
        entry?.prompt.options.map((option) => option.label) ?? buttonLabels(fetched),
        texts,
      ),
    );
    if (await deleteCard(fetched)) dismissed.deletedIds.push(id);
    if (entry !== undefined) settle(registry, entry);
  }
  if (dismissed.turns.length > 0) {
    console.log(
      JSON.stringify({
        event: "ask_cards_dismissed",
        channelId: channel.id,
        cards: dismissed.turns.length,
        deleted: dismissed.deletedIds.length,
      }),
    );
  }
  return dismissed;
}

/** A click that passed its checks and was acknowledged, to be carried out inside the conversation's queue. */
export interface AskClaim {
  entry: AskEntry;
  option: AskUserOption;
  /** When the user clicked: the continuation's message time. */
  answeredAt: number;
}

/** A carried-out click: the continuation's request, the card it answered, and whether that card is gone. */
export interface SettledChoice {
  /**
   * The request of the continuation: the turn the question interrupted, with
   * the user's choice as its message. Its id derives from the question's, so
   * a click delivered twice runs once. History is left empty: the
   * continuation reads the channel again, with the card put back as a turn.
   */
  request: GenerationRequest;
  /** The answered card as the bot's own turn, for the continuation to read the question by. */
  card: HistoryMessage;
  /** False when the card could not be deleted from Discord: its record stays, so a later turn retries. */
  cardDeleted: boolean;
}

/**
 * Carry out an acknowledged click — inside the conversation's queue, where
 * nothing else touches the card meanwhile. The card is deleted and the
 * question settled only while it is still waiting: a typed reply that ran
 * first has done both, and its own generation answers for the click, so this
 * answers null and nothing runs twice.
 */
export async function settleChoice(
  registry: AskPromptRegistry,
  claim: AskClaim,
): Promise<SettledChoice | null> {
  const { entry, option, answeredAt } = claim;
  // The question was settled while the click waited for its turn.
  if (registry.get(entry.prompt.id) !== entry) return null;
  const posted = entry.message;
  if (posted === null) return null;
  const card = cardTurn(
    posted,
    entry.prompt.options.map((candidate) => candidate.label),
    messages(entry.language).askConfirm,
  );
  const cardDeleted = await deleteCard(posted);
  settle(registry, entry);
  console.log(JSON.stringify({ event: "ask_card_answered", messageId: posted.id, cardDeleted }));
  return {
    request: {
      ...entry.request,
      messageId: `${entry.request.messageId}:ask:${entry.prompt.id}`,
      messageCreatedAt: answeredAt,
      summonKind: "component",
      content: messages(entry.language).askConfirm.chosen(option.label),
      history: [],
    },
    card,
    cardDeleted,
  };
}

/** What a click on a question card needs from the caller. */
export interface AskRuntime {
  env: EnvConfig;
  registry: AskPromptRegistry;
  /**
   * A click passed its checks and was acknowledged. The caller hands it to
   * the conversation's queue, which carries it out through {@link settleChoice}
   * — behind whatever the conversation is running, and ahead of what follows.
   */
  confirm: (claim: AskClaim) => void;
}

/**
 * interactionCreate path for the question-card buttons.
 *
 * Only the user who was asked may click; anyone else gets an ephemeral
 * refusal. A card this process no longer tracks — restart, eviction, settled
 * — fails closed the same way: no crash, no generation. A click that passes
 * is claimed (a second one is refused as busy) and acknowledged at once, so
 * nothing later risks Discord's 3-second window; the choice itself is left
 * to the conversation's queue, which deletes the card and starts the
 * continuation in its turn.
 */
export async function handleAskInteraction(
  interaction: MessageComponentInteraction,
  runtime: AskRuntime,
): Promise<void> {
  const { customId } = interaction;
  const messageId = interaction.message.id;
  const userId = interaction.user.id;
  const promptId = parseAskCustomId(customId)?.promptId;
  const entry = promptId === undefined ? undefined : runtime.registry.get(promptId);
  const decision = resolveAskAction(entry, customId, messageId, userId, Date.now());
  if (decision === null) return;
  if (decision.action === "rejected") {
    await refuse(interaction, decision.reason, runtime.env);
    return;
  }
  // A decision to act implies the entry resolved above, and that its card is the message.
  if (entry === undefined || entry.message === null) return;

  entry.busy = true;
  await acknowledge(interaction);
  runtime.confirm({ entry, option: decision.option, answeredAt: interaction.createdTimestamp });
}
