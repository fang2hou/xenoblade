import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Message, Thread } from "chat";

// Mock external modules
vi.mock("ai", () => ({
  streamText: vi.fn(),
  isStepCount: vi.fn((n: number) => ({ type: "step_count", count: n })),
}));

vi.mock("@xenoblade/ai", () => ({
  selectModel: vi.fn(() => ({})),
  composeSystemPrompt: vi.fn((p: { safety: string }) => p.safety),
  GENERATION_LIMITS: {
    maxOutputTokens: 1024,
    timeout: { totalMs: 60000, firstChunkMs: 15000, chunkMs: 5000 },
  },
}));

vi.mock("@xenoblade/db", () => ({
  claimMessage: vi.fn(async () => true),
  reserveGeneration: vi.fn(async () => ({ reservationId: 1, maxOutputTokens: 1024 })),
  finishGeneration: vi.fn(async () => {}),
  recordInteraction: vi.fn(async () => {}),
  getRuntimeConfig: vi.fn(async () => ({
    enabled: true,
    channelAllowed: true,
    defaultSystemPrompt: undefined,
  })),
  getUserContextState: vi.fn(async () => ({ resetAt: 0, lastInteractionAt: null, active: false })),
  markUserInteraction: vi.fn(async () => {}),
  GenerationBudgetExceededError: class extends Error {
    readonly code = "AI_GENERATION_BUDGET_EXCEEDED";
  },
}));

vi.mock("../../src/context", () => ({
  buildContext: vi.fn(async () => ({
    mode: "channel",
    forced: true,
    reason: "forced",
    messages: [],
  })),
  postToConversation: vi.fn(async () => {}),
}));

vi.mock("../../src/prompt", () => ({
  SAFETY_SYSTEM: "SAFETY",
  buildGenerationMessages: vi.fn(async () => [{ role: "user", content: "hello" }]),
}));

vi.mock("../../src/tools", () => ({ createSearchTools: vi.fn(() => undefined) }));
vi.mock("../../src/discord-links", () => ({
  parseDiscordMessageLinks: vi.fn(() => []),
  fetchLinkedMessages: vi.fn(async () => []),
}));
vi.mock("../../src/transcribe", () => ({ transcribeAudio: vi.fn(async () => null) }));

import {
  handleAiTrigger,
  isBareMention,
  interactionRow,
  FAILURE_REPLY,
  type TriggerParams,
} from "../../src/pipeline";
import { streamText } from "ai";
import {
  claimMessage,
  reserveGeneration,
  getRuntimeConfig,
  GenerationBudgetExceededError,
} from "@xenoblade/db";
import { postToConversation } from "../../src/context";

// --- Typed mock handles ----------------------------------------------------

const mockStreamText = streamText as unknown as Mock;
const mockClaim = claimMessage as unknown as Mock;
const mockReserve = reserveGeneration as unknown as Mock;
const mockRuntime = getRuntimeConfig as unknown as Mock;
const mockPost = postToConversation as unknown as Mock;

// --- Stubs -----------------------------------------------------------------

function mkMsg(id: string, text: string, raw: Record<string, unknown> = {}): Message {
  return {
    id,
    text,
    author: { userId: "u1", userName: "alice", fullName: "Alice", isBot: false, isMe: false },
    raw: { guild_id: "guild1", channel_id: "chan1", ...raw },
    attachments: [],
    metadata: { dateSent: new Date(100000), edited: false },
  } as unknown as Message;
}

function mkThread(id = "discord:guild1:chan1"): Thread {
  return {
    id,
    post: vi.fn(async () => {}),
    channel: { id, post: vi.fn(async () => {}) },
    startTyping: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}),
    adapter: { fetchMessages: vi.fn(async () => ({ messages: [] })) },
  } as unknown as Thread;
}

function mkEnv(): Env {
  return {
    DB: {} as Env["DB"],
    AI_PROVIDER: "openrouter",
    AI_MODEL: "test-model",
    DISCORD_BOT_TOKEN: "test-token",
    DISCORD_PUBLIC_KEY: "test-key",
    DISCORD_APPLICATION_ID: "test-app",
    OPENROUTER_API_KEY: "test-key",
    GATEWAY_CONTROL_TOKEN: "test",
    GATEWAY_STATUS_TOKEN: "test",
    BRAVE_SEARCH_API_KEY: "",
  } as unknown as Env;
}

function mkParams(overrides: Partial<TriggerParams> = {}): TriggerParams {
  return { kind: "mention", isReplyToBot: false, unsubscribeOnError: false, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStreamText.mockReturnValue({
    text: Promise.resolve("Mock AI response"),
    usage: Promise.resolve({
      outputTokens: 42,
      inputTokens: 100,
      inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 100 },
    }),
  });
});

// --- handleAiTrigger — normal flow ----------------------------------------

describe("handleAiTrigger — normal flow", () => {
  it("posts the AI response on a normal mention", async () => {
    const env = mkEnv();
    const thread = mkThread();
    const msg = mkMsg("m1", "<@bot> hello");

    await handleAiTrigger(env, thread, msg, mkParams());

    // Dedup + budget reservation occurred.
    expect(mockClaim).toHaveBeenCalledWith(env.DB, "m1", expect.any(Number));
    expect(mockReserve).toHaveBeenCalledWith(env.DB, "discord:guild1:chan1", expect.any(Number));
    // Generation ran exactly once and the response was posted.
    expect(mockStreamText).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledWith(thread, "Mock AI response");
  });

  it("skips a duplicate message when claim returns false", async () => {
    const env = mkEnv();
    const thread = mkThread();
    const msg = mkMsg("dup", "hello");

    mockClaim.mockResolvedValueOnce(false);

    await handleAiTrigger(env, thread, msg, mkParams());

    expect(mockClaim).toHaveBeenCalledTimes(1);
    // Nothing downstream of the dedup gate may run.
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockStreamText).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("posts FAILURE_REPLY and skips generation when budget is exceeded", async () => {
    const env = mkEnv();
    const thread = mkThread();
    const msg = mkMsg("budget", "hello");

    mockReserve.mockRejectedValueOnce(new GenerationBudgetExceededError("exceeded"));

    await handleAiTrigger(env, thread, msg, mkParams());

    // Budget reservation attempted; generation never starts.
    expect(mockReserve).toHaveBeenCalledTimes(1);
    expect(mockStreamText).not.toHaveBeenCalled();
    // The failure reply is delivered via safePost -> postToConversation.
    expect(mockPost).toHaveBeenCalledWith(thread, FAILURE_REPLY);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it("skips generation when runtime is disabled", async () => {
    const env = mkEnv();
    const thread = mkThread();
    const msg = mkMsg("disabled", "hello");

    mockRuntime.mockResolvedValueOnce({
      enabled: false,
      channelAllowed: true,
      defaultSystemPrompt: undefined,
    });

    await handleAiTrigger(env, thread, msg, mkParams());

    // Runtime gate fires before budget reservation and generation.
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockStreamText).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });
});

// --- handleAiTrigger — generation retry -----------------------------------

describe("handleAiTrigger — generation retry", () => {
  // The pipeline backs off with setTimeout(1000ms, 2000ms) between attempts.
  // Drive that clock deterministically with fake timers — never real waits.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("retries and posts the response after a transient failure", async () => {
    const env = mkEnv();
    const thread = mkThread();
    const msg = mkMsg("retry", "hello");

    mockStreamText
      .mockReturnValueOnce({
        text: Promise.reject(new Error("transient")),
        usage: Promise.resolve({
          outputTokens: 0,
          inputTokens: 0,
          inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
        }),
      })
      .mockReturnValueOnce({
        text: Promise.resolve("Retry success"),
        usage: Promise.resolve({
          outputTokens: 42,
          inputTokens: 100,
          inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 100 },
        }),
      });

    const pending = handleAiTrigger(env, thread, msg, mkParams());
    // advanceTimersByTimeAsync flushes microtasks (the mocked async ops) and
    // fires the 1000ms backoff so attempt 2 can run.
    await vi.advanceTimersByTimeAsync(5000);
    await pending;

    // First attempt failed, second succeeded.
    expect(mockStreamText).toHaveBeenCalledTimes(2);
    expect(mockPost).toHaveBeenCalledWith(thread, "Retry success");
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it("posts FAILURE_REPLY after every retry fails", async () => {
    const env = mkEnv();
    const thread = mkThread();
    const msg = mkMsg("failall", "hello");

    mockStreamText.mockReturnValue({
      text: Promise.reject(new Error("always fail")),
      usage: Promise.resolve({
        outputTokens: 0,
        inputTokens: 0,
        inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
    });

    const pending = handleAiTrigger(env, thread, msg, mkParams());
    // Covers both backoff waits (1000ms then 2000ms) across the three attempts.
    await vi.advanceTimersByTimeAsync(5000);
    await pending;

    // All three attempts exhausted; no success was posted.
    expect(mockStreamText).toHaveBeenCalledTimes(3);
    expect(mockPost).toHaveBeenCalledWith(thread, FAILURE_REPLY);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });
});

// --- isBareMention ---------------------------------------------------------

describe("isBareMention", () => {
  it("returns true for a mention-only message", () => {
    expect(isBareMention(mkMsg("m", "<@123>"))).toBe(true);
  });

  it("returns false for a mention followed by text", () => {
    expect(isBareMention(mkMsg("m", "<@123> hello"))).toBe(false);
  });

  it("returns false for plain text with no mention", () => {
    expect(isBareMention(mkMsg("m", "hello"))).toBe(false);
  });
});

// --- interactionRow --------------------------------------------------------

describe("interactionRow", () => {
  it("maps every field including cache token columns", () => {
    const env = mkEnv();
    const msg = mkMsg("m1", "hello");
    const startedAt = Date.now();

    const row = interactionRow({
      message: msg,
      containerId: "discord:guild1:chan1",
      scopeId: "guild1",
      kind: "mention",
      env,
      startedAt,
      status: "success",
      completionTokens: 42,
      inputTokens: 100,
      cacheReadTokens: 5,
      cacheWriteTokens: 10,
    });

    expect(row).toMatchObject({
      messageId: "m1",
      threadId: "discord:guild1:chan1",
      userId: "u1",
      scopeId: "guild1",
      kind: "mention",
      provider: "openrouter",
      model: "test-model",
      status: "success",
      requestedOutputTokens: 1024, // mocked GENERATION_LIMITS.maxOutputTokens
      completionTokens: 42,
      costMicros: null,
      errorCode: null,
      inputTokens: 100,
      cacheReadTokens: 5,
      cacheWriteTokens: 10,
    });
    // Computed timing fields are present numeric values.
    expect(row.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof row.createdAt).toBe("number");
  });
});
