import { describe, it, expect } from "vitest";
import {
  selectModelId,
  selectModel,
  composeSystemPrompt,
  ALLOWED_MODELS,
  DEFAULT_MODELS,
} from "../src/index";

describe("selectModelId", () => {
  it("returns the default model when requested is omitted", () => {
    expect(selectModelId("openrouter")).toBe(DEFAULT_MODELS.openrouter);
  });

  it("returns the explicit allowed model when requested", () => {
    expect(selectModelId("openrouter", "deepseek/deepseek-chat")).toBe("deepseek/deepseek-chat");
  });

  it("throws for an unknown provider", () => {
    expect(() => selectModelId("anthropic")).toThrow(/Unknown AI provider: anthropic/);
  });

  it("throws for a disallowed model", () => {
    expect(() => selectModelId("openrouter", "openai/gpt-4o")).toThrow(
      /Model not allowed: openai\/gpt-4o/,
    );
  });

  it("only allows the whitelisted models", () => {
    expect([...ALLOWED_MODELS.openrouter]).toEqual(["deepseek/deepseek-chat"]);
  });
});

describe("selectModel", () => {
  it("throws when OPENROUTER_API_KEY is missing", () => {
    expect(() => selectModel({ AI_PROVIDER: "openrouter" })).toThrowError(
      /OPENROUTER_API_KEY is not configured/,
    );
  });

  it("throws when OPENROUTER_API_KEY is empty", () => {
    expect(() => selectModel({ AI_PROVIDER: "openrouter", OPENROUTER_API_KEY: "" })).toThrowError(
      /OPENROUTER_API_KEY is not configured/,
    );
  });

  it("throws on unknown provider before checking the key", () => {
    expect(() =>
      selectModel({ AI_PROVIDER: "deepseek", OPENROUTER_API_KEY: "sk-test" }),
    ).toThrowError(/Unknown AI provider: deepseek/);
  });
});

describe("composeSystemPrompt", () => {
  it("places safety first and keeps base then persona", () => {
    const prompt = composeSystemPrompt({
      safety: "SAFETY",
      base: "BASE",
      persona: "PERSONA",
    });
    expect(prompt).toBe("SAFETY\n\nBASE\n\nPERSONA");
  });

  it("always includes safety even when base and persona are empty", () => {
    const prompt = composeSystemPrompt({
      safety: "SAFETY",
      base: "",
      persona: "",
    });
    expect(prompt).toBe("SAFETY");
  });

  it("omits base when it is whitespace-only", () => {
    const prompt = composeSystemPrompt({
      safety: "SAFETY",
      base: "   \n\t ",
      persona: "PERSONA",
    });
    expect(prompt).toBe("SAFETY\n\nPERSONA");
  });

  it("does not let persona replace safety", () => {
    const prompt = composeSystemPrompt({
      safety: "SAFETY",
      persona: "PERSONA",
    });
    expect(prompt.startsWith("SAFETY")).toBe(true);
    expect(prompt).toBe("SAFETY\n\nPERSONA");
  });

  it("returns only safety when base and persona are undefined", () => {
    const prompt = composeSystemPrompt({ safety: "SAFETY" });
    expect(prompt).toBe("SAFETY");
  });
});
