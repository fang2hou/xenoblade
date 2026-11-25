import { afterEach, describe, it, expect, vi } from "vitest";
import { generateText, isStepCount, jsonSchema, tool } from "ai";
import {
  selectModel,
  composeSystemPrompt,
  getModelChain,
  createModel,
  HYPER_BASE_URL,
  type AiEnv,
} from "../src/index";

const baseEnv: AiEnv = { OPENROUTER_API_KEY: "test-key" };
const hyperOnlyEnv: AiEnv = { HYPER_API_KEY: "test-hyper-key" };
const dualEnv: AiEnv = { HYPER_API_KEY: "test-hyper-key", OPENROUTER_API_KEY: "test-or-key" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

  it("routes generation and summarization through Charm Hyper when HYPER_API_KEY is set", () => {
    expect(getModelChain(hyperOnlyEnv, "generation")).toEqual([
      {
        id: "deepseek-v4.1-flash-1017-economy",
        provider: "hyper",
        temperature: 0.7,
        thinking: "low",
        vision: true,
      },
      {
        id: "deepseek-v4.1-flash-1017",
        provider: "hyper",
        thinking: "low",
        vision: true,
      },
    ]);
    expect(getModelChain(hyperOnlyEnv, "summarization")).toEqual([
      { id: "deepseek-v4.1-flash-1017-economy", provider: "hyper", thinking: "low" },
      { id: "deepseek-v4.1-flash-1017", provider: "hyper", thinking: "low" },
    ]);
    expect(getModelChain(hyperOnlyEnv, "vision")).toEqual([
      { id: "deepseek-v4.1-flash-1017-economy", provider: "hyper", vision: true },
    ]);
  });

  it("appends OpenRouter fallback and keeps MiMo vision when both HYPER_API_KEY and OPENROUTER_API_KEY are set", () => {
    expect(getModelChain(dualEnv, "generation")).toEqual([
      {
        id: "deepseek-v4.1-flash-1017-economy",
        provider: "hyper",
        temperature: 0.7,
        thinking: "low",
        vision: true,
      },
      {
        id: "deepseek-v4.1-flash-1017",
        provider: "hyper",
        thinking: "low",
        vision: true,
      },
      {
        id: "deepseek/deepseek-v4.1-flash-1017",
        provider: "openrouter",
        temperature: 0.7,
        vision: true,
      },
    ]);
    expect(getModelChain(dualEnv, "summarization")).toEqual([
      { id: "deepseek-v4.1-flash-1017-economy", provider: "hyper", thinking: "low" },
      { id: "deepseek-v4.1-flash-1017", provider: "hyper", thinking: "low" },
      { id: "deepseek/deepseek-v4.1-flash-1017", provider: "openrouter" },
    ]);
    expect(getModelChain(dualEnv, "vision")).toEqual([
      { id: "xiaomi/mimo-v2.5", providers: ["Xiaomi", "NovitaAI"] },
    ]);
  });

  it("treats blank HYPER_API_KEY as unset and stays on OpenRouter defaults", () => {
    const blankHyper: AiEnv = { HYPER_API_KEY: "   ", OPENROUTER_API_KEY: "test-key" };
    expect(getModelChain(blankHyper, "generation")).toEqual(getModelChain(baseEnv, "generation"));
  });
});

describe("createModel", () => {
  it("throws when OPENROUTER_API_KEY is missing", () => {
    expect(() => createModel({}, { id: "test/model" })).toThrow(/OPENROUTER_API_KEY/);
  });

  it("throws when HYPER_API_KEY is missing for a Charm Hyper model", () => {
    expect(() =>
      createModel(baseEnv, { id: "deepseek-v4.1-flash-1017-economy", provider: "hyper" }),
    ).toThrow(/HYPER_API_KEY/);
  });

  it("succeeds for a basic OpenRouter config and a Charm Hyper config", () => {
    expect(() => createModel(baseEnv, { id: "deepseek/deepseek-v4.1-flash-1017" })).not.toThrow();
    const hyperModel = createModel(hyperOnlyEnv, {
      id: "deepseek-v4.1-flash-1017-economy",
      provider: "hyper",
    });
    expect(hyperModel).toMatchObject({
      modelId: "deepseek-v4.1-flash-1017-economy",
      provider: "hyper.chat",
    });
  });

  it("executes multi-step tool calling against Charm Hyper, preserving reasoning_content, reasoning_effort, and usage.cost.usd compatibility", async () => {
    const requests: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const headers = new Headers(init?.headers);
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        requests.push({ url, auth: headers.get("authorization"), body });

        if (requests.length === 1) {
          return Response.json({
            id: "chatcmpl-step-1",
            object: "chat.completion",
            created: 1_795_610_000,
            model: "deepseek-v4.1-flash-1017-economy",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  reasoning_content: "Let me call echo_tool first.",
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: { name: "echo_tool", arguments: JSON.stringify({ q: "ping" }) },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: {
              prompt_tokens: 120,
              completion_tokens: 45,
              total_tokens: 165,
              prompt_tokens_details: { cached_tokens: 80 },
              completion_tokens_details: { reasoning_tokens: 30 },
              cost: { usd: 0.00012 },
            },
          });
        }

        return Response.json({
          id: "chatcmpl-step-2",
          object: "chat.completion",
          created: 1_795_610_001,
          model: "deepseek-v4.1-flash-1017-economy",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Pong from Charm Hyper.",
                reasoning_content: "Tool returned pong.",
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 180,
            completion_tokens: 25,
            total_tokens: 205,
            prompt_tokens_details: { cached_tokens: 120 },
            completion_tokens_details: { reasoning_tokens: 10 },
            cost: { usd: 0.00008 },
          },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const model = createModel(hyperOnlyEnv, {
      id: "deepseek-v4.1-flash-1017-economy",
      provider: "hyper",
      thinking: "low",
    });

    const result = await generateText({
      model,
      prompt: "Say ping via tool",
      tools: {
        echo_tool: tool({
          description: "Echo input",
          inputSchema: jsonSchema<{ q: string }>({
            type: "object",
            properties: { q: { type: "string" } },
            required: ["q"],
          }),
          execute: async ({ q }) => ({ reply: `${q}:pong` }),
        }),
      },
      stopWhen: isStepCount(4),
      maxOutputTokens: 16_384,
    });

    expect(result.text).toBe("Pong from Charm Hyper.");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(`${HYPER_BASE_URL}/chat/completions`);
    expect(requests[0]?.auth).toBe("Bearer test-hyper-key");
    expect(requests[0]?.body.reasoning_effort).toBe("low");
    expect(requests[0]?.body.max_tokens).toBe(16_384);

    // Step 2 must carry the assistant's prior reasoning_content alongside tool_calls.
    const step2Messages = requests[1]?.body.messages as Array<Record<string, unknown>>;
    const assistantMsg = step2Messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toMatchObject({
      role: "assistant",
      reasoning_content: "Let me call echo_tool first.",
    });
    expect(Array.isArray(assistantMsg?.tool_calls)).toBe(true);

    // Usage & cache metrics parsed cleanly despite Charm Hyper's object-shaped usage.cost.
    expect(result.totalUsage.inputTokens).toBe(300);
    expect(result.totalUsage.outputTokens).toBe(70);
    expect(result.totalUsage.inputTokenDetails.cacheReadTokens).toBe(200);
    expect(result.totalUsage.outputTokenDetails.reasoningTokens).toBe(40);
  });
});

describe("selectModel", () => {
  it("picks the head of the default generation chain", () => {
    expect(selectModel(baseEnv)).toMatchObject({
      modelId: "deepseek/deepseek-v4.1-flash-1017",
    });
  });

  it("picks Charm Hyper economy model when HYPER_API_KEY is set", () => {
    expect(selectModel(hyperOnlyEnv)).toMatchObject({
      modelId: "deepseek-v4.1-flash-1017-economy",
      provider: "hyper.chat",
    });
    expect(selectModel(hyperOnlyEnv, { role: "summarization" })).toMatchObject({
      modelId: "deepseek-v4.1-flash-1017-economy",
      provider: "hyper.chat",
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
