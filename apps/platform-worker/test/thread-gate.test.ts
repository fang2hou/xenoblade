import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateText } from "ai";
import type * as Ai from "ai";
import type * as AiPackage from "@xenoblade/ai";
import type { ThreadShouldReplyRequest } from "@xenoblade/contracts";

import worker from "../src/index";
import { handleThreadShouldReply, parseGateDecision } from "../src/thread-gate";
import { createTestD1 } from "./helpers/d1";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof Ai>();
  return { ...actual, generateText: vi.fn() };
});

vi.mock("@xenoblade/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof AiPackage>();
  return {
    ...actual,
    createModel: vi.fn((_env, config) => ({ modelId: config.id }) as unknown as Ai.LanguageModel),
  };
});

const TOKEN = "test-internal-token";

function makeEnv(db = createTestD1()): Env {
  return {
    DB: db,
    INTERNAL_API_TOKEN: TOKEN,
    OPENROUTER_API_KEY: "test-key",
    MODEL_CONFIG: JSON.stringify({
      summarization: [{ id: "test/primary-gate" }, { id: "test/fallback-gate" }],
    }),
  } as Env;
}

function validBody(overrides: Partial<ThreadShouldReplyRequest> = {}): ThreadShouldReplyRequest {
  return {
    scopeId: "g1",
    channelId: "t1",
    parentChannelId: "c1",
    messageId: "m5",
    userDisplayName: "Bob",
    content: "哈哈确实，明天下午开会定吧",
    recentMessages: [
      { authorName: "Alice", isBot: false, text: "帮我查下方案 A 和 B" },
      { authorName: "Xenoblade", isBot: true, text: "方案 A 更稳，方案 B 更快。" },
      { authorName: "Alice", isBot: false, text: "@Bob 你觉得呢？" },
    ],
    ...overrides,
  };
}

function mockGateText(text: string): void {
  vi.mocked(generateText).mockResolvedValueOnce({
    text,
  } as unknown as Ai.GenerateTextResult<Ai.ToolSet, never, never>);
}

async function postRoute(
  env: Env,
  body: unknown,
  auth: string | null = `Bearer ${TOKEN}`,
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth !== null) headers.Authorization = auth;
  const request = new Request("https://worker/internal/v1/threads/should-reply", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return worker.fetch(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- bridging undici Request to workers-types
    request as unknown as Parameters<typeof worker.fetch>[0],
    env,
    {} as ExecutionContext,
  );
}

beforeEach(() => {
  vi.mocked(generateText).mockReset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseGateDecision", () => {
  it("parses plain JSON, fenced JSON, and minor trailing text", () => {
    expect(parseGateDecision('{"reply":true}')).toBe(true);
    expect(parseGateDecision('{"reply": false}')).toBe(false);
    expect(parseGateDecision('```json\n{"reply": true}\n```')).toBe(true);
    expect(parseGateDecision('Decision: {"reply": false} (side-talk)')).toBe(false);
  });

  it("returns null on unparseable output", () => {
    expect(parseGateDecision("yes")).toBeNull();
    expect(parseGateDecision("")).toBeNull();
    expect(parseGateDecision('{"reply": "maybe"}')).toBeNull();
  });
});

describe("handleThreadShouldReply", () => {
  it("rejects malformed bodies and DM scope", async () => {
    const env = makeEnv();
    expect(await handleThreadShouldReply(env, null)).toEqual({
      status: "error",
      code: "invalid_body",
    });
    expect(await handleThreadShouldReply(env, validBody({ scopeId: "dm" }))).toEqual({
      status: "error",
      code: "invalid_body",
    });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("returns shouldReply false without calling the model when the guild or channel is disallowed", async () => {
    const env = makeEnv();
    await env.DB.prepare(
      "INSERT INTO guild_config (guild_id, enabled, allow_channels_json) VALUES ('g1', 1, ?1)",
    )
      .bind(JSON.stringify(["other-channel"]))
      .run();

    expect(await handleThreadShouldReply(env, validBody())).toEqual({
      status: "ok",
      shouldReply: false,
    });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("returns the classifier verdict and includes pending-question context without logging content", async () => {
    const env = makeEnv();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    mockGateText('{"reply":false}');

    const result = await handleThreadShouldReply(env, validBody({ pendingQuestionForOther: true }));

    expect(result).toEqual({ status: "ok", shouldReply: false });
    expect(generateText).toHaveBeenCalledTimes(1);
    const prompt = String(vi.mocked(generateText).mock.calls[0]?.[0]?.prompt);
    expect(prompt).toContain("unanswered question card waiting on another user");
    expect(prompt).toContain("[Bob]: 哈哈确实，明天下午开会定吧");

    const logged = logSpy.mock.calls.map(([line]) => String(line)).join("\n");
    expect(logged).toContain("thread_gate_decided");
    expect(logged).not.toContain("明天下午开会");
  });

  it("falls back to the next summarization model when the primary fails or outputs garbage", async () => {
    const env = makeEnv();
    mockGateText("I think you should reply");
    mockGateText('{"reply":true}');

    const result = await handleThreadShouldReply(env, validBody());

    expect(result).toEqual({ status: "ok", shouldReply: true });
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it("returns gate_failed when every model in the chain fails", async () => {
    const env = makeEnv();
    vi.mocked(generateText).mockRejectedValue(new Error("timeout"));

    const result = await handleThreadShouldReply(env, validBody());

    expect(result).toEqual({ status: "error", code: "gate_failed" });
    expect(generateText).toHaveBeenCalledTimes(2);
  });
});

describe("POST /internal/v1/threads/should-reply", () => {
  it("enforces bearer auth and maps ok / invalid_body / gate_failed status codes", async () => {
    const env = makeEnv();
    expect((await postRoute(env, validBody(), null)).status).toBe(401);
    expect((await postRoute(env, { bad: true })).status).toBe(400);

    mockGateText('{"reply":true}');
    const okRes = await postRoute(env, validBody());
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({ status: "ok", shouldReply: true });

    vi.mocked(generateText).mockRejectedValue(new Error("down"));
    const errRes = await postRoute(env, validBody());
    expect(errRes.status).toBe(500);
    expect(await errRes.json()).toEqual({ status: "error", code: "gate_failed" });
  });
});
