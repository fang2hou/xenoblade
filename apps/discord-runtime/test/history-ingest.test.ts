import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MessageIngestRequest, MessageIngestResponse } from "@xenoblade/contracts";

import {
  FLUSH_BATCH_SIZE,
  FLUSH_INTERVAL_MS,
  HistoryIngestBuffer,
  type IngestMessage,
  MAX_QUEUE_SIZE,
} from "../src/history-ingest";

const G1 = "100000000000000001";
const G2 = "100000000000000002";
const C1 = "200000000000000001";
const C2 = "200000000000000002";
const THREAD = "200000000000000003";
const BOT = "bot-account";
const SENT_AT = 1_700_000_000_000;

interface Harness {
  buffer: HistoryIngestBuffer;
  requests: MessageIngestRequest[];
  /** The Worker's answer to the next request. */
  behaviour: { fail: boolean; hang: boolean };
  /** Lets a hanging request finish. */
  release: () => void;
}

/** The Worker's answer to a request it stored in full. */
function stored(req: MessageIngestRequest): MessageIngestResponse {
  return {
    status: "ok",
    upserted: req.upserts.length,
    deleted: req.deletes.length,
    skipped: 0,
    rejected: 0,
    pruned: 0,
  };
}

function harness(): Harness {
  const requests: MessageIngestRequest[] = [];
  const behaviour = { fail: false, hang: false };
  const waiting: Array<() => void> = [];
  const buffer = new HistoryIngestBuffer({
    workerUrl: "https://worker.invalid",
    token: "token",
    botId: () => BOT,
    send: async (req) => {
      requests.push(req);
      if (behaviour.hang) {
        const { promise, resolve } = Promise.withResolvers<void>();
        waiting.push(resolve);
        await promise;
      }
      if (behaviour.fail) throw new Error("Worker HTTP 503");
      return stored(req);
    },
  });
  return {
    buffer,
    requests,
    behaviour,
    release: () => waiting.splice(0).forEach((resolve) => resolve()),
  };
}

function message(overrides: Partial<IngestMessage> = {}): IngestMessage {
  return {
    id: "300000000000000001",
    channelId: C1,
    guildId: G1,
    content: "hello there",
    webhookId: null,
    system: false,
    createdTimestamp: SENT_AT,
    editedTimestamp: null,
    channel: { isThread: () => false, isDMBased: () => false, parentId: null },
    author: { id: "u1", bot: false, displayName: "Display Name", username: "username" },
    member: null,
    reference: null,
    ...overrides,
  };
}

/** Message number `n`, told apart by its id and text. */
function numbered(n: number, overrides: Partial<IngestMessage> = {}): IngestMessage {
  return message({
    id: String(300_000_000_000_000_000n + BigInt(n)),
    content: `message ${n}`,
    ...overrides,
  });
}

function numberedId(n: number): string {
  return String(300_000_000_000_000_000n + BigInt(n));
}

function allUpserts(requests: readonly MessageIngestRequest[]) {
  return requests.flatMap((req) => req.upserts);
}

function allDeletes(requests: readonly MessageIngestRequest[]): string[] {
  return requests.flatMap((req) => req.deletes);
}

/** Every line the buffer logged. */
function logLines(): string[] {
  return vi.mocked(console.log).mock.calls.map(([text]) => String(text));
}

/** Let a request that was released finish before the next step. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const open: Harness[] = [];

function start(): Harness {
  const h = harness();
  open.push(h);
  return h;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(async () => {
  // A test that leaves a request hanging must not stall the teardown.
  for (const h of open.splice(0)) {
    h.release();
    await h.buffer.stop();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("what enters the index", () => {
  it("sends a member's guild message with what the index needs", async () => {
    const h = start();

    h.buffer.add(
      message({
        channel: { isThread: () => true, isDMBased: () => false, parentId: C2 },
        channelId: THREAD,
        reference: { messageId: "300000000000000009" },
      }),
    );
    await h.buffer.flush();

    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toEqual({
      guildId: G1,
      deletes: [],
      upserts: [
        {
          messageId: "300000000000000001",
          channelId: THREAD,
          parentChannelId: C2,
          authorId: "u1",
          authorName: "Display Name",
          isBot: false,
          content: "hello there",
          replyToId: "300000000000000009",
          createdAt: SENT_AT,
          updatedAt: SENT_AT,
        },
      ],
    });
  });

  it("names an author by server nickname, then display name, then username", async () => {
    const h = start();

    h.buffer.add(message({ member: { displayName: "Nickname" } }));
    h.buffer.add(
      numbered(2, { author: { id: "u2", bot: false, displayName: null, username: "plain" } }),
    );
    await h.buffer.flush();

    expect(allUpserts(h.requests).map((m) => m.authorName)).toEqual(["Nickname", "plain"]);
  });

  it("indexes Xenoblade's own replies, marked as a bot's", async () => {
    const h = start();

    h.buffer.add(
      numbered(1, {
        author: { id: BOT, bot: true, displayName: "Xenoblade", username: "xenoblade" },
      }),
    );
    await h.buffer.flush();

    expect(allUpserts(h.requests)).toEqual([
      expect.objectContaining({ messageId: numberedId(1), authorId: BOT, isBot: true }),
    ]);
  });

  it.each([
    ["a DM by its missing guild", message({ guildId: null })],
    [
      "a DM by its channel",
      message({ channel: { isThread: () => false, isDMBased: () => true, parentId: null } }),
    ],
    ["a webhook message", message({ webhookId: "400000000000000001" })],
    [
      "another bot's message",
      message({ author: { id: "other-bot", bot: true, displayName: "Bot", username: "bot" } }),
    ],
    ["a message without text", message({ content: "   " })],
    ["a message without any content field", message({ content: null })],
    ["a Discord system notice", message({ system: true, content: "User pinned a message" })],
    ["a partial message without an author", message({ author: null, content: null })],
    ["a partial message that has text but no author", message({ author: null })],
  ])("never sends %s", async (_label, msg) => {
    const h = start();

    h.buffer.add(msg);
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS * 2);
    await h.buffer.flush();

    expect(h.requests).toEqual([]);
  });

  it("removes a deleted message from a partial, which carries nothing but its ids", async () => {
    const h = start();

    h.buffer.remove(
      message({ id: "300000000000000007", content: null, author: null, channel: undefined }),
    );
    await h.buffer.flush();

    expect(h.requests).toEqual([{ guildId: G1, upserts: [], deletes: ["300000000000000007"] }]);
  });

  it("ignores a deletion outside a guild", async () => {
    const h = start();

    h.buffer.remove(message({ guildId: null }));
    await h.buffer.flush();

    expect(h.requests).toEqual([]);
  });
});

describe("edits", () => {
  const before = message({ content: "before" });

  it("re-indexes a message whose text changed", async () => {
    const h = start();

    h.buffer.edit(before, message({ content: "after", editedTimestamp: SENT_AT + 5_000 }));
    await h.buffer.flush();

    expect(allUpserts(h.requests)).toEqual([
      expect.objectContaining({ content: "after", updatedAt: SENT_AT + 5_000, createdAt: SENT_AT }),
    ]);
  });

  it("sends nothing when the text did not change", async () => {
    const h = start();

    h.buffer.edit(before, message({ content: "before", editedTimestamp: SENT_AT + 5_000 }));
    await h.buffer.flush();

    expect(h.requests).toEqual([]);
  });

  it("re-indexes an edit whose previous text it does not know", async () => {
    const h = start();

    // An uncached message arrives with no old version at all.
    h.buffer.edit(null, message({ content: "after" }));
    await h.buffer.flush();

    expect(allUpserts(h.requests)).toEqual([expect.objectContaining({ content: "after" })]);
  });

  it("removes a message that was edited to no text", async () => {
    const h = start();

    h.buffer.edit(before, message({ content: "   " }));
    await h.buffer.flush();

    expect(h.requests).toEqual([{ guildId: G1, upserts: [], deletes: ["300000000000000001"] }]);
  });

  it("ignores a partial update that carries no text at all", async () => {
    const h = start();

    // `content` is null: the update says nothing about the message's text.
    h.buffer.edit(before, message({ content: null }));
    await h.buffer.flush();

    expect(h.requests).toEqual([]);
  });

  it("ignores an edit of a message that never enters the index", async () => {
    const h = start();

    h.buffer.edit(
      message({ webhookId: "400000000000000001" }),
      message({ webhookId: "400000000000000001", content: "" }),
    );
    await h.buffer.flush();

    expect(h.requests).toEqual([]);
  });
});

describe("batching", () => {
  it("sends as soon as a guild holds 20 changes, without waiting for the timer", async () => {
    const h = start();

    for (let n = 1; n < FLUSH_BATCH_SIZE; n++) h.buffer.add(numbered(n));
    await settle();
    expect(h.requests).toEqual([]);

    h.buffer.add(numbered(FLUSH_BATCH_SIZE));
    await settle();

    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.upserts).toHaveLength(FLUSH_BATCH_SIZE);
  });

  it("sends what is pending every 5 seconds", async () => {
    const h = start();

    h.buffer.add(numbered(1));
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS - 1);
    expect(h.requests).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);

    expect(h.requests).toHaveLength(1);
    h.buffer.add(numbered(2));
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(allUpserts(h.requests).map((m) => m.messageId)).toEqual([numberedId(1), numberedId(2)]);
  });

  it("keeps one entry per message, its latest state", async () => {
    const h = start();

    h.buffer.add(numbered(1, { content: "first" }));
    h.buffer.edit(message({ content: "first" }), message({ id: numberedId(1), content: "second" }));
    h.buffer.add(numbered(2));
    h.buffer.remove(numbered(2));
    h.buffer.remove(numbered(3));
    h.buffer.add(numbered(3, { content: "restored" }));
    await h.buffer.flush();

    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.upserts.map((m) => [m.messageId, m.content])).toEqual([
      [numberedId(1), "second"],
      [numberedId(3), "restored"],
    ]);
    expect(allDeletes(h.requests)).toEqual([numberedId(2)]);
  });

  it("sends each guild its own request", async () => {
    const h = start();

    h.buffer.add(numbered(1));
    h.buffer.add(numbered(2, { guildId: G2, channelId: C2 }));
    h.buffer.remove(numbered(3));
    await h.buffer.flush();

    expect(
      h.requests.map((req) => [req.guildId, req.upserts.map((m) => m.messageId), req.deletes]),
    ).toEqual([
      [G1, [numberedId(1)], [numberedId(3)]],
      [G2, [numberedId(2)], []],
    ]);
  });

  it("sends at most 50 changes per request, oldest first", async () => {
    const h = start();
    h.behaviour.hang = true;

    // The first 20 leave at once and hang; 120 more arrive behind them.
    for (let n = 1; n <= 140; n++) h.buffer.add(numbered(n));
    await settle();
    expect(h.requests).toHaveLength(1);

    h.behaviour.hang = false;
    h.release();
    await h.buffer.flush();

    const sizes = h.requests.map((req) => req.upserts.length + req.deletes.length);
    expect(sizes).toEqual([20, 50, 50, 20]);
    expect(allUpserts(h.requests).map((m) => m.messageId)).toEqual(
      Array.from({ length: 140 }, (_, i) => numberedId(i + 1)),
    );
  });

  it("does not start a second flush for a guild while one is still running", async () => {
    const h = start();
    h.behaviour.hang = true;

    for (let n = 1; n <= FLUSH_BATCH_SIZE; n++) h.buffer.add(numbered(n));
    await settle();
    for (let n = 21; n <= 60; n++) h.buffer.add(numbered(n));
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS * 3);

    expect(h.requests).toHaveLength(1);

    h.behaviour.hang = false;
    h.release();
    await h.buffer.flush();
    expect(h.requests).toHaveLength(2);
  });
});

describe("when the Worker cannot take a batch", () => {
  it("sends it again on the next flush, with any newer state of the same message", async () => {
    const h = start();
    h.behaviour.fail = true;

    h.buffer.add(numbered(1, { content: "first" }));
    h.buffer.add(numbered(2));
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    await settle();
    expect(h.requests).toHaveLength(1);

    // Message 1 is edited while its first version waits for a retry.
    h.buffer.edit(
      message({ id: numberedId(1), content: "first" }),
      message({ id: numberedId(1), content: "second" }),
    );
    h.buffer.add(numbered(3));
    h.behaviour.fail = false;
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);

    // Every message once, in its latest state — nothing lost, nothing twice.
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]?.upserts.map((m) => [m.messageId, m.content]).toSorted()).toEqual([
      [numberedId(1), "second"],
      [numberedId(2), "message 2"],
      [numberedId(3), "message 3"],
    ]);
  });

  it("keeps retrying a backlog that nothing arrived behind, until the Worker takes it", async () => {
    const h = start();
    h.behaviour.fail = true;

    h.buffer.add(numbered(1));
    h.buffer.add(numbered(2));
    for (let attempt = 0; attempt < 2; attempt++) {
      await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
      await settle();
    }
    expect(h.requests).toHaveLength(2);

    h.behaviour.fail = false;
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);

    expect(h.requests).toHaveLength(3);
    expect(allUpserts(h.requests.slice(2)).map((m) => m.messageId)).toEqual([
      numberedId(1),
      numberedId(2),
    ]);
  });

  it("keeps at most 200 changes per guild, dropping the oldest", async () => {
    const h = start();
    h.behaviour.fail = true;

    for (let n = 1; n <= MAX_QUEUE_SIZE + 10; n++) h.buffer.add(numbered(n));
    await settle();

    expect(logLines().some((line) => line.includes("history_ingest_overflow"))).toBe(true);
    h.behaviour.fail = false;
    await h.buffer.flush();

    const delivered = allUpserts(h.requests.slice(1)).map((m) => m.messageId);
    expect(delivered).toEqual(Array.from({ length: MAX_QUEUE_SIZE }, (_, i) => numberedId(i + 11)));
  });

  it("treats anything but an ok answer as not delivered", async () => {
    const h = start();
    const buffer = new HistoryIngestBuffer({
      workerUrl: "https://worker.invalid",
      token: "token",
      botId: () => BOT,
      send: async () => ({ status: "error", code: "invalid_body" }),
    });
    open.push({ ...h, buffer });

    buffer.add(numbered(1));
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(logLines().some((line) => line.includes("history_ingest_failed"))).toBe(true);
  });

  it("logs counts and the error name only — never message text", async () => {
    const h = start();
    h.behaviour.fail = true;

    h.buffer.add(
      numbered(1, {
        content: "s3cret message body",
        author: { id: "u1", bot: false, displayName: "Secret Author", username: "secret" },
      }),
    );
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);

    const failed = logLines().find((line) => line.includes("history_ingest_failed"));
    expect(failed).toBeDefined();
    expect(JSON.parse(failed ?? "{}")).toMatchObject({ guildId: G1, messages: 1, error: "Error" });
    for (const line of logLines()) {
      expect(line).not.toContain("s3cret");
      expect(line).not.toContain("Secret Author");
    }
  });
});

describe("flush and stop", () => {
  it("flush sends at once and leaves nothing pending", async () => {
    const h = start();

    h.buffer.add(numbered(1));
    await h.buffer.flush();
    await h.buffer.flush();

    expect(h.requests).toHaveLength(1);
  });

  it("stop delivers what is pending, then sends nothing more", async () => {
    const h = start();

    h.buffer.add(numbered(1));
    await h.buffer.stop();
    h.buffer.add(numbered(2));
    h.buffer.remove(numbered(1));
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS * 3);

    expect(h.requests).toHaveLength(1);
    expect(allUpserts(h.requests).map((m) => m.messageId)).toEqual([numberedId(1)]);
  });

  it("stop waits for a flush in flight and still delivers what arrived behind it", async () => {
    const h = start();
    h.behaviour.hang = true;

    for (let n = 1; n <= FLUSH_BATCH_SIZE; n++) h.buffer.add(numbered(n));
    await settle();
    for (let n = 21; n <= 25; n++) h.buffer.add(numbered(n));

    // Only the flush already in flight hangs; the one `stop` performs goes through.
    h.behaviour.hang = false;
    const stopping = h.buffer.stop();
    h.release();
    await stopping;
    // Stopping twice is harmless.
    await h.buffer.stop();

    expect(h.requests.map((req) => req.upserts.length)).toEqual([FLUSH_BATCH_SIZE, 5]);
  });

  it("stop sends nothing when the buffer is empty", async () => {
    const h = start();

    await h.buffer.stop();

    expect(h.requests).toEqual([]);
  });
});

describe("robustness", () => {
  it("never lets a failing event escape; it logs the error and carries on", async () => {
    const h = start();

    h.buffer.add(
      message({
        id: "300000000000000099",
        channel: {
          isThread: () => false,
          isDMBased: () => {
            throw new TypeError("channel gone");
          },
          parentId: null,
        },
      }),
    );
    h.buffer.add(numbered(1));
    await h.buffer.flush();

    expect(allUpserts(h.requests).map((m) => m.messageId)).toEqual([numberedId(1)]);
    expect(logLines().some((line) => line.includes("history_ingest_event_error"))).toBe(true);
  });

  it("reads the bot's id per event, so a gateway that is not up yet decides nothing", async () => {
    let botId: string | undefined;
    const requests: MessageIngestRequest[] = [];
    const buffer = new HistoryIngestBuffer({
      workerUrl: "https://worker.invalid",
      token: "token",
      botId: () => botId ?? "not-ready",
      send: async (req) => {
        requests.push(req);
        return {
          status: "ok",
          upserted: req.upserts.length,
          deleted: 0,
          skipped: 0,
          rejected: 0,
          pruned: 0,
        };
      },
    });
    open.push({ ...start(), buffer });

    // Before READY the bot's id is unknown: its own messages look like any other bot's.
    botId = undefined;
    buffer.add(
      numbered(1, {
        author: { id: BOT, bot: true, displayName: "Xenoblade", username: "xenoblade" },
      }),
    );
    botId = BOT;
    buffer.add(
      numbered(2, {
        author: { id: BOT, bot: true, displayName: "Xenoblade", username: "xenoblade" },
      }),
    );
    await buffer.flush();

    expect(allUpserts(requests).map((m) => m.messageId)).toEqual([numberedId(2)]);
  });
});
