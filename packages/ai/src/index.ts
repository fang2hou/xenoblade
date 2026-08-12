import { createOpenRouter } from "@openrouter/ai-sdk-provider";

// ── Model roles (ADR-004: Two-Tier Model Architecture) ────────────────────

export type ModelRole = "generation" | "summarization" | "transcription";

/**
 * Primary generation model: DeepSeek V4 Flash.
 * Fallback: OpenAI GPT-5.6 Luna (used when DeepSeek providers are all down).
 *
 * OpenRouter provider routing (via extraBody.provider.order) tells OpenRouter
 * to try DeepSeek's own API first, then NovitaAI, then SiliconFlow — all
 * serving the same DeepSeek model. This maximises availability without
 * changing the model.
 */
const DEFAULT_ROLE_MODELS: Record<ModelRole, string> = {
  generation: "deepseek/deepseek-v4-flash-0731",
  summarization: "deepseek/deepseek-v4-flash-0731",
  transcription: "openai/gpt-transcribe",
};

const FALLBACK_MODELS: Record<ModelRole, string | undefined> = {
  generation: "openai/gpt-5.6-luna",
  summarization: undefined,
  transcription: undefined,
};

/**
 * Provider preference order for DeepSeek models on OpenRouter.
 * OpenRouter tries each provider in sequence; allow_fallbacks lets it
 * fall through to any available provider if the listed ones are unavailable.
 */
const PROVIDER_ORDER: Record<string, string[]> = {
  "deepseek/deepseek-v4-flash-0731": ["DeepSeek", "NovitaAI", "SiliconFlow"],
  "deepseek/deepseek-v4-flash": ["DeepSeek", "NovitaAI", "SiliconFlow"],
};

export const GENERATION_LIMITS = {
  maxOutputTokens: 1024,
  timeout: { totalMs: 60_000, firstChunkMs: 15_000, chunkMs: 5_000 },
} as const;

export interface AiEnv {
  AI_MODEL?: string;
  GENERATION_MODEL?: string;
  GENERATION_FALLBACK_MODEL?: string;
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
 * Provider routing is automatically applied for DeepSeek models: OpenRouter
 * tries DeepSeek's own API → NovitaAI → SiliconFlow in order, maximising
 * availability without changing the model.
 *
 * `sessionId` forwards to OpenRouter for sticky routing (prefix cache).
 * `modelId` overrides role-based resolution (used for fallback).
 */
export function selectModel(
  env: AiEnv,
  options?: { sessionId?: string; role?: ModelRole; modelId?: string },
) {
  const role = options?.role ?? "generation";
  const id = options?.modelId ?? resolveModelId(env, role);

  if (!env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }

  const extraBody: Record<string, unknown> = {};

  if (options?.sessionId) {
    extraBody.session_id = options.sessionId;
  }

  // Apply provider routing for DeepSeek models
  const providers = PROVIDER_ORDER[id];
  if (providers) {
    extraBody.provider = {
      order: providers,
      allow_fallbacks: true,
    };
  }

  if (Object.keys(extraBody).length > 0) {
    return createOpenRouter({
      apiKey: env.OPENROUTER_API_KEY,
      extraBody,
    }).chat(id);
  }

  return createOpenRouter({ apiKey: env.OPENROUTER_API_KEY }).chat(id);
}

/** Get the fallback model ID for a role, or undefined if no fallback. */
export function getFallbackModelId(
  env: AiEnv,
  role: ModelRole = "generation",
): string | undefined {
  if (role === "generation") {
    return env.GENERATION_FALLBACK_MODEL ?? FALLBACK_MODELS.generation;
  }
  return FALLBACK_MODELS[role];
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
