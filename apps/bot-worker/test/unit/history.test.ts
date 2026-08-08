import { describe, it, expect } from "vitest";
import type { Message } from "chat";
import { getBoundedHistory, type HistoryThread } from "../../src/history";

// Message is a real class; getBoundedHistory only reads `.id` and `.text`, so a
// lightweight `{ id, text }` stub cast through `unknown` is the test seam.
type StubMessage = { id: string; text: string };
const msg = (id: string, text: string): Message => ({ id, text }) as StubMessage as Message;

/** Build a fake thread whose adapter returns the provided messages. */
const thread = (messages: Message[], id = "t1"): HistoryThread => ({
  id,
  adapter: {
    fetchMessages: async () => ({ messages }),
  },
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

  it("caps the result at 30 messages", async () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 40; i++) {
      msgs.push(msg(`m${i}`, "x"));
    }
    const current = msgs[msgs.length - 1];
    const result = await getBoundedHistory(thread(msgs), current);
    expect(result).toHaveLength(30);
    // newest 30 retained, oldest dropped first
    expect(result[0]?.id).toBe("m10");
    expect(result[29]?.id).toBe("m39");
  });

  it("enforces the 12000 Unicode character cap", async () => {
    const big = "a".repeat(6_000);
    // current + two 6000-char messages = 18,000 chars; only two fit (12,000).
    const current = msg("c", big);
    const result = await getBoundedHistory(
      thread([msg("a", big), msg("b", big), current]),
      current,
    );
    expect(result.map((m) => m.id)).toEqual(["b", "c"]);
  });

  it("counts Unicode characters, not UTF-16 code units", async () => {
    // Each emoji is 2 UTF-16 code units but 1 Unicode code point. 6000 emoji
    // = 6000 chars but 12000 code units; the char cap uses [...str].length.
    const emoji = "😀".repeat(6_000);
    const current = msg("c", emoji);
    const result = await getBoundedHistory(
      thread([msg("a", emoji), msg("b", emoji), current]),
      current,
    );
    // 6000 chars each; two messages = 12,000 (== cap, allowed), three exceeds.
    expect(result.map((m) => m.id)).toEqual(["b", "c"]);
  });

  it("enforces the 6000 estimated-token cap", async () => {
    // ceil(totalChars / 2) <= 6000. One 12000-char message → 6000 tokens (ok).
    // Adding a second message pushes tokens over 6000.
    const big = "z".repeat(12_000);
    const current = msg("c", big);
    const result = await getBoundedHistory(
      thread([msg("a", big), msg("b", big), current]),
      current,
    );
    expect(result.map((m) => m.id)).toEqual(["c"]);
  });

  it("drops older messages before the newer ones when over the cap", async () => {
    // current is large enough that it alone fits but a sibling does not.
    const big = "z".repeat(13_000);
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
    for (let i = 0; i < 50; i++) {
      empty.push(msg(`e${i}`, ""));
    }
    const result = await getBoundedHistory(thread([...empty, msg("a", "text"), current]), current);
    expect(result.map((m) => m.id)).toEqual(["a", "c"]);
  });

  it("uses only the adapter page (limit 30), never an unbounded source", async () => {
    const current = msg("c", "current");
    let requestedLimit: number | undefined;
    const t: HistoryThread = {
      id: "t1",
      adapter: {
        fetchMessages: async (_id, options) => {
          requestedLimit = options.limit;
          return { messages: [msg("a", "old"), current] };
        },
      },
    };
    await getBoundedHistory(t, current);
    expect(requestedLimit).toBe(30);
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
