import { generateText, isStepCount } from "ai";

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

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export async function generate(env: Env, req: GenerationRequest): Promise<GenerationResult> {
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

  if (!isRegenerate) return runGenerationPipeline(env, req, requestId, now);
  // Release the lease whatever the outcome — the next deliberate re-run
  // must not wait out the TTL. A failed release self-heals at expiry.
  try {
    return await runGenerationPipeline(env, req, requestId, now);
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
): Promise<GenerationResult> {
  // Runtime gate
  const runtime = await getRuntimeConfig(env.DB, req.scopeId, req.channelId);
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
  const system = composeSystemPrompt({
    safety: SAFETY_SYSTEM,
    base: MEMORY_GUIDANCE,
    persona,
    now: new Date(now),
  });

  // Reference block of sources cited in earlier replies of this container, so
  // "where is the source" follow-ups stay answerable without a rendered
  // footer (ADR-007 amendment). Best-effort read; empty on any failure.
  const sourcesBlock = formatSourcesBlock(
    await getRecentSources(env.DB, { containerId: req.containerId, now }),
  );

  // Tools — ALL models get ALL tools (MCP + first-party + vision)
  const firstPartyTools = createFirstPartyTools(env);
  const mcpResult = await connectMcpServers(env);
  const allTools = { ...firstPartyTools, ...mcpResult.tools };

  // Messages — primary gets images natively, fallback uses text refs + vision tool
  const messagesWithImages = buildGenerationMessages(req, contextDecision, sourcesBlock);
  const messagesTextOnly = buildTextOnlyGenerationMessages(req, contextDecision, sourcesBlock);

  // Model chain — try each model until one produces a response
  const chain = getModelChain(env, "generation");
  const sessionId = `xenoblade:${req.containerId}`;

  let result: Awaited<ReturnType<typeof generateText>> | undefined;
  let usedModel = chain[0]?.id ?? "unknown";

  GENERATION_LOOP: try {
    for (const [i, config] of chain.entries()) {
      const isPrimary = i === 0;
      try {
        const model = createModel(env, config, sessionId);

        result = await generateText({
          model,
          system,
          messages: isPrimary ? messagesWithImages : messagesTextOnly,
          tools: allTools,
          stopWhen: isStepCount(5),
          maxRetries: 1,
          timeout: GENERATION_LIMITS.timeout.totalMs,
        });

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
        // Rethrow as-is: everything in this try (createModel, generateText,
        // the empty-text check) throws Error instances, so the terminal
        // failure keeps its original Error shape for the caller.
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
      id: requestId,
      containerId: req.containerId,
      scopeId: req.scopeId,
      userId: req.userId,
      summonKind: req.summonKind,
      model: usedModel,
      status: "failed",
      totalDurationMs: Date.now() - now,
      createdAt: Date.now(),
    });
    return { status: "error", requestId, code, message: errorMsg, retryable: isRetryable(error) };
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
        server: tr.toolName.includes("_") ? (tr.toolName.split("_")[0] ?? "builtin") : "builtin",
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
    }),
  );

  return {
    status: "completed",
    requestId,
    reply: result.text,
    usage,
    sources,
    ...(memoryProposals.length > 0 ? { memoryProposals } : {}),
  };
}
