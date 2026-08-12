import { createOpenRouter } from "@openrouter/ai-sdk-provider";

// ── Model roles (ADR-004: Two-Tier Model Architecture) ────────────────────

export type ModelRole = "generation" | "summarization" | "transcription";

const DEFAULT_ROLE_MODELS: Record<ModelRole, string> = {
  generation: "openai/gpt-5.6-luna",
  summarization: "openai/gpt-5.6-luna",
  transcription: "openai/gpt-transcribe",
};

export const GENERATION_LIMITS = {
  maxOutputTokens: 1024,
  timeout: { totalMs: 60_000, firstChunkMs: 15_000, chunkMs: 5_000 },
} as const;

export interface AiEnv {
  /** Legacy single-model var; still read for the generation role. */
  AI_MODEL?: string;
  GENERATION_MODEL?: string;
  SUMMARIZATION_MODEL?: string;
  TRANSCRIPTION_MODEL?: string;
  OPENROUTER_API_KEY?: string;
}

function resolveModelId(env: AiEnv, role: ModelRole): string {
  switch (role) {
    case "generation":
      return env.GENERATION_MODEL ?? env.AI_MODEL ?? DEFAULT_ROLE_MODELS.generation;
    case "summarization":
      return env.SUMMARIZATION_MODEL ?? DEFAULT_ROLE_MODELS.summarization;
    case "transcription":
      return env.TRANSCRIPTION_MODEL ?? DEFAULT_ROLE_MODELS.transcription;
  }
}

/**
 * Select an AI model for a given role via OpenRouter.
 *
 * All roles go through the AI SDK standard interface, preserving the option
 * to switch providers in the future.
 *
 * `options.sessionId` is forwarded to OpenRouter for sticky routing (prefix
 * cache). The caller keeps it stable per container (e.g. `xenoblade:${containerId}`).
 */
export function selectModel(
  env: AiEnv,
  options?: { sessionId?: string; role?: ModelRole },
) {
  const role = options?.role ?? "generation";
  const modelId = resolveModelId(env, role);

  if (!env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }

  if (options?.sessionId) {
    return createOpenRouter({
      apiKey: env.OPENROUTER_API_KEY,
      extraBody: { session_id: options.sessionId },
    }).chat(modelId);
  }
  return createOpenRouter({ apiKey: env.OPENROUTER_API_KEY }).chat(modelId);
}

export function composeSystemPrompt(parts: {
  safety: string;
  base?: string;
  persona?: string;
}): string {
  const segments: string[] = [];
  for (const part of [parts.safety, parts.base, parts.persona]) {
    if (part !== undefined && part.trim() !== "") {
      segments.push(part);
    }
  }
  return segments.join("\n\n");
}
