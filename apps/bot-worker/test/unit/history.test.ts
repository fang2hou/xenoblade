import { describe, it, expect, vi } from "vitest";
import type { Message } from "chat";
import { getBoundedHistory, isRealDiscordThread, type HistoryThread } from "../../src/history";

// Message is a real class; getBoundedHistory only reads `.id` and `.text`, so a
// lightweight `{ id, text }` stub cast through `unknown` is the test seam.
type StubMessage = { id: string; text: string };
const msg = (id: string, text: string): Message => ({ id, text }) as StubMessage as Message;

/** Build a fake thread whose adapter returns the provided messages. */
const thread = (messages: Message[], id = "discord:g:c:t1"): HistoryThread => ({
  id,
  adapter: {
    fetchMessages: async () => ({ messages }),
  },
});

describe("isRealDiscordThread", () => {
  it("returns true for a four-segment thread ID", () => {
    expect(isRealDiscordThread("discord:guild:parent:thread")).toBe(true);
  });

  it("returns false for a three-segment channel ID", () => {
    expect(isRealDiscordThread("discord:guild:channel")).toBe(false);
  });

  it("returns false for a DM-style ID (guild @me)", () => {
    expect(isRealDiscordThread("discord:@me:channel")).toBe(false);
  });
});

describe("getBoundedHistory", () => {
  it("returns messages in oldest-first chronological order", async () => {
    const current = msg("c", "current");
    const result = await getBoundedHistory(
      thread([msg("a", "old"), msg("b", "mid"), current]),
      current,
    );
    expect(result.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("appends the current message when it is absent from the page", async () => {
    const current = msg("c", "current");
    const result = await getBoundedHistory(thread([msg("a", "old"), msg("b", "mid")]), current);
    expect(result.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("does not duplicate the current message when it is already present", async () => {
    const current = msg("c", "current");
    const result = await getBoundedHistory(thread([msg("a", "old"), current]), current);
    expect(result.filter((m) => m.id === "c")).toHaveLength(1);
  });

  it("caps the result at 40 messages", async () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 50; i++) {
      msgs.push(msg(`m${i}`, "x"));
    }
    const current = msgs[msgs.length - 1];
    const result = await getBoundedHistory(thread(msgs), current);
    expect(result).toHaveLength(40);
    // newest 40 retained, oldest dropped first
    expect(result[0]?.id).toBe("m10");
    expect(result[39]?.id).toBe("m49");
  });

  it("enforces the 16000 Unicode character cap", async () => {
    const big = "a".repeat(8_000);
    // current + two 8000-char messages = 24,000 chars; only two fit (16,000).
    const current = msg("c", big);
    const result = await getBoundedHistory(
      thread([msg("a", big), msg("b", big), current]),
      current,
    );
    expect(result.map((m) => m.id)).toEqual(["b", "c"]);
  });

  it("counts Unicode characters, not UTF-16 code units", async () => {
    // Each emoji is 2 UTF-16 code units but 1 Unicode code point. 8000 emoji
    // = 8000 chars but 16000 code units; the char cap uses [...str].length.
    const emoji = "😀".repeat(8_000);
    const current = msg("c", emoji);
    const result = await getBoundedHistory(
      thread([msg("a", emoji), msg("b", emoji), current]),
      current,
    );
    // 8000 chars each; two messages = 16,000 (== cap, allowed), three exceeds.
    expect(result.map((m) => m.id)).toEqual(["b", "c"]);
  });

  it("enforces the 8000 estimated-token cap", async () => {
    // ceil(totalChars / 2) <= 8000. One 16000-char message → 8000 tokens (ok).
    // Adding a second message pushes tokens over 8000.
    const big = "z".repeat(16_000);
    const current = msg("c", big);
    const result = await getBoundedHistory(
      thread([msg("a", big), msg("b", big), current]),
      current,
    );
    expect(result.map((m) => m.id)).toEqual(["c"]);
  });

  it("drops older messages before the newer ones when over the cap", async () => {
    // current is large enough that it alone fits but a sibling does not.
    const big = "z".repeat(17_000);
    const current = msg("c", "small");
    const result = await getBoundedHistory(
      thread([msg("a", big), msg("b", "small"), current]),
      current,
    );
    // iterating newest→oldest: c (small), b (small) both fit; a exceeds cap.
    expect(result.map((m) => m.id)).toEqual(["b", "c"]);
  });

  it("skips messages with empty text (attachment-only)", async () => {
    const current = msg("c", "current");
    const result = await getBoundedHistory(thread([msg("att", "   "), msg("a", "text")]), current);
    expect(result.map((m) => m.id)).toEqual(["a", "c"]);
  });

  it("does not count skipped attachment-only messages toward the cap", async () => {
    const current = msg("c", "current");
    const empty: Message[] = [];
    for (let i = 0; i < 60; i++) {
      empty.push(msg(`e${i}`, ""));
    }
    const result = await getBoundedHistory(thread([...empty, msg("a", "text"), current]), current);
    expect(result.map((m) => m.id)).toEqual(["a", "c"]);
  });

  it("uses only the adapter page (limit 50), never an unbounded source", async () => {
    const current = msg("c", "current");
    let requestedLimit: number | undefined;
    const t: HistoryThread = {
      id: "discord:g:c:t1",
      adapter: {
        fetchMessages: async (_id, options) => {
          requestedLimit = options.limit;
          return { messages: [msg("a", "old"), current] };
        },
      },
    };
    await getBoundedHistory(t, current);
    expect(requestedLimit).toBe(50);
  });

  it("de-duplicates repeated ids, keeping the last occurrence", async () => {
    const current = msg("c", "current");
    // duplicated id "a"; the second occurrence is the one retained.
    const result = await getBoundedHistory(
      thread([msg("a", "first"), msg("b", "mid"), msg("a", "second"), current]),
      current,
    );
    const aEntries = result.filter((m) => m.id === "a");
    expect(aEntries).toHaveLength(1);
    expect(aEntries[0]?.text).toBe("second");
  });
});

describe("getBoundedHistory — container branching", () => {
  it("calls fetchMessages for a four-segment thread ID", async () => {
    const fetchMessages = vi.fn(async () => ({
      messages: [msg("a", "hi")],
    }));
    const fetchChannelMessages = vi.fn(async () => ({ messages: [] }));
    const t: HistoryThread = {
      id: "discord:guild:parent:thread1",
      adapter: {
        fetchMessages,
        fetchChannelMessages,
      },
    };
    await getBoundedHistory(t, msg("a", "hi"));
    expect(fetchMessages).toHaveBeenCalledWith("discord:guild:parent:thread1", {
      limit: 50,
    });
  });

  it("never calls fetchChannelMessages for a four-segment thread ID", async () => {
    const fetchMessages = vi.fn(async () => ({
      messages: [msg("a", "hi")],
    }));
    const fetchChannelMessages = vi.fn(async () => ({ messages: [] }));
    const t: HistoryThread = {
      id: "discord:guild:parent:thread1",
      adapter: {
        fetchMessages,
        fetchChannelMessages,
      },
    };
    await getBoundedHistory(t, msg("a", "hi"));
    expect(fetchChannelMessages).not.toHaveBeenCalled();
  });

  it("calls fetchChannelMessages for a three-segment channel ID when available", async () => {
    const fetchMessages = vi.fn(async () => ({ messages: [] }));
    const fetchChannelMessages = vi.fn(async () => ({
      messages: [msg("a", "channel")],
    }));
    const t: HistoryThread = {
      id: "discord:guild:channel1",
      adapter: { fetchMessages, fetchChannelMessages },
    };
    const current = msg("a", "channel");
    const result = await getBoundedHistory(t, current);
    expect(fetchChannelMessages).toHaveBeenCalledWith("discord:guild:channel1", {
      limit: 50,
    });
    expect(fetchMessages).not.toHaveBeenCalled();
    expect(result.map((m) => m.id)).toEqual(["a"]);
  });

  it("falls back to fetchMessages for a three-segment ID when fetchChannelMessages is absent", async () => {
    const fetchMessages = vi.fn(async () => ({
      messages: [msg("a", "fallback")],
    }));
    const t: HistoryThread = {
      id: "discord:guild:channel1",
      adapter: { fetchMessages },
    };
    const current = msg("a", "fallback");
    const result = await getBoundedHistory(t, current);
    expect(fetchMessages).toHaveBeenCalledWith("discord:guild:channel1", {
      limit: 50,
    });
    expect(result.map((m) => m.id)).toEqual(["a"]);
  });
});
