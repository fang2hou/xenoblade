import { DMChannel, MessageFlags, TextChannel, ThreadChannel } from "discord.js";
import type { Client, Message, MessageComponentInteraction, SendableChannels } from "discord.js";

import type {
  DiscordAttachment,
  GenerationRequest,
  GenerationResult,
  HistoryMessage,
  SummonKind,
  UiLanguage,
} from "@xenoblade/contracts";

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
  continuationRequest,
  dismissPendingCards,
  handleAskInteraction,
  isAskCustomId,
  postAskCard,
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
import { sendTyping } from "./output";
import { StagedStatus } from "./staged-status";
import { generate } from "./ai-client";
import { handleDmMessage } from "./dm-commands";
import { publicChannelIds } from "./history-ingest";
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
  memoryConfirms: MemoryConfirmRegistry;
  soulConfirms: SoulConfirmRegistry;
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
        dispatch(runtime, dmMessage, messageTurn(dmMessage, DM_CHAT), target);
      });
      return;
    }

    const channel = message.channel;
    if (!channel?.isSendable()) return;
    const botId = client.user?.id ?? runtime.env.discordApplicationId;

    if (channel.isThread()) {
      const thread: ThreadRef = { id: channel.id, parentId: channel.parentId };
      const trigger = await evaluateThreadTrigger(message, botId, runtime.env.mentionRoleIds, () =>
        runtime.threadSessions.isFollowed(thread),
      );
      if (trigger.kind === "none") return;
      if (trigger.kind === "summon" && trigger.resume) {
        await runtime.threadSessions.follow(thread, scopeIdFromMessage(message), message.author.id);
      }
      const decision = trigger.kind === "summon" ? trigger.decision : THREAD_CHAT;
      dispatch(runtime, message, messageTurn(message, decision), {
        channel,
        containerId: containerIdFromMessage(message),
        channelId: channel.id,
        thread,
      });
      return;
    }

    const decision = await evaluateTrigger(message, botId, runtime.env.mentionRoleIds);
    if (decision === null) return;
    const turn = messageTurn(message, decision);

    // A thread the bot may not start is no reason not to answer: the summon
    // then runs in the channel, like a reply to the bot.
    const started = startsThread(decision.kind, channel)
      ? await startSummonThread(message, turn, runtime)
      : null;
    dispatch(runtime, message, turn, started ?? channelTarget(message, channel));
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

/** Log a trigger and queue its generation behind whatever the container is running. */
function dispatch(runtime: Runtime, message: Message, turn: Turn, target: Target): void {
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
  runtime.queue.enqueue(target.containerId, () => runGeneration(message, turn, target, runtime));
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

  const parentId = started.thread.parentId ?? message.channelId;
  const thread: ThreadRef = { id: started.thread.id, parentId };
  const scopeId = scopeIdFromMessage(message);
  await runtime.threadSessions.follow(thread, scopeId, message.author.id);

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

/**
 * Serialized generation for one turn: read the history the model will see,
 * build the request, and hand off to {@link executeGeneration}. Runs inside
 * the per-container queue.
 */
async function runGeneration(
  message: Message,
  turn: Turn,
  target: Target,
  runtime: Runtime,
): Promise<void> {
  const history = await readTurnHistory(target.channel, target.thread, runtime);
  const publicIds = publicChannelIds(message.guild);
  const request: GenerationRequest = {
    messageId: turn.messageId,
    containerId: target.containerId,
    scopeId: scopeIdFromMessage(message),
    channelId: target.channelId,
    parentChannelId: target.thread?.parentId ?? null,
    ...(publicIds === undefined ? {} : { publicChannelIds: publicIds }),
    userId: message.author.id,
    userDisplayName:
      message.member?.displayName || message.author.displayName || message.author.username,
    summonKind: turn.kind,
    content: turn.content,
    history,
    ...(target.anchorHistory === undefined ? {} : { anchorHistory: target.anchorHistory }),
    reference: turn.reference,
    attachments: turn.attachments,
  };
  logRequest(request);

  await executeGeneration(target.channel, request, runtime);
}

/**
 * The history a turn's model will see. Every question card still waiting in
 * the conversation is deleted from Discord first — the user moved on without
 * clicking — and put back as the bot's own turn, so the reply can still read
 * the question it answers.
 */
async function readTurnHistory(
  channel: SendableChannels,
  thread: ThreadRef | null,
  runtime: Runtime,
): Promise<HistoryMessage[]> {
  const history = await fetchTurnHistory(channel);
  const readable = toReadable(channel);
  if (readable === undefined) return history;

  const recorded = thread === null ? [] : await runtime.threadSessions.pendingCardIds(thread);
  const cards = await dismissPendingCards(readable, runtime.askCards, recorded);
  if (thread !== null && recorded.length > 0) await runtime.threadSessions.forgetCards(thread);
  return restoreCards(history, cards);
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

  const history = restoreCards(await readTurnHistory(channel, threadOf(request), runtime), [card]);
  // Which channels are public is read again: the request is as old as the
  // question, and a channel made private since stays unread.
  const current: GenerationRequest = channel.isDMBased()
    ? request
    : { ...request, publicChannelIds: publicChannelIds(channel.guild) };
  logRequest(current);

  await executeGeneration(channel, { ...current, history }, runtime);
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

  let result: GenerationResult;
  try {
    result = await generate(request, runtime.env.workerUrl, runtime.env.internalApiToken);
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

  switch (result.status) {
    case "completed": {
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
}

/**
 * interactionCreate entry point for the bot's buttons. Each family has its
 * own registry and handler: the guild memory cards (`xbl:gmem:*`), the soul
 * cards (`xbl:soul:*`), and the question cards (`xbl:ask:*`). A question
 * card's click deletes the card and carries the chosen option into the next
 * turn of the same conversation.
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
    if (isAskCustomId(customId)) {
      await handleAskInteraction(interaction, {
        env: runtime.env,
        registry: runtime.askCards,
        choose: async (choice) => {
          const request = continuationRequest(choice);
          const thread = threadOf(request);
          // The card is gone from Discord; its record goes too, ahead of the
          // continuation that may post the next one.
          if (thread !== null) await runtime.threadSessions.forgetCards(thread);
          runtime.queue.enqueue(request.containerId, () =>
            runContinuation(client, request, choice.card, runtime),
          );
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
