import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateText } from "ai";
import type * as Ai from "ai";
import { GENERATION_LIMITS, type ModelConfig } from "@xenoblade/ai";
import type { GenerationRequest } from "@xenoblade/contracts";
import type * as Tools from "../src/tools";

import { generate } from "../src/generation";
import { createTestD1 } from "./helpers/d1";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof Ai>();
  return { ...actual, generateText: vi.fn() };
});

// MCP connections stay offline; the first-party tools stay real so the audit
// attributes the production tool names.
vi.mock("../src/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof Tools>();
  return {
    ...actual,
    connectMcpServers: async () => ({
      tools: { context7_resolve_library_id: {}, github_search: {} },
      clients: [],
    }),
    closeMcpClients: async () => {},
  };
});

/** One call per first-party tool and per MCP server the chain exposes. */
const CALLED_TOOLS = [
  "web_search",
  "read_url",
  "model_list",
  "vision_describe",
  "context7_resolve_library_id",
  "github_search",
];

function stubModel(): void {
  vi.mocked(generateText).mockResolvedValue({
    text: "Answer [来源](https://example.com/a).",
    usage: { inputTokens: 12, outputTokens: 34, inputTokenDetails: {} },
    toolResults: CALLED_TOOLS.map((toolName) => ({
      toolName,
      input: { query: "x" },
      output: { ok: true },
    })),
    steps: [{}],
  } as unknown as Ai.GenerateTextResult<Ai.ToolSet, never, never>);
}

function makeEnv(generation: ModelConfig[]): Env {
  return {
    DB: createTestD1(),
    INTERNAL_API_TOKEN: "test-internal-token",
    OPENROUTER_API_KEY: "test-key",
    // The model-info tools only exist when this key is configured.
    ARTIFICIAL_ANALYSIS_API_KEY: "test-key",
    MODEL_CONFIG: JSON.stringify({ generation }),
  } as Env;
}

async function allowChannels(db: D1Database, channels: string[]): Promise<void> {
  await db
    .prepare("INSERT INTO guild_config (guild_id, allow_channels_json) VALUES ('g1', ?1)")
    .bind(JSON.stringify(channels))
    .run();
}

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    messageId: "m1",
    containerId: "discord:g1:c1",
    scopeId: "g1",
    channelId: "c1",
    parentChannelId: null,
    userId: "u1",
    userDisplayName: "User",
    summonKind: "user-mention",
    content: "hello",
    history: [],
    reference: null,
    attachments: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(generateText).mockReset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generate model options", () => {
  it("passes the model's own temperature and output cap to generateText", async () => {
    const env = makeEnv([{ id: "test/primary", temperature: 0.4, maxOutputTokens: 2048 }]);
    stubModel();

    expect((await generate(env, request())).status).toBe("completed");
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0.4, maxOutputTokens: 2048 }),
    );
  });

  it("uses the shared output cap and sends no temperature when the model sets none", async () => {
    const env = makeEnv([{ id: "test/reasoning" }]);
    stubModel();
    await generate(env, request());

    const options = vi.mocked(generateText).mock.calls[0]?.[0];
    expect(options?.maxOutputTokens).toBe(GENERATION_LIMITS.maxOutputTokens);
    expect(GENERATION_LIMITS.maxOutputTokens).toBeGreaterThanOrEqual(4096);
    // Absent, not undefined: reasoning models reject an explicit temperature.
    expect(options).not.toHaveProperty("temperature");
  });
});

describe("generate tool audit", () => {
  it("records first-party tools as builtin and MCP tools under their server", async () => {
    const env = makeEnv([{ id: "test/primary" }]);
    stubModel();
    await generate(env, request());

    const { results } = await env.DB.prepare(
      "SELECT tool_name, server FROM tool_invocations ORDER BY rowid",
    ).all<{ tool_name: string; server: string }>();
    expect(results).toEqual([
      { tool_name: "web_search", server: "builtin" },
      { tool_name: "read_url", server: "builtin" },
      { tool_name: "model_list", server: "builtin" },
      { tool_name: "vision_describe", server: "builtin" },
      { tool_name: "context7_resolve_library_id", server: "context7" },
      { tool_name: "github_search", server: "github" },
    ]);
  });
});

describe("generate channel allowlist", () => {
  it("answers a thread whose parent channel is allowlisted", async () => {
    const env = makeEnv([{ id: "test/primary" }]);
    await allowChannels(env.DB, ["parent"]);
    stubModel();

    const result = await generate(env, request({ channelId: "thread", parentChannelId: "parent" }));

    expect(result.status).toBe("completed");
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("rejects a thread whose parent channel is not allowlisted", async () => {
    const env = makeEnv([{ id: "test/primary" }]);
    await allowChannels(env.DB, ["other"]);
    stubModel();

    const result = await generate(env, request({ channelId: "thread", parentChannelId: "parent" }));

    expect(result).toMatchObject({ status: "rejected", code: "disabled" });
    expect(generateText).not.toHaveBeenCalled();
  });
});
