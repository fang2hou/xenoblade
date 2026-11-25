import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolExecutionOptions, ToolSet } from "ai";

import type {
  GenerationRequest,
  IndexedMessageUpsert,
  MessageIngestResponse,
} from "@xenoblade/contracts";

import { handleMessageIngest } from "../src/history-index";
import { createFirstPartyTools } from "../src/tools";
import {
  createHistoryTools,
  type HistoryContextOutput,
  type HistoryContextMessage,
  type HistoryToolContext,
  type HistoryToolError,
  type HistoryToolMessage,
  type HistoryToolOutput,
} from "../src/tools/history-tools";
import { createFailingD1, createTestD1 } from "./helpers/d1";

const EXECUTION: ToolExecutionOptions<Record<string, unknown>> = {
  toolCallId: "call-1",
  messages: [],
  context: {},
};

type ToolName = "get_recent_messages" | "search_chat_history" | "get_message_context";
type AnyOutput = HistoryToolOutput | HistoryContextOutput;

const G1 = "g1";
const G2 = "g2";
const C1 = "c1";
const C2 = "c2";
const PARENT = "parent-channel";
const THREAD = "thread-channel";
const DAY = 24 * 60 * 60 * 1000;
const TRUNCATED_MARK = "…[truncated]";

/** Run one tool with whatever arguments a model might send; it answers with one plain object. */
async function run<T>(tools: ToolSet, name: ToolName, input: unknown): Promise<T> {
  const historyTool = tools[name];
  if (historyTool?.execute === undefined) throw new Error(`${name} has no execute`);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test helper: the caller names the output type it reads
  return historyTool.execute(input, EXECUTION) as Promise<T>;
}

/** The messages of a successful call; a call that answered an error fails the test. */
function messagesOf(output: AnyOutput): HistoryToolMessage[] {
  if ("error" in output) throw new Error(`the tool answered ${output.error}`);
  return output.messages;
}

function ids(output: AnyOutput): string[] {
  return messagesOf(output).map((m) => m.messageId);
}

/** `[messageId, isAnchor]` for each message of a context result. */
function anchors(output: HistoryContextOutput): Array<[string, boolean]> {
  return messagesOf(output).map((m): [string, boolean] => {
    const anchor = m as HistoryContextMessage;
    return [anchor.messageId, anchor.isAnchor];
  });
}

function aRequest(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    messageId: "trigger",
    containerId: `discord:${G1}:${C1}`,
    scopeId: G1,
    channelId: C1,
    parentChannelId: null,
    userId: "u1",
    userDisplayName: "User",
    summonKind: "user-mention",
    content: "question",
    history: [],
    reference: null,
    attachments: [],
    ...overrides,
  };
}

/** The triggering user in a channel of guild g1. */
function guildContext(
  db = createTestD1(),
  extra: Partial<HistoryToolContext> = {},
): HistoryToolContext {
  return { db, scopeId: G1, channelId: C1, parentChannelId: null, ...extra };
}

/** A test D1 that also counts how often it reads the guild's config. */
function countingDb(): { db: D1Database; configReads: () => number } {
  let configReads = 0;
  const inner = createTestD1();
  const db = {
    prepare: (query: string) => {
      if (query.includes("guild_config")) configReads += 1;
      return inner.prepare(query);
    },
    batch: (statements: D1PreparedStatement[]) => inner.batch(statements),
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double wrapping the SQLite facade
  return { db: db as unknown as D1Database, configReads: () => configReads };
}

function message(n: number, overrides: Partial<IndexedMessageUpsert> = {}): IndexedMessageUpsert {
  return {
    messageId: `m${n}`,
    channelId: C1,
    parentChannelId: null,
    authorId: "u-alice",
    authorName: "Alice",
    isBot: false,
    content: `message number ${n}`,
    replyToId: null,
    createdAt: Date.now() - (100 - n) * 60_000,
    updatedAt: Date.now() - (100 - n) * 60_000,
    ...overrides,
  };
}

async function store(db: D1Database, upserts: IndexedMessageUpsert[], guildId = G1): Promise<void> {
  // The Runtime sends at most 50 upserts per request; the Worker refuses more.
  for (let i = 0; i < upserts.length; i += 50) {
    const batch = upserts.slice(i, i + 50);
    const result: MessageIngestResponse = await handleMessageIngest(db, {
      guildId,
      upserts: batch,
      deletes: [],
    });
    expect(result).toMatchObject({ status: "ok", upserted: batch.length });
  }
}

async function allow(db: D1Database, guildId: string, channels: string[]): Promise<void> {
  await db
    .prepare("INSERT INTO guild_config (guild_id, allow_channels_json) VALUES (?1, ?2)")
    .bind(guildId, JSON.stringify(channels))
    .run();
}

/** Every line the code under test logged. */
function logLines(): string[] {
  return vi.mocked(console.log).mock.calls.map(([text]) => String(text));
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("get_recent_messages", () => {
  it("reads the current channel's latest 20 messages, oldest first", async () => {
    const context = guildContext();
    const stored = Array.from({ length: 25 }, (_, i) => message(i + 1));
    await store(context.db, stored);

    const output = await run<HistoryToolOutput>(
      createHistoryTools(context),
      "get_recent_messages",
      {},
    );

    expect(ids(output)).toEqual(Array.from({ length: 20 }, (_, i) => `m${i + 6}`));
    expect(messagesOf(output)[0]).toEqual({
      messageId: "m6",
      channelId: C1,
      authorId: "u-alice",
      authorName: "Alice",
      isBot: false,
      content: "message number 6",
      replyToId: null,
      createdAt: new Date(stored[5]?.createdAt ?? 0).toISOString(),
    });
    // Recent messages have no anchor: that marker belongs to get_message_context.
    expect(messagesOf(output).some((m) => "isAnchor" in m)).toBe(false);
  });

  it("reads the channel it is told to read", async () => {
    const context = guildContext();
    await store(context.db, [message(1), message(2, { channelId: C2 })]);

    const output = await run<HistoryToolOutput>(
      createHistoryTools(context),
      "get_recent_messages",
      { channel_id: C2 },
    );

    expect(ids(output)).toEqual(["m2"]);
  });

  it('reads the thread\'s parent channel for channel_id "parent"', async () => {
    const context = guildContext(createTestD1(), { channelId: THREAD, parentChannelId: PARENT });
    await store(context.db, [message(1, { channelId: PARENT }), message(2, { channelId: THREAD })]);
    const tools = createHistoryTools(context);

    expect(ids(await run<HistoryToolOutput>(tools, "get_recent_messages", {}))).toEqual(["m2"]);
    expect(
      ids(await run<HistoryToolOutput>(tools, "get_recent_messages", { channel_id: "parent" })),
    ).toEqual(["m1"]);
  });

  it("answers no_parent_channel for the parent shortcut outside a thread", async () => {
    const context = guildContext();
    await store(context.db, [message(1)]);

    expect(
      await run<HistoryToolOutput>(createHistoryTools(context), "get_recent_messages", {
        channel_id: "parent",
      }),
    ).toEqual({ error: "no_parent_channel" });
  });

  it("pages backwards from a message id", async () => {
    const context = guildContext();
    await store(
      context.db,
      Array.from({ length: 8 }, (_, i) => message(i + 1)),
    );
    const tools = createHistoryTools(context);

    const firstPage = await run<HistoryToolOutput>(tools, "get_recent_messages", { limit: 3 });
    const secondPage = await run<HistoryToolOutput>(tools, "get_recent_messages", {
      limit: 3,
      before_message_id: "m6",
    });

    expect(ids(firstPage)).toEqual(["m6", "m7", "m8"]);
    expect(ids(secondPage)).toEqual(["m3", "m4", "m5"]);
  });

  it("keeps the limit between 1 and 50", async () => {
    const context = guildContext();
    await store(
      context.db,
      Array.from({ length: 60 }, (_, i) => message(i + 1)),
    );
    const tools = createHistoryTools(context);

    expect(
      ids(await run<HistoryToolOutput>(tools, "get_recent_messages", { limit: 0 })),
    ).toHaveLength(1);
    expect(
      ids(await run<HistoryToolOutput>(tools, "get_recent_messages", { limit: 500 })),
    ).toHaveLength(50);
    expect(
      ids(await run<HistoryToolOutput>(tools, "get_recent_messages", { limit: 7.9 })),
    ).toHaveLength(7);
  });

  it.each([
    ["a non-object", "recent"],
    ["a non-string channel", { channel_id: 42 }],
    ["an empty message id", { before_message_id: "  " }],
    ["a string limit", { limit: "20" }],
    ["a non-finite limit", { limit: Number.NaN }],
    ["an infinite limit", { limit: Number.POSITIVE_INFINITY }],
  ])("answers invalid_input for %s and reads nothing", async (_label, input) => {
    const context = guildContext();
    await store(context.db, [message(1)]);

    expect(
      await run<HistoryToolOutput>(createHistoryTools(context), "get_recent_messages", input),
    ).toEqual({ error: "invalid_input" });
  });
});

describe("search_chat_history", () => {
  async function seeded(): Promise<HistoryToolContext> {
    const context = guildContext();
    await store(context.db, [
      message(1, { content: "rust is fast", authorName: "Alice" }),
      message(2, { content: "typescript has types too", authorName: "Bob" }),
      message(3, { content: "rust and types", authorName: "Alice", channelId: C2 }),
    ]);
    return context;
  }

  it("searches the whole guild, requiring every keyword", async () => {
    const tools = createHistoryTools(await seeded());

    expect(
      ids(await run<HistoryToolOutput>(tools, "search_chat_history", { query: "rust" })),
    ).toEqual(["m3", "m1"]);
    expect(
      ids(await run<HistoryToolOutput>(tools, "search_chat_history", { query: "rust types" })),
    ).toEqual(["m3"]);
    expect(
      await run<HistoryToolOutput>(tools, "search_chat_history", { query: "？？？？" }),
    ).toEqual({
      messages: [],
    });
  });

  it("narrows by channel and by author name, without regard to case", async () => {
    const tools = createHistoryTools(await seeded());

    const inChannel = await run<HistoryToolOutput>(tools, "search_chat_history", {
      query: "rust",
      channel_id: C2,
    });
    const byAuthor = await run<HistoryToolOutput>(tools, "search_chat_history", {
      query: "rust",
      author_name: "alice",
    });

    expect(ids(inChannel)).toEqual(["m3"]);
    expect(ids(byAuthor)).toEqual(["m3", "m1"]);
  });

  it("accepts ISO dates, zone-less date-times as UTC, and epoch milliseconds", async () => {
    const context = guildContext();
    // Two messages an hour either side of an instant, written as a UTC wall-clock time.
    const instant = Math.floor((Date.now() - 10 * DAY) / 60_000) * 60_000;
    await store(context.db, [
      message(1, { content: "the meeting", createdAt: instant - 3_600_000 }),
      message(2, { content: "the meeting", createdAt: instant + 3_600_000 }),
    ]);
    const tools = createHistoryTools(context);
    const utcWallClock = new Date(instant).toISOString().slice(0, 19);

    const bound = (extra: object) =>
      run<HistoryToolOutput>(tools, "search_chat_history", { query: "meeting", ...extra });

    expect(ids(await bound({ after: utcWallClock }))).toEqual(["m2"]);
    expect(ids(await bound({ after: new Date(instant).toISOString() }))).toEqual(["m2"]);
    expect(ids(await bound({ after: String(instant) }))).toEqual(["m2"]);
    // A zone-less date-time is read as UTC. In a local zone east of UTC the
    // bound would move west and admit message 1 as well.
    expect(
      ids(await bound({ after: new Date(instant + 3_600_000).toISOString().slice(0, 19) })),
    ).toEqual(["m2"]);
    expect(
      ids(await bound({ after: new Date(instant - 3_600_000).toISOString().slice(0, 19) })),
    ).toEqual(["m2", "m1"]);
    // The bound itself counts on the `after` side and not on the `before` side.
    expect(ids(await bound({ before: new Date(instant + 3_600_000).toISOString() }))).toEqual([
      "m1",
    ]);
  });

  it("answers invalid_time_range for an unparseable date or an empty range", async () => {
    const tools = createHistoryTools(await seeded());

    expect(
      await run<HistoryToolOutput>(tools, "search_chat_history", {
        query: "rust",
        after: "yesterday-ish",
      }),
    ).toEqual({ error: "invalid_time_range" });
    const sameInstant = new Date(Date.now() - DAY).toISOString();
    expect(
      await run<HistoryToolOutput>(tools, "search_chat_history", {
        query: "rust",
        after: sameInstant,
        before: sameInstant,
      }),
    ).toEqual({ error: "invalid_time_range" });
  });

  it("returns at most 25 messages, 10 by default", async () => {
    const context = guildContext();
    await store(
      context.db,
      Array.from({ length: 40 }, (_, i) => message(i + 1, { content: "needle" })),
    );
    const tools = createHistoryTools(context);

    expect(
      ids(await run<HistoryToolOutput>(tools, "search_chat_history", { query: "needle" })),
    ).toHaveLength(10);
    expect(
      ids(
        await run<HistoryToolOutput>(tools, "search_chat_history", { query: "needle", limit: 99 }),
      ),
    ).toHaveLength(25);
  });

  it.each([
    ["a missing query", {}],
    ["a blank query", { query: "   " }],
    ["a non-string query", { query: 42 }],
    ["an overlong query", { query: "x".repeat(501) }],
    ["a blank author name", { query: "rust", author_name: " " }],
    ["a non-string channel", { query: "rust", channel_id: [C1] }],
    ["a non-string date", { query: "rust", after: 1700000000000 }],
    ["a string limit", { query: "rust", limit: "5" }],
  ])("answers invalid_input for %s and reads nothing", async (_label, input) => {
    const context = await seeded();

    expect(
      await run<HistoryToolOutput>(createHistoryTools(context), "search_chat_history", input),
    ).toEqual({
      error: "invalid_input",
    });
  });
});

describe("get_message_context", () => {
  async function seeded(): Promise<HistoryToolContext> {
    const context = guildContext();
    const inChannel = Array.from({ length: 8 }, (_, i) => message(i + 1));
    await store(context.db, [
      ...inChannel,
      // Another channel, in the middle of the same time range.
      message(50, { channelId: C2, createdAt: (inChannel[3]?.createdAt ?? 0) + 1 }),
    ]);
    return context;
  }

  it("returns five messages either side of the anchor, oldest first, and marks the anchor", async () => {
    const output = await run<HistoryContextOutput>(
      createHistoryTools(await seeded()),
      "get_message_context",
      { message_id: "m4" },
    );

    expect(anchors(output)).toEqual([
      ["m1", false],
      ["m2", false],
      ["m3", false],
      ["m4", true],
      ["m5", false],
      ["m6", false],
      ["m7", false],
      ["m8", false],
    ]);
    expect(messagesOf(output)[3]).toMatchObject({
      messageId: "m4",
      channelId: C1,
      content: "message number 4",
    });
  });

  it("takes the counts it is given, between 0 and 15", async () => {
    const tools = createHistoryTools(await seeded());

    const none = await run<HistoryContextOutput>(tools, "get_message_context", {
      message_id: "m4",
      before: 0,
      after: 0,
    });
    const clamped = await run<HistoryContextOutput>(tools, "get_message_context", {
      message_id: "m4",
      before: -3,
      after: 99,
    });

    expect(anchors(none)).toEqual([["m4", true]]);
    expect(anchors(clamped)).toEqual([
      ["m4", true],
      ["m5", false],
      ["m6", false],
      ["m7", false],
      ["m8", false],
    ]);
  });

  it("answers message_not_found for an id the guild cannot read", async () => {
    const context = await seeded();
    await store(context.db, [message(90)], G2);
    const tools = createHistoryTools(context);

    for (const messageId of ["missing", "m90"]) {
      expect(
        await run<HistoryContextOutput>(tools, "get_message_context", { message_id: messageId }),
      ).toEqual({
        error: "message_not_found",
      });
    }
  });

  it.each([
    ["a missing id", {}],
    ["a non-string id", { message_id: 42 }],
    ["a blank id", { message_id: "" }],
    ["a string count", { message_id: "m4", before: "2" }],
  ])("answers invalid_input for %s and reads nothing", async (_label, input) => {
    const context = await seeded();

    expect(
      await run<HistoryContextOutput>(createHistoryTools(context), "get_message_context", input),
    ).toEqual({
      error: "invalid_input",
    });
  });
});

/** An Env holding only what the first-party tools read here: the database. */
function env(db: D1Database): Env {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test env: unread fields are omitted
  return { DB: db } as Env;
}

describe("history tools scope", () => {
  const HISTORY_TOOLS: ToolName[] = [
    "get_recent_messages",
    "search_chat_history",
    "get_message_context",
  ];

  it("offers the three history tools to a guild generation", () => {
    const tools = createFirstPartyTools(env(createTestD1()), aRequest());

    for (const name of HISTORY_TOOLS) expect(tools[name]?.execute).toBeTypeOf("function");
  });

  it("gives a DM generation none of them", () => {
    const tools = createFirstPartyTools(
      env(createTestD1()),
      aRequest({ scopeId: "dm", containerId: "discord:@me:42", channelId: "42" }),
    );

    for (const name of HISTORY_TOOLS) expect(tools).not.toHaveProperty(name);
    expect(
      createHistoryTools({
        db: createTestD1(),
        scopeId: "dm",
        channelId: "42",
        parentChannelId: null,
      }),
    ).toEqual({});
  });

  it("never returns another guild's messages, even under the same channel id", async () => {
    const context = guildContext();
    await store(context.db, [message(1, { content: "shared topic here" })]);
    await store(context.db, [message(2, { content: "shared topic foreign" })], G2);
    const tools = createHistoryTools(context);

    expect(ids(await run<HistoryToolOutput>(tools, "get_recent_messages", {}))).toEqual(["m1"]);
    expect(
      ids(await run<HistoryToolOutput>(tools, "search_chat_history", { query: "shared topic" })),
    ).toEqual(["m1"]);
    expect(
      await run<HistoryContextOutput>(tools, "get_message_context", { message_id: "m2" }),
    ).toEqual({
      error: "message_not_found",
    });
  });

  it("reads nothing outside the guild's channel allowlist", async () => {
    const context = guildContext();
    await store(context.db, [
      message(1, { content: "allowed text" }),
      message(2, { content: "forbidden text", channelId: C2 }),
    ]);
    await allow(context.db, G1, [C1]);
    const tools = createHistoryTools(context);

    expect(await run<HistoryToolOutput>(tools, "get_recent_messages", { channel_id: C2 })).toEqual({
      messages: [],
    });
    expect(
      ids(await run<HistoryToolOutput>(tools, "search_chat_history", { query: "text" })),
    ).toEqual(["m1"]);
    expect(
      await run<HistoryContextOutput>(tools, "get_message_context", { message_id: "m2" }),
    ).toEqual({
      error: "message_not_found",
    });
  });

  it("reads nothing for a disabled guild", async () => {
    const context = guildContext();
    await store(context.db, [message(1)]);
    await context.db
      .prepare("INSERT INTO guild_config (guild_id, enabled) VALUES (?1, 0)")
      .bind(G1)
      .run();
    const tools = createHistoryTools(context);

    expect(await run<HistoryToolOutput>(tools, "get_recent_messages", {})).toEqual({
      messages: [],
    });
    expect(
      await run<HistoryToolOutput>(tools, "search_chat_history", { query: "message" }),
    ).toEqual({ messages: [] });
  });

  it("reads the guild's allowlist once per generation, however many tools run", async () => {
    const { db, configReads } = countingDb();
    const context = guildContext(db);
    await store(context.db, [message(1)]);
    const tools = createHistoryTools(context);
    const readsAfterIngest = configReads();

    await run(tools, "get_recent_messages", {});
    await run(tools, "search_chat_history", { query: "message" });
    await run(tools, "get_message_context", { message_id: "m1" });

    expect(configReads() - readsAfterIngest).toBe(1);
  });
});

describe("history tool output size", () => {
  it("cuts a long message and says so", async () => {
    const context = guildContext();
    await store(context.db, [message(1, { content: "字".repeat(3_000) })]);

    const output = await run<HistoryToolOutput>(
      createHistoryTools(context),
      "get_recent_messages",
      {},
    );
    const content = messagesOf(output)[0]?.content ?? "";

    expect(content).toBe(`${"字".repeat(1_000)}${TRUNCATED_MARK}`);
  });

  it("shares 24,000 characters of message text across a full result", async () => {
    const context = guildContext();
    await store(
      context.db,
      Array.from({ length: 50 }, (_, i) => message(i + 1, { content: "字".repeat(2_000) })),
    );

    const output = await run<HistoryToolOutput>(
      createHistoryTools(context),
      "get_recent_messages",
      { limit: 50 },
    );
    const texts = messagesOf(output).map((m) => m.content.replace(TRUNCATED_MARK, ""));

    expect(texts).toHaveLength(50);
    for (const text of texts) expect(text).toBe("字".repeat(480));
  });

  it("leaves a short message untouched", async () => {
    const context = guildContext();
    await store(context.db, [message(1)]);

    expect(
      messagesOf(
        await run<HistoryToolOutput>(createHistoryTools(context), "get_recent_messages", {}),
      )[0]?.content,
    ).toBe("message number 1");
  });
});

describe("history tool failure", () => {
  it.each<ToolName>(["get_recent_messages", "search_chat_history", "get_message_context"])(
    "%s answers history_read_failed instead of throwing when the database fails",
    async (name) => {
      const tools = createHistoryTools(guildContext(createFailingD1()));
      const input = name === "get_message_context" ? { message_id: "m1" } : { query: "message" };

      expect(await run<{ error: HistoryToolError }>(tools, name, input)).toEqual({
        error: "history_read_failed",
      });
    },
  );

  it("logs ids, counts, and timings only — never a query, a name, or message text", async () => {
    const context = guildContext();
    await store(context.db, [
      message(1, { content: "s3cret message body", authorName: "Secret Author" }),
    ]);
    const tools = createHistoryTools(context);
    vi.mocked(console.log).mockClear();

    await run(tools, "search_chat_history", { query: "s3cret", author_name: "Secret" });
    await run(tools, "get_message_context", { message_id: "m1" });

    const lines = logLines();
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toContain("s3cret");
      expect(line).not.toContain("Secret");
      expect(JSON.parse(line)).toMatchObject({ scopeId: G1 });
    }
  });
});
