import { describe, it, expect } from "vitest";
import { selectModel, composeSystemPrompt, type AiEnv } from "../src/index";

const baseEnv: AiEnv = { OPENROUTER_API_KEY: "test-key" };

describe("selectModel", () => {
  it("throws when OPENROUTER_API_KEY is missing", () => {
    expect(() => selectModel({})).toThrow(/OPENROUTER_API_KEY/);
  });

  it("throws when OPENROUTER_API_KEY is empty", () => {
    expect(() => selectModel({ OPENROUTER_API_KEY: "" })).toThrow(
      /OPENROUTER_API_KEY/,
    );
  });

  it("succeeds for generation role (default)", () => {
    expect(() => selectModel(baseEnv)).not.toThrow();
  });

  it("succeeds for summarization role", () => {
    expect(() => selectModel(baseEnv, { role: "summarization" })).not.toThrow();
  });

  it("succeeds with a sessionId option", () => {
    expect(() =>
      selectModel(baseEnv, { sessionId: "xenoblade:test-container" }),
    ).not.toThrow();
  });

  it("prefers GENERATION_MODEL over legacy AI_MODEL", () => {
    const env: AiEnv = {
      ...baseEnv,
      AI_MODEL: "deepseek/deepseek-chat",
      GENERATION_MODEL: "openai/gpt-5.6-luna",
    };
    // Both should work without throwing — model ID resolution is internal.
    expect(() => selectModel(env)).not.toThrow();
    expect(() => selectModel({ ...baseEnv, AI_MODEL: "deepseek/deepseek-chat" })).not.toThrow();
  });
});

describe("composeSystemPrompt", () => {
  it("joins non-empty parts with double newlines", () => {
    const result = composeSystemPrompt({
      safety: "Be safe.",
      base: "Be helpful.",
    });
    expect(result).toBe("Be safe.\n\nBe helpful.");
  });

  it("skips undefined parts", () => {
    const result = composeSystemPrompt({
      safety: "Be safe.",
      base: undefined,
      persona: "Be concise.",
    });
    expect(result).toBe("Be safe.\n\nBe concise.");
  });

  it("skips empty/whitespace parts", () => {
    const result = composeSystemPrompt({
      safety: "Be safe.",
      base: "   ",
    });
    expect(result).toBe("Be safe.");
  });

  it("returns safety alone when others are empty", () => {
    const result = composeSystemPrompt({ safety: "Be safe." });
    expect(result).toBe("Be safe.");
  });
});
