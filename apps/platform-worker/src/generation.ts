import { APICallError, generateText, isStepCount, type ModelMessage, type ToolSet } from "ai";

import { composeSystemPrompt, createModel, GENERATION_LIMITS, getModelChain } from "@xenoblade/ai";
import type {
  AdminActionPlan,
  GenerationRequest,
  GenerationResult,
  GenerationUsage,
  GuildMemory,
  UserMemory,
} from "@xenoblade/contracts";

import {
  ADMIN_PLAN_TTL_MS,
  createAdminPlan,
  getAdminConfig,
  hashAdminPlanPayload,
  isAdminSession,
} from "./admin-plans";

import {
  claimMessage,
  claimRegenerate,
  releaseRegenerate,
  DM_SCOPE,
  finishGeneration,
  GenerationBudgetExceededError,
  getGuildMemory,
  getRecentSources,
  getRuntimeConfig,
  getUserContextState,
  getUserMemory,
  markUserInteraction,
  recordInteraction,
  recordInteractionSources,
  recordToolInvocation,
  reserveGeneration,
  type InteractionRecord,
} from "./db";
import { buildContext } from "./context";
import { extractGuildMemoryProposals } from "./memory";
import { extractSources } from "./sources";
import { extractSoulProposal, formatSoulSegment, getBotSoul } from "./soul";
import { recordLastReply, recordLastTurn } from "./thread-sessions";
import {
  ADMIN_GUIDANCE,
  buildGenerationMessages,
  buildTextOnlyGenerationMessages,
  formatAdminReadResultsBlock,
  MEMORY_GUIDANCE,
  SAFETY_SYSTEM,
  formatSourcesBlock,
} from "./prompt";
import {
  closeMcpClients,
  connectMcpServers,
  createFirstPartyTools,
  extractAdminOperations,
  extractAskPrompt,
  extractDiscordReadRequests,
  hasRetry,
  hasThreadPause,
  pauseThread,
  stoppedOnAskUser,
  stoppedOnDiscordRead,
} from "./tools";

function formatMemoryBlock(displayName: string, memories: readonly UserMemory[]): string {
  if (memories.length === 0) return "";
  const lines = memories.map((m) => `- ${m.key}: ${m.value}`);
  return [
    `What you already know about ${displayName} (weave in naturally; never list or cite this):`,
    ...lines,
  ].join("\n");
}

function formatGuildMemoryBlock(memories: readonly GuildMemory[]): string {
  if (memories.length === 0) return "";
  const lines = memories.map((m) => `- ${m.key}: ${m.value}`);
  return [
    "What this server asked you to remember (shared knowledge for everyone here; weave in naturally; never list or cite this):",
    ...lines,
  ].join("\n");
}

async function safeFinish(db: D1Database, reservationId: number): Promise<void> {
  try {
    await finishGeneration(db, reservationId, Date.now());
  } catch (error) {
    console.log(JSON.stringify({ event: "finish_error", error: String(error) }));
  }
}

async function safeRecord(db: D1Database, row: InteractionRecord): Promise<void> {
  try {
    await recordInteraction(db, row);
  } catch (error) {
    console.log(JSON.stringify({ event: "record_interaction_error", error: String(error) }));
  }
}

/** Store what `retry_last_reply` reads next; a failed write only costs the next retry its stored turn. */
async function safeRecordTurn(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    console.log(JSON.stringify({ event: "last_turn_record_error", error: String(error) }));
  }
}

/**
 * Store a run's `thread_pause` and report whether it took. A failed write
 * leaves the thread followed, and the result then says nothing about a pause
 * — the Runtime's view stays in step with the stored one.
 */
async function safePauseThread(env: Env, req: GenerationRequest): Promise<boolean> {
  try {
    return await pauseThread(env.DB, req, Date.now());
  } catch (error) {
    console.log(JSON.stringify({ event: "thread_pause_error", error: String(error) }));
    return false;
  }
}

function isRetryable(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes("rate-limited") || msg.includes("rate_limit") || msg.includes("429");
}

/**
 * Wall-clock budget for the whole model chain, from the request's arrival.
 * It sits under the Runtime's 150s request timeout (`GENERATION_TIMEOUT_MS`
 * in discord-runtime), so the Worker answers with a structured result — even
 * when every model of the chain hangs — before the Runtime gives up on the
 * call.
 */
const CHAIN_DEADLINE_MS = 135_000;

/**
 * Smallest budget still worth handing to a model attempt. With less of the
 * chain's budget left, the chain gives up instead of starting a call that
 * cannot finish in time.
 */
const MIN_ATTEMPT_MS = 5_000;

/**
 * Most model steps (rounds of tool calls) one attempt may take. The last one
 * forbids further tool calls with `toolChoice: "none"` and a synthesis notice
 * (see `prepareStep` below), so a run that spends every earlier step on tool
 * calls still ends with a clean text reply.
 */
const MAX_STEPS = 12;

/**
 * Appended on the last step and on DSML-leak rescue calls so the model knows
 * its tool budget is spent and writes the final answer directly. Keeping
 * `tools` intact while setting `toolChoice: "none"` ensures OpenRouter sends
 * `tool_choice: "none"` (dropping `tools` via `activeTools: []` omits
 * `tool_choice`, invalidates the prompt cache, and causes DeepSeek models to
 * emit raw DSML markup as plain text).
 */
const FINAL_STEP_SYNTHESIS_NOTICE =
  "[Tool call limit reached. Do not call any more tools or output tool-call markup. " +
  "Answer the user now using only the information already gathered, and note briefly if anything could not be verified.]";

/**
 * Matches raw DeepSeek DSML tool-call markup leaked into assistant text when
 * an upstream provider fails to parse a tool call — both canonical single-bar
 * fullwidth `<｜DSML｜function_calls>` (U+FF5C) and degraded double/ASCII forms
 * such as `<｜｜DSML｜｜ calls>` or `<||DSML||invoke ...>`.
 */
const LEAKED_TOOL_MARKUP_RE =
  /<\/?[｜|]+\s*DSML\s*[｜|]+\s*(?:function_calls|calls|invoke|parameter)\b/i;

export function containsLeakedToolMarkup(text: string): boolean {
  return LEAKED_TOOL_MARKUP_RE.test(text);
}

/**
 * Thrown when the model chain runs out of {@link CHAIN_DEADLINE_MS} before a
 * result arrives. Carries a stable code for telemetry.
 */
class GenerationDeadlineError extends Error {
  readonly code = "AI_GENERATION_DEADLINE";
  constructor() {
    super("Model chain exceeded its time budget");
    this.name = "GenerationDeadlineError";
  }
}

/**
 * Settle with `attempt`, or reject with {@link GenerationDeadlineError} once
 * `ms` has passed — whatever the attempt is still waiting on. An attempt's
 * own timeout does not bound a tool that ignores its abort signal.
 */
async function withDeadline<T>(attempt: Promise<T>, ms: number): Promise<T> {
  const { promise, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => reject(new GenerationDeadlineError()), ms);
  try {
    return await Promise.race([attempt, promise]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Did the run stop because it ran out of time — the chain's deadline, or the
 * attempt's own timeout (the SDK aborts with an error named `TimeoutError`)?
 */
function isTimeout(error: unknown): boolean {
  if (error instanceof GenerationDeadlineError) return true;
  return (
    (error instanceof Error || error instanceof DOMException) &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * Attribute a tool call to its MCP server, or `"builtin"` for a first-party
 * tool. MCP tools are registered as `<server>_<tool>` (see
 * `connectMcpServers`), and a first-party name such as `web_search` must not
 * be read as a call to a server named `web`.
 */
function toolServer(toolName: string, firstPartyTools: ToolSet): string {
  if (Object.hasOwn(firstPartyTools, toolName)) return "builtin";
  return toolName.split("_")[0] ?? "builtin";
}

export async function generate(
  env: Env,
  req: GenerationRequest,
  ctx?: ExecutionContext,
): Promise<GenerationResult> {
  const now = Date.now();
  const requestId = crypto.randomUUID();

  // Dedup by the message id. A request carrying `regenerateOf` — dormant
  // since ADR-015 was superseded: no Runtime sends it — claims a short-lived
  // lease on the original message instead, so racing duplicate deliveries are
  // rejected while sequential re-runs stay allowed; the rolling budget below
  // remains the real bound on totals.
  let isRegenerate = false;
  try {
    const claimed =
      req.regenerateOf !== undefined
        ? await claimRegenerate(env.DB, req.regenerateOf, now)
        : await claimMessage(env.DB, req.messageId, now);
    if (!claimed) {
      return { status: "rejected", requestId, code: "duplicate" };
    }
    isRegenerate = req.regenerateOf !== undefined;
  } catch (error) {
    return {
      status: "error",
      requestId,
      code: "claim_failed",
      message: String(error),
      retryable: true,
    };
  }

  if (!isRegenerate) return runGenerationPipeline(env, req, requestId, now, ctx);
  // Release the lease whatever the outcome — the next deliberate re-run
  // must not wait out the TTL. A failed release self-heals at expiry.
  try {
    return await runGenerationPipeline(env, req, requestId, now, ctx);
  } finally {
    const originalMessageId = req.regenerateOf;
    if (originalMessageId !== undefined) {
      try {
        await releaseRegenerate(env.DB, originalMessageId);
      } catch (error) {
        console.log(
          JSON.stringify({
            event: "regen_lease_release_error",
            messageId: originalMessageId,
            error: String(error),
          }),
        );
      }
    }
  }
}

async function runGenerationPipeline(
  env: Env,
  req: GenerationRequest,
  requestId: string,
  now: number,
  ctx: ExecutionContext | undefined,
): Promise<GenerationResult> {
  // Runtime gate
  const runtime = await getRuntimeConfig(env.DB, req.scopeId, req.channelId, req.parentChannelId);
  if (!runtime.enabled || !runtime.channelAllowed) {
    return { status: "rejected", requestId, code: "disabled" };
  }

  const adminSession = isAdminSession(env, req);

  // Budget (continuation hops of an admin read-proxy turn already reserved on hop 0).
  let reservationId: number | null = null;
  if (!(adminSession && req.adminContinuation === true)) {
    try {
      reservationId = (await reserveGeneration(env.DB, req.containerId, now)).reservationId;
    } catch (error) {
      if (error instanceof GenerationBudgetExceededError) {
        return { status: "rejected", requestId, code: "budget_exceeded" };
      }
      return {
        status: "error",
        requestId,
        code: "reserve_failed",
        message: String(error),
        retryable: true,
      };
    }
  }

  // Context + prompt
  const state = await getUserContextState(env.DB, {
    scopeId: req.scopeId,
    containerId: req.containerId,
    userId: req.userId,
  });
  const contextDecision = buildContext(req, state.resetAt);

  let persona: string | undefined;
  try {
    const memories = await getUserMemory(env.DB, req.userId);
    persona = formatMemoryBlock(req.userDisplayName, memories);
  } catch (error) {
    console.log(JSON.stringify({ event: "memory_read_error", error: String(error) }));
  }
  // In owner-only admin sessions, skip guild-writable `bot_soul` and
  // `guild_memory` so ordinary members in public channels cannot inject
  // instructions into the admin system prompt.
  const soulSegment = adminSession
    ? ADMIN_GUIDANCE
    : formatSoulSegment((await getBotSoul(env.DB, req.scopeId)).content);
  const guildMemory =
    adminSession || req.scopeId === DM_SCOPE ? [] : await getGuildMemory(env.DB, req.scopeId);
  const system = composeSystemPrompt({
    safety: SAFETY_SYSTEM,
    base: MEMORY_GUIDANCE,
    soul: soulSegment,
    guildMemory: formatGuildMemoryBlock(guildMemory),
    persona,
    now: new Date(now),
  });

  // Reference block of sources cited in earlier replies of this container, plus
  // any Runtime-proxied live Discord read results on admin continuation hops.
  const sourcesBlock =
    formatSourcesBlock(await getRecentSources(env.DB, { containerId: req.containerId, now })) +
    (adminSession ? formatAdminReadResultsBlock(req.adminReadResults ?? []) : "");

  // Tools — ALL models get ALL tools (MCP + first-party + vision); the soul,
  // memory, and history tools act on this request's user, scope, and channel
  const firstPartyTools = createFirstPartyTools(env, req, state.resetAt);
  // The route tests pass a bare object as the context, so waitUntil is not assumed here.
  const mcpResult = await connectMcpServers(env, { waitUntil: ctx?.waitUntil?.bind(ctx) });
  const allTools = { ...firstPartyTools, ...mcpResult.tools };

  // Messages — primary gets images natively, fallback uses text refs + vision tool
  const messagesWithImages = buildGenerationMessages(req, contextDecision, sourcesBlock);
  const messagesTextOnly = buildTextOnlyGenerationMessages(req, contextDecision, sourcesBlock);

  // Model chain — try each model until one produces a response, within one
  // wall-clock budget for the whole chain.
  const chain = getModelChain(env, "generation");
  const sessionId = `xenoblade:${req.containerId}`;
  const chainDeadline = now + CHAIN_DEADLINE_MS;

  let result: Awaited<ReturnType<typeof generateText>> | undefined;
  let finalReply = "";
  let extraInputTokens = 0;
  let extraOutputTokens = 0;
  let extraCacheReadTokens = 0;
  let extraCacheWriteTokens = 0;
  let hasExtraCacheRead = false;
  let hasExtraCacheWrite = false;
  let usedModel = chain[0]?.id ?? "unknown";

  GENERATION_LOOP: try {
    for (const [i, config] of chain.entries()) {
      const isPrimary = i === 0;
      const remainingMs = chainDeadline - Date.now();
      if (remainingMs < MIN_ATTEMPT_MS) {
        throw new GenerationDeadlineError();
      }
      try {
        const model = createModel(env, config, sessionId);
        const attemptMessages = isPrimary ? messagesWithImages : messagesTextOnly;

        result = await withDeadline(
          generateText({
            model,
            system,
            messages: attemptMessages,
            tools: allTools,
            // A question for the user or a Runtime-proxied Discord read ends
            // the current hop cleanly.
            stopWhen: [isStepCount(MAX_STEPS), stoppedOnAskUser, stoppedOnDiscordRead],
            // The last step keeps `tools` defined so OpenRouter serializes
            // `tool_choice: "none"` and keeps the prompt cache warm, paired
            // with an explicit synthesis notice so the model answers directly.
            prepareStep: ({ stepNumber, messages }) =>
              stepNumber >= MAX_STEPS - 1
                ? {
                    toolChoice: "none",
                    messages: [...messages, { role: "user", content: FINAL_STEP_SYNTHESIS_NOTICE }],
                  }
                : undefined,
            maxRetries: 1,
            timeout: Math.min(GENERATION_LIMITS.timeout.totalMs, remainingMs),
            maxOutputTokens: config.maxOutputTokens ?? GENERATION_LIMITS.maxOutputTokens,
            // Omitted, not defaulted: reasoning models reject any temperature but their own.
            ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
          }),
          remainingMs,
        );

        usedModel = config.id;
        finalReply = result.text;
        extraInputTokens = 0;
        extraOutputTokens = 0;
        extraCacheReadTokens = 0;
        extraCacheWriteTokens = 0;
        hasExtraCacheRead = false;
        hasExtraCacheWrite = false;

        // A run that stopped on a question or a Runtime-proxied Discord read
        // has no final answer text to validate on this hop.
        const askedUser = extractAskPrompt(result.toolResults ?? []) !== undefined;
        const pendingReads = adminSession
          ? extractDiscordReadRequests(result.toolResults ?? [])
          : [];
        const hopSuspended = askedUser || pendingReads.length > 0;
        if (!hopSuspended && containsLeakedToolMarkup(finalReply)) {
          console.log(
            JSON.stringify({
              event: "tool_markup_leaked",
              messageId: req.messageId,
              model: config.id,
              steps: result.steps.length,
            }),
          );
          const rescueRemainingMs = chainDeadline - Date.now();
          const priorMessages: ModelMessage[] =
            result.steps.length > 1
              ? result.steps.slice(0, -1).flatMap((step) => step.response?.messages ?? [])
              : [];
          let rescued = false;
          if (priorMessages.length > 0 && rescueRemainingMs >= MIN_ATTEMPT_MS) {
            try {
              const rescue = await withDeadline(
                generateText({
                  model,
                  system,
                  messages: [
                    ...attemptMessages,
                    ...priorMessages,
                    { role: "user", content: FINAL_STEP_SYNTHESIS_NOTICE },
                  ],
                  tools: allTools,
                  toolChoice: "none",
                  stopWhen: isStepCount(1),
                  maxRetries: 0,
                  timeout: Math.min(GENERATION_LIMITS.timeout.totalMs, rescueRemainingMs),
                  maxOutputTokens: config.maxOutputTokens ?? GENERATION_LIMITS.maxOutputTokens,
                  ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
                }),
                rescueRemainingMs,
              );
              extraInputTokens = rescue.usage.inputTokens ?? 0;
              extraOutputTokens = rescue.usage.outputTokens ?? 0;
              if (rescue.usage.inputTokenDetails.cacheReadTokens !== undefined) {
                extraCacheReadTokens = rescue.usage.inputTokenDetails.cacheReadTokens;
                hasExtraCacheRead = true;
              }
              if (rescue.usage.inputTokenDetails.cacheWriteTokens !== undefined) {
                extraCacheWriteTokens = rescue.usage.inputTokenDetails.cacheWriteTokens;
                hasExtraCacheWrite = true;
              }
              if (rescue.text.trim() !== "" && !containsLeakedToolMarkup(rescue.text)) {
                finalReply = rescue.text;
                rescued = true;
                console.log(
                  JSON.stringify({
                    event: "tool_markup_rescued",
                    messageId: req.messageId,
                    model: config.id,
                  }),
                );
              }
            } catch (rescueError) {
              if (rescueError instanceof GenerationDeadlineError) throw rescueError;
              console.log(
                JSON.stringify({
                  event: "tool_markup_rescue_failed",
                  messageId: req.messageId,
                  model: config.id,
                  error: rescueError instanceof Error ? rescueError.name : typeof rescueError,
                }),
              );
            }
          }
          if (!rescued) {
            if (i < chain.length - 1) continue;
            throw new Error(`${config.id} leaked raw tool markup`);
          }
        }

        if (!hopSuspended && finalReply.trim() === "") {
          console.log(
            JSON.stringify({
              event: "empty_generation",
              messageId: req.messageId,
              model: config.id,
            }),
          );
          if (i < chain.length - 1) continue;
          throw new Error(`${config.id} returned empty text`);
        }
        break GENERATION_LOOP;
      } catch (error) {
        console.log(
          JSON.stringify({
            event: "attempt_failed",
            messageId: req.messageId,
            model: config.id,
            retryable: isRetryable(error),
            // Never the message: a provider or a tool may fill it with
            // request content, which no log may carry in any scope.
            error: error instanceof Error ? error.name : typeof error,
            ...(APICallError.isInstance(error) && error.statusCode !== undefined
              ? { statusCode: error.statusCode }
              : {}),
          }),
        );
        // The chain's time is gone: nothing is left to try another model with.
        if (error instanceof GenerationDeadlineError) throw error;
        // Rethrow as-is: everything in this try (createModel, generateText,
        // the empty-text check) throws Error instances, so the terminal
        // failure keeps its original Error shape for the caller.
        if (i === chain.length - 1) throw error;
        await sleep(3000);
      }
    }
  } catch (error) {
    await closeMcpClients(mcpResult.clients);
    const outOfTime = isTimeout(error);
    // A DOMException — how the SDK's timeout arrives — is read like an Error.
    const named = error instanceof Error || error instanceof DOMException ? error : null;
    const code = named === null ? "GENERATION_FAILED" : named.name;
    const errorMsg = named === null ? String(error) : named.message;
    if (reservationId !== null) await safeFinish(env.DB, reservationId);
    await safeRecord(env.DB, {
      id: requestId,
      containerId: req.containerId,
      scopeId: req.scopeId,
      userId: req.userId,
      summonKind: req.summonKind,
      model: usedModel,
      status: outOfTime ? "timeout" : "failed",
      totalDurationMs: Date.now() - now,
      createdAt: Date.now(),
    });
    // A run that merely ran out of time is worth asking again.
    return {
      status: "error",
      requestId,
      code,
      message: errorMsg,
      retryable: outOfTime || isRetryable(error),
    };
  }

  if (!result) throw new Error("unreachable: no generation result");

  // Telemetry
  const baseCacheRead = result.usage.inputTokenDetails.cacheReadTokens;
  const baseCacheWrite = result.usage.inputTokenDetails.cacheWriteTokens;
  const usage: GenerationUsage = {
    model: usedModel,
    inputTokens: (result.usage.inputTokens ?? 0) + extraInputTokens,
    outputTokens: (result.usage.outputTokens ?? 0) + extraOutputTokens,
    cacheReadTokens:
      baseCacheRead !== undefined || hasExtraCacheRead
        ? (baseCacheRead ?? 0) + extraCacheReadTokens
        : undefined,
    cacheWriteTokens:
      baseCacheWrite !== undefined || hasExtraCacheWrite
        ? (baseCacheWrite ?? 0) + extraCacheWriteTokens
        : undefined,
    durationMs: Date.now() - now,
  };

  if (reservationId !== null) await safeFinish(env.DB, reservationId);
  await safeRecord(env.DB, {
    id: requestId,
    containerId: req.containerId,
    scopeId: req.scopeId,
    userId: req.userId,
    summonKind: req.summonKind,
    model: usedModel,
    status: "completed",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? null,
    cacheWriteTokens: usage.cacheWriteTokens ?? null,
    totalDurationMs: usage.durationMs,
    createdAt: Date.now(),
  });

  try {
    await markUserInteraction(env.DB, {
      scopeId: req.scopeId,
      containerId: req.containerId,
      userId: req.userId,
      now: Date.now(),
    });
  } catch (error) {
    console.log(JSON.stringify({ event: "mark_interaction_error", error: String(error) }));
  }

  // Tool audit
  try {
    for (const tr of result.toolResults ?? []) {
      const output: unknown = tr.output;
      const isError = output != null && typeof output === "object" && "error" in output;
      await recordToolInvocation(env.DB, {
        id: crypto.randomUUID(),
        interactionId: requestId,
        toolName: tr.toolName,
        server: toolServer(tr.toolName, firstPartyTools),
        status: isError ? "error" : "ok",
        inputSize: JSON.stringify(tr.input).length,
        outputSize: JSON.stringify(tr.output).length,
        createdAt: Date.now(),
      });
    }
  } catch (error) {
    console.log(JSON.stringify({ event: "tool_audit_error", error: String(error) }));
  }

  await closeMcpClients(mcpResult.clients);

  const sources = extractSources(result.toolResults ?? []);
  const guildMemoryProposals = extractGuildMemoryProposals(result.toolResults ?? []);
  const soulProposal = extractSoulProposal(result.toolResults ?? []);
  const askPrompt = extractAskPrompt(result.toolResults ?? []);
  const discordReadRequests = adminSession
    ? extractDiscordReadRequests(result.toolResults ?? [])
    : [];

  if (discordReadRequests.length > 0) {
    console.log(
      JSON.stringify({
        event: "generation_admin_reads_requested",
        messageId: req.messageId,
        model: usedModel,
        reads: discordReadRequests.length,
      }),
    );
    return {
      status: "completed",
      requestId,
      reply: "",
      usage,
      sources,
      discordReadRequests,
    };
  }

  let adminActionPlan: AdminActionPlan | undefined;
  if (adminSession) {
    const adminConfig = getAdminConfig(env);
    const operations = extractAdminOperations(result.toolResults ?? []);
    if (adminConfig !== null && operations.length > 0) {
      const planNow = Date.now();
      const risk = operations.some((op) => op.risk === "high") ? "high" : "standard";
      const payloadHash = await hashAdminPlanPayload(
        adminConfig.guildId,
        adminConfig.ownerUserId,
        operations,
      );
      const summary = operations
        .map((op) => op.description)
        .join("; ")
        .slice(0, 300);
      const plan: AdminActionPlan = {
        id: crypto.randomUUID(),
        guildId: adminConfig.guildId,
        channelId: req.channelId,
        ownerUserId: adminConfig.ownerUserId,
        summary,
        operations,
        risk,
        payloadHash,
        createdAt: planNow,
        expiresAt: planNow + ADMIN_PLAN_TTL_MS,
      };
      try {
        await createAdminPlan(env.DB, plan);
        adminActionPlan = plan;
      } catch (error) {
        console.log(
          JSON.stringify({
            event: "admin_plan_persist_error",
            messageId: req.messageId,
            error: error instanceof Error ? error.name : typeof error,
          }),
        );
      }
    }
  }

  await recordInteractionSources(env.DB, {
    interactionId: requestId,
    containerId: req.containerId,
    sources,
    now: Date.now(),
  });

  // A question ends the turn without an answer, so the thread it was asked in
  // is still mid-conversation: a pause asked beside one waits for the answer.
  const threadDeactivated =
    askPrompt === undefined && hasThreadPause(result.toolResults ?? [])
      ? await safePauseThread(env, req)
      : false;

  // What `retry_last_reply` reads next. A turn that stopped on a question has
  // not answered yet and leaves the stored turn alone; one that redid the
  // last reply replaces that reply, so the prompt — and when it was sent —
  // stay the user's own.
  const retried = askPrompt === undefined && hasRetry(result.toolResults ?? []);
  if (askPrompt === undefined) {
    const assistantReply = finalReply;
    const storedAt = Date.now();
    await safeRecordTurn(() =>
      retried
        ? recordLastReply(
            env.DB,
            { containerId: req.containerId, scopeId: req.scopeId, assistantReply },
            storedAt,
          )
        : recordLastTurn(
            env.DB,
            {
              containerId: req.containerId,
              scopeId: req.scopeId,
              channelId: req.channelId,
              userId: req.userId,
              userDisplayName: req.userDisplayName,
              triggerMessageId: req.messageId,
              // A Runtime that does not say when the message was sent gets the
              // time of the reply as the prompt's: late, never early.
              triggerCreatedAt: req.messageCreatedAt ?? storedAt,
              triggerContent: req.content,
              assistantReply,
            },
            storedAt,
          ),
    );
  }

  console.log(
    JSON.stringify({
      event: "generation_completed",
      messageId: req.messageId,
      model: usedModel,
      // Length only: a reply can echo personal or shared memory, so no scope
      // logs a preview of it.
      replyLength: finalReply.length,
      toolCalls: (result.toolResults ?? []).length,
      steps: result.steps.length,
      sources: sources.length,
      guildMemoryProposals: guildMemoryProposals.length,
      soulProposal: soulProposal !== undefined,
      askPrompt: askPrompt !== undefined,
      adminActionPlan: adminActionPlan !== undefined,
      threadDeactivated,
      retried,
    }),
  );

  return {
    status: "completed",
    requestId,
    reply: finalReply,
    usage,
    sources,
    ...(guildMemoryProposals.length > 0 ? { guildMemoryProposals } : {}),
    ...(soulProposal !== undefined ? { soulProposal } : {}),
    ...(askPrompt !== undefined ? { askPrompt } : {}),
    ...(adminActionPlan !== undefined ? { adminActionPlan } : {}),
    ...(threadDeactivated ? { threadDeactivated: true } : {}),
    ...(retried ? { retriedLastReply: true } : {}),
  };
}
