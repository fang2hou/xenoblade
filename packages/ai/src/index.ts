import { createOpenRouter } from "@openrouter/ai-sdk-provider";

export type ModelRole = "generation" | "summarization" | "transcription" | "vision";

// Primary: Luna (native multimodal — can see images directly).
// Fallback: DeepSeek V4 Flash (text-only — uses vision_describe tool instead).
const DEFAULT_ROLE_MODELS: Record<ModelRole, string> = {
  generation: "openai/gpt-5.6-luna",
  summarization: "openai/gpt-5.6-luna",
  transcription: "openai/gpt-transcribe",
  vision: "xiaomi/mimo-v2.5",
};

const FALLBACK_MODELS: Record<ModelRole, string | undefined> = {
  generation: "deepseek/deepseek-v4-flash-0731",
  summarization: undefined,
  transcription: undefined,
  vision: undefined,
};

// Provider routing: try the source provider first, then alternates.
const PROVIDER_ORDER: Record<string, string[]> = {
  "deepseek/deepseek-v4-flash-0731": ["DeepSeek", "NovitaAI", "SiliconFlow"],
  "xiaomi/mimo-v2.5": ["Xiaomi", "NovitaAI"],
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
  VISION_MODEL?: string;
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
    case "vision":
      return env.VISION_MODEL ?? DEFAULT_ROLE_MODELS.vision;
  }
}

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
  if (options?.sessionId) extraBody.session_id = options.sessionId;

  const providers = PROVIDER_ORDER[id];
  if (providers) {
    extraBody.provider = { order: providers, allow_fallbacks: true };
  }

  if (Object.keys(extraBody).length > 0) {
    return createOpenRouter({ apiKey: env.OPENROUTER_API_KEY, extraBody }).chat(id);
  }
  return createOpenRouter({ apiKey: env.OPENROUTER_API_KEY }).chat(id);
}

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
