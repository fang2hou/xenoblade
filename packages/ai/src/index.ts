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
  maxOutputTokens: 163_840,
  timeout: { totalMs: 60_000, firstChunkMs: 15_000, chunkMs: 5_000 },
} as const;

/**
 * Elevated generation budget for owner-only server administration sessions,
 * which combine DeepSeek reasoning with bulk planning tool calls. No short
 * per-step timeout is imposed because a single reasoning + batch-planning step
 * routinely takes 50–90s on OpenRouter.
 */
export const ADMIN_GENERATION_LIMITS = {
  maxOutputTokens: 327_680,
  timeout: { totalMs: 120_000 },
} as const;

/**
 * Verified per-provider model output token ceilings (from Charm Hyper
 * `/v1/models` and OpenRouter `/api/v1/models`). Used to clamp requested
 * `maxOutputTokens` so fallback or `MODEL_CONFIG`-overridden models with a
 * lower hard ceiling (e.g. Charm Hyper `deepseek-v4.1-flash-1017` at 262,144
 * on an admin turn requesting 327,680) never receive a 400 Bad Request.
 */
export const MODEL_MAX_OUTPUT_TOKENS: Readonly<Record<string, number>> = {
  "hyper:deepseek-v4.1-flash-1017-economy": 384_000,
  "hyper:deepseek-v4.1-flash-1017": 262_144,
  "hyper:deepseek-v4-pro-0813": 262_144,
  "hyper:prism": 131_072,
  "hyper:prism-core": 131_072,
  "hyper:prism-flash": 131_072,
  "hyper:kimi-k3.1-pro": 262_144,
  "hyper:kimi-k3": 16_000,
  "hyper:glm-5.3": 128_000,
  "hyper:glm-5.3-flash": 131_072,
  "hyper:qwen4-max": 128_000,
  "hyper:qwen3.8-max": 65_536,
  "hyper:qwen3.8-flash": 128_000,
  "hyper:gpt-oss-120b": 13_107,
  "hyper:gemma-4-26b-a4b-it": 25_600,
  "openrouter:deepseek/deepseek-v4.1-flash-1017": 393_216,
  "openrouter:deepseek/deepseek-v4-flash-0731": 943_718,
  "openrouter:xiaomi/mimo-v2.6-flash-mopd": 32_768,
};

/** Known hard output token ceiling for a model/provider pair, or undefined when unknown. */
export function getModelMaxOutputTokens(
  config: Pick<ModelConfig, "id" | "provider">,
): number | undefined {
  const provider = config.provider ?? "openrouter";
  return MODEL_MAX_OUTPUT_TOKENS[`${provider}:${config.id}`];
}

/**
 * Resolve effective `maxOutputTokens` for a call: respect an explicit per-model
 * override (`config.maxOutputTokens`) when set, otherwise `defaultMaxOutputTokens`,
 * and always clamp to the model's known hard provider ceiling when one exists.
 */
export function resolveMaxOutputTokens(
  config: ModelConfig | undefined,
  defaultMaxOutputTokens: number,
): number {
  const desired = config?.maxOutputTokens ?? defaultMaxOutputTokens;
  const ceiling = config !== undefined ? getModelMaxOutputTokens(config) : undefined;
  return ceiling !== undefined ? Math.min(desired, ceiling) : desired;
}

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
      {
        id: HYPER_PRIMARY_MODEL,
        provider: "hyper",
        temperature: 0.7,
        thinking: "low",
        vision: true,
      },
      { id: HYPER_FALLBACK_MODEL, provider: "hyper", thinking: "low", vision: true },
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
    const ceiling = getModelMaxOutputTokens(config);
    return createOpenAICompatible({
      name: "hyper",
      baseURL: HYPER_BASE_URL,
      apiKey,
      includeUsage: true,
      ...(reasoningEffort !== undefined || ceiling !== undefined
        ? {
            transformRequestBody: (body) => {
              const next: Record<string, unknown> = { ...body };
              if (reasoningEffort !== undefined) {
                next.reasoning_effort = reasoningEffort;
              }
              if (ceiling !== undefined) {
                if (typeof next.max_tokens === "number" && next.max_tokens > ceiling) {
                  next.max_tokens = ceiling;
                }
                if (
                  typeof next.max_completion_tokens === "number" &&
                  next.max_completion_tokens > ceiling
                ) {
                  next.max_completion_tokens = ceiling;
                }
              }
              return next;
            },
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
