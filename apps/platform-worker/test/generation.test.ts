import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateText } from "ai";
import type * as Ai from "ai";
import { GENERATION_LIMITS, type ModelConfig } from "@xenoblade/ai";
import type { GenerationRequest, GenerationResult } from "@xenoblade/contracts";
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

/** Drive the pipeline through every hang and pause it waits on (fake timers), then read its answer. */
async function settleRun(run: Promise<GenerationResult>): Promise<GenerationResult> {
  await vi.advanceTimersByTimeAsync(200_000);
  return run;
}

/** Wait `ms` of faked time, as an attempt stuck until its timeout does. */
function hang(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** The interaction row a single-run test leaves behind. */
async function recordedRun(db: D1Database): Promise<{ status: string; total_duration_ms: number }> {
  const { results } = await db
    .prepare("SELECT status, total_duration_ms FROM interactions")
    .all<{ status: string; total_duration_ms: number }>();
  return results[0] ?? { status: "missing", total_duration_ms: -1 };
}

describe("generate chain deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives every attempt only the time the chain has left, and still answers in time", async () => {
    const env = makeEnv([{ id: "test/a" }, { id: "test/b" }, { id: "test/c" }]);
    const timeouts: number[] = [];
    // Each attempt hangs for its whole timeout and then times out, as the SDK does.
    vi.mocked(generateText).mockImplementation(async ({ timeout }) => {
      const ms = typeof timeout === "number" ? timeout : 0;
      timeouts.push(ms);
      await hang(ms);
      throw new DOMException(`timeout of ${ms}ms exceeded`, "TimeoutError");
    });

    const result = await settleRun(generate(env, request()));

    // 135s budget: 60s + 3s pause + 60s + 3s pause leaves 9s for the last model.
    expect(timeouts).toEqual([60_000, 60_000, 9_000]);
    expect(result).toMatchObject({ status: "error", code: "TimeoutError", retryable: true });
    // The Worker answers at its deadline, 15s before the Runtime would give up.
    expect(await recordedRun(env.DB)).toEqual({ status: "timeout", total_duration_ms: 135_000 });
  });

  it("cuts off an attempt that outlives the chain's deadline", async () => {
    const env = makeEnv([{ id: "test/a" }, { id: "test/b" }]);
    // A tool that ignores its abort signal keeps the first attempt hanging
    // far beyond both its own timeout and the chain's deadline.
    vi.mocked(generateText).mockImplementationOnce(async () => {
      await hang(300_000);
      throw new Error("never reached");
    });

    const result = await settleRun(generate(env, request()));

    // Cut at the deadline with no pause or second attempt, and still a structured answer.
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "error",
      code: "GenerationDeadlineError",
      retryable: true,
    });
    expect(await recordedRun(env.DB)).toEqual({ status: "timeout", total_duration_ms: 135_000 });
  });

  it("gives up instead of starting an attempt the chain has no time for", async () => {
    const env = makeEnv([{ id: "test/a" }, { id: "test/b" }]);
    // The first attempt outlives its own timeout.
    vi.mocked(generateText).mockImplementationOnce(async () => {
      await hang(131_000);
      throw new Error("hung");
    });

    const result = await settleRun(generate(env, request()));

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "error",
      code: "GenerationDeadlineError",
      retryable: true,
    });
    expect(await recordedRun(env.DB)).toEqual({ status: "timeout", total_duration_ms: 134_000 });
  });
});
