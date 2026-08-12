import { describe, it, expect } from "vitest";
import { selectModel, composeSystemPrompt, getModelChain, createModel, type AiEnv } from "../src/index";

const baseEnv: AiEnv = { OPENROUTER_API_KEY: "test-key" };

describe("getModelChain", () => {
  it("returns default generation chain (Luna → DeepSeek)", () => {
    const chain = getModelChain("generation");
    expect(chain.length).toBeGreaterThanOrEqual(2);
    expect(chain[0].id).toBe("openai/gpt-5.6-luna");
    expect(chain[1].id).toBe("deepseek/deepseek-v4-flash-0731");
    expect(chain[1].providers).toEqual(["DeepSeek", "NovitaAI", "SiliconFlow"]);
  });

  it("supports env overrides for primary model", () => {
    const chain = getModelChain("generation", "custom/model");
    expect(chain[0].id).toBe("custom/model");
  });

  it("vision chain has MiMo with Xiaomi provider", () => {
    const chain = getModelChain("vision");
    expect(chain[0].id).toBe("xiaomi/mimo-v2.5");
    expect(chain[0].providers).toEqual(["Xiaomi", "NovitaAI"]);
  });
});

describe("createModel", () => {
  it("throws when OPENROUTER_API_KEY is missing", () => {
    expect(() => createModel({}, { id: "test/model" })).toThrow(/OPENROUTER_API_KEY/);
  });

  it("succeeds for a basic config", () => {
    expect(() => createModel(baseEnv, { id: "openai/gpt-5.6-luna" })).not.toThrow();
  });

  it("succeeds with providers and sessionId", () => {
    expect(() =>
      createModel(baseEnv, { id: "deepseek/deepseek-v4-flash-0731", providers: ["DeepSeek"] }, "session-1"),
    ).not.toThrow();
  });
});

describe("selectModel", () => {
  it("returns the first model in the generation chain", () => {
    expect(() => selectModel(baseEnv)).not.toThrow();
  });

  it("accepts explicit modelId override", () => {
    expect(() => selectModel(baseEnv, { modelId: "custom/model" })).not.toThrow();
  });
});

describe("composeSystemPrompt", () => {
  it("joins non-empty parts with double newlines", () => {
    expect(composeSystemPrompt({ safety: "Be safe.", base: "Be helpful." }))
      .toBe("Be safe.\n\nBe helpful.");
  });

  it("skips undefined parts", () => {
    expect(composeSystemPrompt({ safety: "Be safe.", base: undefined, persona: "Be concise." }))
      .toBe("Be safe.\n\nBe concise.");
  });

  it("skips whitespace-only parts", () => {
    expect(composeSystemPrompt({ safety: "Be safe.", base: "   " }))
      .toBe("Be safe.");
  });
});
