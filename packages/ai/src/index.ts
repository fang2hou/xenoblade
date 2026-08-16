import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

// ── Model Configuration ───────────────────────────────────────────────────

export interface ModelConfig {
  id: string;
  providers?: string[];
  temperature?: number;
  maxOutputTokens?: number;
  thinking?: number;
}

export type ModelRole = "generation" | "summarization" | "transcription" | "vision";

/** Default chains used when MODEL_CONFIG env var is absent. */
const DEFAULT_CHAINS: Record<ModelRole, ModelConfig[]> = {
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
  /** JSON string of Record<ModelRole, ModelConfig[]>. Overrides defaults. */
  MODEL_CONFIG?: string;
}

/** Type guard: is the parsed JSON a partial model-chain override? */
function isChainsOverride(value: unknown): value is Partial<Record<ModelRole, ModelConfig[]>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse MODEL_CONFIG env var, fall back to DEFAULT_CHAINS. */
function loadChains(env: AiEnv): Record<ModelRole, ModelConfig[]> {
  if (!env.MODEL_CONFIG) return DEFAULT_CHAINS;
  try {
    const parsed: unknown = JSON.parse(env.MODEL_CONFIG);
    if (isChainsOverride(parsed)) {
      return { ...DEFAULT_CHAINS, ...parsed };
    }
    return DEFAULT_CHAINS;
  } catch {
    console.log(JSON.stringify({ event: "model_config_parse_error" }));
    return DEFAULT_CHAINS;
  }
}

/** Get the model chain for a role (from env or defaults). */
export function getModelChain(env: AiEnv, role: ModelRole): ModelConfig[] {
  return loadChains(env)[role] ?? [];
}

/** Create a LanguageModel from a config via OpenRouter. */
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

/** Pick the first model in the chain for the given role. */
export function selectModel(
  env: AiEnv,
  options?: { sessionId?: string; role?: ModelRole },
): LanguageModel {
  const role = options?.role ?? "generation";
  const chain = getModelChain(env, role);
  const config = chain[0] ?? { id: "openai/gpt-5.6-luna" };
  return createModel(env, config, options?.sessionId);
}

/**
 * Render the request-time clock as a system segment. Kept last so the
 * stable prefix (safety/base/persona) stays cache-friendly; only this
 * trailing segment changes day to day.
 */
function formatNowSegment(now: Date): string {
  const iso = now.toISOString();
  const weekday = now.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  return (
    `Current date: ${iso.slice(0, 10)} (${weekday}), ${iso.slice(11, 16)} UTC. ` +
    'Use this clock for every "today"/"now" reference; never infer the current ' +
    "date from training data or from dates mentioned in the conversation."
  );
}

export function composeSystemPrompt(parts: {
  safety: string;
  base?: string;
  persona?: string;
  now?: Date;
}): string {
  const segments: string[] = [];
  for (const part of [parts.safety, parts.base, parts.persona]) {
    if (part !== undefined && part.trim() !== "") segments.push(part);
  }
  if (parts.now !== undefined) {
    segments.push(formatNowSegment(parts.now));
  }
  return segments.join("\n\n");
}
