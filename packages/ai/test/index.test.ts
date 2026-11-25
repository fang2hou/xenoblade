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
  it("returns the default generation chain (DeepSeek V4.1 Flash → V4 Flash)", () => {
    const chain = getModelChain(baseEnv, "generation");
    expect(chain).toEqual([
      { id: "deepseek/deepseek-v4.1-flash-1017", temperature: 0.7 },
      {
        id: "deepseek/deepseek-v4-flash-0731",
        providers: ["DeepSeek", "NovitaAI", "SiliconFlow"],
      },
    ]);
  });

  it("returns the default summarization chain, led by the same model without a temperature", () => {
    const chain = getModelChain(baseEnv, "summarization");
    expect(chain).toEqual([
      { id: "deepseek/deepseek-v4.1-flash-1017" },
      {
        id: "deepseek/deepseek-v4-flash-0731",
        providers: ["DeepSeek", "NovitaAI", "SiliconFlow"],
      },
    ]);
  });

  it("leaves the transcription chain on the speech-to-text model", () => {
    expect(getModelChain(baseEnv, "transcription")).toEqual([{ id: "openai/gpt-transcribe" }]);
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

  it("falls back to the default chains for roles an override leaves out", () => {
    const env: AiEnv = {
      OPENROUTER_API_KEY: "key",
      MODEL_CONFIG: JSON.stringify({ generation: [{ id: "custom/model" }] }),
    };
    expect(getModelChain(env, "summarization")).toEqual(getModelChain(baseEnv, "summarization"));
    expect(getModelChain(env, "vision")).toEqual(getModelChain(baseEnv, "vision"));
  });

  it("falls back to the default chains when MODEL_CONFIG is not valid JSON", () => {
    const env: AiEnv = { OPENROUTER_API_KEY: "key", MODEL_CONFIG: "{not json" };
    expect(getModelChain(env, "generation")).toEqual(getModelChain(baseEnv, "generation"));
  });
});

describe("createModel", () => {
  it("throws when OPENROUTER_API_KEY is missing", () => {
    expect(() => createModel({}, { id: "test/model" })).toThrow(/OPENROUTER_API_KEY/);
  });

  it("succeeds for a basic config", () => {
    expect(() => createModel(baseEnv, { id: "deepseek/deepseek-v4.1-flash-1017" })).not.toThrow();
  });
});

describe("selectModel", () => {
  it("picks the head of the default generation chain", () => {
    expect(selectModel(baseEnv)).toMatchObject({
      modelId: "deepseek/deepseek-v4.1-flash-1017",
    });
  });

  it("falls back to the primary model when a role's chain is empty", () => {
    const env: AiEnv = {
      OPENROUTER_API_KEY: "key",
      MODEL_CONFIG: JSON.stringify({ generation: [] }),
    };
    expect(selectModel(env)).toMatchObject({ modelId: "deepseek/deepseek-v4.1-flash-1017" });
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

  it("places the soul after the base guidance and before the persona", () => {
    const prompt = composeSystemPrompt({
      safety: "Safety.",
      base: "Memory guidance.",
      soul: "Soul.",
      persona: "Known about the user.",
    });
    expect(prompt).toBe("Safety.\n\nMemory guidance.\n\nSoul.\n\nKnown about the user.");
  });

  it("places the guild's shared memory after the soul and before the persona", () => {
    const prompt = composeSystemPrompt({
      safety: "Safety.",
      base: "Memory guidance.",
      soul: "Soul.",
      guildMemory: "Shared memory.",
      persona: "Known about the user.",
    });
    expect(prompt).toBe(
      "Safety.\n\nMemory guidance.\n\nSoul.\n\nShared memory.\n\nKnown about the user.",
    );
  });

  it("skips an empty soul", () => {
    expect(composeSystemPrompt({ safety: "Safety.", soul: "  ", persona: "Persona." })).toBe(
      "Safety.\n\nPersona.",
    );
  });

  it("appends the clock segment last when now is provided", () => {
    const prompt = composeSystemPrompt({
      safety: "Be safe.",
      persona: "Be concise.",
      now: new Date("2026-08-17T14:32:00.000Z"),
    });
    expect(prompt).toBe(
      "Be safe.\n\nBe concise.\n\n" +
        "Current date: 2026-08-17 (Monday), 14:32 UTC. " +
        'Use this clock for every "today"/"now" reference; never infer the current ' +
        "date from training data or from dates mentioned in the conversation.",
    );
  });

  it("omits the clock segment when now is undefined", () => {
    expect(composeSystemPrompt({ safety: "Be safe." })).toBe("Be safe.");
  });
});
