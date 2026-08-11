import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import type { Message } from "chat";
import { buildContext, formatContextBlock, type BuildContextParams } from "../../src/context";

// --- Stubs ------------------------------------------------------------------

type StubAuthor = {
  userId: string;
  userName: string;
  fullName: string;
  isBot: boolean | "unknown";
  isMe: boolean;
};

type StubMessage = {
  id: string;
  text: string;
  author: StubAuthor;
  metadata: { dateSent: Date; edited: boolean };
};

function mkMsg(id: string, text: string, opts: Partial<StubMessage> = {}): Message {
  const author: StubAuthor = opts.author ?? {
    userId: "u1",
    userName: "alice",
    fullName: "Alice",
    isBot: false,
    isMe: false,
  };
  const metadata = opts.metadata ?? {
    dateSent: new Date(100_000),
    edited: false,
  };
  return { id, text, author, metadata } as unknown as Message;
}

function mkBotMsg(id: string, text: string, dateSent = new Date(100_000)): Message {
  return mkMsg(id, text, {
    author: {
      userId: "bot",
      userName: "Xenoblade",
      fullName: "Xenoblade",
      isBot: true,
      isMe: true,
    },
    metadata: { dateSent, edited: false },
  });
}

/** Build a fake Thread whose adapter returns the provided messages. */
function mkThread(
  messages: Message[],
  opts: {
    id?: string;
    fetchMessages?: Mock;
    fetchChannelMessages?: Mock;
    channelPost?: Mock;
    post?: Mock;
  } = {},
) {
  const id = opts.id ?? "discord:g:c";
  const fetchMessages = opts.fetchMessages ?? vi.fn(async () => ({ messages }));
  const fetchChannelMessages = opts.fetchChannelMessages;
  const post = opts.post ?? vi.fn(async () => {});
  const channelPost = opts.channelPost ?? vi.fn(async () => {});
  return {
    id,
    adapter: {
      fetchMessages,
      ...(fetchChannelMessages ? { fetchChannelMessages } : {}),
    },
    post,
    channel: { id, post: channelPost },
  } as unknown as BuildContextParams["thread"];
}

const BASE_NOW = 200_000;

function mkParams(
  thread: BuildContextParams["thread"],
  message: Message,
  overrides: Partial<BuildContextParams> = {},
): BuildContextParams {
  return {
    thread,
    message,
    forceContext: false,
    resetAt: 0,
    now: BASE_NOW,
    ...overrides,
  };
}

// --- Tests ------------------------------------------------------------------

describe("buildContext — forced thread mode", () => {
  it("includes all resetAt-filtered messages in a real thread", async () => {
    const current = mkMsg("cur", "hello");
    const old1 = mkMsg("a", "old1", {
      metadata: { dateSent: new Date(10_000), edited: false },
    });
    const recent = mkMsg("b", "recent", {
      metadata: { dateSent: new Date(150_000), edited: false },
    });
    const thread = mkThread([old1, recent, current], { id: "discord:g:p:t1" });

    const result = await buildContext(
      mkParams(thread, current, { forceContext: true, resetAt: 50_000 }),
    );

    expect(result.mode).toBe("thread");
    expect(result.forced).toBe(true);
    // old1 is before resetAt (10k < 50k), excluded; recent and current kept.
    expect(result.messages.map((m) => m.id)).toEqual(["b", "cur"]);
  });

  it("keeps all messages when resetAt is 0", async () => {
    const current = mkMsg("cur", "hello");
    const old1 = mkMsg("a", "old");
    const thread = mkThread([old1, current], { id: "discord:g:p:t1" });

    const result = await buildContext(
      mkParams(thread, current, { forceContext: true, resetAt: 0 }),
    );

    expect(result.messages.map((m) => m.id)).toEqual(["a", "cur"]);
  });

  it("never calls fetchChannelMessages for a four-segment thread ID", async () => {
    const current = mkMsg("cur", "hello");
    const fetchChannelMessages = vi.fn(async () => ({ messages: [] }));
    const thread = mkThread([current], {
      id: "discord:g:p:t1",
      fetchChannelMessages,
    });

    await buildContext(mkParams(thread, current, { forceContext: true }));

    expect(fetchChannelMessages).not.toHaveBeenCalled();
  });
});

describe("buildContext — forced channel mode", () => {
  it("filters to same-user and bot messages only", async () => {
    const alice = mkMsg("a1", "alice msg", {
      author: { userId: "alice", userName: "alice", fullName: "Alice", isBot: false, isMe: false },
    });
    const bob = mkMsg("b1", "bob msg", {
      author: { userId: "bob", userName: "bob", fullName: "Bob", isBot: false, isMe: false },
    });
    const botReply = mkBotMsg("bot1", "bot reply");
    const current = mkMsg("cur", "alice again", {
      author: { userId: "alice", userName: "alice", fullName: "Alice", isBot: false, isMe: false },
    });
    // Three-segment ID = channel.
    const thread = mkThread([alice, bob, botReply, current], { id: "discord:g:c" });

    const result = await buildContext(mkParams(thread, current, { forceContext: true }));

    expect(result.mode).toBe("channel");
    expect(result.forced).toBe(true);
    // Bob's message should be excluded; Alice + bot kept.
    expect(result.messages.map((m) => m.id)).toEqual(["a1", "bot1", "cur"]);
    expect(result.messages.some((m) => m.id === "b1")).toBe(false);
  });

  it("caps at MAX_FORCED_CHANNEL_MESSAGES (12)", async () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(
        mkMsg(`m${i}`, `msg${i}`, {
          author: {
            userId: "alice",
            userName: "alice",
            fullName: "Alice",
            isBot: false,
            isMe: false,
          },
          metadata: { dateSent: new Date(i), edited: false },
        }),
      );
    }
    const current = mkMsg("cur", "current", {
      author: { userId: "alice", userName: "alice", fullName: "Alice", isBot: false, isMe: false },
    });
    const thread = mkThread([...msgs, current], { id: "discord:g:c" });

    const result = await buildContext(mkParams(thread, current, { forceContext: true }));

    // 20 alice msgs + 1 current = 21, capped to last 12.
    expect(result.messages.length).toBe(12);
    // Most recent 12 retained (m9..m19 + cur = 12).
    expect(result.messages[result.messages.length - 1]?.id).toBe("cur");
    expect(result.messages[0]?.id).toBe("m9");
  });

  it("excludes messages before resetAt", async () => {
    const old = mkMsg("old", "old", {
      metadata: { dateSent: new Date(1_000), edited: false },
    });
    const recent = mkMsg("rec", "recent", {
      metadata: { dateSent: new Date(100_000), edited: false },
    });
    const current = mkMsg("cur", "hi", {
      metadata: { dateSent: new Date(BASE_NOW), edited: false },
    });
    const thread = mkThread([old, recent, current], { id: "discord:g:c" });

    const result = await buildContext(
      mkParams(thread, current, { forceContext: true, resetAt: 50_000 }),
    );

    expect(result.messages.map((m) => m.id)).toEqual(["rec", "cur"]);
  });
});

describe("buildContext — relevance scoring path", () => {
  it("returns selected messages with forced=false", async () => {
    const current = mkMsg("cur", "tell me about blades");
    const relevant = mkMsg("r1", "blades are weapons", {
      metadata: { dateSent: new Date(180_000), edited: false },
    });
    const irrelevant = mkMsg("r2", "pizza is good", {
      metadata: { dateSent: new Date(180_000), edited: false },
    });
    const thread = mkThread([relevant, irrelevant, current], { id: "discord:g:c" });

    const result = await buildContext(mkParams(thread, current));

    expect(result.forced).toBe(false);
    expect(result.mode).toBe("channel");
    // "blades" overlap should make r1 relevant; r2 likely below threshold.
    expect(result.reason).toBe("relevant");
    // current message is always excluded from selected messages.
    expect(result.messages.every((m) => m.id !== "cur")).toBe(true);
  });

  it("returns empty messages when no candidates are relevant", async () => {
    const current = mkMsg("cur", "zzz qqq xxx");
    const other = mkMsg("o1", "completely different topic", {
      metadata: { dateSent: new Date(100), edited: false },
    });
    const thread = mkThread([other, current], { id: "discord:g:c" });

    const result = await buildContext(mkParams(thread, current));

    expect(result.messages.length).toBe(0);
  });
});

describe("buildContext — history fetch error", () => {
  it("degrades to mode none on adapter error", async () => {
    const current = mkMsg("cur", "hello");
    const fetchMessages = vi.fn(async () => {
      throw new Error("network failure");
    });
    const thread = mkThread([], {
      id: "discord:g:p:t1",
      fetchMessages,
    });

    const result = await buildContext(mkParams(thread, current, { forceContext: true }));

    expect(result.mode).toBe("none");
    expect(result.forced).toBe(false);
    expect(result.messages).toEqual([]);
  });
});

describe("formatContextBlock", () => {
  it("returns empty string for no messages", () => {
    expect(formatContextBlock([])).toBe("");
  });

  it("formats messages with author display name and text", () => {
    const msgs = [
      mkMsg("a", "hello world", {
        author: { userId: "u1", userName: "alice", fullName: "Alice", isBot: false, isMe: false },
      }),
      mkMsg("b", "hi there", {
        author: {
          userId: "bot",
          userName: "Xenoblade",
          fullName: "Xenoblade",
          isBot: true,
          isMe: true,
        },
      }),
    ];
    const block = formatContextBlock(msgs);
    expect(block).toContain("[Relevant Discord context]");
    expect(block).toContain("Alice: hello world");
    expect(block).toContain("Xenoblade: hi there");
  });

  it("falls back to userName when fullName is empty", () => {
    const msg = mkMsg("a", "text", {
      author: { userId: "u1", userName: "bob", fullName: "", isBot: false, isMe: false },
    });
    const block = formatContextBlock([msg]);
    expect(block).toContain("bob: text");
  });
});
