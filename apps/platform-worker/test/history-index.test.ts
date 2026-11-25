import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IndexedMessageUpsert, MessageIngestRequest } from "@xenoblade/contracts";
import worker from "../src/index";
import {
  buildFtsQuery,
  getIndexedMessageContext,
  getRecentIndexedMessages,
  handleMessageIngest,
  HISTORY_RETENTION_MS,
  MAX_CONTENT_CHARS,
  MAX_DELETES_PER_REQUEST,
  MAX_UPSERTS_PER_REQUEST,
  PRUNE_BATCH_SIZE,
  searchIndexedMessages,
  segmentForSearch,
} from "../src/history-index";
import { createFailingD1, createTestD1 } from "./helpers/d1";

const TOKEN = "test-internal-token";

/** A fixed "now" for every time window in this file. */
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const G1 = "1000000000000000001";
const G2 = "1000000000000000002";
const C1 = "2000000000000000001";
const C2 = "2000000000000000002";
const THREAD = "2000000000000000003";

/** A snowflake-shaped message id — far above 2^53, so no JS number holds it exactly. */
function mid(n: number): string {
  return String(3_000_000_000_000_000_000n + BigInt(n));
}

function message(n: number, overrides: Partial<IndexedMessageUpsert> = {}): IndexedMessageUpsert {
  const at = NOW - 100_000 + n;
  return {
    messageId: mid(n),
    channelId: C1,
    parentChannelId: null,
    authorId: "u-alice",
    authorName: "Alice",
    isBot: false,
    content: `message ${n}`,
    replyToId: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function ingest(db: D1Database, req: unknown, now = NOW) {
  return handleMessageIngest(db, req, now);
}

/** Index messages of one guild, as the Runtime would in a single request. */
async function store(
  db: D1Database,
  upserts: IndexedMessageUpsert[],
  guildId = G1,
  now = NOW,
): Promise<void> {
  const request: MessageIngestRequest = { guildId, upserts, deletes: [] };
  expect(await ingest(db, request, now)).toMatchObject({ status: "ok", upserted: upserts.length });
}

async function allow(db: D1Database, guildId: string, channels: string[]): Promise<void> {
  await db
    .prepare("INSERT INTO guild_config (guild_id, allow_channels_json) VALUES (?1, ?2)")
    .bind(guildId, JSON.stringify(channels))
    .run();
}

async function rowCount(
  db: D1Database,
  table: "guild_messages" | "guild_messages_fts",
): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

async function storedIds(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT message_id FROM guild_messages ORDER BY message_id")
    .all<{ message_id: string }>();
  return (results ?? []).map((row) => row.message_id);
}

/** The ids of a result's rows, as one comparable list. */
function rowIds(rows: { id: number }[] | undefined): string {
  return (rows ?? []).map((row) => row.id).join(",");
}

/** True while every stored row has a search row of the same id, and no other does. */
async function inStep(db: D1Database): Promise<boolean> {
  const stored = await db
    .prepare("SELECT id FROM guild_messages ORDER BY id")
    .all<{ id: number }>();
  const indexed = await db
    .prepare("SELECT rowid AS id FROM guild_messages_fts ORDER BY id")
    .all<{ id: number }>();
  return rowIds(stored.results) === rowIds(indexed.results);
}

/** A D1 whose statements containing `needle` fail when run — an outage midway through a batch. */
function failingOn(db: D1Database, needle: string): D1Database {
  return {
    prepare: (query: string) => {
      const statement = db.prepare(query);
      if (!query.includes(needle)) return statement;
      return {
        bind: (...values: unknown[]) => {
          const bound = statement.bind(...values);
          return {
            first: () => bound.first(),
            all: () => bound.all(),
            run: async () => {
              throw new Error("D1 unavailable");
            },
          };
        },
      };
    },
    batch: (statements: D1PreparedStatement[]) => db.batch(statements),
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double wrapping the SQLite facade
  } as unknown as D1Database;
}

function found(messages: readonly { messageId: string }[]): string[] {
  return messages.map((m) => m.messageId);
}

function search(db: D1Database, query: string, extra: object = {}) {
  return searchIndexedMessages(db, {
    guildId: G1,
    query,
    allowedChannels: null,
    limit: 10,
    now: NOW,
    ...extra,
  });
}

function recent(db: D1Database, channelId: string, extra: object = {}) {
  return getRecentIndexedMessages(db, {
    guildId: G1,
    channelId,
    allowedChannels: null,
    limit: 20,
    now: NOW,
    ...extra,
  });
}

function context(db: D1Database, messageId: string, before = 5, after = 5) {
  return getIndexedMessageContext(db, {
    guildId: G1,
    messageId,
    before,
    after,
    allowedChannels: null,
    now: NOW,
  });
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

describe("segmentForSearch", () => {
  it("lowercases English words and drops punctuation", () => {
    expect(segmentForSearch("Hello, World!")).toBe("hello world");
  });

  it("breaks an unbroken run of Chinese into word tokens", () => {
    const tokens = segmentForSearch("的发售日是七月二十九日").split(" ");

    // Every character survives and the run is no longer a single token — which
    // is what lets a search for 发售日 match inside 的发售日是 (the search tests
    // below prove that). Where exactly the dictionary cuts is left to it: it
    // differs between ICU builds, and index and query always share one.
    expect(tokens.join("")).toBe("的发售日是七月二十九日");
    expect(tokens.length).toBeGreaterThan(1);
  });

  it("keeps Chinese and Latin words apart in mixed text", () => {
    const segmented = segmentForSearch("Xenoblade 3 发售日！");

    expect(segmented.startsWith("xenoblade 3 ")).toBe(true);
    expect(segmented.endsWith("日")).toBe(true);
    expect(segmented).not.toMatch(/[!！]/);
  });

  it("returns an empty string for text without words", () => {
    expect(segmentForSearch("！！！？？？")).toBe("");
    expect(segmentForSearch("")).toBe("");
  });
});

describe("buildFtsQuery", () => {
  it("quotes every distinct word as a phrase, lowercased", () => {
    expect(buildFtsQuery("Rust is async")).toBe('"rust" "is" "async"');
    expect(buildFtsQuery("rust rust rust")).toBe('"rust"');
  });

  it("keeps every character of a Chinese query inside phrases", () => {
    const query = buildFtsQuery("发售日");

    expect(query).not.toBeNull();
    expect(query?.split(" ").every((phrase) => /^"[^"]+"$/.test(phrase))).toBe(true);
    expect(query?.replaceAll('"', "").split(" ").join("")).toBe("发售日");
  });

  it("requires at most 12 distinct words", () => {
    const words = Array.from({ length: 20 }, (_, i) => `w${i}`);

    const query = buildFtsQuery(words.join(" "));

    expect(query).toBe(
      words
        .slice(0, 12)
        .map((word) => `"${word}"`)
        .join(" "),
    );
  });

  it("returns null when nothing searchable remains", () => {
    expect(buildFtsQuery("")).toBeNull();
    expect(buildFtsQuery("   ")).toBeNull();
    expect(buildFtsQuery("？？？！！！")).toBeNull();
    expect(buildFtsQuery("-*()")).toBeNull();
  });
});

describe("FTS5 operator injection", () => {
  async function seeded(): Promise<D1Database> {
    const db = createTestD1();
    await store(db, [
      message(1, { content: "alpha" }),
      message(2, { content: "beta" }),
      message(3, { content: "alphabet soup" }),
    ]);
    return db;
  }

  // Each query would change meaning, or fail, if its operator were read as
  // FTS5 syntax. Quoted, its words are only ever required literally.
  it.each([
    ["alpha OR beta", []],
    ["alpha NOT beta", []],
    ["NOT alpha", []],
    ["alpha -beta", []],
    ["-alpha", [mid(1)]],
    ["alpha*", [mid(1)]],
    ["^alpha", [mid(1)]],
    ["content:alpha", []],
    ["alpha NEAR beta", []],
    ['"alpha"', [mid(1)]],
    ["(alpha)", [mid(1)]],
    ["alpha + beta", []],
  ])("treats %j as words, not syntax", async (query, expected) => {
    const db = await seeded();

    expect(found(await search(db, query))).toEqual(expected);
  });

  it("answers an empty list for a query without words instead of failing", async () => {
    const db = await seeded();

    expect(await search(db, "？？？")).toEqual([]);
    expect(await search(db, "   ")).toEqual([]);
  });
});

describe("handleMessageIngest", () => {
  it("stores a message and its segmented text", async () => {
    const db = createTestD1();

    const result = await ingest(db, {
      guildId: G1,
      upserts: [message(1, { content: "  大家好，Xenoblade！  " })],
      deletes: [],
    });

    expect(result).toEqual({
      status: "ok",
      upserted: 1,
      deleted: 0,
      skipped: 0,
      rejected: 0,
      pruned: 0,
    });
    expect(await rowCount(db, "guild_messages")).toBe(1);
    expect(await rowCount(db, "guild_messages_fts")).toBe(1);
    expect(
      await db
        .prepare("SELECT guild_id, channel_id, content, is_bot, author_name FROM guild_messages")
        .first(),
    ).toEqual({
      guild_id: G1,
      channel_id: C1,
      content: "大家好，Xenoblade！",
      is_bot: 0,
      author_name: "Alice",
    });
    expect(found(await search(db, "大家好"))).toEqual([mid(1)]);
  });

  it("refuses the DM scope and malformed payloads, storing nothing", async () => {
    const db = createTestD1();
    const valid = message(1);
    const refused: unknown[] = [
      { guildId: "dm", upserts: [valid], deletes: [] },
      null,
      "text",
      { upserts: [valid], deletes: [] },
      { guildId: "", upserts: [valid], deletes: [] },
      { guildId: G1, upserts: valid, deletes: [] },
      { guildId: G1, upserts: [valid], deletes: "not-a-list" },
      {
        guildId: G1,
        upserts: Array.from({ length: MAX_UPSERTS_PER_REQUEST + 1 }, (_, i) => message(i + 1)),
        deletes: [],
      },
      {
        guildId: G1,
        upserts: [],
        deletes: Array.from({ length: MAX_DELETES_PER_REQUEST + 1 }, (_, i) => mid(i + 1)),
      },
    ];

    for (const payload of refused) {
      expect(await ingest(db, payload)).toEqual({ status: "error", code: "invalid_body" });
    }
    expect(await storedIds(db)).toEqual([]);
    expect(await rowCount(db, "guild_messages_fts")).toBe(0);
  });

  it("accepts a request at the size limits", async () => {
    const db = createTestD1();
    const upserts = Array.from({ length: MAX_UPSERTS_PER_REQUEST }, (_, i) => message(i + 1));

    const result = await ingest(db, {
      guildId: G1,
      upserts,
      deletes: Array.from({ length: MAX_DELETES_PER_REQUEST }, (_, i) => mid(10_000 + i)),
    });

    expect(result).toMatchObject({
      status: "ok",
      upserted: MAX_UPSERTS_PER_REQUEST,
      deleted: MAX_DELETES_PER_REQUEST,
    });
    expect(await rowCount(db, "guild_messages")).toBe(MAX_UPSERTS_PER_REQUEST);
  });

  it("leaves out malformed, textless, and expired entries without losing the rest", async () => {
    const db = createTestD1();
    const expiredAt = NOW - HISTORY_RETENTION_MS - 1;
    const futureAt = NOW + 2 * DAY;

    const result = await ingest(db, {
      guildId: G1,
      upserts: [
        message(1),
        message(2, { content: "   " }),
        message(3, { content: "" }),
        message(4, { createdAt: expiredAt, updatedAt: expiredAt }),
        { ...message(5), createdAt: futureAt, updatedAt: futureAt },
        { ...message(6), authorId: undefined },
        { ...message(7), isBot: "no" },
        { ...message(8), createdAt: Number.NaN },
        "not a message",
        null,
      ],
      deletes: ["", 42, null, mid(1)],
    });

    // Nine bad upserts and three bad delete ids; the valid delete removed message 1.
    expect(result).toMatchObject({ status: "ok", upserted: 1, rejected: 12, deleted: 1 });
    expect(await storedIds(db)).toEqual([]);
    expect(await rowCount(db, "guild_messages_fts")).toBe(0);
  });

  it("clamps a long message and keeps only the latest of a repeated id", async () => {
    const db = createTestD1();

    const result = await ingest(db, {
      guildId: G1,
      upserts: [
        message(1, { content: "字".repeat(MAX_CONTENT_CHARS + 500) }),
        message(2, { content: "first" }),
        message(2, { content: "second" }),
      ],
      deletes: [],
    });

    expect(result).toMatchObject({ status: "ok", upserted: 2, rejected: 0 });
    const { results } = await db
      .prepare("SELECT message_id, content FROM guild_messages ORDER BY message_id")
      .all<{ message_id: string; content: string }>();
    expect(results).toEqual([
      { message_id: mid(1), content: "字".repeat(MAX_CONTENT_CHARS) },
      { message_id: mid(2), content: "second" },
    ]);
  });

  it("stores every channel of a guild without an allowlist", async () => {
    const db = createTestD1();

    const result = await ingest(db, {
      guildId: G1,
      upserts: [message(1, { channelId: C1 }), message(2, { channelId: C2 })],
      deletes: [],
    });

    expect(result).toMatchObject({ status: "ok", upserted: 2, skipped: 0 });
    expect(await storedIds(db)).toEqual([mid(1), mid(2)]);
  });

  it("skips messages of channels the guild does not allow, a thread through its parent", async () => {
    const db = createTestD1();
    await allow(db, G1, [C1]);

    const result = await ingest(db, {
      guildId: G1,
      upserts: [
        message(1, { channelId: C1 }),
        message(2, { channelId: C2 }),
        message(3, { channelId: THREAD, parentChannelId: C1 }),
        message(4, { channelId: THREAD, parentChannelId: C2 }),
      ],
      deletes: [],
    });

    expect(result).toMatchObject({ status: "ok", upserted: 2, skipped: 2 });
    expect(await storedIds(db)).toEqual([mid(1), mid(3)]);
    expect(await rowCount(db, "guild_messages_fts")).toBe(2);
  });

  it("stores nothing for a disabled guild, yet still removes what was deleted", async () => {
    const db = createTestD1();
    await store(db, [message(1)]);
    await db.prepare("INSERT INTO guild_config (guild_id, enabled) VALUES (?1, 0)").bind(G1).run();

    const result = await ingest(db, { guildId: G1, upserts: [message(2)], deletes: [mid(1)] });

    expect(result).toMatchObject({ status: "ok", upserted: 0, skipped: 1, deleted: 1 });
    expect(await storedIds(db)).toEqual([]);
    expect(await rowCount(db, "guild_messages_fts")).toBe(0);
  });

  it("removes a deleted message from both tables, only within its own guild", async () => {
    const db = createTestD1();
    await store(db, [message(1)]);
    await store(db, [message(2, { content: "other guild" })], G2);

    // Another guild naming this id deletes nothing of the first one.
    expect(await ingest(db, { guildId: G2, upserts: [], deletes: [mid(1)] })).toMatchObject({
      status: "ok",
      deleted: 1,
    });
    expect(await storedIds(db)).toEqual([mid(1), mid(2)]);

    expect(await ingest(db, { guildId: G1, upserts: [], deletes: [mid(1)] })).toMatchObject({
      status: "ok",
      deleted: 1,
    });
    expect(await storedIds(db)).toEqual([mid(2)]);
    expect(await rowCount(db, "guild_messages_fts")).toBe(1);
    expect(await search(db, "message")).toEqual([]);
  });

  it.each([
    ["a snowflake id", (n: number) => mid(n)],
    ["an id that is not a number", (n: number) => `m-${n}`],
  ])("re-indexes an edited message in place, keyed by %s", async (_label, id) => {
    const db = createTestD1();
    await store(db, [message(1, { messageId: id(1), content: "the old wording" }), message(2)]);

    await store(db, [message(1, { messageId: id(1), content: "the new wording" })]);

    // The old text is gone, and the new one matches exactly once: no stale row is left behind.
    expect(await search(db, "old wording")).toEqual([]);
    expect(found(await search(db, "new wording"))).toEqual([id(1)]);
    expect(await rowCount(db, "guild_messages")).toBe(2);
    expect(await rowCount(db, "guild_messages_fts")).toBe(2);

    await ingest(db, { guildId: G1, upserts: [], deletes: [id(1)] });

    expect(await rowCount(db, "guild_messages_fts")).toBe(1);
    expect(found(await search(db, "new wording"))).toEqual([]);
    expect(await storedIds(db)).toEqual([mid(2)]);
  });

  it("lets a delete win when the same request upserts the message too", async () => {
    const db = createTestD1();

    const result = await ingest(db, { guildId: G1, upserts: [message(1)], deletes: [mid(1)] });

    expect(result).toMatchObject({ status: "ok", upserted: 1, deleted: 1 });
    expect(await storedIds(db)).toEqual([]);
    expect(await rowCount(db, "guild_messages_fts")).toBe(0);
  });

  it("prunes messages older than 90 days, at most 200 per ingest, from both tables", async () => {
    const db = createTestD1();
    // Aged messages, indexed 90 days and an hour ago while they were still fresh.
    const agedAt = NOW - HISTORY_RETENTION_MS - 3_600_000;
    const aged = Array.from({ length: PRUNE_BATCH_SIZE + 5 }, (_, i) =>
      message(i + 1, { createdAt: agedAt, updatedAt: agedAt }),
    );
    // The Runtime sends at most 50 upserts per request.
    for (let i = 0; i < aged.length; i += MAX_UPSERTS_PER_REQUEST) {
      await store(db, aged.slice(i, i + MAX_UPSERTS_PER_REQUEST), G1, agedAt + 60_000);
    }
    expect(await rowCount(db, "guild_messages")).toBe(PRUNE_BATCH_SIZE + 5);

    const first = await ingest(db, { guildId: G1, upserts: [message(999)], deletes: [] });

    expect(first).toMatchObject({ status: "ok", upserted: 1, pruned: PRUNE_BATCH_SIZE });
    expect(await rowCount(db, "guild_messages")).toBe(6);
    expect(await rowCount(db, "guild_messages_fts")).toBe(6);
    expect(await inStep(db)).toBe(true);

    const second = await ingest(db, { guildId: G1, upserts: [], deletes: [] });

    expect(second).toMatchObject({ status: "ok", pruned: 5 });
    expect(await storedIds(db)).toEqual([mid(999)]);
    expect(await rowCount(db, "guild_messages_fts")).toBe(1);
    expect(await inStep(db)).toBe(true);
  });

  it("prunes only the ingesting guild's expired messages", async () => {
    const db = createTestD1();
    const agedAt = NOW - HISTORY_RETENTION_MS - 3_600_000;
    await store(db, [message(1, { createdAt: agedAt, updatedAt: agedAt })], G1, agedAt + 60_000);
    await store(db, [message(2, { createdAt: agedAt, updatedAt: agedAt })], G2, agedAt + 60_000);

    expect(await ingest(db, { guildId: G1, upserts: [], deletes: [] })).toMatchObject({
      pruned: 1,
    });
    expect(await storedIds(db)).toEqual([mid(2)]);
    expect(await inStep(db)).toBe(true);
  });

  it("rolls a prune back whole when it cannot finish, so the tables stay in step", async () => {
    const db = createTestD1();
    const agedAt = NOW - HISTORY_RETENTION_MS - 3_600_000;
    await store(db, [message(1, { createdAt: agedAt, updatedAt: agedAt })], G1, agedAt + 60_000);
    await store(db, [message(2, { createdAt: agedAt, updatedAt: agedAt })], G1, agedAt + 60_000);

    // The second half of the prune — removing the stored rows — cannot run.
    const result = await ingest(failingOn(db, "DELETE FROM guild_messages WHERE id IN"), {
      guildId: G1,
      upserts: [],
      deletes: [],
    });

    // The first half was undone with it: neither table lost a row.
    expect(result).toEqual({ status: "error", code: "ingest_failed" });
    expect(await storedIds(db)).toEqual([mid(1), mid(2)]);
    expect(await rowCount(db, "guild_messages_fts")).toBe(2);
    expect(await inStep(db)).toBe(true);
  });

  it("answers ingest_failed when the database fails, without logging message text", async () => {
    const secret = "the quick brown fox jumps over the lazy dog";

    const result = await ingest(createFailingD1(), {
      guildId: G1,
      upserts: [message(1, { content: secret })],
      deletes: [],
    });

    expect(result).toEqual({ status: "error", code: "ingest_failed" });
    expect(logLines().some((line) => line.includes("history_ingest_failed"))).toBe(true);
    for (const line of logLines()) expect(line).not.toContain(secret);
  });

  it("logs counts and ids only — never message text or author names", async () => {
    const db = createTestD1();
    const secret = "s3cret message body";

    await ingest(db, {
      guildId: G1,
      upserts: [message(1, { content: secret, authorName: "Secret Author" })],
      deletes: [],
    });

    const lines = logLines();
    const line = lines.find((text) => text.includes('"history_ingest"'));
    expect(line).toBeDefined();
    expect(JSON.parse(line ?? "{}")).toMatchObject({
      guildId: G1,
      channelIds: [C1],
      upserted: 1,
    });
    for (const text of lines) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain("Secret Author");
    }
  });
});

describe("getRecentIndexedMessages", () => {
  async function seeded(): Promise<D1Database> {
    const db = createTestD1();
    await store(
      db,
      Array.from({ length: 6 }, (_, i) => message(i + 1)),
    );
    await store(db, [message(50, { channelId: C2 }), message(51, { channelId: THREAD })]);
    await store(db, [message(60)], G2);
    return db;
  }

  it("returns a channel's newest messages, oldest first", async () => {
    const db = await seeded();

    expect(found(await recent(db, C1, { limit: 3 }))).toEqual([mid(4), mid(5), mid(6)]);
    expect(found(await recent(db, C1))).toEqual([mid(1), mid(2), mid(3), mid(4), mid(5), mid(6)]);
  });

  it("never crosses guilds or channels", async () => {
    const db = await seeded();

    expect(found(await recent(db, C2))).toEqual([mid(50)]);
    expect(found(await recent(db, THREAD))).toEqual([mid(51)]);
    expect(
      found(
        await getRecentIndexedMessages(db, {
          guildId: G2,
          channelId: C1,
          allowedChannels: null,
          limit: 20,
          now: NOW,
        }),
      ),
    ).toEqual([mid(60)]);
  });

  it("reads only allowlisted channels, a thread through its parent", async () => {
    const db = await seeded();
    // THREAD's parent is C1.
    await db
      .prepare("UPDATE guild_messages SET parent_channel_id = ?1 WHERE channel_id = ?2")
      .bind(C1, THREAD)
      .run();

    expect(found(await recent(db, C2, { allowedChannels: [C1] }))).toEqual([]);
    expect(found(await recent(db, THREAD, { allowedChannels: [C1] }))).toEqual([mid(51)]);
    expect(await recent(db, THREAD, { allowedChannels: [C2] })).toEqual([]);
    // A thread listed in its own right is admitted too.
    expect(found(await recent(db, THREAD, { allowedChannels: [THREAD] }))).toEqual([mid(51)]);
    expect(await recent(db, C1, { allowedChannels: [] })).toEqual([]);
  });

  it("pages backwards from a message id", async () => {
    const db = await seeded();

    expect(found(await recent(db, C1, { limit: 2 }))).toEqual([mid(5), mid(6)]);
    expect(found(await recent(db, C1, { limit: 2, beforeMessageId: mid(5) }))).toEqual([
      mid(3),
      mid(4),
    ]);
    expect(await recent(db, C1, { beforeMessageId: mid(1) })).toEqual([]);
    // A message the index does not hold, or that belongs to another guild, anchors nothing.
    expect(await recent(db, C1, { beforeMessageId: mid(60) })).toEqual([]);
    expect(await recent(db, C1, { beforeMessageId: "unknown" })).toEqual([]);
  });

  it("ignores messages older than 90 days even before they are pruned", async () => {
    const db = await seeded();
    const staleAt = NOW - HISTORY_RETENTION_MS - 1;
    await store(db, [message(70, { createdAt: staleAt, updatedAt: staleAt })], G1, staleAt + 1_000);
    expect(await rowCount(db, "guild_messages")).toBe(10);

    expect(found(await recent(db, C1))).not.toContain(mid(70));
    expect(await search(db, "message 70")).toEqual([]);
    expect(await context(db, mid(70))).toEqual([]);
  });
});

describe("searchIndexedMessages", () => {
  async function seeded(): Promise<D1Database> {
    const db = createTestD1();
    await store(db, [
      message(1, { content: "rust is fast", createdAt: NOW - 5_000 }),
      message(2, {
        content: "rust rust rust everywhere",
        authorName: "Bob",
        createdAt: NOW - 6_000,
      }),
      message(3, { content: "typescript brings types", authorName: "Alice_100%" }),
      message(4, { content: "Дима любит rust", authorName: "Дима", createdAt: NOW - 8_000 }),
      message(5, { content: "of the guild next door", channelId: C2, createdAt: NOW - 9_000 }),
      message(6, { content: "in a thread", channelId: THREAD, createdAt: NOW - 10_000 }),
      message(7, { content: "types again", authorName: "AliceX100", createdAt: NOW - 11_000 }),
    ]);
    await store(db, [message(9, { content: "rust in another guild" })], G2);
    return db;
  }

  it("finds Chinese text by a word inside an unbroken run", async () => {
    const db = createTestD1();
    await store(db, [
      message(1, { content: "Xenoblade 3 的发售日是七月二十九日" }),
      message(2, { content: "明天的午饭吃什么" }),
    ]);

    expect(found(await search(db, "发售日"))).toEqual([mid(1)]);
    expect(found(await search(db, "午饭"))).toEqual([mid(2)]);
    expect(found(await search(db, "xenoblade 发售日"))).toEqual([mid(1)]);
    expect(await search(db, "午饭 发售日")).toEqual([]);
  });

  it("requires every word and ranks the best match first, then the newest", async () => {
    const db = await seeded();

    // Message 2 mentions rust three times; 1 and 4 tie, and 1 is newer.
    expect(found(await search(db, "rust"))).toEqual([mid(2), mid(1), mid(4)]);
    expect(found(await search(db, "rust typescript"))).toEqual([]);
    expect(found(await search(db, "RUST"))).toEqual([mid(2), mid(1), mid(4)]);
  });

  it("prefers the newer of two equally good matches", async () => {
    const db = createTestD1();
    await store(db, [
      message(1, { content: "deploy at noon", createdAt: NOW - 5_000 }),
      message(2, { content: "deploy at noon", createdAt: NOW - 1_000 }),
    ]);

    expect(found(await search(db, "deploy noon"))).toEqual([mid(2), mid(1)]);
  });

  it("stays inside its guild", async () => {
    const db = await seeded();

    expect(found(await search(db, "guild"))).toEqual([mid(5)]);
    expect(found(await search(db, "rust", { guildId: G2 }))).toEqual([mid(9)]);
  });

  it("honors the channel allowlist, a thread through its parent", async () => {
    const db = await seeded();
    await db
      .prepare("UPDATE guild_messages SET parent_channel_id = ?1 WHERE channel_id = ?2")
      .bind(C1, THREAD)
      .run();

    expect(found(await search(db, "thread", { allowedChannels: [C1] }))).toEqual([mid(6)]);
    expect(found(await search(db, "thread", { allowedChannels: [THREAD] }))).toEqual([mid(6)]);
    expect(await search(db, "thread", { allowedChannels: [C2] })).toEqual([]);
    expect(found(await search(db, "guild next", { allowedChannels: [C2] }))).toEqual([mid(5)]);
    expect(await search(db, "rust", { allowedChannels: [] })).toEqual([]);
  });

  it("narrows by channel, author, and time", async () => {
    const db = await seeded();

    expect(found(await search(db, "rust", { channelId: THREAD }))).toEqual([]);
    expect(found(await search(db, "rust", { authorName: "alice" }))).toEqual([mid(1)]);
    expect(found(await search(db, "rust", { authorName: "BOB" }))).toEqual([mid(2)]);
    expect(found(await search(db, "rust", { authorName: "дима" }))).toEqual([mid(4)]);
    expect(found(await search(db, "rust", { afterMs: NOW - 5_500 }))).toEqual([mid(1)]);
    expect(found(await search(db, "rust", { beforeMs: NOW - 6_500 }))).toEqual([mid(4)]);
    expect(
      found(await search(db, "rust", { afterMs: NOW - 7_500, beforeMs: NOW - 5_500 })),
    ).toEqual([mid(2)]);
    expect(await search(db, "rust", { beforeMs: NOW - HISTORY_RETENTION_MS })).toEqual([]);
  });

  it("matches an author filter's wildcards literally", async () => {
    const db = await seeded();

    // `_` and `%` are characters here, not "any one" and "any run".
    expect(found(await search(db, "types", { authorName: "_" }))).toEqual([mid(3)]);
    expect(found(await search(db, "types", { authorName: "100%" }))).toEqual([mid(3)]);
    expect(found(await search(db, "types", { authorName: "alicex" }))).toEqual([mid(7)]);
  });

  it("returns at most the limit", async () => {
    const db = await seeded();

    expect(found(await search(db, "rust", { limit: 2 }))).toEqual([mid(2), mid(1)]);
  });
});

describe("getIndexedMessageContext", () => {
  async function seeded(): Promise<D1Database> {
    const db = createTestD1();
    await store(
      db,
      Array.from({ length: 6 }, (_, i) => message(i + 1)),
    );
    // Another channel, right between messages 3 and 4 in time.
    await store(db, [message(40, { channelId: C2, createdAt: NOW - 100_000 + 3 })]);
    await store(db, [message(50)], G2);
    return db;
  }

  it("returns the messages around one, oldest first, marking the anchor", async () => {
    const db = await seeded();

    const window = await context(db, mid(4), 2, 2);

    expect(window.map((m) => [m.messageId, m.isAnchor])).toEqual([
      [mid(2), false],
      [mid(3), false],
      [mid(4), true],
      [mid(5), false],
      [mid(6), false],
    ]);
    expect(window.map((m) => m.content)).toEqual([
      "message 2",
      "message 3",
      "message 4",
      "message 5",
      "message 6",
    ]);
  });

  it("stays in the anchor's channel", async () => {
    const db = await seeded();

    expect(found(await context(db, mid(3), 5, 5))).toEqual([
      mid(1),
      mid(2),
      mid(3),
      mid(4),
      mid(5),
      mid(6),
    ]);
    expect(found(await context(db, mid(40), 5, 5))).toEqual([mid(40)]);
  });

  it("clamps the window at the channel's ends and honors zero counts", async () => {
    const db = await seeded();

    expect(found(await context(db, mid(1), 5, 2))).toEqual([mid(1), mid(2), mid(3)]);
    expect(found(await context(db, mid(6), 2, 5))).toEqual([mid(4), mid(5), mid(6)]);
    const only = await context(db, mid(3), 0, 0);
    expect(only.map((m) => [m.messageId, m.isAnchor])).toEqual([[mid(3), true]]);
  });

  it("returns nothing for an anchor outside the guild, the allowlist, or the window", async () => {
    const db = await seeded();
    const staleAt = NOW - HISTORY_RETENTION_MS - 1;
    await store(db, [message(70, { createdAt: staleAt, updatedAt: staleAt })], G1, staleAt + 1_000);
    const inGuild = (messageId: string, allowedChannels: string[] | null) =>
      getIndexedMessageContext(db, {
        guildId: G1,
        messageId,
        before: 5,
        after: 5,
        allowedChannels,
        now: NOW,
      });

    expect(await context(db, "unknown")).toEqual([]);
    expect(await context(db, mid(50))).toEqual([]);
    expect(await context(db, mid(70))).toEqual([]);
    expect(await inGuild(mid(40), null)).toEqual([
      expect.objectContaining({ messageId: mid(40), isAnchor: true }),
    ]);
    expect(await inGuild(mid(40), [C2])).toEqual([expect.objectContaining({ messageId: mid(40) })]);
    expect(await inGuild(mid(40), [C1])).toEqual([]);
    expect(await inGuild(mid(40), [])).toEqual([]);
  });
});

/** POST a raw body to the ingest route, as the Runtime would. */
async function post(
  env: Env,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const request = new Request("https://worker/internal/v1/messages/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
  return worker.fetch(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- bridging undici Request to the workers-types signature
    request as unknown as Parameters<typeof worker.fetch>[0],
    env,
    {} as ExecutionContext,
  );
}

describe("SQLite-owned ids and guild ownership", () => {
  it("gives message ids beyond the signed 64-bit range rows of their own", async () => {
    const db = createTestD1();
    // Both overflow a signed 64-bit integer, where a cast would clamp them onto the same value.
    const beyond = "9223372036854775808";
    const further = "18446744073709551616";

    await store(db, [
      message(1, { messageId: beyond, content: "first beyond" }),
      message(2, { messageId: further, content: "second beyond" }),
    ]);

    expect(await rowCount(db, "guild_messages")).toBe(2);
    expect(await rowCount(db, "guild_messages_fts")).toBe(2);
    expect(found(await search(db, "beyond"))).toEqual([further, beyond]);

    await ingest(db, { guildId: G1, upserts: [], deletes: [beyond] });

    expect(await rowCount(db, "guild_messages_fts")).toBe(1);
    expect(found(await search(db, "beyond"))).toEqual([further]);
  });

  it("never lets another guild overwrite a message id it does not own", async () => {
    const db = createTestD1();
    await store(db, [message(1, { content: "owned by the first guild" })], G1);

    const foreign = await ingest(db, {
      guildId: G2,
      upserts: [message(1, { content: "claimed by the second guild" })],
      deletes: [],
    });

    expect(foreign).toMatchObject({ status: "ok", upserted: 0, rejected: 1 });
    const { results } = await db
      .prepare("SELECT guild_id, content FROM guild_messages")
      .all<{ guild_id: string; content: string }>();
    expect(results).toEqual([{ guild_id: G1, content: "owned by the first guild" }]);
    expect(found(await search(db, "owned", { guildId: G1 }))).toEqual([mid(1)]);
    expect(await search(db, "claimed", { guildId: G1 })).toEqual([]);
    expect(await search(db, "owned", { guildId: G2 })).toEqual([]);
    expect(await inStep(db)).toBe(true);
  });

  it("lets a guild keep re-indexing and deleting its own message under the same id", async () => {
    const db = createTestD1();
    await store(db, [message(1, { content: "first wording" })], G1);

    await store(db, [message(1, { content: "second wording" })], G1);

    expect(await search(db, "first wording")).toEqual([]);
    expect(found(await search(db, "second wording"))).toEqual([mid(1)]);
    expect(await ingest(db, { guildId: G1, upserts: [], deletes: [mid(1)] })).toMatchObject({
      deleted: 1,
    });
    expect(await rowCount(db, "guild_messages_fts")).toBe(0);
  });
});

describe("reads honor which channels are public now", () => {
  async function seeded(): Promise<D1Database> {
    const db = createTestD1();
    await store(db, [
      message(1),
      message(2, { channelId: C2 }),
      message(3, { channelId: THREAD, parentChannelId: C1 }),
    ]);
    return db;
  }

  it("read nothing of a channel that stopped being public after it was indexed", async () => {
    const db = await seeded();
    const scope = { publicChannelIds: [C1] };
    const expand = (messageId: string) =>
      getIndexedMessageContext(db, {
        guildId: G1,
        messageId,
        before: 5,
        after: 5,
        allowedChannels: null,
        now: NOW,
        ...scope,
      });

    expect(await recent(db, C2, scope)).toEqual([]);
    expect(found(await search(db, "message", scope))).toEqual([mid(1)]);
    expect(await expand(mid(2))).toEqual([]);
    // Public again, and its messages are back.
    expect(found(await recent(db, C2, { publicChannelIds: [C1, C2] }))).toEqual([mid(2)]);
    // A Runtime that named no public channel leaves the read unfiltered.
    expect(found(await recent(db, C2))).toEqual([mid(2)]);
    expect(await recent(db, C1, { publicChannelIds: [] })).toEqual([]);
  });

  it("counts a thread as public only by its own id — a public parent does not vouch for it", async () => {
    const db = await seeded();

    expect(await recent(db, THREAD, { publicChannelIds: [C1] })).toEqual([]);
    expect(found(await recent(db, THREAD, { publicChannelIds: [THREAD] }))).toEqual([mid(3)]);
  });

  it("reads only channels that are both allowlisted and public", async () => {
    const db = await seeded();
    // C1 is allowlisted but no longer public; C2 is public but not allowlisted.
    const scope = { allowedChannels: [C1], publicChannelIds: [C2, THREAD] };

    // The thread passes both: public in its own right, allowlisted through its parent.
    expect(found(await search(db, "message", scope))).toEqual([mid(3)]);
    expect(found(await recent(db, THREAD, scope))).toEqual([mid(3)]);
    expect(await recent(db, C1, scope)).toEqual([]);
    expect(await recent(db, C2, scope)).toEqual([]);
  });
});

describe("reads honor the triggering user's truncation", () => {
  /** Six messages in the current channel, and one in another. */
  async function seeded(): Promise<D1Database> {
    const db = createTestD1();
    await store(db, [
      ...Array.from({ length: 6 }, (_, i) => message(i + 1)),
      message(50, { channelId: C2 }),
    ]);
    return db;
  }
  // The user truncated the current channel just before its fourth message.
  const truncated = { resetAt: NOW - 100_000 + 4, containerChannelId: C1 };
  const expand = (db: D1Database, messageId: string, scope: object) =>
    getIndexedMessageContext(db, {
      guildId: G1,
      messageId,
      before: 5,
      after: 5,
      allowedChannels: null,
      now: NOW,
      ...scope,
    });

  it("keep the truncated messages of the current channel out of every read", async () => {
    const db = await seeded();

    expect(found(await recent(db, C1, truncated))).toEqual([mid(4), mid(5), mid(6)]);
    // Best match first, then newest: the other channel's message was never truncated.
    expect(found(await search(db, "message", truncated))).toEqual([
      mid(50),
      mid(6),
      mid(5),
      mid(4),
    ]);
    const window = await expand(db, mid(4), truncated);
    expect(window.map((m) => [m.messageId, m.isAnchor])).toEqual([
      [mid(4), true],
      [mid(5), false],
      [mid(6), false],
    ]);
    // A truncated message is not expanded either.
    expect(await expand(db, mid(2), truncated)).toEqual([]);
  });

  it("apply to the current channel only, and a watermark of 0 is no truncation", async () => {
    const db = await seeded();

    expect(found(await recent(db, C2, truncated))).toEqual([mid(50)]);
    expect(found(await recent(db, C1, { resetAt: 0, containerChannelId: C1 }))).toEqual([
      mid(1),
      mid(2),
      mid(3),
      mid(4),
      mid(5),
      mid(6),
    ]);
  });
});

describe("POST /internal/v1/messages/ingest", () => {
  function makeEnv(db = createTestD1()): Env {
    // The ingest route reads only DB and INTERNAL_API_TOKEN.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- route test: the fields the route never reads are omitted
    return { DB: db, INTERNAL_API_TOKEN: TOKEN } as Env;
  }

  const auth = { Authorization: `Bearer ${TOKEN}` };
  const empty = JSON.stringify({ guildId: G1, upserts: [], deletes: [] });

  it("requires the bearer token", async () => {
    expect((await post(makeEnv(), empty)).status).toBe(401);
    expect((await post(makeEnv(), empty, { Authorization: "Bearer nope" })).status).toBe(401);
  });

  it("stores an authenticated batch", async () => {
    const env = makeEnv();
    // The route stamps the request with the wall clock, so date the message there.
    const sentAt = Date.now() - 1_000;

    const response = await post(
      env,
      JSON.stringify({
        guildId: G1,
        upserts: [message(1, { createdAt: sentAt, updatedAt: sentAt })],
        deletes: [],
      }),
      auth,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", upserted: 1 });
    expect(await storedIds(env.DB)).toEqual([mid(1)]);
  });

  it("answers 400 for an invalid body and 500 for a failed write", async () => {
    const invalid = await post(makeEnv(), "{not json", auth);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ status: "error", code: "invalid_body" });

    const refused = await post(
      makeEnv(),
      JSON.stringify({ guildId: "dm", upserts: [], deletes: [] }),
      auth,
    );
    expect(refused.status).toBe(400);

    const failed = await post(
      makeEnv(createFailingD1()),
      JSON.stringify({ guildId: G1, upserts: [message(1)], deletes: [] }),
      auth,
    );
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ status: "error", code: "ingest_failed" });
  });
});
