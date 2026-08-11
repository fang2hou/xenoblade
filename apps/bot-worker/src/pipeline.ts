import type { Message, Thread } from "chat";
import { streamText } from "ai";

import { GENERATION_LIMITS, composeSystemPrompt, selectModel } from "@xenoblade/ai";
import {
  claimMessage,
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
import { parseDiscordMessageLinks, fetchLinkedMessages } from "./discord-links";
import { renderUrlViaBrowser } from "./browser-render";
import { transcribeAudio } from "./transcribe";

const FAILURE_REPLY = "这次处理失败了，请稍后重试。";
const STOP_REPLY = "好的，我先停止这段对话。";
const STOP_WORDS: Record<string, true> = { stop: true, 结束: true };

export type TriggerParams = {
  kind: InteractionKind;
  isReplyToBot: boolean;
  unsubscribeOnError: boolean;
  claimId?: string;
  forceContext?: boolean;
};

/**
 * Detect a bare mention: a message whose text is ONLY user mentions (e.g.
 * `<@123>` with nothing else). Used as a fallback trigger — the bot reads
 * the user's most recent prior message instead.
 */
export function isBareMention(message: Message): boolean {
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
export async function findLastUserMessage(
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
 * message. Returns true if handled (caller should return), false otherwise.
 */
export async function tryBareMentionFallback(
  env: Env,
  thread: Thread,
  message: Message,
): Promise<boolean> {
  if (!isBareMention(message)) {
    return false;
  }
  try {
    await thread.startTyping();
  } catch {
    /* non-fatal */
  }
  const lastMsg = await findLastUserMessage(thread, message);
  if (!lastMsg) {
    return false;
  }
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

/**
 * Unified AI trigger pipeline shared by all three message entry points.
 */
export async function handleAiTrigger(
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

  // 4. Container ID.
  const containerId = thread.id;

  // 5. User-isolated context state.
  const state = await getUserContextState(env.DB, {
    scopeId,
    containerId,
    userId: message.author.userId,
  });

  // 6. Always force full context.
  const forceContext = true;

  // 7. Budget reservation.
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

  // 8. Start typing indicator.
  await thread.startTyping();

  // 9. Build context decision.
  const contextDecision = await buildContext({
    thread,
    message,
    forceContext,
    resetAt: state.resetAt,
    now,
  });

  // 10. Generation + telemetry.
  const startedAt = now;
  let completionTokens: number | null = null;
  let inputTokens: number | null = null;
  let cacheReadTokens: number | null = null;
  let cacheWriteTokens: number | null = null;

  try {
    let linkedContent;
    const msgLinks = parseDiscordMessageLinks(message.text);
    if (msgLinks.length > 0) {
      linkedContent = await fetchLinkedMessages(msgLinks, env.DISCORD_BOT_TOKEN);
    }

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

    // Fetch web content: search for queries, read URLs from messages.
    let searchContext: string | undefined;
    if (looksLikeSearch(message.text)) {
      searchContext = await searchAndRead(message.text, env);
    }

    // Read non-Discord URLs: Jina Reader first, Browser Rendering fallback.
    let urlContext: string | undefined;
    const webUrls = extractWebUrls(message.text);
    if (webUrls.length > 0) {
      const contents = await Promise.allSettled(
        webUrls.slice(0, 2).map(async (url) => {
          // Tier 2: Jina Reader
          if (env.JINA_API_KEY) {
            const text = await readUrlViaJina(url, env.JINA_API_KEY);
            if (text && text.length > 100) return { url, text };
          }
          // Tier 3: Browser Rendering (JS-heavy pages)
          if (env.BROWSER) {
            const text = await renderUrlViaBrowser(url, env.BROWSER);
            if (text) return { url, text };
          }
          return null;
        }),
      );
      const parts: string[] = [];
      for (const r of contents) {
        if (r.status === "fulfilled" && r.value) {
          parts.push(`## ${r.value.url}\n${r.value.text}`);
        }
      }
      if (parts.length > 0) urlContext = parts.join("\n\n---\n\n");
    }

    // Combine search + URL content into one context block.
    if (urlContext) {
      searchContext = (searchContext ?? "") + "\n\n[URL content]\n" + urlContext;
    }

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
          searchContext,
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
        });

        const text = await result.text;
        await postToConversation(thread, text);

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

export function interactionRow(args: {
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

/** Detect if a message looks like it needs web search. */
function looksLikeSearch(text: string): boolean {
  const lower = text.toLowerCase();
  const keywords = [
    "查一下",
    "搜索",
    "搜一下",
    "最新",
    "新闻",
    "排名",
    "search",
    "google",
    "latest",
    "news",
    "rank",
    "today",
    "2024",
    "2025",
    "2026",
    "什么是",
    "怎么回事",
    "怎么办",
    "为什么",
    "如何",
    "what is",
    "how to",
    "why",
    "who is",
    "when",
  ];
  return keywords.some((k) => lower.includes(k));
}

/** Search: Brave Answers (synthesized) primary, Jina Search (raw content) fallback. */
async function searchAndRead(query: string, env: Env): Promise<string | undefined> {
  const cleanQuery = query
    .replace(/<@!?\d+>/g, "")
    .trim()
    .slice(0, 200);
  if (!cleanQuery) return undefined;

  // 1. Brave Answers — AI-generated grounded answer (OpenAI-compatible endpoint)
  if (env.BRAVE_SEARCH_API_KEY) {
    try {
      const response = await fetch("https://api.search.brave.com/res/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-subscription-token": env.BRAVE_SEARCH_API_KEY,
        },
        body: JSON.stringify({
          stream: false,
          messages: [{ role: "user", content: cleanQuery }],
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) {
        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const answer = data?.choices?.[0]?.message?.content;
        if (answer && answer.trim()) {
          return answer.trim().slice(0, 4000);
        }
      }
    } catch {
      // Brave Answers failed — try Jina
    }
  }

  // 2. Jina Search — raw page content from top results
  if (env.JINA_API_KEY) {
    try {
      const response = await fetch(
        `https://s.jina.ai/?q=${encodeURIComponent(cleanQuery)}&count=3`,
        {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${env.JINA_API_KEY}`,
          },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (response.ok) {
        const data = (await response.json()) as {
          data?: Array<{ title?: string; url?: string; content?: string }>;
        };
        const results = (data?.data ?? []).slice(0, 3);
        if (results.length > 0) {
          return results
            .map(
              (r, i) =>
                `${i + 1}. ${r.title ?? ""}\n   ${r.url ?? ""}\n   ${(r.content ?? "").slice(0, 2000)}`,
            )
            .join("\n\n---\n\n");
        }
      }
    } catch {
      // Both failed
    }
  }

  return undefined;
}

/** Extract non-Discord HTTP(S) URLs from text (max 3). */
function extractWebUrls(text: string): string[] {
  const urls = text.match(
    /https?:\/\/(?!discord\.com|ptb\.discord\.com|canary\.discord\.com)[^\s<>"']+/gi,
  );
  return (urls ?? []).slice(0, 3);
}

/** Read a single URL's content via Jina Reader (r.jina.ai). */
async function readUrlViaJina(url: string, apiKey: string): Promise<string | undefined> {
  try {
    const response = await fetch(`https://r.jina.ai/${url}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return undefined;
    return (await response.text()).slice(0, 3000);
  } catch {
    return undefined;
  }
}

export async function safePost(thread: Thread, text: string): Promise<void> {
  try {
    await postToConversation(thread, text);
  } catch {
    /* best-effort reply */
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

export { FAILURE_REPLY, STOP_REPLY, STOP_WORDS, resolveReplyToBot };
