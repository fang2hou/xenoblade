import { DMChannel, MessageFlags, TextChannel, ThreadChannel } from "discord.js";
import type { Client, Message, MessageComponentInteraction, SendableChannels } from "discord.js";

import type {
  DiscordAttachment,
  DiscordReadResult,
  GenerationRequest,
  GenerationResult,
  HistoryMessage,
  SummonKind,
  UiLanguage,
} from "@xenoblade/contracts";

import {
  handleAdminConfirmInteraction,
  isAdminConfirmCustomId,
  postAdminConfirmation,
  type AdminConfirmRegistry,
} from "./admin-confirm";
import { executeDiscordReads } from "./admin-executor";
import type { EnvConfig } from "./env";
import { containerIdFromMessage, scopeIdFromMessage } from "./conversation-scope";
import {
  handleMemoryConfirmInteraction,
  isMemoryConfirmCustomId,
  postMemoryConfirmation,
  type MemoryConfirmRegistry,
} from "./memory-confirm";
import {
  handleSoulConfirmInteraction,
  isSoulConfirmCustomId,
  postSoulConfirmation,
  type SoulConfirmRegistry,
} from "./soul-confirm";
import {
  dismissPendingCards,
  handleAskInteraction,
  isAskCustomId,
  postAskCard,
  settleChoice,
  type AskClaim,
  type AskPromptRegistry,
  type ReadableChannel,
} from "./ask-confirm";
import { evaluateThreadTrigger, evaluateTrigger, type TriggerDecision } from "./trigger-policy";
import {
  buildThreadTitle,
  startDiscussionThread,
  startsThread,
  threadOf,
  type ThreadRef,
  type ThreadSessions,
} from "./thread-manager";
import { fetchHistory } from "./history";
import { renderReply } from "./citations";
import type { RetryRequests } from "./retry-requests";
import { sendTyping } from "./output";
import { StagedStatus } from "./staged-status";
import { generate } from "./ai-client";
import { handleDmMessage } from "./dm-commands";
import { isPublicChannel, publicChannelIds } from "./history-ingest";
import { resolveUiLanguageBounded } from "./language";
import { messages, stagedMilestones } from "./i18n";

/** What runs a container's generations one at a time: the Runtime's `ConversationQueue`. */
export interface TaskQueue {
  enqueue(containerId: string, task: () => Promise<void>): void;
}

/** What every generation path of the Runtime shares. */
export interface Runtime {
  env: EnvConfig;
  queue: TaskQueue;
  /** Unanswered question cards: their buttons, and their cleanup. */
  askCards: AskPromptRegistry;
  /** Which messages only asked for the bot's previous reply to be redone. */
  retryRequests: RetryRequests;
  memoryConfirms: MemoryConfirmRegistry;
  soulConfirms: SoulConfirmRegistry;
  adminConfirms?: AdminConfirmRegistry;
  threadSessions: ThreadSessions;
}

/**
 * The message a generation answers, as the request carries it. A continuation
 * has a derived message id — the Worker's dedup key — and the user's choice
 * as its content.
 */
interface Turn {
  messageId: string;
  kind: SummonKind;
  content: string;
  /** True when a bare mention made an earlier message the trigger content. */
  fallback: boolean;
  reference: GenerationRequest["reference"];
  attachments: DiscordAttachment[];
}

/** Where a generation's request is addressed. */
interface Target {
  channel: SendableChannels;
  /** `discord:` key of the conversation; a started thread is its own. */
  containerId: string;
  channelId: string;
  /** The thread the generation runs in, when it runs in one. */
  thread: ThreadRef | null;
  /** The parent channel's discussion a thread was started from; only that first turn sends any. */
  anchorHistory?: HistoryMessage[];
}

/** The decision of an un-summoned message in a thread the bot follows. */
const THREAD_CHAT: TriggerDecision = { kind: "thread-chat" };

/** The decision of non-command text from a chat-opted-in user. */
const DM_CHAT: TriggerDecision = { kind: "dm-chat" };

/** A channel the Runtime reads history from: a server text channel, a thread, or a DM. */
type HistoryChannel = TextChannel | ThreadChannel | DMChannel;

/**
 * messageCreate entry point. Skips bots, routes DMs to the control plane
 * (which dispatches opted-in non-command text to generation), and runs the
 * summon matrix for guild messages. A direct or role mention in a regular
 * text channel is answered in a thread started on the message, which the bot
 * then follows (ADR-003 amendment). Triggered messages are enqueued
 * per-container so only one generation runs at a time per conversation.
 */
export async function handleMessageCreate(
  message: Message,
  client: Client,
  runtime: Runtime,
): Promise<void> {
  try {
    if (message.author.bot) return;

    // DMs route to the control plane first (commands always win); non-command
    // text continues to generation only for chat-opted-in users (ADR-011).
    if (message.channel?.isDMBased()) {
      await handleDmMessage(message, runtime.env, (dmMessage) => {
        const channel = dmMessage.channel;
        if (!channel?.isSendable()) return;
        const target: Target = {
          channel,
          containerId: containerIdFromMessage(dmMessage),
          channelId: dmMessage.channelId,
          thread: null,
        };
        dispatch(runtime, dmMessage, messageTurn(dmMessage, DM_CHAT), target, client);
      });
      return;
    }

    const channel = message.channel;
    if (!channel?.isSendable()) return;
    const botId = client.user?.id ?? runtime.env.discordApplicationId;

    if (channel.isThread()) {
      const thread: ThreadRef = {
        guildId: scopeIdFromMessage(message),
        id: channel.id,
        parentId: channel.parentId,
      };
      const trigger = await evaluateThreadTrigger(message, botId, runtime.env.mentionRoleIds, () =>
        runtime.threadSessions.isFollowed(thread),
      );
      if (trigger.kind === "none") return;
      if (trigger.kind === "skipped") {
        if (trigger.reason === "reply-to-other" || trigger.reason === "leading-mention") {
          runtime.threadSessions.markSideTalk(channel.id);
        }
        console.log(
          JSON.stringify({
            event: "thread_message_skipped",
            messageId: message.id,
            channelId: channel.id,
            layer: "deterministic",
            reason: trigger.reason,
          }),
        );
        return;
      }
      if (trigger.kind === "summon") {
        runtime.threadSessions.clearSideTalk(channel.id);
        if (trigger.resume) {
          await runtime.threadSessions.follow(thread, message.author.id);
        }
      }
      const decision = trigger.kind === "summon" ? trigger.decision : THREAD_CHAT;
      dispatch(
        runtime,
        message,
        messageTurn(message, decision),
        {
          channel,
          containerId: containerIdFromMessage(message),
          channelId: channel.id,
          thread,
        },
        client,
      );
      return;
    }

    const decision = await evaluateTrigger(message, botId, runtime.env.mentionRoleIds);
    if (decision === null) return;
    const turn = messageTurn(message, decision);

    const route = await routeChannelSummon(message, turn, channel, runtime);
    // The Worker would not answer this summon at all: a disabled guild, or a
    // channel off its allowlist. Nothing is said, and no thread is started.
    if (route.kind === "refused") return;
    dispatch(runtime, message, turn, route.target, client);
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "message_handler_error",
        messageId: message.id,
        error: String(error),
      }),
    );
  }
}

/** Where a summon sent in a channel is answered: in a thread started on it, in the channel, or nowhere. */
type SummonRoute =
  | { kind: "thread"; target: Target }
  | { kind: "channel"; target: Target }
  | { kind: "refused" };

/**
 * Decide where a summon in a regular text channel is answered. A thread is
 * started only where the Worker answers at all — it reads the guild's switch
 * and the channel allowlist first, so a disabled guild or a channel off the
 * list never gets an empty thread of its own. When the Worker cannot say, no
 * thread is started and the summon is answered in the channel, where the
 * generation gate decides as before. A thread the bot may not start or
 * cannot post in is no reason not to answer: the summon then runs in the
 * channel, like a reply to the bot.
 */
async function routeChannelSummon(
  message: Message,
  turn: Turn,
  channel: SendableChannels,
  runtime: Runtime,
): Promise<SummonRoute> {
  const inChannel = (): SummonRoute => ({
    kind: "channel",
    target: channelTarget(message, channel),
  });
  if (!startsThread(turn.kind, channel)) return inChannel();

  const allowed = await runtime.threadSessions.isChannelAllowed({
    guildId: scopeIdFromMessage(message),
    channelId: channel.id,
  });
  if (allowed === false) {
    console.log(
      JSON.stringify({ event: "summon_refused", messageId: message.id, channelId: channel.id }),
    );
    return { kind: "refused" };
  }
  if (allowed !== true) return inChannel();

  const started = await startSummonThread(message, turn, runtime);
  return started === null ? inChannel() : { kind: "thread", target: started };
}

/** Log a trigger and queue its generation behind whatever the container is running. */
function dispatch(
  runtime: Runtime,
  message: Message,
  turn: Turn,
  target: Target,
  client: Client,
): void {
  console.log(
    JSON.stringify({
      event: "trigger",
      messageId: message.id,
      containerId: target.containerId,
      kind: turn.kind,
      hasFallback: turn.fallback,
      inThread: target.thread !== null,
    }),
  );
  runtime.queue.enqueue(target.containerId, () =>
    runGeneration(message, turn, target, runtime, client),
  );
}

/** The conversation a message already sits in: a channel, where no thread is started. */
function channelTarget(message: Message, channel: SendableChannels): Target {
  return {
    channel,
    containerId: containerIdFromMessage(message),
    channelId: channel.id,
    thread: null,
  };
}

/**
 * Start a thread on a summoning message and register it as followed, so the
 * summon is answered there and the bot keeps following the thread afterwards.
 * Returns where that first turn is addressed, or null when the thread could
 * not be had.
 */
async function startSummonThread(
  message: Message,
  turn: Turn,
  runtime: Runtime,
): Promise<Target | null> {
  const language = await resolveUiLanguageBounded(message.author.id, runtime.env, 1_000);
  const started = await startDiscussionThread(message, {
    name: buildThreadTitle(turn.content, messages(language).thread.defaultTitle),
  });
  if (started === null) return null;

  const scopeId = scopeIdFromMessage(message);
  const parentId = started.thread.parentId ?? message.channelId;
  const thread: ThreadRef = { guildId: scopeId, id: started.thread.id, parentId };
  await runtime.threadSessions.follow(thread, message.author.id);

  return {
    channel: started.thread,
    containerId: `discord:${scopeId}:${parentId}:${thread.id}`,
    channelId: thread.id,
    thread,
    // Only this first turn carries the parent channel's discussion; the
    // thread's own history takes over from the answer on.
    ...(started.anchorHistory.length === 0 ? {} : { anchorHistory: started.anchorHistory }),
  };
}

/** The message a generation answers: the trigger event's identity, the fallback's words when there is one. */
function messageTurn(message: Message, decision: TriggerDecision): Turn {
  const effective = decision.fallbackMessage ?? message;
  return {
    // messageId is the dedup key on the Worker — the trigger event (the
    // mention), not the fallback content source, so a bare mention that
    // re-uses a prior message still triggers.
    messageId: message.id,
    kind: decision.kind,
    content: effective.content,
    fallback: decision.fallbackMessage !== undefined,
    reference: buildReference(message),
    attachments: mapAttachments(effective.attachments),
  };
}

/** Recent prior thread messages inspected by the Layer 2 relevance gate. */
const THREAD_GATE_WINDOW = 8;

/**
 * Serialized generation for one turn: read the history the model will see,
 * run the conditional Layer 2 relevance gate for ambiguous followed-thread
 * messages (before dismissing any pending question cards or flashing typing),
 * build the request, and hand off to {@link executeGeneration}. Runs inside
 * the per-container queue.
 */
/** Maximum Runtime-proxied live Discord read hops allowed within a single user turn. */
const MAX_ADMIN_READ_HOPS = 6;

/**
 * Evaluate whether a turn is eligible for owner-only server administration:
 * requires configured `ADMIN_GUILD_ID` & `ADMIN_OWNER_USER_ID`, matching guild
 * and owner user, and real-time verification that the channel (or its parent
 * channel when in a thread) is non-public (`@everyone` lacks `ViewChannel`).
 * Returns the protected channel/parent/category IDs when eligible, else null.
 */
function resolveAdminTurnContext(
  channel: SendableChannels,
  scopeId: string,
  parentChannelId: string | null,
  userId: string,
  env: EnvConfig,
): string[] | null {
  const admin = env.admin;
  if (admin == null) return null;
  if (scopeId !== admin.guildId || userId !== admin.ownerUserId) return null;
  if (channel.isDMBased()) return null;
  const guild = "guild" in channel ? channel.guild : undefined;
  if (!guild) return null;

  const effectiveChannel =
    parentChannelId !== null ? (guild.channels?.cache?.get(parentChannelId) ?? channel) : channel;
  if (isPublicChannel(effectiveChannel, guild.roles?.everyone)) return null;

  const protectedIds = new Set<string>([channel.id]);
  if (parentChannelId !== null) protectedIds.add(parentChannelId);
  const categoryId =
    "parentId" in effectiveChannel && typeof effectiveChannel.parentId === "string"
      ? effectiveChannel.parentId
      : null;
  if (categoryId !== null) protectedIds.add(categoryId);
  return [...protectedIds];
}

async function runGeneration(
  message: Message,
  turn: Turn,
  target: Target,
  runtime: Runtime,
  client: Client,
): Promise<void> {
  const rawHistory = await fetchTurnHistory(target.channel);
  const userDisplayName =
    message.member?.displayName || message.author.displayName || message.author.username;

  if (turn.kind === "thread-chat" && target.thread !== null) {
    const proceed = await shouldProceedThreadChat(
      message,
      turn,
      target.thread,
      userDisplayName,
      rawHistory,
      runtime,
    );
    if (!proceed) return;
  }

  const history = markRedoRequests(
    await settleTurnCards(target.channel, target.thread, rawHistory, runtime),
    target.containerId,
    runtime.retryRequests,
  );
  const scopeId = scopeIdFromMessage(message);
  const parentChannelId = target.thread?.parentId ?? null;
  const publicIds = publicChannelIds(message.guild);
  const adminProtectedIds = resolveAdminTurnContext(
    target.channel,
    scopeId,
    parentChannelId,
    message.author.id,
    runtime.env,
  );
  const request: GenerationRequest = {
    messageId: turn.messageId,
    messageCreatedAt: message.createdTimestamp,
    containerId: target.containerId,
    scopeId,
    channelId: target.channelId,
    parentChannelId,
    ...(publicIds === undefined ? {} : { publicChannelIds: publicIds }),
    ...(adminProtectedIds === null
      ? {}
      : { adminMode: true, adminProtectedChannelIds: adminProtectedIds }),
    userId: message.author.id,
    userDisplayName,
    summonKind: turn.kind,
    content: turn.content,
    history,
    ...(target.anchorHistory === undefined ? {} : { anchorHistory: target.anchorHistory }),
    reference: turn.reference,
    attachments: turn.attachments,
  };
  logRequest(request);

  await executeGeneration(target.channel, request, runtime, client);
}

/**
 * Layer 2 conditional semantic gate for an un-summoned `thread-chat` message.
 *
 * Bypasses immediately (zero extra latency) when the author is answering an
 * active `ask_user` card addressed to them, or when recent thread messages
 * involve only that single human and the bot with no recent skipped side-talk.
 * Otherwise asks the Worker's lightweight classifier; fails open on gate
 * errors so a transient hiccup never silently drops a real follow-up.
 */
async function shouldProceedThreadChat(
  message: Message,
  turn: Turn,
  thread: ThreadRef,
  userDisplayName: string,
  rawHistory: readonly HistoryMessage[],
  runtime: Runtime,
): Promise<boolean> {
  const now = Date.now();
  const activeCards = runtime.askCards
    .inChannel(thread.id)
    .filter((entry) => now < entry.expiresAt);
  if (activeCards.some((entry) => entry.userId === message.author.id)) {
    runtime.threadSessions.clearSideTalk(thread.id);
    return true;
  }

  const pendingQuestionForOther = activeCards.some((entry) => entry.userId !== message.author.id);
  const priorWindow = rawHistory
    .filter((entry) => entry.id !== message.id)
    .slice(-THREAD_GATE_WINDOW);
  const humanSpeakers = new Set(
    priorWindow.filter((entry) => !entry.isBot).map((entry) => entry.authorId),
  );
  humanSpeakers.add(message.author.id);

  const needsGate =
    humanSpeakers.size >= 2 ||
    runtime.threadSessions.hasRecentSideTalk(thread.id) ||
    pendingQuestionForOther;
  if (!needsGate) return true;

  const decision = await runtime.threadSessions.checkShouldReply({
    scopeId: thread.guildId,
    channelId: thread.id,
    parentChannelId: thread.parentId,
    messageId: message.id,
    userDisplayName,
    content: turn.content,
    hasAttachments: turn.attachments.length > 0,
    recentMessages: priorWindow.map((entry) => ({
      authorName: entry.authorName,
      isBot: entry.isBot,
      text: entry.text,
    })),
    pendingQuestionForOther,
  });

  if (decision === false) {
    runtime.threadSessions.markSideTalk(thread.id);
    console.log(
      JSON.stringify({
        event: "thread_message_skipped",
        messageId: message.id,
        channelId: thread.id,
        layer: "semantic",
      }),
    );
    return false;
  }

  if (decision === null) {
    console.log(
      JSON.stringify({
        event: "thread_gate_fallback",
        messageId: message.id,
        channelId: thread.id,
      }),
    );
    return true;
  }

  runtime.threadSessions.clearSideTalk(thread.id);
  return true;
}

/**
 * The history a turn's model will see. Every question card still waiting in
 * the conversation is deleted from Discord first — the user moved on without
 * clicking — and put back as the bot's own turn, so the reply can still read
 * the question it answers. Only cards that are gone come off the record: one
 * that could not be deleted waits for a later turn.
 */
async function readTurnHistory(
  channel: SendableChannels,
  thread: ThreadRef | null,
  runtime: Runtime,
): Promise<HistoryMessage[]> {
  return settleTurnCards(channel, thread, await fetchTurnHistory(channel), runtime);
}

async function settleTurnCards(
  channel: SendableChannels,
  thread: ThreadRef | null,
  history: HistoryMessage[],
  runtime: Runtime,
): Promise<HistoryMessage[]> {
  const readable = toReadable(channel);
  if (readable === undefined) return history;

  const recorded = thread === null ? [] : await runtime.threadSessions.pendingCardIds(thread);
  const cards = await dismissPendingCards(readable, runtime.askCards, recorded);
  if (thread !== null) await runtime.threadSessions.forgetCards(thread, cards.deletedIds);
  return restoreCards(history, cards.turns);
}

/**
 * Mark the messages that only asked for the bot's previous reply to be
 * redone, so the Worker's `retry_last_reply` walks back past them to the
 * question the user actually asked.
 */
function markRedoRequests(
  history: HistoryMessage[],
  containerId: string,
  retries: RetryRequests,
): HistoryMessage[] {
  return history.map((entry) =>
    retries.isRedoRequest(containerId, entry.id) ? { ...entry, retryRequest: true } : entry,
  );
}

/** The channel's recent messages; none when they cannot be read. */
async function fetchTurnHistory(channel: SendableChannels): Promise<HistoryMessage[]> {
  const source = toHistoryChannel(channel);
  if (source === undefined) return [];
  try {
    return await fetchHistory(source);
  } catch (error) {
    console.log(
      JSON.stringify({ event: "history_fetch_error", channelId: channel.id, error: String(error) }),
    );
    return [];
  }
}

function toHistoryChannel(channel: SendableChannels): HistoryChannel | undefined {
  return channel instanceof TextChannel ||
    channel instanceof ThreadChannel ||
    channel instanceof DMChannel
    ? channel
    : undefined;
}

/** The channel as one whose messages can be fetched and deleted, when the Runtime holds it in full. */
function toReadable(channel: SendableChannels): ReadableChannel | undefined {
  return "messages" in channel ? channel : undefined;
}

/**
 * Put each deleted question card back where the history shows it, as the
 * turn the model reads the question by. A card the history fetch did not
 * reach is appended; everything then reads in the order it was said.
 */
function restoreCards(
  history: HistoryMessage[],
  cards: readonly HistoryMessage[],
): HistoryMessage[] {
  if (cards.length === 0) return history;
  const byId = new Map(cards.map((card) => [card.id, card] as const));
  const shown = new Set(history.map((entry) => entry.id));
  return [
    ...history.map((entry) => byId.get(entry.id) ?? entry),
    ...cards.filter((card) => !shown.has(card.id)),
  ].toSorted((a, b) => a.createdAt - b.createdAt);
}

/**
 * A click on a question card, carried out inside the container's queue —
 * behind whatever the conversation is running, and never alongside a typed
 * reply's own cleanup of the same cards. The card is deleted and its record
 * cleared there, and the choice continues the conversation; when a typed
 * reply that ran first already settled the card, the click has nothing left
 * to do. A card that could not be deleted stays on record for a later turn.
 */
async function runChoice(client: Client, claim: AskClaim, runtime: Runtime): Promise<void> {
  const choice = await settleChoice(runtime.askCards, claim);
  if (choice === null) return;

  const thread = threadOf(choice.request);
  if (thread !== null && choice.cardDeleted) {
    await runtime.threadSessions.forgetCards(thread, [choice.card.id]);
  }
  await runContinuation(client, choice.request, choice.card, runtime);
}

/**
 * The generation a click on a question card starts: the turn the question
 * interrupted, answered by the chosen option. The card is gone from Discord,
 * so it returns to the history as the bot's turn the choice replies to.
 * Runs inside the per-container queue.
 */
async function runContinuation(
  client: Client,
  request: GenerationRequest,
  card: HistoryMessage,
  runtime: Runtime,
): Promise<void> {
  const channel = await client.channels.fetch(request.channelId).catch(() => undefined);
  if (!channel?.isSendable()) {
    console.log(
      JSON.stringify({
        event: "ask_continuation_channel_unavailable",
        messageId: request.messageId,
      }),
    );
    return;
  }

  const history = markRedoRequests(
    restoreCards(await readTurnHistory(channel, threadOf(request), runtime), [card]),
    request.containerId,
    runtime.retryRequests,
  );
  // Re-evaluate both public channels and admin eligibility in case channel
  // visibility changed while the question card waited.
  const adminProtectedIds = resolveAdminTurnContext(
    channel,
    request.scopeId,
    request.parentChannelId ?? null,
    request.userId,
    runtime.env,
  );
  const current: GenerationRequest = channel.isDMBased()
    ? request
    : {
        ...request,
        publicChannelIds: publicChannelIds(channel.guild),
        ...(adminProtectedIds === null
          ? { adminMode: undefined, adminProtectedChannelIds: undefined }
          : { adminMode: true, adminProtectedChannelIds: adminProtectedIds }),
      };
  logRequest(current);

  await executeGeneration(channel, { ...current, history }, runtime, client);
}

/** Log a generation's shape: ids, kinds, and counts — never content. */
function logRequest(request: GenerationRequest): void {
  console.log(
    JSON.stringify({
      event: "generation_request",
      messageId: request.messageId,
      containerId: request.containerId,
      scopeId: request.scopeId,
      summonKind: request.summonKind,
      historyLen: request.history.length,
      anchors: request.anchorHistory?.length ?? 0,
    }),
  );
}

/**
 * Serialized generation execution: one typing indicator, call the Worker,
 * post the result. Long runs get a staged status placeholder (ADR-003
 * amendment) that the final reply replaces. Runs inside the per-container
 * queue.
 */
async function executeGeneration(
  channel: SendableChannels,
  request: GenerationRequest,
  runtime: Runtime,
  client: Client,
): Promise<void> {
  // Keep typing indicator alive during generation. Discord's typing
  // indicator expires after ~10s; refresh every 8s until done.
  await sendTyping(channel);
  const typingInterval = setInterval(() => void sendTyping(channel), 8000);

  // UI language for this user's notices (staged status, failure texts);
  // chat reply language stays conversation-driven and never comes from here.
  // Bounded wait: a cold/slow settings fetch must never delay the placeholder
  // or the generation call — zh covers the degraded case, and the underlying
  // resolve keeps populating the cache for the next run.
  const language = await resolveUiLanguageBounded(request.userId, runtime.env, 1_000);

  // Staged status placeholder for long generations: posts after ~8s,
  // escalates at coarse milestones, and is replaced by the final reply or
  // failure notice.
  const staged = new StagedStatus(channel, { milestones: stagedMilestones(language) });
  staged.start();

  let currentRequest: GenerationRequest = request;
  const accumulatedReads: DiscordReadResult[] = [];
  let result: GenerationResult | undefined;

  try {
    for (let hop = 0; hop <= MAX_ADMIN_READ_HOPS; hop += 1) {
      result = await generate(currentRequest, runtime.env.workerUrl, runtime.env.internalApiToken);
      if (
        result.status === "completed" &&
        result.discordReadRequests !== undefined &&
        result.discordReadRequests.length > 0 &&
        request.adminMode === true &&
        runtime.env.admin != null
      ) {
        if (hop === MAX_ADMIN_READ_HOPS) {
          console.log(
            JSON.stringify({
              event: "admin_read_hop_limit_reached",
              messageId: request.messageId,
              hops: hop,
            }),
          );
          clearInterval(typingInterval);
          await settleFailure(staged, messages(language).generation.failure, request.messageId);
          return;
        }
        const fetched = await executeDiscordReads(
          client,
          runtime.env.admin,
          result.discordReadRequests,
        );
        accumulatedReads.push(...fetched);
        console.log(
          JSON.stringify({
            event: "admin_reads_executed",
            messageId: request.messageId,
            hop: hop + 1,
            reads: fetched.length,
            ok: fetched.filter((r) => r.ok).length,
          }),
        );
        currentRequest = {
          ...request,
          messageId: `${request.messageId}:ar:${hop + 1}`,
          adminContinuation: true,
          adminReadResults: [...accumulatedReads],
        };
        continue;
      }
      break;
    }
  } catch (error) {
    clearInterval(typingInterval);
    console.log(
      JSON.stringify({
        event: "generation_call_failed",
        messageId: request.messageId,
        error: String(error),
      }),
    );
    await settleFailure(staged, messages(language).generation.failure, request.messageId);
    return;
  }

  clearInterval(typingInterval);
  if (result === undefined) {
    await settleFailure(staged, messages(language).generation.failure, request.messageId);
    return;
  }
  await applyGenerationResult(result, { request, staged, channel, language, runtime });
}

/** Context for posting a result. */
interface PostContext {
  request: GenerationRequest;
  /** Staged placeholder this run owns; settle post or remove it. */
  staged: StagedStatus;
  /** Channel the reply was posted to; cards follow the reply. */
  channel: SendableChannels;
  /** UI language for this user's notices and cards. */
  language: UiLanguage;
  runtime: Runtime;
}

/** Replace the placeholder with a notice, or post it; a failed post is logged, never thrown. */
async function settleFailure(staged: StagedStatus, text: string, messageId: string): Promise<void> {
  await staged.settle(text).catch((error) => {
    console.log(JSON.stringify({ event: "post_reply_error", messageId, error: String(error) }));
  });
}

/** A result that carries a reply. */
type CompletedResult = Extract<GenerationResult, { status: "completed" }>;

/**
 * Post the Worker result (or a fallback message) to the channel, settling the
 * staged status placeholder (if any) with the outcome text. Nothing here logs
 * content in any scope: a reply can echo personal or shared memory, and the
 * Worker's error text can quote a request, so the logs carry lengths,
 * statuses, and codes only.
 */
async function applyGenerationResult(result: GenerationResult, ctx: PostContext): Promise<void> {
  const messageId = ctx.request.messageId;
  console.log(
    JSON.stringify({
      event: "generation_result",
      messageId,
      status: result.status,
    }),
  );

  if (result.status === "completed" && result.threadDeactivated) {
    // The Worker stored the pause; this keeps the Runtime's view in step.
    ctx.runtime.threadSessions.unfollow(ctx.request.channelId);
    console.log(
      JSON.stringify({ event: "thread_unfollowed", messageId, channelId: ctx.request.channelId }),
    );
  }

  // The message that asked for the redo is no prompt of its own: the next
  // retry of the conversation must walk back past it. A continuation's
  // message never shows up in a later history, so it has nothing to mark.
  if (
    result.status === "completed" &&
    result.retriedLastReply &&
    ctx.request.summonKind !== "component"
  ) {
    ctx.runtime.retryRequests.remember(ctx.request.containerId, messageId);
  }

  switch (result.status) {
    case "completed": {
      ctx.runtime.threadSessions.clearSideTalk(ctx.request.channelId);
      if (result.askPrompt !== undefined) {
        await postQuestion(result, ctx);
      } else {
        await postReplyResult(result, ctx);
      }
      await postProposals(result, ctx);
      return;
    }
    case "rejected":
      // duplicate / disabled → silent; budget_exceeded → courteous notice.
      if (result.code === "budget_exceeded") {
        await settleFailure(ctx.staged, messages(ctx.language).generation.rateLimited, messageId);
      } else {
        // Silent rejection still must not leave a stale placeholder.
        await ctx.staged.dismiss();
      }
      console.log(
        JSON.stringify({
          event: "generation_rejected",
          messageId,
          code: result.code,
        }),
      );
      return;
    case "error":
      // The Worker's message is provider text that may quote request
      // content; its code (the error's name) is all the log needs.
      console.log(
        JSON.stringify({
          event: "generation_error",
          messageId,
          code: result.code,
          retryable: result.retryable,
        }),
      );
      await settleFailure(ctx.staged, messages(ctx.language).generation.failure, messageId);
      return;
  }
}

/** Post a completed reply, replacing the staged placeholder with it. */
async function postReplyResult(result: CompletedResult, ctx: PostContext): Promise<void> {
  const messageId = ctx.request.messageId;
  const content = renderReply(result.reply);
  const replyLength = result.reply.length;
  console.log(
    JSON.stringify({
      event: "reply_posting",
      messageId,
      replyLength,
      sources: result.sources.length,
    }),
  );
  if (replyLength === 0 || content === "") {
    console.log(JSON.stringify({ event: "empty_reply", messageId }));
    await settleFailure(ctx.staged, messages(ctx.language).generation.failure, messageId);
    return;
  }

  await ctx.staged.settle(content).then(
    () => {
      console.log(
        JSON.stringify({
          event: "reply_sent",
          messageId,
          length: replyLength,
        }),
      );
    },
    (error: unknown) => {
      console.log(
        JSON.stringify({
          event: "post_reply_error",
          messageId,
          error: String(error),
          replyLength,
        }),
      );
    },
  );
}

/**
 * Post the question a run stopped on as a card with one button per option
 * (ADR-003 amendment): the placeholder gives way to it, and the turn ends
 * there — the user's answer is the next one. In a thread the card is also
 * recorded with the Worker, so it is cleaned up across a restart.
 */
async function postQuestion(result: CompletedResult, ctx: PostContext): Promise<void> {
  const messageId = ctx.request.messageId;
  const prompt = result.askPrompt;
  if (prompt === undefined) return;

  console.log(
    JSON.stringify({
      event: "ask_card_posting",
      messageId,
      promptId: prompt.id,
      options: prompt.options.length,
      replyLength: result.reply.length,
    }),
  );
  await ctx.staged.dismiss();
  const card = await postAskCard(
    ctx.channel,
    { prompt, reply: result.reply, request: ctx.request, language: ctx.language },
    ctx.runtime.askCards,
  );
  const thread = threadOf(ctx.request);
  if (card !== null && thread !== null) {
    await ctx.runtime.threadSessions.recordCard(thread, card.id);
  }
}

/**
 * Guild memory and soul proposals from this generation (ADR-013 amendment):
 * post a 是 / 不是 confirmation card right after the reply. Nothing reaches
 * `guild_memory` or `bot_soul` until the owner clicks 是. Count-only logs —
 * proposal text never reaches the logs (DM posture applies everywhere).
 */
async function postProposals(result: CompletedResult, ctx: PostContext): Promise<void> {
  const messageId = ctx.request.messageId;
  const proposals = result.guildMemoryProposals;
  if (proposals !== undefined && proposals.length > 0) {
    console.log(
      JSON.stringify({
        event: "guild_memory_proposals_posted",
        messageId,
        proposals: proposals.length,
      }),
    );
    await postMemoryConfirmation(
      ctx.channel,
      ctx.request.userId,
      proposals,
      messages(ctx.language).memoryConfirm,
      ctx.runtime.memoryConfirms,
    );
  }
  if (result.soulProposal !== undefined) {
    console.log(
      JSON.stringify({
        event: "soul_proposal_posted",
        messageId,
        proposalId: result.soulProposal.id,
      }),
    );
    await postSoulConfirmation(
      ctx.channel,
      ctx.request.userId,
      result.soulProposal,
      messages(ctx.language).soulConfirm,
      ctx.runtime.soulConfirms,
    );
  }
  if (result.adminActionPlan !== undefined && ctx.runtime.adminConfirms !== undefined) {
    console.log(
      JSON.stringify({
        event: "admin_plan_posted",
        messageId,
        planId: result.adminActionPlan.id,
        operations: result.adminActionPlan.operations.length,
        risk: result.adminActionPlan.risk,
      }),
    );
    await postAdminConfirmation(
      ctx.channel,
      result.adminActionPlan,
      messages(ctx.language).adminConfirm,
      ctx.runtime.adminConfirms,
    );
  }
}

/**
 * interactionCreate entry point for the bot's buttons. Each family has its
 * own registry and handler: the guild memory cards (`xbl:gmem:*`), the soul
 * cards (`xbl:soul:*`), and the question cards (`xbl:ask:*`). A question
 * card's click is carried out inside the conversation's queue, where it
 * deletes the card and carries the chosen option into the next turn.
 *
 * Anything else fails closed with an ephemeral notice and no action: a
 * reply-control button from before those were retired (ADR-015), or a
 * customId this process cannot place.
 */
export async function handleComponentInteraction(
  interaction: MessageComponentInteraction,
  client: Client,
  runtime: Runtime,
): Promise<void> {
  try {
    const { customId } = interaction;
    if (isMemoryConfirmCustomId(customId)) {
      await handleMemoryConfirmInteraction(interaction, runtime.env, runtime.memoryConfirms);
      return;
    }
    if (isSoulConfirmCustomId(customId)) {
      await handleSoulConfirmInteraction(interaction, runtime.env, runtime.soulConfirms);
      return;
    }
    if (isAdminConfirmCustomId(customId)) {
      if (runtime.adminConfirms !== undefined) {
        await handleAdminConfirmInteraction(
          interaction,
          client,
          runtime.env,
          runtime.adminConfirms,
        );
      }
      return;
    }
    if (isAskCustomId(customId)) {
      await handleAskInteraction(interaction, {
        env: runtime.env,
        registry: runtime.askCards,
        // The click joins the conversation's queue: its card is deleted and
        // its continuation runs there, serialized with every typed reply's
        // own cleanup of the same cards.
        confirm: (claim) => {
          const containerId = claim.entry.request.containerId;
          runtime.queue.enqueue(containerId, () => runChoice(client, claim, runtime));
        },
      });
      return;
    }

    console.log(
      JSON.stringify({ event: "component_unhandled", messageId: interaction.message.id }),
    );
    const language = await resolveUiLanguageBounded(interaction.user.id, runtime.env, 1_000);
    await interaction
      .reply({
        content: messages(language).interaction.unknownControl,
        flags: MessageFlags.Ephemeral,
      })
      .catch((error) => {
        console.log(
          JSON.stringify({
            event: "component_refuse_reply_error",
            messageId: interaction.message.id,
            error: String(error),
          }),
        );
      });
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "component_handler_error",
        messageId: interaction.message.id,
        error: String(error),
      }),
    );
  }
}

/** Build the wire `reference` from a reply, if any. */
function buildReference(message: Message): GenerationRequest["reference"] {
  const reference = message.reference;
  if (!reference?.messageId) return null;
  return {
    messageId: reference.messageId,
    channelId: reference.channelId,
    authorId: message.mentions.repliedUser?.id ?? null,
  };
}

/** Map discord.js attachments to the wire `DiscordAttachment` shape. */
function mapAttachments(attachments: Message["attachments"]): DiscordAttachment[] {
  return [...attachments.values()].map((attachment) => ({
    id: attachment.id,
    url: attachment.url,
    contentType: attachment.contentType,
    size: attachment.size,
  }));
}
