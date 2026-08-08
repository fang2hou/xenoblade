import { createOpenRouter } from "@openrouter/ai-sdk-provider";

export const ALLOWED_MODELS = {
  openrouter: new Set(["deepseek/deepseek-chat"]),
} as const;

export const DEFAULT_MODELS = {
  openrouter: "deepseek/deepseek-chat",
} as const;

export const GENERATION_LIMITS = {
  maxOutputTokens: 512,
  timeout: { totalMs: 30_000, firstChunkMs: 10_000, chunkMs: 5_000 },
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

export function selectModel(env: {
  AI_PROVIDER: string;
  AI_MODEL?: string;
  OPENROUTER_API_KEY?: string;
}) {
  const modelId = selectModelId(env.AI_PROVIDER, env.AI_MODEL);
  if (!env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured");
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
