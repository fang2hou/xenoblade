import { describe, expect, it } from "vitest";
import type { GenerationRequest, HistoryMessage } from "@xenoblade/contracts";

import { buildContext, isThreadContainer, threadOf } from "../src/context";

/**
 * Context membership and budgets. ADR-011 isolation invariants: DM context
 * lives under `scopeId = "dm"`, `containerId = discord:@me:<dmChannelId>`;
 * guild requests use a guild scope and container. History reaches
 * `buildContext` only from the triggering channel itself, so these tests pin
 * the remaining invariants: DM containers are non-thread containers (channel
 * mode, user+bot filtering) and honor the reset cutoff, while a guild channel
 * carries every member's messages.
 */

function message(partial: Partial<HistoryMessage> & Pick<HistoryMessage, "id">): HistoryMessage {
  return {
    text: `text of ${partial.id}`,
    authorId: "author",
    authorName: "Author",
    isBot: false,
    createdAt: 1000,
    ...partial,
  };
}

function request(containerId: string, history: HistoryMessage[]): GenerationRequest {
  return {
    messageId: "current",
    containerId,
    scopeId: containerId.startsWith("discord:@me:") ? "dm" : "123",
    channelId: containerId.split(":").at(-1) ?? "",
    userId: "user-a",
    userDisplayName: "User A",
    summonKind: "dm-chat",
    content: "hello",
    history,
    reference: null,
    attachments: [],
  };
}

describe("guild channel context", () => {
  const channel = "discord:123:c1";

  it("includes every member's messages, not only the requesting user's", () => {
    const history = [
      message({ id: "m1", authorId: "user-a", authorName: "A" }),
      message({ id: "m2", authorId: "user-b", authorName: "B" }),
      message({ id: "m3", authorId: "user-c", authorName: "C" }),
      message({ id: "m4", authorId: "bot", isBot: true }),
    ];
    const decision = buildContext(request(channel, history), 0);
    expect(decision.mode).toBe("channel");
    expect(decision.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("applies the reset cutoff to everyone's messages alike", () => {
    const history = [
      message({ id: "old-b", authorId: "user-b", createdAt: 1000 }),
      message({ id: "new-a", authorId: "user-a", createdAt: 2000 }),
      message({ id: "new-b", authorId: "user-b", createdAt: 2100 }),
    ];
    const decision = buildContext(request(channel, history), 1500);
    expect(decision.messages.map((m) => m.id)).toEqual(["new-a", "new-b"]);
  });

  it("still includes other members when the requesting user has said nothing yet", () => {
    const history = [
      message({ id: "m1", authorId: "user-b" }),
      message({ id: "m2", authorId: "user-c" }),
    ];
    const decision = buildContext(request(channel, history), 0);
    expect(decision.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("keeps every message of a thread", () => {
    const history = [
      message({ id: "m1", authorId: "user-b" }),
      message({ id: "m2", authorId: "user-a" }),
    ];
    const decision = buildContext(request("discord:123:c1:t1", history), 0);
    expect(decision.mode).toBe("thread");
    expect(decision.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("degrades to no context when only the current message survives", () => {
    const history = [
      message({ id: "old", authorId: "user-b", createdAt: 1000 }),
      message({ id: "current", authorId: "user-a", createdAt: 2000 }),
    ];
    expect(buildContext(request(channel, history), 1500)).toEqual({ mode: "none", messages: [] });
  });
});

describe("context limits", () => {
  const channel = "discord:123:c1";

  /** `count` messages with ascending ids, oldest first, each `text` long. */
  function many(count: number, text = `text of m`): HistoryMessage[] {
    return Array.from({ length: count }, (_, i) =>
      message({ id: `m${i}`, authorId: "user-b", text }),
    );
  }

  function ids(history: HistoryMessage[]): string[] {
    return buildContext(request(channel, history), 0).messages.map((m) => m.id);
  }

  it("keeps the 40 most recent messages and drops the oldest beyond that", () => {
    const kept = ids(many(45));
    expect(kept).toHaveLength(40);
    expect(kept[0]).toBe("m5");
    expect(kept.at(-1)).toBe("m44");
  });

  it("stops at the character budget, always keeping the most recent messages", () => {
    // Six messages of 6,000 chars: only four fit the 24,000-char budget.
    const decision = buildContext(request(channel, many(6, "x".repeat(6_000))), 0);
    expect(decision.messages.map((m) => m.id)).toEqual(["m2", "m3", "m4", "m5"]);
  });

  it("drops the oldest message first when the character budget is nearly full", () => {
    // Four messages of 10,000 chars (m0 is the oldest): m3 and m2 fill 20,000; m1
    // would exceed 24,000, so m1 and the older m0 go.
    expect(ids(many(4, "y".repeat(10_000)))).toEqual(["m2", "m3"]);
  });

  it("stops at the token budget for Chinese text that fits the character budget", () => {
    // Three messages of 5,000 Chinese characters: 15,000 chars fit the 24,000-char
    // budget, but each character is about a token, and 15,000 do not fit 12,000.
    expect(ids(many(3, "字".repeat(5_000)))).toEqual(["m1", "m2"]);
  });

  it("estimates mixed text per script: one token per CJK character, four Latin chars per token", () => {
    // Each message is 5,000 Chinese characters (5,000 tokens) plus 3,000 Latin ones
    // (750): 5,750 tokens in 8,000 chars. All three fit the 24,000-char budget and
    // two fit the 12,000-token budget. Counting every char as a quarter token would
    // keep all three; counting every char as a whole token would keep only m2.
    expect(ids(many(3, "字".repeat(5_000) + "x".repeat(3_000)))).toEqual(["m1", "m2"]);
  });

  it("does not overcount Latin text: two full-budget messages still fit the token budget", () => {
    // Two messages of 12,000 Latin chars fill the 24,000-char budget at 3,000 tokens
    // each; at one token per character the second would already bust the budget.
    expect(ids(many(2, "x".repeat(12_000)))).toEqual(["m0", "m1"]);
  });
});

describe("anchor history (a thread started from a channel discussion)", () => {
  const thread = "discord:123:c1:t1";

  function anchor(id: string, createdAt = 1000): HistoryMessage {
    return message({ id, authorId: "user-b", createdAt });
  }

  /** A thread's first turn: the mention is its starter, so it sits in both lists. */
  function startedRequest(
    anchorHistory: HistoryMessage[],
    history: HistoryMessage[] = [],
  ): GenerationRequest {
    return { ...request(thread, history), messageId: "mention", anchorHistory };
  }

  const anchors = [anchor("a1"), anchor("a2"), anchor("mention")];

  it("reads the parent channel's discussion ahead of the thread's own history", () => {
    const decision = buildContext(startedRequest(anchors), 0);

    expect(decision.mode).toBe("thread");
    expect(decision.messages.map((m) => m.id)).toEqual(["a1", "a2"]);
  });

  it("shows a message present in both lists once, where it was said", () => {
    const decision = buildContext(startedRequest(anchors, [anchor("mention"), anchor("h1")]), 0);

    expect(decision.messages.map((m) => m.id)).toEqual(["a1", "a2", "h1"]);
  });

  it("applies the reset cutoff to the anchors like to any other message", () => {
    const decision = buildContext(startedRequest([anchor("a1", 1000), anchor("a2", 2000)]), 1500);

    expect(decision.messages.map((m) => m.id)).toEqual(["a2"]);
  });

  it("lets a long thread history crowd out the oldest anchors first", () => {
    const many = (prefix: string, count: number): HistoryMessage[] =>
      Array.from({ length: count }, (_, i) => anchor(`${prefix}${i}`));

    // 35 thread messages leave room for all five anchors; 40 leave none.
    const short = buildContext(startedRequest(many("a", 5), many("h", 35)), 0).messages;
    expect(short).toHaveLength(40);
    expect(short.slice(0, 5).map((m) => m.id)).toEqual(["a0", "a1", "a2", "a3", "a4"]);

    const full = buildContext(startedRequest(many("a", 5), many("h", 40)), 0).messages;
    expect(full).toHaveLength(40);
    expect(full.every((m) => m.id.startsWith("h"))).toBe(true);
  });

  it("answers from the anchors alone when the thread is new", () => {
    const decision = buildContext(startedRequest(anchors), 0);

    expect(decision.messages).toHaveLength(2);
    expect(buildContext(startedRequest([]), 0)).toEqual({ mode: "none", messages: [] });
  });

  it("keeps a DM to the requesting user's and the bot's anchors, as with its history", () => {
    const req: GenerationRequest = {
      ...request("discord:@me:999888", []),
      anchorHistory: [
        anchor("theirs", 1000),
        message({ id: "mine", authorId: "user-a", createdAt: 1100 }),
        message({ id: "bots", authorId: "bot", isBot: true, createdAt: 1200 }),
      ],
    };

    const decision = buildContext(req, 0);

    expect(decision.messages.map((m) => m.id)).toEqual(["mine", "bots"]);
  });
});

describe("threadOf", () => {
  const thread: GenerationRequest = {
    ...request("123", []),
    containerId: "discord:123:c1:t1",
    channelId: "t1",
    parentChannelId: "c1",
  };

  it("names the thread and its parent channel for a thread request", () => {
    expect(threadOf(thread)).toEqual({ threadId: "t1", parentChannelId: "c1" });
  });

  it("answers null for a channel, for a thread without a parent, and always for a DM", () => {
    expect(threadOf(request("123", []))).toBeNull();
    expect(threadOf({ ...thread, parentChannelId: null })).toBeNull();
    expect(threadOf({ ...thread, parentChannelId: undefined })).toBeNull();
    expect(threadOf({ ...thread, scopeId: "dm", containerId: "discord:@me:t1" })).toBeNull();
  });
});

describe("DM container keying (ADR-011 §3)", () => {
  it("a DM container is never treated as a thread", () => {
    expect(isThreadContainer("discord:@me:999888")).toBe(false);
    expect(isThreadContainer("discord:111:222:333")).toBe(true);
  });

  it("DM context keeps only the requesting user's and bot messages", () => {
    const history = [
      message({ id: "m1", authorId: "user-a", createdAt: 1000 }),
      message({ id: "m2", authorId: "intruder", createdAt: 1100 }),
      message({ id: "m3", authorId: "bot", isBot: true, createdAt: 1200 }),
    ];
    const decision = buildContext(request("discord:@me:999888", history), 0);
    expect(decision.mode).toBe("channel");
    expect(decision.messages.map((m) => m.id)).toEqual(["m1", "m3"]);
  });

  it("DM context honors the reset cutoff", () => {
    const history = [
      message({ id: "old", authorId: "user-a", createdAt: 1000 }),
      message({ id: "new", authorId: "user-a", createdAt: 2000 }),
    ];
    const decision = buildContext(request("discord:@me:999888", history), 1500);
    expect(decision.messages.map((m) => m.id)).toEqual(["new"]);
  });

  it("the current message is never part of its own context", () => {
    const history = [message({ id: "current", authorId: "user-a", createdAt: 1000 })];
    const decision = buildContext(request("discord:@me:999888", history), 0);
    expect(decision.mode).toBe("none");
    expect(decision.messages).toEqual([]);
  });
});
