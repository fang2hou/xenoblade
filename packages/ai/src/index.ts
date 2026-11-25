import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

// ── Model Configuration ───────────────────────────────────────────────────

export type ModelProvider = "hyper" | "openrouter";

export type ReasoningEffort = "low" | "high" | "max";

export interface ModelConfig {
  id: string;
  /** Backend provider. Defaults to `"openrouter"` when omitted (preserves MODEL_CONFIG compatibility). */
  provider?: ModelProvider;
  /** OpenRouter provider routing preference (unused on Charm Hyper). */
  providers?: string[];
  temperature?: number;
  maxOutputTokens?: number;
  /** OpenRouter numeric thinking effort, or Charm Hyper `reasoning_effort` ("low" | "high" | "max"). */
  thinking?: number | ReasoningEffort;
  /** Whether this model accepts native image URL parts directly. */
  vision?: boolean;
}

export type ModelRole = "generation" | "summarization" | "transcription" | "vision";

/** Charm Hyper OpenAI-compatible Chat Completions endpoint for DeepSeek models. */
export const HYPER_BASE_URL = "https://hyper.charm.land/v1";

/** Head of the default OpenRouter generation and summarization chains (ADR-004 amendment). */
const DEFAULT_PRIMARY_MODEL = "deepseek/deepseek-v4.1-flash-1017";

/** Charm Hyper DeepSeek models: economy primary, standard fallback. */
const HYPER_PRIMARY_MODEL = "deepseek-v4.1-flash-1017-economy";
const HYPER_FALLBACK_MODEL = "deepseek-v4.1-flash-1017";

/**
 * Default OpenRouter model chains, used when `HYPER_API_KEY` is unset and as
 * cross-provider fallback when both keys are present.
 */
const OPENROUTER_DEFAULT_CHAINS: Record<ModelRole, ModelConfig[]> = {
  generation: [
    { id: DEFAULT_PRIMARY_MODEL, temperature: 0.7 },
    { id: "deepseek/deepseek-v4-flash-0731", providers: ["DeepSeek", "NovitaAI", "SiliconFlow"] },
  ],
  summarization: [
    { id: DEFAULT_PRIMARY_MODEL },
    { id: "deepseek/deepseek-v4-flash-0731", providers: ["DeepSeek", "NovitaAI", "SiliconFlow"] },
  ],
  transcription: [{ id: "openai/gpt-transcribe" }],
  vision: [{ id: "xiaomi/mimo-v2.5", providers: ["Xiaomi", "NovitaAI"] }],
};

export const GENERATION_LIMITS = {
  maxOutputTokens: 4096,
  timeout: { totalMs: 60_000, firstChunkMs: 15_000, chunkMs: 5_000 },
} as const;

/**
 * Elevated generation budget for owner-only server administration sessions,
 * which combine DeepSeek reasoning with bulk planning tool calls. No short
 * per-step timeout is imposed because a single reasoning + batch-planning step
 * routinely takes 50–90s on OpenRouter.
 */
export const ADMIN_GENERATION_LIMITS = {
  maxOutputTokens: 16_384,
  timeout: { totalMs: 120_000 },
} as const;

export interface AiEnv {
  HYPER_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  /** JSON string of a partial Record<ModelRole, ModelConfig[]>. Overrides
   * the listed roles' chains; unset by default, so default chains apply. */
  MODEL_CONFIG?: string;
}

function hasKey(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

/** Build the active default chains based on configured provider API keys. */
function defaultChainsForEnv(env: AiEnv): Record<ModelRole, ModelConfig[]> {
  if (!hasKey(env.HYPER_API_KEY)) {
    return OPENROUTER_DEFAULT_CHAINS;
  }
  const hasOpenRouter = hasKey(env.OPENROUTER_API_KEY);
  return {
    generation: [
      { id: HYPER_PRIMARY_MODEL, provider: "hyper", temperature: 0.7, vision: true },
      { id: HYPER_FALLBACK_MODEL, provider: "hyper", vision: true },
      ...(hasOpenRouter
        ? [
            {
              id: DEFAULT_PRIMARY_MODEL,
              provider: "openrouter" as const,
              temperature: 0.7,
              vision: true,
            },
          ]
        : []),
    ],
    summarization: [
      { id: HYPER_PRIMARY_MODEL, provider: "hyper", thinking: "low" },
      { id: HYPER_FALLBACK_MODEL, provider: "hyper", thinking: "low" },
      ...(hasOpenRouter ? [{ id: DEFAULT_PRIMARY_MODEL, provider: "openrouter" as const }] : []),
    ],
    transcription: OPENROUTER_DEFAULT_CHAINS.transcription,
    vision: hasOpenRouter
      ? OPENROUTER_DEFAULT_CHAINS.vision
      : [{ id: HYPER_PRIMARY_MODEL, provider: "hyper", vision: true }],
  };
}

/** Type guard: is the parsed JSON a partial model-chain override? */
function isChainsOverride(value: unknown): value is Partial<Record<ModelRole, ModelConfig[]>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse MODEL_CONFIG env var, fall back to active default chains. */
function loadChains(env: AiEnv): Record<ModelRole, ModelConfig[]> {
  const defaults = defaultChainsForEnv(env);
  if (!env.MODEL_CONFIG) return defaults;
  try {
    const parsed: unknown = JSON.parse(env.MODEL_CONFIG);
    if (isChainsOverride(parsed)) {
      return { ...defaults, ...parsed };
    }
    return defaults;
  } catch {
    console.log(JSON.stringify({ event: "model_config_parse_error" }));
    return defaults;
  }
}

/** Get the model chain for a role (from env or defaults). */
export function getModelChain(env: AiEnv, role: ModelRole): ModelConfig[] {
  return loadChains(env)[role] ?? [];
}

/** Create a LanguageModel from a config via Charm Hyper or OpenRouter. */
export function createModel(env: AiEnv, config: ModelConfig, sessionId?: string): LanguageModel {
  const provider = config.provider ?? "openrouter";
  if (provider === "hyper") {
    const apiKey = env.HYPER_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("HYPER_API_KEY is not configured");
    }
    const reasoningEffort = typeof config.thinking === "string" ? config.thinking : undefined;
    return createOpenAICompatible({
      name: "hyper",
      baseURL: HYPER_BASE_URL,
      apiKey,
      includeUsage: true,
      ...(reasoningEffort !== undefined
        ? {
            transformRequestBody: (body) => ({
              ...body,
              reasoning_effort: reasoningEffort,
            }),
          }
        : {}),
    }).chatModel(config.id);
  }

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
  const fallback: ModelConfig =
    hasKey(env.HYPER_API_KEY) &&
    (role === "generation" ||
      role === "summarization" ||
      (role === "vision" && !hasKey(env.OPENROUTER_API_KEY)))
      ? { id: HYPER_PRIMARY_MODEL, provider: "hyper" }
      : { id: DEFAULT_PRIMARY_MODEL };
  const config = chain[0] ?? fallback;
  return createModel(env, config, options?.sessionId);
}

/**
 * Render the request-time clock as a system segment. Kept last so the
 * stable prefix (safety/base/soul/guild memory/persona) stays cache-friendly;
 * only this trailing segment changes day to day.
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
  /** Persona and voice: who the bot is and how it speaks. Changes only when
   * the soul is edited, so it belongs to the stable prefix, ahead of the
   * per-user persona. */
  soul?: string;
  /** Shared memory of the guild the conversation runs in. Identical for
   * every member of the guild, so it sits ahead of the per-user persona and
   * keeps that prefix cache-friendly across members. Never set for a DM. */
  guildMemory?: string;
  persona?: string;
  now?: Date;
}): string {
  const segments: string[] = [];
  for (const part of [parts.safety, parts.base, parts.soul, parts.guildMemory, parts.persona]) {
    if (part !== undefined && part.trim() !== "") segments.push(part);
  }
  if (parts.now !== undefined) {
    segments.push(formatNowSegment(parts.now));
  }
  return segments.join("\n\n");
}
