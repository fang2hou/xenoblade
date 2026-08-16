import { describe, it, expect } from "vitest";
import {
  selectModel,
  composeSystemPrompt,
  getModelChain,
  createModel,
  type AiEnv,
} from "../src/index";

const baseEnv: AiEnv = { OPENROUTER_API_KEY: "test-key" };

describe("getModelChain", () => {
  it("returns default generation chain (Luna → DeepSeek)", () => {
    const chain = getModelChain(baseEnv, "generation");
    expect(chain.length).toBeGreaterThanOrEqual(2);
    expect(chain[0]?.id).toBe("openai/gpt-5.6-luna");
    expect(chain[1]?.id).toBe("deepseek/deepseek-v4-flash-0731");
    expect(chain[1]?.providers).toEqual(["DeepSeek", "NovitaAI", "SiliconFlow"]);
  });

  it("vision chain has MiMo with Xiaomi provider", () => {
    const chain = getModelChain(baseEnv, "vision");
    expect(chain[0]?.id).toBe("xiaomi/mimo-v2.5");
    expect(chain[0]?.providers).toEqual(["Xiaomi", "NovitaAI"]);
  });

  it("reads from MODEL_CONFIG env var", () => {
    const env: AiEnv = {
      OPENROUTER_API_KEY: "key",
      MODEL_CONFIG: JSON.stringify({ generation: [{ id: "custom/model" }] }),
    };
    const chain = getModelChain(env, "generation");
    expect(chain[0]?.id).toBe("custom/model");
  });
});

describe("createModel", () => {
  it("throws when OPENROUTER_API_KEY is missing", () => {
    expect(() => createModel({}, { id: "test/model" })).toThrow(/OPENROUTER_API_KEY/);
  });

  it("succeeds for a basic config", () => {
    expect(() => createModel(baseEnv, { id: "openai/gpt-5.6-luna" })).not.toThrow();
  });
});

describe("selectModel", () => {
  it("picks first model in generation chain", () => {
    expect(() => selectModel(baseEnv)).not.toThrow();
  });

  it("picks vision model for vision role", () => {
    expect(() => selectModel(baseEnv, { role: "vision" })).not.toThrow();
  });
});

describe("composeSystemPrompt", () => {
  it("joins non-empty parts", () => {
    expect(composeSystemPrompt({ safety: "Be safe.", base: "Be helpful." })).toBe(
      "Be safe.\n\nBe helpful.",
    );
  });

  it("skips undefined parts", () => {
    expect(composeSystemPrompt({ safety: "Be safe.", persona: "Be concise." })).toBe(
      "Be safe.\n\nBe concise.",
    );
  });
});
