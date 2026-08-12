import { generateText, isStepCount } from "ai";

import { composeSystemPrompt, GENERATION_LIMITS, selectModel } from "@xenoblade/ai";
import type {
  GenerationRequest,
  GenerationResult,
  GenerationUsage,
  UserMemory,
} from "@xenoblade/contracts";

import {
  claimMessage,
  finishGeneration,
  GenerationBudgetExceededError,
  getRuntimeConfig,
  getUserContextState,
  getUserMemory,
  markUserInteraction,
  recordInteraction,
  recordToolInvocation,
  reserveGeneration,
  type InteractionRecord,
} from "./db";
import { buildContext } from "./context";
import { buildGenerationMessages, SAFETY_SYSTEM } from "./prompt";
import { createAllTools } from "./tools";

/**
 * Format persona/preference memories as a private system-prompt block so the
 * model can weave the user's known context in naturally. Fact memories are
 * excluded (they are reference data, not style guidance).
 */
function formatMemoryBlock(displayName: string, memories: readonly UserMemory[]): string {
  const relevant = memories.filter(
    (m) => m.category === "persona" || m.category === "preference",
  );
  if (relevant.length === 0) {
    return "";
  }
  const lines = relevant.map((m) => `- ${m.key}: ${m.value}`);
  return [
    `What you already know about ${displayName} (weave in naturally; never list or cite this):`,
    ...lines,
  ].join("\n");
}

/** Mark a reservation finalized; telemetry must never mask the real result. */
async function safeFinish(db: D1Database, reservationId: number): Promise<void> {
  try {
    await finishGeneration(db, reservationId, Date.now());
  } catch (error) {
    console.log(JSON.stringify({ event: "finish_error", error: String(error) }));
  }
}

/** Record an interaction row; a telemetry failure is logged, not fatal. */
async function safeRecord(db: D1Database, row: InteractionRecord): Promise<void> {
  try {
    await recordInteraction(db, row);
  } catch (error) {
    console.log(JSON.stringify({ event: "record_interaction_error", error: String(error) }));
  }
}

/**
 * Run the full generation pipeline for one request.
 *
 * claim → runtime gate → budget → context → prompt → generateText → telemetry
 *
 * Every terminal path returns a {@link GenerationResult}; the Worker never
 * throws to the caller.
 */
export async function generate(
  env: Env,
  req: GenerationRequest,
): Promise<GenerationResult> {
  const now = Date.now();
  const requestId = crypto.randomUUID();

  // 1. De-duplicate delivery.
  try {
    if (!(await claimMessage(env.DB, req.messageId, now))) {
      console.log(JSON.stringify({ event: "duplicate", messageId: req.messageId }));
      return { status: "rejected", requestId, code: "duplicate" };
    }
  } catch (error) {
    console.log(JSON.stringify({ event: "claim_error", error: String(error) }));
    return { status: "error", requestId, code: "claim_failed", retryable: true };
  }

  // 2. Runtime configuration (fail-closed).
  const runtime = await getRuntimeConfig(env.DB, req.scopeId, req.channelId);
  if (!runtime.enabled || !runtime.channelAllowed) {
    console.log(
      JSON.stringify({
        event: "runtime_disabled",
        scopeId: req.scopeId,
        channelId: req.channelId,
        enabled: runtime.enabled,
        allowed: runtime.channelAllowed,
      }),
    );
    return { status: "rejected", requestId, code: "disabled" };
  }

  // 3. Budget reservation.
  let reservationId: number;
  try {
    reservationId = (await reserveGeneration(env.DB, req.containerId, now)).reservationId;
  } catch (error) {
    if (error instanceof GenerationBudgetExceededError) {
      console.log(JSON.stringify({ event: "budget_exceeded", containerId: req.containerId }));
      return { status: "rejected", requestId, code: "budget_exceeded" };
    }
    console.log(JSON.stringify({ event: "reserve_error", error: String(error) }));
    return { status: "error", requestId, code: "reserve_failed", retryable: true };
  }

  // 4. User-isolated context state (fail-closed to current-message-only).
  const state = await getUserContextState(env.DB, {
    scopeId: req.scopeId,
    containerId: req.containerId,
    userId: req.userId,
  });

  // 5. Context + prompt.
  const contextDecision = buildContext(req, state.resetAt);
  const messages = buildGenerationMessages(req, contextDecision);

  // Inject persona/preference memory into the system prompt.
  let persona: string | undefined;
  try {
    const memories = await getUserMemory(env.DB, req.userId);
    persona = formatMemoryBlock(req.userDisplayName, memories);
  } catch (error) {
    console.log(JSON.stringify({ event: "memory_read_error", error: String(error) }));
  }

  const system = composeSystemPrompt({ safety: SAFETY_SYSTEM, persona });

  // 6. Generate (non-streaming). Provider-level retries are delegated to the SDK.
  const startedAt = now;
  let result;
  try {
    result = await generateText({
      model: selectModel(env, { role: "generation", sessionId: `xenoblade:${req.containerId}` }),
      system,
      messages,
      tools: createAllTools(env),
      stopWhen: isStepCount(5),
      maxOutputTokens: GENERATION_LIMITS.maxOutputTokens,
      maxRetries: 2,
      timeout: GENERATION_LIMITS.timeout.totalMs,
    });
  } catch (error) {
    const code = error instanceof Error ? error.name : "GENERATION_FAILED";
    console.log(
      JSON.stringify({
        event: "generation_failed",
        messageId: req.messageId,
        containerId: req.containerId,
        error: String(error),
        errorCode: code,
      }),
    );
    await safeFinish(env.DB, reservationId);
    await safeRecord(env.DB, {
      id: requestId,
      containerId: req.containerId,
      scopeId: req.scopeId,
      userId: req.userId,
      summonKind: req.summonKind,
      model: env.GENERATION_MODEL,
      status: "failed",
      totalDurationMs: Date.now() - startedAt,
      createdAt: Date.now(),
    });
    // Already retried at the SDK level; a Runtime retry would hit dedup.
    return { status: "error", requestId, code, retryable: false };
  }

  // 7. Extract usage (synchronous for generateText).
  const usage: GenerationUsage = {
    model: env.GENERATION_MODEL,
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
    cacheReadTokens: result.usage.inputTokenDetails.cacheReadTokens,
    cacheWriteTokens: result.usage.inputTokenDetails.cacheWriteTokens,
    durationMs: Date.now() - startedAt,
  };

  // 8. Telemetry (best-effort).
  await safeFinish(env.DB, reservationId);
  await safeRecord(env.DB, {
    id: requestId,
    containerId: req.containerId,
    scopeId: req.scopeId,
    userId: req.userId,
    summonKind: req.summonKind,
    model: usage.model,
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

  // 9. Record tool invocations (best-effort, non-fatal).
  try {
    for (const tr of result.toolResults) {
      const output = tr.output as Record<string, unknown> | null;
      const isError =
        output != null && typeof output === "object" && "error" in output;
      await recordToolInvocation(env.DB, {
        id: crypto.randomUUID(),
        interactionId: requestId,
        toolName: tr.toolName,
        server: "builtin",
        status: isError ? "error" : "ok",
        inputSize: JSON.stringify(tr.input).length,
        outputSize: JSON.stringify(tr.output).length,
        createdAt: Date.now(),
      });
    }
  } catch (error) {
    console.log(
      JSON.stringify({ event: "record_tool_invocations_error", error: String(error) }),
    );
  }

  return {
    status: "completed",
    requestId,
    reply: result.text,
    usage,
  };
}
