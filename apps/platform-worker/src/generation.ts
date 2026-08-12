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

function isRetryable(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes("rate-limited") || msg.includes("rate_limit") || msg.includes("429");
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export async function generate(
  env: Env,
  req: GenerationRequest,
): Promise<GenerationResult> {
  const now = Date.now();
  const requestId = crypto.randomUUID();

  // 1. Dedup
  try {
    if (!(await claimMessage(env.DB, req.messageId, now))) {
      return { status: "rejected", requestId, code: "duplicate" };
    }
  } catch (error) {
    return { status: "error", requestId, code: "claim_failed", message: String(error), retryable: true };
  }

  // 2. Runtime gate
  const runtime = await getRuntimeConfig(env.DB, req.scopeId, req.channelId);
  if (!runtime.enabled || !runtime.channelAllowed) {
    return { status: "rejected", requestId, code: "disabled" };
  }

  // 3. Budget
  let reservationId: number;
  try {
    reservationId = (await reserveGeneration(env.DB, req.containerId, now)).reservationId;
  } catch (error) {
    if (error instanceof GenerationBudgetExceededError) {
      return { status: "rejected", requestId, code: "budget_exceeded" };
    }
    return { status: "error", requestId, code: "reserve_failed", message: String(error), retryable: true };
  }

  // 4. Context
  const state = await getUserContextState(env.DB, {
    scopeId: req.scopeId,
    containerId: req.containerId,
    userId: req.userId,
  });
  const contextDecision = buildContext(req, state.resetAt);

  // 5. Prompt (with user memory)
  let persona: string | undefined;
  try {
    const memories = await getUserMemory(env.DB, req.userId);
    persona = formatMemoryBlock(req.userDisplayName, memories);
  } catch (error) {
    console.log(JSON.stringify({ event: "memory_read_error", error: String(error) }));
  }
  const system = composeSystemPrompt({ safety: SAFETY_SYSTEM, persona });

  // 6. Tools — ALL models get ALL tools (MCP + first-party + vision)
  const firstPartyTools = createFirstPartyTools(env);
  const mcpResult = await connectMcpServers(env);
  const allTools = { ...firstPartyTools, ...mcpResult.tools };

  // 7. Messages — two variants for multimodal vs text-only models
  //    Primary (Luna): images as native content parts
  //    Fallback (DeepSeek): images as text refs, uses vision_describe tool
  const messagesWithImages = buildGenerationMessages(req, contextDecision, true);
  const messagesTextOnly = buildGenerationMessages(req, contextDecision, false);

  // 8. Generate: primary (×2) → fallback (×1)
  const sessionId = `xenoblade:${req.containerId}`;
  const fallbackId = getFallbackModelId(env, "generation");
  const primaryId = env.GENERATION_MODEL ?? "openai/gpt-5.6-luna";

  type Attempt = { label: string; isFallback: boolean; modelId: string };
  const chain: Attempt[] = [
    { label: "primary", isFallback: false, modelId: primaryId },
    { label: "primary-retry", isFallback: false, modelId: primaryId },
  ];
  if (fallbackId) {
    chain.push({ label: "fallback", isFallback: true, modelId: fallbackId });
  }

  let result: Awaited<ReturnType<typeof generateText>> | undefined;
  let usedModel = primaryId;

  GENERATION_LOOP:
  try {
    for (let i = 0; i < chain.length; i++) {
      const att = chain[i];
      try {
        const model = att.isFallback
          ? selectModel(env, { role: "generation", sessionId, modelId: att.modelId })
          : selectModel(env, { role: "generation", sessionId });

        result = await generateText({
          model,
          system,
          messages: att.isFallback ? messagesTextOnly : messagesWithImages,
          tools: allTools,
          stopWhen: isStepCount(5),
          maxRetries: 1,
          timeout: GENERATION_LIMITS.timeout.totalMs,
        });

        if (att.isFallback) usedModel = att.modelId;

        // Empty text → try next attempt
        if (!result.text || result.text.trim() === "") {
          console.log(JSON.stringify({
            event: "empty_generation", messageId: req.messageId, model: att.label,
          }));
          if (i < chain.length - 1) continue;
          throw new Error(`${att.label} returned empty text`);
        }
        break GENERATION_LOOP;

      } catch (error) {
        console.log(JSON.stringify({
          event: "attempt_failed", messageId: req.messageId,
          attempt: att.label, retryable: isRetryable(error),
          error: error instanceof Error ? error.message : String(error),
        }));
        if (i === chain.length - 1) throw error;
        await sleep(3000);
      }
    }
  } catch (error) {
    await closeMcpClients(mcpResult.clients);
    const code = error instanceof Error ? error.name : "GENERATION_FAILED";
    const errorMsg = error instanceof Error ? error.message : String(error);
    await safeFinish(env.DB, reservationId);
    await safeRecord(env.DB, {
      id: requestId, containerId: req.containerId, scopeId: req.scopeId,
      userId: req.userId, summonKind: req.summonKind,
      model: usedModel, status: "failed",
      totalDurationMs: Date.now() - now, createdAt: Date.now(),
    });
    return { status: "error", requestId, code, message: errorMsg, retryable: isRetryable(error) };
  }

  if (!result) throw new Error("unreachable: no generation result");

  // 9. Telemetry
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
    id: requestId, containerId: req.containerId, scopeId: req.scopeId,
    userId: req.userId, summonKind: req.summonKind,
    model: usedModel, status: "completed",
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? null,
    cacheWriteTokens: usage.cacheWriteTokens ?? null,
    totalDurationMs: usage.durationMs, createdAt: Date.now(),
  });

  try {
    await markUserInteraction(env.DB, {
      scopeId: req.scopeId, containerId: req.containerId,
      userId: req.userId, now: Date.now(),
    });
  } catch (error) {
    console.log(JSON.stringify({ event: "mark_interaction_error", error: String(error) }));
  }

  // 10. Tool audit
  try {
    for (const tr of result.toolResults ?? []) {
      const output = tr.output as Record<string, unknown> | null;
      const isError = output != null && typeof output === "object" && "error" in output;
      await recordToolInvocation(env.DB, {
        id: crypto.randomUUID(), interactionId: requestId,
        toolName: tr.toolName,
        server: tr.toolName.includes("_") ? tr.toolName.split("_")[0] : "builtin",
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

  console.log(JSON.stringify({
    event: "generation_completed", messageId: req.messageId,
    model: usedModel, replyLength: result.text.length,
    replyPreview: result.text.slice(0, 100),
    toolCalls: (result.toolResults ?? []).length, steps: result.steps.length,
  }));

  return { status: "completed", requestId, reply: result.text, usage };
}
