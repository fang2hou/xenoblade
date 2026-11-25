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

/** The Worker client a `ThreadSessions` sends with. */
type Send = NonNullable<ThreadSessionsOptions["send"]>;

const GUILD = "g1";
const CHANNEL = "c1";
const THREAD = "t1";
const USER = "u1";

const REF: ThreadRef = { id: THREAD, parentId: CHANNEL };

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

/** A `ThreadSessions` whose every request goes to `send`. */
function sessions(send: Send): ThreadSessions {
  return new ThreadSessions({ workerUrl: "https://worker", token: "token", send });
}

/** A Worker that answers each request from a script, and records what it was asked. */
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

type FakeThread = { id: string; isThread: () => boolean };

/** A summoning message in a server text channel, with what was done to it recorded. */
function summonMessage(options: { hasThread?: boolean; thread?: FakeThread; fail?: Error } = {}): {
  message: Message;
  calls: string[];
  thread: FakeThread;
  startThread: Mock<() => Promise<FakeThread>>;
} {
  const calls: string[] = [];
  const thread: FakeThread = { id: THREAD, isThread: () => true };
  const startThread = vi.fn<() => Promise<FakeThread>>(async () => {
    calls.push("startThread");
    if (options.fail) throw options.fail;
    return thread;
  });
  const fetchThread = vi.fn<() => Promise<FakeThread>>(async () => {
    calls.push("fetchThread");
    return thread;
  });
  const message = {
    id: "m9",
    channelId: CHANNEL,
    channel: { id: CHANNEL, type: ChannelType.GuildText },
    thread: options.thread ?? null,
    hasThread: options.hasThread ?? false,
    startThread,
    client: { channels: { fetch: fetchThread } },
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double standing in for a discord.js Message
  return { message: message as unknown as Message, calls, thread, startThread };
}

/** The parent channel's messages, newest first as Discord answers. */
const PARENT_MESSAGES: HistoryMessage[] = ["m9", "m8", "m7"].map((id, i) => ({
  id,
  text: `text ${id}`,
  authorId: USER,
  authorName: "User",
  isBot: false,
  createdAt: 900 - i,
}));

/** A history reader standing in for Discord: answers from `PARENT_MESSAGES`, oldest first like the real one, and records each limit. */
function stubHistory(): { fetchHistory: typeof fetchHistory; limits: number[] } {
  const limits: number[] = [];
  const reader = vi.fn<typeof fetchHistory>(async (_channel, requested) => {
    limits.push(requested ?? 50);
    return PARENT_MESSAGES.slice(0, requested ?? 50).toReversed();
  });
  return { fetchHistory: reader, limits };
}

describe("startDiscussionThread", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads 20 parent messages before it starts the thread, and leaves the summon out of them", async () => {
    const { message, calls } = summonMessage();
    const { fetchHistory, limits } = stubHistory();

    const started = await startDiscussionThread(message, { name: "Deploy help", fetchHistory });

    expect(started?.thread.id).toBe(THREAD);
    expect(limits).toEqual([20]);
    // The summon is the request; the anchors are what was said before it, oldest first.
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
    const existing = { id: THREAD, isThread: () => true };
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
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await startDiscussionThread(message, { name: "Deploy help", fetchHistory })).toBeNull();

    const events = log.mock.calls.map(
      (line) => JSON.parse(String(line[0])) as Record<string, unknown>,
    );
    expect(events).toEqual([{ event: "thread_start_error", messageId: "m9", code: 50013 }]);
  });

  it("names any other failure by its error name, without its message, and still answers in the channel", async () => {
    const { message } = summonMessage({ fail: new TypeError("socket hung up") });
    const { fetchHistory } = stubHistory();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await startDiscussionThread(message, { name: "Deploy help", fetchHistory })).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain('"code":"TypeError"');
  });

  it("still starts the thread when the parent history cannot be read", async () => {
    const { message } = summonMessage();
    const reader = vi.fn<typeof fetchHistory>(async () => {
      throw new Error("Discord down");
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const started = await startDiscussionThread(message, {
      name: "Deploy help",
      fetchHistory: reader,
    });

    expect(started).toMatchObject({
      thread: { id: THREAD },
      anchorHistory: [],
    });
    expect(
      log.mock.calls.map((line) => (JSON.parse(String(line[0])) as Record<string, unknown>).event),
    ).toEqual(["anchor_fetch_error", "thread_started"]);
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

  it("names the thread a request was addressed to", () => {
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

  it("asks the Worker whether a thread is followed, and remembers the answer", async () => {
    const { requests, send } = stubWorker(session());
    const store = sessions(send);

    expect(await store.isFollowed(REF)).toBe(true);
    expect(await store.isFollowed(REF)).toBe(true);
    expect(await store.pendingCardIds(REF)).toEqual([]);

    expect(requests).toEqual([{ op: "get", threadId: THREAD }]);
  });

  it("reads a thread that was never registered as unfollowed, without asking again", async () => {
    const { requests, send } = stubWorker(null);
    const store = sessions(send);

    expect(await store.isFollowed(REF)).toBe(false);
    expect(await store.isFollowed(REF)).toBe(false);
    expect(requests).toEqual([{ op: "get", threadId: THREAD }]);
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

  it("makes the bot follow a thread, registering it with who summoned there", async () => {
    const { requests, send } = stubWorker(session());
    const store = sessions(send);

    await store.follow(REF, GUILD, USER);
    expect(await store.isFollowed(REF)).toBe(true);

    expect(requests).toEqual([
      { op: "upsert", threadId: THREAD, guildId: GUILD, parentChannelId: CHANNEL, createdBy: USER },
    ]);
  });

  it("resumes a thread it remembered as unfollowed", async () => {
    const { requests, send } = stubWorker(session({ active: false }), session());
    const store = sessions(send);

    expect(await store.isFollowed(REF)).toBe(false);
    await store.follow(REF, GUILD, USER);
    expect(await store.isFollowed(REF)).toBe(true);

    expect(ops(requests)).toEqual(["get", "upsert"]);
  });

  it("keeps what it remembered when a change cannot be stored", async () => {
    const { send } = stubWorker(new Error("Worker request failed"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const store = sessions(send);

    await store.follow(REF, GUILD, USER);

    expect(await store.isFollowed(REF)).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("sends nothing for a thread Discord gave no parent channel", async () => {
    const { requests, send } = stubWorker(session());
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await sessions(send).follow({ id: THREAD, parentId: null }, GUILD, USER);

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

  it("records a question card with the Worker and remembers it", async () => {
    const { requests, send } = stubWorker(session({ pendingCardIds: ["card-1"] }));
    const store = sessions(send);

    await store.recordCard(REF, "card-1");

    expect(await store.pendingCardIds(REF)).toEqual(["card-1"]);
    expect(requests).toEqual([{ op: "add_card", threadId: THREAD, cardMessageId: "card-1" }]);
  });

  it("forgets the thread's question cards with the Worker", async () => {
    const { requests, send } = stubWorker(session({ pendingCardIds: ["card-1"] }), session());
    const store = sessions(send);
    expect(await store.pendingCardIds(REF)).toEqual(["card-1"]);

    await store.forgetCards(REF);

    expect(await store.pendingCardIds(REF)).toEqual([]);
    expect(requests.at(-1)).toEqual({ op: "clear_cards", threadId: THREAD });
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
    const first: ThreadRef = { id: "old", parentId: CHANNEL };
    await store.isFollowed(first);
    expect(await store.isFollowed(REF)).toBe(true);

    for (let i = 0; i < 2048; i++) await store.isFollowed({ id: `bulk-${i}`, parentId: CHANNEL });
    await store.isFollowed(first);

    // `old` was evicted by the bulk and is read again; the newest bulk entry is not.
    const asked = (threadId: string) => requests.filter((request) => request.threadId === threadId);
    expect(asked("old")).toHaveLength(2);
    expect(asked("bulk-2047")).toHaveLength(1);
  });
});
