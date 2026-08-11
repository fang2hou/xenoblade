import { Chat } from "chat";
import { createDiscordAdapter } from "@chat-adapter/discord";
import { isStepCount, streamText } from "ai";
import { createCloudflareState } from "chat-state-cloudflare-do";
import type { Message, Thread } from "chat";
// DO bindings are generated as generic DurableObjectNamespace; the adapter needs
// the RPC-typed class, so cast at the call site.
import type { ChatStateDO } from "chat-state-cloudflare-do";

import { GENERATION_LIMITS, composeSystemPrompt, selectModel } from "@xenoblade/ai";
import {
  claimMessage,
  clearUserContext,
  finishGeneration,
  GenerationBudgetExceededError,
  getRuntimeConfig,
  getUserContextState,
  markUserInteraction,
  recordInteraction,
  reserveGeneration,
  type InteractionKind,
} from "@xenoblade/db";
import {
  getChannelIdFromDiscordMessage,
  getScopeIdFromDiscordMessage,
  resolveReplyToBot,
} from "./scope";
import { fetchRecentMessages, type HistoryThread } from "./history";
import { buildContext, postToConversation } from "./context";
import { SAFETY_SYSTEM, buildGenerationMessages } from "./prompt";

import { createSearchTools } from "./tools";
import { parseDiscordMessageLinks, fetchLinkedMessages } from "./discord-links";
import { transcribeAudio } from "./transcribe";
import { handleGatewayRequest, notFound } from "./gateway-routes";

// Re-export the Durable Object classes so Wrangler can instantiate them.
export { ChatStateDO } from "chat-state-cloudflare-do";
export { XenobladeGatewayDO } from "./gateway-do";

const FAILURE_REPLY = "这次处理失败了，请稍后重试。";
const CLEAR_SUCCESS_REPLY = "好的，已清除你在此频道的对话上下文。";
const CLEAR_FAILURE_REPLY = "清除上下文失败，请稍后重试。";
const STOP_REPLY = "好的，我先停止这段对话。";
const STOP_WORDS: Record<string, true> = { stop: true, 结束: true };

type TriggerParams = {
  kind: InteractionKind;
  isReplyToBot: boolean;
  /** Legacy subscribed path unsubscribes on failure; new paths never do. */
  unsubscribeOnError: boolean;
  claimId?: string;
  /** Force full conversation context regardless of TTL/thread/reply state. */
  forceContext?: boolean;
};

/**
 * Detect a bare mention: a message whose text is ONLY user mentions (e.g.
 * `<@123>` with nothing else). Used as a fallback trigger — the bot reads
 * the user's most recent prior message instead.
 */
function isBareMention(message: Message): boolean {
  if (!/<@!?\d+>/.test(message.text)) {
    return false;
  }
  const stripped = message.text
    .replace(/<@!?\d+>/g, "")
    .replace(/<@&\d+>/g, "")
    .replace(/<#\d+>/g, "")
    .trim();
  return stripped.length === 0;
}

/**
 * Find the user's most recent message in the same container, excluding the
 * current message. Returns null on fetch failure or when no prior message
 * from the same user exists.
 */
async function findLastUserMessage(
  thread: Thread,
  currentMessage: Message,
): Promise<Message | null> {
  try {
    const messages = await fetchRecentMessages(thread as unknown as HistoryThread, 20);
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (
        msg.id !== currentMessage.id &&
        msg.author.userId === currentMessage.author.userId &&
        !msg.author.isMe
      ) {
        return msg;
      }
    }
  } catch {
    // fetch failed — no fallback
  }
  return null;
}

/**
 * Handle a bare mention by falling back to the user's most recent prior
 * message. Returns true if handled (caller should return), false otherwise
 * (caller should continue with normal handling).
 */
async function tryBareMentionFallback(
  env: Env,
  thread: Thread,
  message: Message,
): Promise<boolean> {
  if (!isBareMention(message)) {
    return false;
  }
  // Show typing immediately — the lookup and processing take time.
  try {
    await thread.startTyping();
  } catch {
    /* non-fatal */
  }
  const lastMsg = await findLastUserMessage(thread, message);
  if (!lastMsg) {
    return false;
  }
  // History messages from fetchMessages may lack Discord raw payload
  // fields (guild_id, channel_id). Copy from the current message since
  // they share the same container.
  if (
    !lastMsg.raw ||
    typeof lastMsg.raw !== "object" ||
    !("guild_id" in (lastMsg.raw as Record<string, unknown>))
  ) {
    lastMsg.raw = message.raw;
  }
  console.log(
    JSON.stringify({
      event: "bare_mention",
      originalMsgId: message.id,
      fallbackMsgId: lastMsg.id,
      fallbackText: lastMsg.text.slice(0, 80),
      hasAttachments: (lastMsg.attachments ?? []).length,
    }),
  );
  await handleAiTrigger(env, thread, lastMsg, {
    kind: "mention",
    isReplyToBot: false,
    unsubscribeOnError: false,
    claimId: `bare:${message.id}`,
    forceContext: true,
  });
  return true;
}

function createBot(env: Env): Chat {
  const bot = new Chat({
    userName: "Xenoblade",
    adapters: {
      discord: createDiscordAdapter({
        botToken: env.DISCORD_BOT_TOKEN,
        publicKey: env.DISCORD_PUBLIC_KEY,
        applicationId: env.DISCORD_APPLICATION_ID,
        // Keep mentions in their original channel instead of auto-creating
        // a Discord thread. The adapter patch gates both forwarded-message
        // and gateway-message mention branches on this flag.
        createThreadsForMentions: false,
      }),
    },
    state: createCloudflareState({
      namespace: env.CHAT_STATE as DurableObjectNamespace<ChatStateDO>,
    }),
    concurrency: {
      strategy: "queue",
      maxQueueSize: 10,
      queueEntryTtlMs: 90_000,
      onQueueFull: "drop-oldest",
    },
  });
  registerHandlers(bot, env);
  return bot;
}

function registerHandlers(bot: Chat, env: Env): void {
  // --- Slash commands ---

  bot.onSlashCommand(["/status"], async (event) => {
    await event.channel.post("Xenoblade Gateway MVP OK");
  });

  bot.onSlashCommand(["/clear-context"], async (event) => {
    const containerId = event.channel.id;
    const userId = event.user.userId;
    const parts = containerId.split(":");
    const scopeId = parts[1] === "@me" ? "dm" : (parts[1] ?? "dm");

    const ok = await clearUserContext(env.DB, {
      scopeId,
      containerId,
      userId,
      now: Date.now(),
    });
    await event.channel.post(ok ? CLEAR_SUCCESS_REPLY : CLEAR_FAILURE_REPLY);
  });

  // --- Message triggers ---

  bot.onNewMention(async (thread, message) => {
    console.log(
      JSON.stringify({
        event: "handler",
        type: "onNewMention",
        messageId: message.id,
        isMention: message.isMention,
        textLen: message.text.length,
      }),
    );
    if (await tryBareMentionFallback(env, thread, message)) return;

    const isReply = await resolveReplyToBot(
      message,
      env.DISCORD_APPLICATION_ID,
      env.DISCORD_BOT_TOKEN,
    );
    await handleAiTrigger(env, thread, message, {
      kind: "mention",
      isReplyToBot: isReply,
      unsubscribeOnError: false,
    });
  });

  bot.onNewMessage(/[\s\S]+/, async (thread, message) => {
    console.log(
      JSON.stringify({
        event: "handler",
        type: "onNewMessage",
        messageId: message.id,
        isMention: message.isMention,
        isMe: message.author.isMe,
        textLen: message.text.length,
      }),
    );
    if (message.author.isMe) {
      return;
    }
    if (await tryBareMentionFallback(env, thread, message)) return;

    const isMention = message.isMention === true;
    const isReply = await resolveReplyToBot(
      message,
      env.DISCORD_APPLICATION_ID,
      env.DISCORD_BOT_TOKEN,
    );
    if (!isMention && !isReply) {
      return;
    }
    await handleAiTrigger(env, thread, message, {
      kind: "mention",
      isReplyToBot: isReply,
      unsubscribeOnError: false,
    });
  });

  // Legacy compatibility: threads subscribed by a prior deployment still
  // deliver messages here. Keep the stop/结束 behavior, route qualifying
  // messages through the same pipeline, but never create new subscriptions.
  bot.onSubscribedMessage(async (thread, message, context) => {
    console.log(
      JSON.stringify({
        event: "handler",
        type: "onSubscribedMessage",
        messageId: message.id,
        isMention: message.isMention,
        isMe: message.author.isMe,
        textLen: message.text.length,
      }),
    );
    if (message.author.isMe) {
      return;
    }

    const queued = [...(context?.skipped ?? []), message];
    const wantsStop = queued.some(
      (m) => !m.author.isMe && STOP_WORDS[m.text.trim().toLowerCase()] === true,
    );
    if (wantsStop) {
      await safeUnsubscribe(thread);
      await safePost(thread, STOP_REPLY);
      return;
    }
    if (await tryBareMentionFallback(env, thread, message)) return;

    const isMention = message.isMention === true;
    const isReply = await resolveReplyToBot(
      message,
      env.DISCORD_APPLICATION_ID,
      env.DISCORD_BOT_TOKEN,
    );
    if (!isMention && !isReply) {
      return;
    }

    await handleAiTrigger(env, thread, message, {
      kind: "subscribed",
      isReplyToBot: isReply,
      unsubscribeOnError: true,
    });
  });
}

/**
 * Unified AI trigger pipeline shared by all three message entry points.
 *
 * claim → scope/channel/runtime gate → user context state → one-shot directive
 * → forceContext decision → budget → typing → context build → generation
 * → post → usage/telemetry → markUserInteraction.
 */
async function handleAiTrigger(
  env: Env,
  thread: Thread,
  message: Message,
  params: TriggerParams,
): Promise<void> {
  const { kind, unsubscribeOnError } = params;
  const now = Date.now();

  // 1. De-duplicate delivery.
  const claimKey = params.claimId ?? message.id;
  if (!(await claimMessage(env.DB, claimKey, now))) {
    console.log(JSON.stringify({ event: "duplicate", messageId: claimKey }));
    return;
  }

  // 2. Resolve scope and Discord channel.
  let scopeId: string;
  let channelId: string;
  try {
    scopeId = getScopeIdFromDiscordMessage(message);
    channelId = getChannelIdFromDiscordMessage(message);
  } catch {
    console.log(JSON.stringify({ event: "scope_unresolved", messageId: message.id }));
    return;
  }

  // 3. Runtime configuration (fail-closed).
  const runtime = await getRuntimeConfig(env.DB, scopeId, channelId);
  if (!runtime.enabled || !runtime.channelAllowed) {
    console.log(
      JSON.stringify({
        event: "runtime_disabled",
        scopeId,
        channelId,
        enabled: runtime.enabled,
        allowed: runtime.channelAllowed,
      }),
    );
    return;
  }

  // 4. Container ID: real threads use their four-segment ID; channels/DMs use
  //    their three-segment ID (same as thread.id in both cases).
  const containerId = thread.id;

  // 5. User-isolated context state (fail-closed → current-message-only).
  const state = await getUserContextState(env.DB, {
    scopeId,
    containerId,
    userId: message.author.userId,
  });

  // 6. Always force full context — every mention/reply is an intentional
  //    request. The LLM decides whether to use the history (system prompt
  //    guides it to ignore context when the user asks for a fresh answer).
  const forceContext = true;

  // 7. Budget reservation (before any AI call).
  let reservationId: number;
  try {
    reservationId = (await reserveGeneration(env.DB, containerId, now)).reservationId;
  } catch (error) {
    if (error instanceof GenerationBudgetExceededError) {
      console.log(JSON.stringify({ event: "budget_exceeded", containerId }));
    }
    await safePost(thread, FAILURE_REPLY);
    return;
  }

  // 9. Start typing indicator.
  await thread.startTyping();

  // 10. Build context decision.
  const contextDecision = await buildContext({
    thread,
    message,
    forceContext,
    resetAt: state.resetAt,
    now,
  });

  // 11. Generation + telemetry.
  const startedAt = now;
  let completionTokens: number | null = null;
  let inputTokens: number | null = null;
  let cacheReadTokens: number | null = null;
  let cacheWriteTokens: number | null = null;

  try {
    // Fetch linked Discord messages' content (text + images) before generation.
    let linkedContent;
    const msgLinks = parseDiscordMessageLinks(message.text);
    if (msgLinks.length > 0) {
      linkedContent = await fetchLinkedMessages(msgLinks, env.DISCORD_BOT_TOKEN);
      console.log(
        JSON.stringify({
          event: "linked_msg_debug",
          links: msgLinks.length,
          linkedContents: linkedContent.length,
          linkedImages: linkedContent.reduce((n, c) => n + c.images.length, 0),
          msgTextLen: message.text.length,
          msgTextSnippet: message.text.slice(0, 120),
        }),
      );
    }

    // Transcribe audio attachments (voice messages) to text.
    let audioTranscription: string | undefined;
    const audioAttachments = (message.attachments ?? []).filter((a) => a.type === "audio" && a.url);
    if (audioAttachments.length > 0) {
      const transcriptions: string[] = [];
      for (const att of audioAttachments.slice(0, 2)) {
        const text = await transcribeAudio(att.url!, env.OPENROUTER_API_KEY);
        if (text) transcriptions.push(text);
      }
      if (transcriptions.length > 0) {
        audioTranscription = transcriptions.join("\n");
      }
    }

    const searchTools = createSearchTools(env.BRAVE_SEARCH_API_KEY);

    // Generation with retry (max 3 attempts, exponential backoff).
    let genUsage: {
      completionTokens: number | null;
      inputTokens: number | null;
      cacheReadTokens: number | null;
      cacheWriteTokens: number | null;
    } | null = null;
    let lastError: unknown;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const aiMessages = await buildGenerationMessages(
          contextDecision,
          message,
          linkedContent,
          audioTranscription,
        );

        const result = streamText({
          model: selectModel(env, { sessionId: `xenoblade:${containerId}` }),
          system: composeSystemPrompt({
            safety: SAFETY_SYSTEM,
            base: runtime.defaultSystemPrompt,
          }),
          messages: aiMessages,
          maxOutputTokens: GENERATION_LIMITS.maxOutputTokens,
          timeout: GENERATION_LIMITS.timeout,
          ...(searchTools ? { tools: searchTools, stopWhen: isStepCount(3) } : {}),
        });

        const text = await result.text;
        await postToConversation(thread, text);

        // Extract usage (best-effort).
        try {
          const usage = await result.usage;
          completionTokens = usage.outputTokens ?? null;
          inputTokens = usage.inputTokens ?? null;
          const details = usage.inputTokenDetails;
          cacheReadTokens = details?.cacheReadTokens ?? null;
          cacheWriteTokens = details?.cacheWriteTokens ?? null;
        } catch {
          // Provider did not report usage.
        }

        genUsage = { completionTokens, inputTokens, cacheReadTokens, cacheWriteTokens };
        break;
      } catch (error) {
        lastError = error;
        console.log(
          JSON.stringify({
            event: "gen_error",
            attempt,
            messageId: message.id,
            containerId,
            error: String(error),
            errorCode: error instanceof Error ? error.name : "UNKNOWN",
          }),
        );
        if (attempt < 3) {
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, 1000 * attempt);
          await promise;
        }
      }
    }

    if (!genUsage) {
      throw lastError;
    }

    if (cacheReadTokens !== null || cacheWriteTokens !== null) {
      console.log(
        JSON.stringify({
          event: "cache_usage",
          containerId,
          inputTokens,
          cacheReadTokens,
          cacheWriteTokens,
        }),
      );
    }

    await finishGeneration(env.DB, reservationId, completionTokens);
    await safeRecord(
      env.DB,
      interactionRow({
        message,
        containerId,
        scopeId,
        kind,
        env,
        startedAt,
        status: "success",
        completionTokens,
        inputTokens,
        cacheReadTokens,
        cacheWriteTokens,
      }),
    );

    // Mark interaction (non-fatal).
    try {
      await markUserInteraction(env.DB, {
        scopeId,
        containerId,
        userId: message.author.userId,
        now: Date.now(),
      });
    } catch {
      // telemetry failure is non-fatal
    }
  } catch (error) {
    const errorCode = error instanceof Error ? error.name : "UNKNOWN";
    console.log(
      JSON.stringify({
        event: "generation_failed",
        messageId: message.id,
        containerId,
        error: String(error),
        errorCode,
      }),
    );
    await safeFinish(env.DB, reservationId);
    await safeRecord(
      env.DB,
      interactionRow({
        message,
        containerId,
        scopeId,
        kind,
        env,
        startedAt,
        status: "error",
        errorCode,
      }),
    );
    if (unsubscribeOnError) {
      await safeUnsubscribe(thread);
    }
    await safePost(thread, FAILURE_REPLY);
  }
}

function interactionRow(args: {
  message: Message;
  containerId: string;
  scopeId: string;
  kind: InteractionKind;
  env: Env;
  startedAt: number;
  status: "success" | "error";
  completionTokens?: number | null;
  inputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  errorCode?: string | null;
}) {
  return {
    messageId: args.message.id,
    threadId: args.containerId,
    userId: args.message.author.userId,
    scopeId: args.scopeId,
    kind: args.kind,
    provider: args.env.AI_PROVIDER,
    model: args.env.AI_MODEL,
    status: args.status,
    requestedOutputTokens: GENERATION_LIMITS.maxOutputTokens,
    completionTokens: args.completionTokens ?? null,
    costMicros: null,
    latencyMs: Date.now() - args.startedAt,
    errorCode: args.errorCode ?? null,
    createdAt: Date.now(),
    inputTokens: args.inputTokens ?? null,
    cacheReadTokens: args.cacheReadTokens ?? null,
    cacheWriteTokens: args.cacheWriteTokens ?? null,
  } as const;
}

async function safePost(thread: Thread, text: string): Promise<void> {
  try {
    await postToConversation(thread, text);
  } catch {
    /* best-effort reply; never mask the original failure */
  }
}

async function safeUnsubscribe(thread: Thread): Promise<void> {
  try {
    await thread.unsubscribe();
  } catch {
    /* cleanup failure is non-fatal */
  }
}

async function safeFinish(db: Env["DB"], reservationId: number): Promise<void> {
  try {
    await finishGeneration(db, reservationId, null);
  } catch {
    /* telemetry must not mask the original error */
  }
}

async function safeRecord(
  db: Env["DB"],
  row: Parameters<typeof recordInteraction>[1],
): Promise<void> {
  try {
    await recordInteraction(db, row);
  } catch {
    /* structured telemetry failure only */
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    console.log(
      JSON.stringify({
        event: "fetch",
        method: request.method,
        path: new URL(request.url).pathname,
      }),
    );
    const gatewayResponse = await handleGatewayRequest(request, env);
    if (gatewayResponse !== null) {
      return gatewayResponse;
    }

    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/webhooks/discord") {
      const bot = createBot(env);
      return bot.webhooks.discord(request, {
        waitUntil: (task: Promise<unknown>) => ctx.waitUntil(task),
      });
    }

    return notFound();
  },
};
