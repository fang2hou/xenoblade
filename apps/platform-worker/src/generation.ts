import { generateText, isStepCount, type ToolSet } from "ai";

import { composeSystemPrompt, createModel, GENERATION_LIMITS, getModelChain } from "@xenoblade/ai";
import type {
  GenerationRequest,
  GenerationResult,
  GenerationUsage,
  UserMemory,
} from "@xenoblade/contracts";

import {
  claimMessage,
  claimRegenerate,
  releaseRegenerate,
  DM_SCOPE,
  finishGeneration,
  GenerationBudgetExceededError,
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
import { extractMemoryProposals } from "./memory-proposals";
import { extractSources } from "./sources";
import { extractSoulProposal, formatSoulSegment, getBotSoul } from "./soul";
import {
  buildGenerationMessages,
  buildTextOnlyGenerationMessages,
  MEMORY_GUIDANCE,
  SAFETY_SYSTEM,
  formatSourcesBlock,
} from "./prompt";
import { createFirstPartyTools, connectMcpServers, closeMcpClients } from "./tools";

function formatMemoryBlock(displayName: string, memories: readonly UserMemory[]): string {
  if (memories.length === 0) return "";
  const lines = memories.map((m) => `- ${m.key}: ${m.value}`);
  return [
    `What you already know about ${displayName} (weave in naturally; never list or cite this):`,
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
 * runs without tools (see `prepareStep` below), so a run that spends every
 * earlier step on tool calls still ends with a text reply.
 */
const MAX_STEPS = 8;

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

  // Dedup — a regenerate claims a short-lived lease on the original
  // message instead of the message-id claim, so racing duplicate deliveries
  // are rejected while sequential re-runs stay allowed (ADR-015); the
  // rolling budget below remains the real bound on totals.
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

  // Budget
  let reservationId: number;
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
  const soul = await getBotSoul(env.DB, req.scopeId);
  const system = composeSystemPrompt({
    safety: SAFETY_SYSTEM,
    base: MEMORY_GUIDANCE,
    soul: formatSoulSegment(soul.content),
    persona,
    now: new Date(now),
  });

  // Reference block of sources cited in earlier replies of this container, so
  // "where is the source" follow-ups stay answerable without a rendered
  // footer (ADR-007 amendment). Best-effort read; empty on any failure.
  const sourcesBlock = formatSourcesBlock(
    await getRecentSources(env.DB, { containerId: req.containerId, now }),
  );

  // Tools — ALL models get ALL tools (MCP + first-party + vision); the soul
  // tools act on this request's scope
  const firstPartyTools = createFirstPartyTools(env, req.scopeId);
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

        result = await withDeadline(
          generateText({
            model,
            system,
            messages: isPrimary ? messagesWithImages : messagesTextOnly,
            tools: allTools,
            stopWhen: isStepCount(MAX_STEPS),
            // Step 8, the last one, offers no tools to push the model into a
            // final synthesis instead of another tool call. A provider that
            // still answers with empty text is caught by the empty-reply check
            // below and falls through to the next model as usual.
            prepareStep: ({ stepNumber }) =>
              stepNumber >= MAX_STEPS - 1 ? { activeTools: [] } : undefined,
            maxRetries: 1,
            timeout: Math.min(GENERATION_LIMITS.timeout.totalMs, remainingMs),
            maxOutputTokens: config.maxOutputTokens ?? GENERATION_LIMITS.maxOutputTokens,
            // Omitted, not defaulted: reasoning models reject any temperature but their own.
            ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
          }),
          remainingMs,
        );

        usedModel = config.id;

        if (!result.text || result.text.trim() === "") {
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
            error: error instanceof Error ? error.message : String(error),
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
    await safeFinish(env.DB, reservationId);
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
  const usage: GenerationUsage = {
    model: usedModel,
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
    cacheReadTokens: result.usage.inputTokenDetails.cacheReadTokens,
    cacheWriteTokens: result.usage.inputTokenDetails.cacheWriteTokens,
    durationMs: Date.now() - now,
  };

  await safeFinish(env.DB, reservationId);
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
  const memoryProposals = extractMemoryProposals(result.toolResults ?? []);
  const soulProposal = extractSoulProposal(result.toolResults ?? []);
  await recordInteractionSources(env.DB, {
    interactionId: requestId,
    containerId: req.containerId,
    sources,
    now: Date.now(),
  });

  console.log(
    JSON.stringify({
      event: "generation_completed",
      messageId: req.messageId,
      model: usedModel,
      replyLength: result.text.length,
      // DM-scope generations never log content previews (ADR-011 privacy posture).
      ...(req.scopeId === DM_SCOPE ? {} : { replyPreview: result.text.slice(0, 100) }),
      toolCalls: (result.toolResults ?? []).length,
      steps: result.steps.length,
      sources: sources.length,
      memoryProposals: memoryProposals.length,
      soulProposal: soulProposal !== undefined,
    }),
  );

  return {
    status: "completed",
    requestId,
    reply: result.text,
    usage,
    sources,
    ...(memoryProposals.length > 0 ? { memoryProposals } : {}),
    ...(soulProposal !== undefined ? { soulProposal } : {}),
  };
}
