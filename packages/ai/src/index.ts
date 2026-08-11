import { createOpenRouter } from "@openrouter/ai-sdk-provider";

export const ALLOWED_MODELS = {
  openrouter: new Set(["openai/gpt-5.6-luna", "deepseek/deepseek-chat"]),
} as const;

export const DEFAULT_MODELS = {
  openrouter: "openai/gpt-5.6-luna",
} as const;

export const GENERATION_LIMITS = {
  maxOutputTokens: 1024,
  timeout: { totalMs: 60_000, firstChunkMs: 15_000, chunkMs: 5_000 },
} as const;

export function selectModelId(provider: string, requested?: string): string {
  if (provider !== "openrouter") {
    throw new Error(`Unknown AI provider: ${provider}`);
  }
  if (requested === undefined) {
    return DEFAULT_MODELS.openrouter;
  }
  if (!ALLOWED_MODELS.openrouter.has(requested)) {
    throw new Error(`Model not allowed: ${requested}`);
  }
  return requested;
}

/**
 * Selects an AI model for the configured provider.
 *
 * When `options.sessionId` is provided, it is forwarded to OpenRouter via
 * `extraBody.session_id` to enable provider sticky routing, which improves
 * DeepSeek automatic prefix-cache hit rates across turns for the same
 * conversation container. The caller is responsible for keeping the session
 * id stable (e.g. `xenoblade:${containerId}`) and under 256 characters.
 */
export function selectModel(
  env: {
    AI_PROVIDER: string;
    AI_MODEL?: string;
    OPENROUTER_API_KEY?: string;
  },
  options?: { sessionId?: string },
) {
  const modelId = selectModelId(env.AI_PROVIDER, env.AI_MODEL);
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
