import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ChannelType, DiscordAPIError, type Message } from "discord.js";
import type {
  GenerationRequest,
  HistoryMessage,
  SummonKind,
  ThreadSession,
  ThreadSessionRequest,
  ThreadSessionResponse,
} from "@xenoblade/contracts";

import type { fetchHistory } from "../src/history";
import {
  buildThreadTitle,
  startDiscussionThread,
  startsThread,
  threadOf,
  ThreadSessions,
  type ThreadRef,
  type ThreadSessionsOptions,
} from "../src/thread-manager";

/** The Worker client a `ThreadSessions` sends session requests with. */
type Send = NonNullable<ThreadSessionsOptions["send"]>;

/** The Worker client a `ThreadSessions` asks about channels with. */
type Ask = NonNullable<ThreadSessionsOptions["ask"]>;

const GUILD = "g1";
const CHANNEL = "c1";
const THREAD = "t1";
const USER = "u1";

const REF: ThreadRef = { guildId: GUILD, id: THREAD, parentId: CHANNEL };

function session(overrides: Partial<ThreadSession> = {}): ThreadSession {
  return {
    threadId: THREAD,
    guildId: GUILD,
    parentChannelId: CHANNEL,
    active: true,
    pendingCardIds: [],
    ...overrides,
  };
}

/** A `ThreadSessions` whose every request goes to `send` and `ask`. */
function sessions(send: Send, ask?: Ask): ThreadSessions {
  return new ThreadSessions({ workerUrl: "https://worker", token: "token", send, ask });
}

/** A Worker that answers each session request from a script, and records what it was asked. */
function stubWorker(...answers: Array<ThreadSession | null | Error>): {
  requests: ThreadSessionRequest[];
  send: Send;
} {
  const requests: ThreadSessionRequest[] = [];
  const send = vi.fn<Send>(async (req) => {
    requests.push(req);
    const answer = answers.shift() ?? null;
    if (answer instanceof Error) throw answer;
    return { status: "ok", session: answer } satisfies ThreadSessionResponse;
  });
  return { requests, send };
}

const ops = (requests: readonly ThreadSessionRequest[]) => requests.map((request) => request.op);

describe("startsThread", () => {
  const cases: Array<[string, SummonKind, ChannelType, boolean]> = [
    ["a direct mention", "user-mention", ChannelType.GuildText, true],
    ["a watched-role mention", "role-mention", ChannelType.GuildText, true],
    ["a reply to the bot", "reply-to-bot", ChannelType.GuildText, false],
    ["a mention in an announcement channel", "user-mention", ChannelType.GuildAnnouncement, false],
    ["a mention in a voice channel's text chat", "user-mention", ChannelType.GuildVoice, false],
  ];

  it.each(cases)("is %s answered in a started thread: %s", (_case, kind, type, expected) => {
    expect(startsThread(kind, { type })).toBe(expected);
  });
});

describe("buildThreadTitle", () => {
  it("names the thread by the summon's words, without its mention tokens", () => {
    expect(buildThreadTitle("<@123> how do I deploy this?", "fallback")).toBe(
      "how do I deploy this?",
    );
    expect(buildThreadTitle("<@&9>   <@!123>\n  the build\n\n  broke   ", "fallback")).toBe(
      "the build broke",
    );
    expect(buildThreadTitle("check <#123> please", "fallback")).toBe("check please");
  });

  it("falls back when the summon says nothing but the mention", () => {
    expect(buildThreadTitle("<@123>", "Discussion")).toBe("Discussion");
    expect(buildThreadTitle("  ", "Discussion")).toBe("Discussion");
    expect(buildThreadTitle("<@&9> <#12>", "Discussion")).toBe("Discussion");
  });

  it("cuts a long summon to Discord's limit without splitting a surrogate pair", () => {
    expect(buildThreadTitle("x".repeat(300), "fallback")).toHaveLength(100);

    // 99 ASCII units, then an emoji (two units): it does not fit, and is not cut in half.
    expect(buildThreadTitle(`${"x".repeat(99)}😀y`, "fallback")).toBe("x".repeat(99));
    expect(buildThreadTitle(`${"x".repeat(98)}😀y`, "fallback")).toBe(`${"x".repeat(98)}😀`);
  });

  it("trims what a cut leaves behind", () => {
    expect(buildThreadTitle(`${"x".repeat(99)} y`, "fallback")).toBe("x".repeat(99));
  });
});

/** A thread as the starter reads it: whether the bot may post in it is `sendable` and `locked`. */
type FakeThread = { id: string; isThread: () => boolean; sendable: boolean; locked: boolean };

/** Discord's answer to "a thread has already been created for this message". */
function threadAlreadyCreated(): DiscordAPIError {
  return new DiscordAPIError(
    { code: 160004, message: "A thread has already been created for this message" },
    160004,
    400,
    "POST",
    "/channels/c1/messages/m9/threads",
    { files: [], body: {} },
  );
}

/** A writable thread standing in for the one started on the message. */
function writableThread(): FakeThread {
  return { id: THREAD, isThread: () => true, sendable: true, locked: false };
}

/** A summoning message in a server text channel, with what was done to it recorded. */
function summonMessage(
  options: {
    hasThread?: boolean;
    thread?: FakeThread;
    /** What `startThread` ends in: an error, or nothing (it answers the thread). */
    fail?: Error;
    /** What fetching the message's thread answers. */
    fetches?: FakeThread | Error;
    /** Whether the channel's permissions let the bot post in threads. */
    botMayPost?: boolean;
  } = {},
): {
  message: Message;
  calls: string[];
  thread: FakeThread;
  startThread: Mock<() => Promise<FakeThread>>;
} {
  const calls: string[] = [];
  const thread = options.thread ?? writableThread();
  const startThread = vi.fn<() => Promise<FakeThread>>(async () => {
    calls.push("startThread");
    if (options.fail) throw options.fail;
    return thread;
  });
  const fetchThread = vi.fn<() => Promise<FakeThread>>(async () => {
    calls.push("fetchThread");
    if (options.fetches instanceof Error) throw options.fetches;
    return options.fetches ?? thread;
  });
  const message = {
    id: "m9",
    channelId: CHANNEL,
    channel: {
      id: CHANNEL,
      type: ChannelType.GuildText,
      permissionsFor: () => ({ has: () => options.botMayPost ?? true }),
    },
    // A thread given is one the message already has in the cache; the flag alone means an uncached one.
    thread: options.thread ?? null,
    hasThread: options.hasThread ?? options.thread !== undefined,
    startThread,
    client: { user: { id: "bot" }, channels: { fetch: fetchThread } },
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double standing in for a discord.js Message
  return { message: message as unknown as Message, calls, thread, startThread };
}

/** The parent channel's messages, oldest first as the reader returns them. */
const PARENT_MESSAGES: HistoryMessage[] = ["m7", "m8", "m9"].map((id, i) => ({
  id,
  text: `text of ${id}`,
  authorId: USER,
  authorName: "User",
  isBot: false,
  createdAt: 900 + i,
}));

/** A history reader standing in for Discord: answers from `PARENT_MESSAGES`, and records each limit and bound. */
function stubHistory(): {
  fetchHistory: typeof fetchHistory;
  calls: Array<[number | undefined, string | undefined]>;
} {
  const calls: Array<[number | undefined, string | undefined]> = [];
  const reader = vi.fn<typeof fetchHistory>(async (_channel, limit, before) => {
    calls.push([limit, before]);
    return PARENT_MESSAGES.slice(0, limit ?? 50);
  });
  return { fetchHistory: reader, calls };
}

describe("startDiscussionThread", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the 20 parent messages older than the summon, and leaves the summon out of them", async () => {
    const { message, calls } = summonMessage();
    const { fetchHistory, calls: reads } = stubHistory();

    const started = await startDiscussionThread(message, { name: "Deploy help", fetchHistory });

    expect(started?.thread.id).toBe(THREAD);
    expect(reads).toEqual([[20, "m9"]]);
    expect(started?.anchorHistory.map((anchor) => anchor.id)).toEqual(["m7", "m8"]);
    expect(calls).toEqual(["startThread"]);
  });

  it("starts a public thread named after the summon, archived after a day", async () => {
    const { message, startThread } = summonMessage();
    const { fetchHistory } = stubHistory();

    await startDiscussionThread(message, { name: "Deploy help", fetchHistory });

    expect(startThread).toHaveBeenCalledWith({ name: "Deploy help", autoArchiveDuration: 1440 });
  });

  it("reuses the thread already started on the message", async () => {
    const existing = writableThread();
    const { message, calls, startThread } = summonMessage({ hasThread: true, thread: existing });
    const { fetchHistory } = stubHistory();

    const started = await startDiscussionThread(message, { name: "Deploy help", fetchHistory });

    expect(started?.thread).toBe(existing);
    expect(startThread).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("fetches a thread the message is flagged to have when it is not cached", async () => {
    const { message, calls, startThread } = summonMessage({ hasThread: true });
    const { fetchHistory } = stubHistory();

    const started = await startDiscussionThread(message, { name: "Deploy help", fetchHistory });

    expect(started?.thread.id).toBe(THREAD);
    expect(startThread).not.toHaveBeenCalled();
    expect(calls).toEqual(["fetchThread"]);
  });

  it("reads the history before it starts the thread", async () => {
    const { message } = summonMessage();
    const order: string[] = [];
    const reader = vi.fn<typeof fetchHistory>(async () => {
      order.push("history");
      return [];
    });
    (message.startThread as unknown as () => Promise<FakeThread>) = async () => {
      order.push("startThread");
      return writableThread();
    };

    await startDiscussionThread(message, { name: "Deploy help", fetchHistory: reader });

    expect(order).toEqual(["history", "startThread"]);
  });

  describe("when Discord says the message has a thread already", () => {
    it("answers with that thread instead of giving up", async () => {
      // Another writer started a thread on the message between the look-up and the call.
      const { message, calls, startThread } = summonMessage({ fail: threadAlreadyCreated() });
      const { fetchHistory } = stubHistory();

      const started = await startDiscussionThread(message, { name: "Deploy help", fetchHistory });

      expect(startThread).toHaveBeenCalledTimes(1);
      expect(calls).toEqual(["startThread", "fetchThread"]);
      expect(started).toMatchObject({ thread: { id: THREAD } });
    });

    it("answers in the channel when that thread cannot be fetched", async () => {
      const { message } = summonMessage({
        fail: threadAlreadyCreated(),
        fetches: new DiscordAPIError(
          { code: 10003, message: "Unknown Channel" },
          10003,
          404,
          "GET",
          "/channels/m9",
          {
            files: [],
            body: {},
          },
        ),
      });
      const { fetchHistory } = stubHistory();

      expect(
        await startDiscussionThread(message, { name: "Deploy help", fetchHistory }),
      ).toBeNull();
    });

    it("answers in the channel when that thread is closed to the bot", async () => {
      const { message } = summonMessage({
        fail: threadAlreadyCreated(),
        fetches: { id: THREAD, isThread: () => true, sendable: true, locked: true },
      });
      const { fetchHistory } = stubHistory();

      expect(
        await startDiscussionThread(message, { name: "Deploy help", fetchHistory }),
      ).toBeNull();
    });
  });

  describe("thread writability", () => {
    it("starts no thread where the bot may not post in threads", async () => {
      const { message, startThread } = summonMessage({ botMayPost: false });
      const { fetchHistory, calls: reads } = stubHistory();

      expect(
        await startDiscussionThread(message, { name: "Deploy help", fetchHistory }),
      ).toBeNull();

      // Refused before anything is asked of Discord: no thread is left standing empty.
      expect(startThread).not.toHaveBeenCalled();
      expect(reads).toEqual([]);
    });

    it("answers in the channel, and reads no history, when the thread on the message is locked", async () => {
      const { message, startThread } = summonMessage({
        hasThread: true,
        thread: { id: THREAD, isThread: () => true, sendable: true, locked: true },
      });
      const { fetchHistory, calls: reads } = stubHistory();

      expect(
        await startDiscussionThread(message, { name: "Deploy help", fetchHistory }),
      ).toBeNull();

      expect(startThread).not.toHaveBeenCalled();
      expect(reads).toEqual([]);
    });

    it("answers in the channel when the thread on the message is not sendable for the bot", async () => {
      const { message } = summonMessage({
        hasThread: true,
        thread: { id: THREAD, isThread: () => true, sendable: false, locked: false },
      });
      const { fetchHistory } = stubHistory();

      expect(
        await startDiscussionThread(message, { name: "Deploy help", fetchHistory }),
      ).toBeNull();
    });

    it("answers in the channel when the thread it started turns out not to be postable", async () => {
      const { message } = summonMessage({
        thread: { id: THREAD, isThread: () => true, sendable: false, locked: false },
      });
      const { fetchHistory } = stubHistory();

      expect(
        await startDiscussionThread(message, { name: "Deploy help", fetchHistory }),
      ).toBeNull();
    });

    it("posts in the thread it started when the bot may", async () => {
      const { message } = summonMessage();
      const { fetchHistory } = stubHistory();

      expect(
        await startDiscussionThread(message, { name: "Deploy help", fetchHistory }),
      ).toMatchObject({
        thread: { id: THREAD },
      });
    });
  });

  it("answers in the channel instead when the bot may not start a thread", async () => {
    const error = new DiscordAPIError(
      { code: 50013, message: "Missing Permissions" },
      50013,
      403,
      "POST",
      "/channels/c1/messages/m9/threads",
      { files: [], body: {} },
    );
    const { message } = summonMessage({ fail: error });
    const { fetchHistory } = stubHistory();

    expect(await startDiscussionThread(message, { name: "Deploy help", fetchHistory })).toBeNull();

    const events = vi
      .mocked(console.log)
      .mock.calls.map((line) => JSON.parse(String(line[0])) as { event: string });
    expect(events.map((event) => event.event)).toEqual(["thread_start_error"]);
  });

  it("names any other failure by its error name, without its message, and still answers in the channel", async () => {
    const { message } = summonMessage({ fail: new TypeError("socket hung up") });
    const { fetchHistory } = stubHistory();

    expect(await startDiscussionThread(message, { name: "Deploy help", fetchHistory })).toBeNull();
    expect(vi.mocked(console.log).mock.calls).toHaveLength(1);
    expect(String(vi.mocked(console.log).mock.calls[0]?.[0])).toContain('"code":"TypeError"');
  });

  it("still starts the thread when the parent history cannot be read", async () => {
    const { message } = summonMessage();
    const reader = vi.fn<typeof fetchHistory>(async () => {
      throw new Error("Discord down");
    });

    const started = await startDiscussionThread(message, {
      name: "Deploy help",
      fetchHistory: reader,
    });

    expect(started).toMatchObject({ thread: { id: THREAD }, anchorHistory: [] });
    const events = vi
      .mocked(console.log)
      .mock.calls.map((line) => (JSON.parse(String(line[0])) as { event: string }).event);
    expect(events).toEqual(["anchor_fetch_error", "thread_started"]);
  });

  it("starts no thread outside a regular text channel", async () => {
    const { message, startThread } = summonMessage();
    (message.channel as unknown as { type: ChannelType }).type = ChannelType.GuildAnnouncement;
    const { fetchHistory } = stubHistory();

    expect(await startDiscussionThread(message, { name: "Deploy help", fetchHistory })).toBeNull();
    expect(fetchHistory).not.toHaveBeenCalled();
    expect(startThread).not.toHaveBeenCalled();
  });
});

describe("threadOf", () => {
  const request: GenerationRequest = {
    messageId: "m1",
    containerId: `discord:${GUILD}:${CHANNEL}`,
    scopeId: GUILD,
    channelId: CHANNEL,
    parentChannelId: null,
    userId: USER,
    userDisplayName: "User",
    summonKind: "user-mention",
    content: "hi",
    history: [],
    reference: null,
    attachments: [],
  };

  it("names the thread and its guild from a request addressed to it", () => {
    expect(
      threadOf({
        ...request,
        containerId: `discord:${GUILD}:${CHANNEL}:${THREAD}`,
        channelId: THREAD,
        parentChannelId: CHANNEL,
      }),
    ).toEqual(REF);
  });

  it("answers null for a channel request, and for one that names no parent", () => {
    expect(threadOf(request)).toBeNull();
    expect(threadOf({ ...request, parentChannelId: undefined })).toBeNull();
  });
});

describe("ThreadSessions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("isChannelAllowed", () => {
    const channel = { guildId: GUILD, channelId: CHANNEL };

    it("asks the Worker whether it answers in the channel", async () => {
      const ask = vi.fn<Ask>(async () => ({ status: "ok", allowed: false }));

      expect(await sessions(stubWorker().send, ask).isChannelAllowed(channel)).toBe(false);
      expect(ask).toHaveBeenCalledWith(channel);
    });

    it("answers null when the Worker cannot be asked, so no caller acts on a guess", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const failing = sessions(
        stubWorker().send,
        vi.fn<Ask>(async () => {
          throw new Error("Worker HTTP 503");
        }),
      );
      const refusing = sessions(
        stubWorker().send,
        vi.fn<Ask>(async () => ({ status: "error", code: "invalid_body" })),
      );

      expect(await failing.isChannelAllowed(channel)).toBeNull();
      expect(await refusing.isChannelAllowed(channel)).toBeNull();
      expect(log).toHaveBeenCalledTimes(1);
    });
  });

  it("asks the Worker whether a thread is followed — naming its guild — and remembers the answer", async () => {
    const { requests, send } = stubWorker(session());
    const store = sessions(send);

    expect(await store.isFollowed(REF)).toBe(true);
    expect(await store.isFollowed(REF)).toBe(true);
    expect(await store.pendingCardIds(REF)).toEqual([]);

    expect(requests).toEqual([{ op: "get", threadId: THREAD, guildId: GUILD }]);
  });

  it("reads a thread that was never registered as unfollowed, without asking again", async () => {
    const { requests, send } = stubWorker(null);
    const store = sessions(send);

    expect(await store.isFollowed(REF)).toBe(false);
    expect(await store.isFollowed(REF)).toBe(false);
    expect(ops(requests)).toEqual(["get"]);
  });

  it("asks the Worker again once what it remembered has grown old", async () => {
    vi.useFakeTimers();
    const { requests, send } = stubWorker(session({ active: false }), session());
    const store = sessions(send);

    expect(await store.isFollowed(REF)).toBe(false);
    expect(await store.isFollowed(REF)).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await store.isFollowed(REF)).toBe(true);
    expect(ops(requests)).toEqual(["get", "get"]);
  });

  it("reads a thread as unfollowed while the Worker cannot be reached, and asks again later", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { requests, send } = stubWorker(new Error("Worker HTTP 503"), session());
    const store = sessions(send);

    expect(await store.isFollowed(REF)).toBe(false);
    expect(await store.isFollowed(REF)).toBe(true);

    expect(ops(requests)).toEqual(["get", "get"]);
    const events = log.mock.calls.map(
      (line) => JSON.parse(String(line[0])) as Record<string, unknown>,
    );
    expect(events).toEqual([
      { event: "thread_session_error", op: "get", threadId: THREAD, detail: "Error" },
    ]);
  });

  it("reads a thread as unfollowed when the Worker answers with an error", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const send = vi.fn<Send>(async () => ({ status: "error", code: "thread_state_failed" }));
    const store = sessions(send);

    expect(await store.isFollowed(REF)).toBe(false);

    expect(send).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("makes the bot follow a thread, registering it with its guild and who summoned there", async () => {
    const { requests, send } = stubWorker(session());
    const store = sessions(send);

    await store.follow(REF, USER);
    expect(await store.isFollowed(REF)).toBe(true);

    expect(requests).toEqual([
      { op: "upsert", threadId: THREAD, guildId: GUILD, parentChannelId: CHANNEL, createdBy: USER },
    ]);
  });

  it("resumes a thread it remembered as unfollowed", async () => {
    const { requests, send } = stubWorker(session({ active: false }), session());
    const store = sessions(send);

    expect(await store.isFollowed(REF)).toBe(false);
    await store.follow(REF, USER);
    expect(await store.isFollowed(REF)).toBe(true);

    expect(ops(requests)).toEqual(["get", "upsert"]);
  });

  it("keeps what it remembered when a change cannot be stored", async () => {
    const { send } = stubWorker(new Error("Worker request failed"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const store = sessions(send);

    await store.follow(REF, USER);

    expect(await store.isFollowed(REF)).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("sends nothing for a thread Discord gave no parent channel", async () => {
    const { requests, send } = stubWorker(session());
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await sessions(send).follow({ guildId: GUILD, id: THREAD, parentId: null }, USER);

    expect(requests).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("notes an unfollowed thread without a request, since the Worker stored it", async () => {
    const { requests, send } = stubWorker(session());
    const store = sessions(send);
    expect(await store.isFollowed(REF)).toBe(true);

    store.unfollow(THREAD);

    expect(await store.isFollowed(REF)).toBe(false);
    expect(ops(requests)).toEqual(["get"]);
  });

  it("records a question card with the Worker, naming the guild, and remembers it", async () => {
    const { requests, send } = stubWorker(session({ pendingCardIds: ["card-1"] }));
    const store = sessions(send);

    await store.recordCard(REF, "card-1");

    expect(await store.pendingCardIds(REF)).toEqual(["card-1"]);
    expect(requests).toEqual([
      { op: "add_card", threadId: THREAD, guildId: GUILD, cardMessageId: "card-1" },
    ]);
  });

  it("forgets the cards it is told are gone, and keeps the cards the Worker still lists", async () => {
    const { requests, send } = stubWorker(
      session({ pendingCardIds: ["card-1", "card-2"] }),
      session({ pendingCardIds: ["card-2"] }),
    );
    const store = sessions(send);
    expect(await store.pendingCardIds(REF)).toEqual(["card-1", "card-2"]);

    // The Runtime deleted card-1; card-2's delete failed, so it is not named.
    await store.forgetCards(REF, ["card-1"]);

    expect(requests.at(-1)).toEqual({
      op: "clear_cards",
      threadId: THREAD,
      guildId: GUILD,
      clearedIds: ["card-1"],
    });
    // The Worker's own list is what is remembered: the card it still lists is still cleaned up.
    expect(await store.pendingCardIds(REF)).toEqual(["card-2"]);
  });

  it("sends nothing when there is no card to forget", async () => {
    const { requests, send } = stubWorker(session());
    const store = sessions(send);

    await store.forgetCards(REF, []);

    expect(requests).toEqual([]);
  });

  it("keeps its cards on record when the Worker cannot be told they are gone", async () => {
    const { requests, send } = stubWorker(
      session({ pendingCardIds: ["card-1"] }),
      new Error("Worker request failed"),
    );
    const store = sessions(send);
    expect(await store.pendingCardIds(REF)).toEqual(["card-1"]);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await store.forgetCards(REF, ["card-1"]);

    expect(ops(requests)).toEqual(["get", "clear_cards"]);
    expect(await store.pendingCardIds(REF)).toEqual(["card-1"]);
  });

  it("forgets a thread the Worker kept no session for, so the next lookup asks again", async () => {
    const { requests, send } = stubWorker(session(), null, session());
    const store = sessions(send);
    expect(await store.isFollowed(REF)).toBe(true);

    await store.recordCard(REF, "card-1");
    expect(await store.isFollowed(REF)).toBe(true);

    expect(ops(requests)).toEqual(["get", "add_card", "get"]);
  });

  it("forgets the oldest sessions beyond its cap", async () => {
    const { requests, send } = stubWorker(session(), session());
    const store = sessions(send);
    const first: ThreadRef = { guildId: GUILD, id: "old", parentId: CHANNEL };
    await store.isFollowed(first);
    expect(await store.isFollowed(REF)).toBe(true);

    for (let i = 0; i < 2048; i++) {
      await store.isFollowed({ guildId: GUILD, id: `bulk-${i}`, parentId: CHANNEL });
    }
    await store.isFollowed(first);

    // `old` was evicted by the bulk and is read again; the newest bulk entry is not.
    const asked = (threadId: string) => requests.filter((request) => request.threadId === threadId);
    expect(asked("old")).toHaveLength(2);
    expect(asked("bulk-2047")).toHaveLength(1);
  });
});
