import { generateText, isStepCount } from "ai";

import {
  composeSystemPrompt,
  GENERATION_LIMITS,
  getFallbackModelId,
  selectModel,
} from "@xenoblade/ai";
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
import { createFirstPartyTools, connectMcpServers, closeMcpClients } from "./tools";

function formatMemoryBlock(displayName: string, memories: readonly UserMemory[]): string {
  const relevant = memories.filter(
    (m) => m.category === "persona" || m.category === "preference",
  );
  if (relevant.length === 0) return "";
  const lines = relevant.map((m) => `- ${m.key}: ${m.value}`);
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

function isRateLimited(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes("rate-limited") || msg.includes("rate_limit");
}

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
    return { status: "error", requestId, code: "claim_failed", message: String(error), retryable: true };
  }

  // 2. Runtime configuration (fail-closed).
  const runtime = await getRuntimeConfig(env.DB, req.scopeId, req.channelId);
  if (!runtime.enabled || !runtime.channelAllowed) {
    return { status: "rejected", requestId, code: "disabled" };
  }

  // 3. Budget reservation.
  let reservationId: number;
  try {
    reservationId = (await reserveGeneration(env.DB, req.containerId, now)).reservationId;
  } catch (error) {
    if (error instanceof GenerationBudgetExceededError) {
      return { status: "rejected", requestId, code: "budget_exceeded" };
    }
    return { status: "error", requestId, code: "reserve_failed", message: String(error), retryable: true };
  }

  // 4. Context + prompt.
  const state = await getUserContextState(env.DB, {
    scopeId: req.scopeId,
    containerId: req.containerId,
    userId: req.userId,
  });

  const contextDecision = buildContext(req, state.resetAt);
  const messages = buildGenerationMessages(req, contextDecision);

  let persona: string | undefined;
  try {
    const memories = await getUserMemory(env.DB, req.userId);
    persona = formatMemoryBlock(req.userDisplayName, memories);
  } catch (error) {
    console.log(JSON.stringify({ event: "memory_read_error", error: String(error) }));
  }

  const system = composeSystemPrompt({ safety: SAFETY_SYSTEM, persona });

  // 5. Connect MCP servers + build tool set.
  const firstPartyTools = createFirstPartyTools(env);
  const mcpResult = await connectMcpServers(env);
  const allTools = { ...firstPartyTools, ...mcpResult.tools };

  // 6. Generate with retry + fallback model.
  const startedAt = now;
  const sessionId = `xenoblade:${req.containerId}`;
  const fallbackId = getFallbackModelId(env, "generation");

  // Build model chain: primary (2 retries) → fallback (1 attempt)
  type ModelAttempt = { modelId: string; label: string };
  const chain: ModelAttempt[] = [
    { modelId: "primary", label: "primary" },
    { modelId: "primary", label: "primary-retry" },
  ];
  if (fallbackId) {
    chain.push({ modelId: fallbackId, label: "fallback" });
  }

  let result;
  let usedFallback = false;

  try {
    for (let i = 0; i < chain.length; i++) {
      const attempt = chain[i];
      try {
        const model =
          attempt.modelId === "primary"
            ? selectModel(env, { role: "generation", sessionId })
            : selectModel(env, { role: "generation", sessionId, modelId: attempt.modelId });

        result = await generateText({
          model,
          system,
          messages,
          tools: allTools,
          stopWhen: isStepCount(5),
          maxRetries: 1,
          timeout: GENERATION_LIMITS.timeout.totalMs,
        });

        usedFallback = i > 1;
        break;
      } catch (error) {
        lastError = error;
        const rateLimited = isRateLimited(error);

        console.log(
          JSON.stringify({
            event: "generation_attempt_failed",
            messageId: req.messageId,
            attempt: attempt.label,
            rateLimited,
            error: error instanceof Error ? error.message : String(error),
          }),
        );

        if (!rateLimited || i === chain.length - 1) {
          throw error;
        }

        // Wait before next attempt
        if (i < chain.length - 1) {
          const { promise: sleepP, resolve: wake } = Promise.withResolvers<void>();
          setTimeout(wake, 3000);
          await sleepP;
        }
      }
    }
  } catch (error) {
    await closeMcpClients(mcpResult.clients);
    const code = error instanceof Error ? error.name : "GENERATION_FAILED";
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.log(
      JSON.stringify({
        event: "generation_failed",
        messageId: req.messageId,
        error: errorMsg,
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
    return { status: "error", requestId, code, message: errorMsg, retryable: isRateLimited(error) };
  }

  if (!result) throw new Error("Generation produced no result after all attempts");
  const usedModel = usedFallback && fallbackId ? fallbackId : (env.GENERATION_MODEL ?? "openai/gpt-5.6-luna");
  const usage: GenerationUsage = {
    model: usedModel,
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
    cacheReadTokens: result.usage.inputTokenDetails.cacheReadTokens,
    cacheWriteTokens: result.usage.inputTokenDetails.cacheWriteTokens,
    durationMs: Date.now() - startedAt,
  };

  // 8. Telemetry.
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

  // 9. Record tool invocations.
  try {
    for (const tr of result.toolResults ?? []) {
      const output = tr.output as Record<string, unknown> | null;
      const isError = output != null && typeof output === "object" && "error" in output;
      await recordToolInvocation(env.DB, {
        id: crypto.randomUUID(),
        interactionId: requestId,
        toolName: tr.toolName,
        server: tr.toolName.includes("_") ? tr.toolName.split("_")[0] : "builtin",
        status: isError ? "error" : "ok",
        inputSize: JSON.stringify(tr.input).length,
        outputSize: JSON.stringify(tr.output).length,
        createdAt: Date.now(),
      });
    }
  } catch (error) {
    console.log(JSON.stringify({ event: "record_tool_invocations_error", error: String(error) }));
  }

  // 10. Close MCP clients.
  await closeMcpClients(mcpResult.clients);

  console.log(
    JSON.stringify({
      event: "generation_completed",
      messageId: req.messageId,
      model: usedModel,
      usedFallback,
      replyLength: result.text.length,
      replyPreview: result.text.slice(0, 100),
      toolCalls: (result.toolResults ?? []).length,
      steps: result.steps.length,
    }),
  );

  return {
    status: "completed",
    requestId,
    reply: result.text,
    usage,
  };
}
