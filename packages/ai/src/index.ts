import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

// ── Model Configuration ───────────────────────────────────────────────────

export interface ModelConfig {
  /** OpenRouter model ID, e.g. "openai/gpt-5.6-luna". */
  id: string;
  /** Provider routing order. OpenRouter tries each in sequence. */
  providers?: string[];
  /** Temperature override (0–2). Omit for provider default. */
  temperature?: number;
  /** Max output tokens override. */
  maxOutputTokens?: number;
  /** Thinking/reasoning intensity (0–1) for models that support it. */
  thinking?: number;
}

export type ModelRole = "generation" | "summarization" | "transcription" | "vision";

const MODEL_CHAINS: Record<ModelRole, ModelConfig[]> = {
  generation: [
    { id: "openai/gpt-5.6-luna", temperature: 0.7 },
    { id: "deepseek/deepseek-v4-flash-0731", providers: ["DeepSeek", "NovitaAI", "SiliconFlow"] },
  ],
  summarization: [
    { id: "openai/gpt-5.6-luna" },
    { id: "deepseek/deepseek-v4-flash-0731", providers: ["DeepSeek", "NovitaAI", "SiliconFlow"] },
  ],
  transcription: [{ id: "openai/gpt-transcribe" }],
  vision: [{ id: "xiaomi/mimo-v2.5", providers: ["Xiaomi", "NovitaAI"] }],
};

export const GENERATION_LIMITS = {
  maxOutputTokens: 1024,
  timeout: { totalMs: 60_000, firstChunkMs: 15_000, chunkMs: 5_000 },
} as const;

export interface AiEnv {
  OPENROUTER_API_KEY?: string;
}

/** Resolve the model chain for a role, with optional env overrides. */
export function getModelChain(
  role: ModelRole,
  primaryOverride?: string,
  fallbackOverride?: string,
): ModelConfig[] {
  const defaults = MODEL_CHAINS[role] ?? [];
  const chain = defaults.map((c) => ({ ...c }));
  if (primaryOverride && chain.length > 0) {
    chain[0] = { ...chain[0], id: primaryOverride };
  }
  if (fallbackOverride && chain.length > 1) {
    chain[1] = { ...chain[1], id: fallbackOverride };
  }
  return chain;
}

/** Create a LanguageModel from a ModelConfig via OpenRouter. */
export function createModel(env: AiEnv, config: ModelConfig, sessionId?: string): LanguageModel {
  if (!env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }
  const extraBody: Record<string, unknown> = {};
  if (sessionId) extraBody.session_id = sessionId;
  if (config.providers) {
    extraBody.provider = { order: config.providers, allow_fallbacks: true };
  }
  if (config.thinking !== undefined) {
    extraBody.reasoning = { effort: config.thinking };
  }
  return createOpenRouter({ apiKey: env.OPENROUTER_API_KEY, extraBody }).chat(config.id);
}

/** Simple single-model selection (for non-generation roles like vision). */
export function selectModel(
  env: AiEnv,
  options?: { sessionId?: string; role?: ModelRole; modelId?: string },
): LanguageModel {
  const role = options?.role ?? "generation";
  const config: ModelConfig = options?.modelId
    ? { id: options.modelId }
    : MODEL_CHAINS[role]?.[0] ?? { id: "openai/gpt-5.6-luna" };
  return createModel(env, config, options?.sessionId);
}

export function composeSystemPrompt(parts: {
  safety: string;
  base?: string;
  persona?: string;
}): string {
  const segments: string[] = [];
  for (const part of [parts.safety, parts.base, parts.persona]) {
    if (part !== undefined && part.trim() !== "") segments.push(part);
  }
  return segments.join("\n\n");
}
