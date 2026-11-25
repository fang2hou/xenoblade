import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  ButtonStyle,
  ChannelType,
  DMChannel,
  DiscordAPIError,
  MessageFlags,
  TextChannel,
  ThreadChannel,
  type Client,
  type Message,
  type MessageComponentInteraction,
  type MessageCreateOptions,
  type SendableChannels,
} from "discord.js";
import type {
  GenerationRequest,
  GenerationResult,
  HistoryMessage,
  ThreadSession,
  ThreadSessionRequest,
  ThreadSessionResponse,
} from "@xenoblade/contracts";

import { generate } from "../src/ai-client";
import type * as AiClient from "../src/ai-client";
import { AskPromptRegistry } from "../src/ask-confirm";
import {
  handleMessageCreate,
  handleComponentInteraction,
  type Runtime,
} from "../src/generation-flow";
import { handleDmMessage } from "../src/dm-commands";
import { fetchHistory } from "../src/history";
import type * as History from "../src/history";
import type * as Language from "../src/language";
import { MemoryConfirmRegistry } from "../src/memory-confirm";
import { RetryRequests } from "../src/retry-requests";
import { SoulConfirmRegistry } from "../src/soul-confirm";
import { ThreadSessions, type ThreadSessionsOptions } from "../src/thread-manager";

vi.mock("../src/ai-client", async (importOriginal) => {
  const actual = await importOriginal<typeof AiClient>();
  return { ...actual, generate: vi.fn<typeof generate>() };
});

vi.mock("../src/history", async (importOriginal) => {
  const actual = await importOriginal<typeof History>();
  return { ...actual, fetchHistory: vi.fn<typeof fetchHistory>() };
});

vi.mock("../src/language", async (importOriginal) => {
  const actual = await importOriginal<typeof Language>();
  return {
    ...actual,
    resolveUiLanguageBounded: vi.fn<typeof Language.resolveUiLanguageBounded>(async () => "zh"),
  };
});

vi.mock("../src/dm-commands", () => ({ handleDmMessage: vi.fn<typeof handleDmMessage>() }));

/** The Worker client a `ThreadSessions` sends session requests with. */
type Send = NonNullable<ThreadSessionsOptions["send"]>;

/** The Worker client a `ThreadSessions` asks about channels with. */
type Ask = NonNullable<ThreadSessionsOptions["ask"]>;

/** The flow's view of a discord.js client: its own id, and channel lookups. */
interface FakeClient {
  user: { id: string };
  channels: { fetch: (id: string) => Promise<SendableChannels | null> };
}

/** A completed generation as the flow receives it. */
type Completed = Extract<GenerationResult, { status: "completed" }>;

type Task = { containerId: string; run: () => Promise<void> };

/** What a fake message was asked to do, for a test to assert on. */
interface MessageSpies {
  startThread: Mock<() => Promise<SendableChannels>> | undefined;
  delete: Mock<() => Promise<Message>>;
}

const messageSpies = new WeakMap<Message, MessageSpies>();

/** The spies of a fake message. */
function spiesOf(message: Message): MessageSpies {
  const spies = messageSpies.get(message);
  if (spies === undefined) throw new Error("not a fake message");
  return spies;
}

const BOT = "123";
const USER = "u1";
const GUILD = "g1";
const CHANNEL = "c1";
const THREAD = "t1";

/** When a member's message was sent, as Discord timestamps messages. */
const SENT_AT = 1000;

/** When the user clicked a card, as Discord timestamps interactions. */
const CLICKED_AT = 7777;

const ok = (session: ThreadSession | null): ThreadSessionResponse => ({ status: "ok", session });

/** What a Worker holding thread sessions in memory answers to one request. */
function respond(
  req: ThreadSessionRequest,
  sessions: Map<string, ThreadSession>,
): ThreadSessionResponse {
  const current = sessions.get(req.threadId);
  // A session belongs to the guild that registered it; another guild's request finds none.
  const own = current?.guildId === req.guildId ? current : undefined;
  if (req.op === "get") return ok(own ?? null);
  if (req.op === "upsert" || (req.op === "set_active" && own === undefined)) {
    const created: ThreadSession = {
      threadId: req.threadId,
      guildId: req.guildId,
      parentChannelId: req.parentChannelId,
      active: req.op === "upsert" ? true : req.active,
      pendingCardIds: own?.pendingCardIds ?? [],
    };
    sessions.set(req.threadId, created);
    return ok(created);
  }
  if (own === undefined) return ok(null);
  if (req.op === "set_active") {
    const updated = { ...own, active: req.active };
    sessions.set(req.threadId, updated);
    return ok(updated);
  }
  const pendingCardIds =
    req.op === "add_card"
      ? [...own.pendingCardIds, req.cardMessageId]
      : own.pendingCardIds.filter((id) => !req.clearedIds.includes(id));
  const updated = { ...own, pendingCardIds };
  sessions.set(req.threadId, updated);
  return ok(updated);
}

/** A Worker holding thread sessions in memory, which answers every channel with "allowed". */
function fakeWorker(): {
  sessions: Map<string, ThreadSession>;
  send: Mock<Send>;
  ask: Mock<Ask>;
} {
  const sessions = new Map<string, ThreadSession>();
  const send = vi.fn<Send>(async (req) => respond(req, sessions));
  const ask = vi.fn<Ask>(async () => ({ status: "ok", allowed: true }));
  return { sessions, send, ask };
}

/** A queue that keeps its tasks for the test to run one at a time. */
function fakeQueue(): {
  tasks: Task[];
  enqueue: Mock<(containerId: string, task: () => Promise<void>) => void>;
} {
  const tasks: Task[] = [];
  const enqueue = vi.fn<(containerId: string, task: () => Promise<void>) => void>(
    (containerId, task) => {
      tasks.push({ containerId, run: task });
    },
  );
  return { tasks, enqueue };
}

const env = {
  discordBotToken: "test-token",
  discordApplicationId: "app-id",
  workerUrl: "https://worker",
  internalApiToken: "token",
  mentionRoleIds: ["r9"],
  healthPort: 8397,
};

/**
 * An object carrying a discord.js class's prototype, so the Runtime's
 * `instanceof` checks hold. Its own fields shadow the prototype's — getters
 * such as `ThreadChannel#sendable` included.
 */
function withPrototype(prototype: object, fields: object): SendableChannels {
  const target = Object.create(prototype) as object;
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double carrying a discord.js class's prototype
  return target as SendableChannels;
}

interface FakeChannel {
  channel: SendableChannels;
  sent: MessageCreateOptions[];
  /**
   * Messages a fetch from Discord finds. A posted card is not in it unless a
   * test puts it there — which is what a card whose delete failed amounts to.
   */
  stored: Message[];
}

/** A bot message as the handlers use it. */
function fakeMessage(options: { id: string; channelId: string; content: string }): Message {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double standing in for a discord.js Message
  const message = {} as Message;
  const spies: MessageSpies = {
    startThread: undefined,
    delete: vi.fn<() => Promise<Message>>(async () => message),
  };
  Object.assign(message, {
    id: options.id,
    channelId: options.channelId,
    content: options.content,
    components: [],
    createdTimestamp: SENT_AT,
    author: { id: BOT, bot: true, displayName: "Xenoblade", username: "xenoblade" },
    member: null,
    // What a message payload reads to resolve its request body.
    client: { options: {} },
    ...spies,
  });
  messageSpies.set(message, spies);
  return message;
}

/** Discord's answer for a message that no longer exists. */
function unknownMessage(): DiscordAPIError {
  return new DiscordAPIError(
    { code: 10008, message: "Unknown Message" },
    10008,
    404,
    "GET",
    "/channels/t1/messages/x",
    { files: [], body: {} },
  );
}

/**
 * A channel the flow can post to and read back; whatever it posts comes back
 * as a bot message. The bot may post in threads of a text channel, and may
 * post in a thread, unless a test says otherwise.
 */
function fakeChannel(
  kind: "text" | "thread" | "dm",
  options: { botMayPostInThreads?: boolean; threadWritable?: boolean } = {},
): FakeChannel {
  const id = kind === "thread" ? THREAD : kind === "dm" ? "dm1" : CHANNEL;
  const sent: MessageCreateOptions[] = [];
  const stored: Message[] = [];
  const common = {
    id,
    send: vi.fn<(payload: MessageCreateOptions) => Promise<Message>>(async (payload) => {
      sent.push(payload);
      return fakeMessage({
        id: `posted-${sent.length}`,
        channelId: id,
        content: payload.content ?? "",
      });
    }),
    sendTyping: vi.fn<() => Promise<void>>(async () => undefined),
    messages: {
      fetch: vi.fn<(messageId: string) => Promise<Message>>(async (messageId) => {
        const found = stored.find((message) => message.id === messageId);
        if (found === undefined) throw unknownMessage();
        return found;
      }),
    },
    guild: { id: GUILD, channels: { cache: new Map() }, roles: { everyone: null } },
    permissionsFor: () => ({ has: () => options.botMayPostInThreads ?? true }),
  };
  const channel =
    kind === "thread"
      ? withPrototype(ThreadChannel.prototype, {
          ...common,
          type: ChannelType.PublicThread,
          parentId: CHANNEL,
          sendable: options.threadWritable ?? true,
          locked: false,
        })
      : kind === "dm"
        ? withPrototype(DMChannel.prototype, { ...common, type: ChannelType.DM, guild: null })
        : withPrototype(TextChannel.prototype, { ...common, type: ChannelType.GuildText });
  return { channel, sent, stored };
}

/** A member's message in a channel, as the trigger matrix and the request builder read it. */
function fakeSummon(options: {
  id?: string;
  content?: string;
  channel: FakeChannel;
  mentionsBot?: boolean;
  /** The message replies to one of the bot's messages. */
  repliesBot?: boolean;
  startThread?: Mock<() => Promise<SendableChannels>>;
}): Message {
  const users = new Map<string, { id: string }>();
  if (options.mentionsBot) users.set(BOT, { id: BOT });
  const inGuild = options.channel.channel.type !== ChannelType.DM;
  const startThread =
    options.startThread ??
    vi.fn<() => Promise<SendableChannels>>(async () => options.channel.channel);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double standing in for a discord.js Message
  const message = {
    id: options.id ?? "m1",
    channelId: options.channel.channel.id,
    content: options.content ?? "how do I deploy this?",
    createdTimestamp: SENT_AT,
    author: { id: USER, bot: false, displayName: "User", username: "user" },
    member: null,
    webhookId: null,
    mentions: { users, roles: new Map(), repliedUser: options.repliesBot ? { id: BOT } : null },
    reference: options.repliesBot
      ? { messageId: "bot-reply", channelId: options.channel.channel.id }
      : null,
    attachments: new Map(),
    channel: options.channel.channel,
    guildId: inGuild ? GUILD : null,
    guild: inGuild
      ? { id: GUILD, channels: { cache: new Map() }, roles: { everyone: null } }
      : null,
    thread: null,
    hasThread: false,
    startThread,
    client: { user: { id: BOT }, channels: { fetch: async () => null } },
  } as unknown as Message;
  messageSpies.set(message, {
    startThread,
    delete: vi.fn<() => Promise<Message>>(async () => message),
  });
  return message;
}

function completed(overrides: Partial<Completed> = {}): Completed {
  return {
    status: "completed",
    requestId: "req-1",
    reply: "It deploys on Fridays.",
    usage: { model: "test/model", inputTokens: 10, outputTokens: 5, durationMs: 1 },
    sources: [],
    ...overrides,
  };
}

/** Member messages, oldest first. */
function historyOf(...ids: string[]): HistoryMessage[] {
  return ids.map((id, i) => ({
    id,
    text: `text of ${id}`,
    authorId: USER,
    authorName: "User",
    isBot: false,
    createdAt: SENT_AT + i,
  }));
}

/** A bot reply in the history, after the member messages named before it. */
function botReply(id: string, after: number): HistoryMessage {
  return {
    id,
    text: `text of ${id}`,
    authorId: BOT,
    authorName: "Xenoblade",
    isBot: true,
    createdAt: SENT_AT + after,
  };
}

const ASK = {
  id: "p-1",
  question: "Which approach do you want?",
  options: [
    { id: "quick", label: "Quick fix" },
    { id: "proper", label: "Proper rewrite" },
  ],
};

const followed: ThreadSession = {
  threadId: THREAD,
  guildId: GUILD,
  parentChannelId: CHANNEL,
  active: true,
  pendingCardIds: [],
};

/** A Runtime wired to doubles: a queue that holds its tasks, a Worker in memory, and a client. */
interface Harness {
  /** What the flow queued, in order, for the test to run. */
  tasks: Task[];
  enqueue: Mock<(containerId: string, task: () => Promise<void>) => void>;
  sessions: Map<string, ThreadSession>;
  send: Mock<Send>;
  ask: Mock<Ask>;
  runtime: Runtime;
  fakeClient: FakeClient;
  client: Client;
}

function setup(worker = fakeWorker()): Harness {
  const queue = fakeQueue();
  const runtime: Runtime = {
    env,
    queue: { enqueue: queue.enqueue },
    askCards: new AskPromptRegistry(),
    retryRequests: new RetryRequests(),
    memoryConfirms: new MemoryConfirmRegistry(),
    soulConfirms: new SoulConfirmRegistry(),
    threadSessions: new ThreadSessions({
      workerUrl: env.workerUrl,
      token: env.internalApiToken,
      send: worker.send,
      ask: worker.ask,
    }),
  };
  const fakeClient: FakeClient = { user: { id: BOT }, channels: { fetch: async () => null } };
  return {
    ...queue,
    ...worker,
    runtime,
    fakeClient,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double standing in for a discord.js Client
    client: fakeClient as unknown as Client,
  };
}

/** The request of the `i`-th generation the flow sent to the Worker. */
function requestSent(i = 0): GenerationRequest {
  const call = vi.mocked(generate).mock.calls[i];
  if (call === undefined) throw new Error(`no generation #${i} was sent`);
  return call[0];
}

/** The ops of the requests a test's Worker client was asked, in order. */
function opsOf(send: Mock<Send>): string[] {
  return send.mock.calls.map((call) => call[0].op);
}

/** The card ids of each `clear_cards` request a test's Worker client was asked, in order. */
function clearedIdsOf(send: Mock<Send>): string[][] {
  return send.mock.calls.flatMap(([request]) =>
    request.op === "clear_cards" ? [request.clearedIds] : [],
  );
}

/** A button click on a card, with its acks. */
function click(customId: string, card: Message, userId = USER) {
  const interaction = {
    customId,
    user: { id: userId },
    message: card,
    createdTimestamp: CLICKED_AT,
    deferUpdate: vi.fn<() => Promise<void>>(async () => undefined),
    reply: vi.fn<(payload: unknown) => Promise<void>>(async () => undefined),
  };
  return {
    ...interaction,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double standing in for a discord.js interaction
    asInteraction: interaction as unknown as MessageComponentInteraction,
  };
}

beforeEach(() => {
  vi.mocked(generate).mockReset();
  vi.mocked(generate).mockResolvedValue(completed());
  vi.mocked(handleDmMessage).mockReset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a summon in a text channel", () => {
  it("starts a thread on the message, follows it, and answers there with the channel's discussion as anchors", async () => {
    const parent = fakeChannel("text");
    const thread = fakeChannel("thread");
    vi.mocked(fetchHistory).mockImplementation(async (channel) =>
      channel.id === CHANNEL ? historyOf("m-1", "m0", "m1") : historyOf("m1"),
    );
    const startThread = vi.fn<() => Promise<SendableChannels>>(async () => thread.channel);
    const message = fakeSummon({
      id: "m1",
      content: `<@${BOT}> how do I deploy this?`,
      channel: parent,
      mentionsBot: true,
      startThread,
    });
    const test = setup();

    await handleMessageCreate(message, test.client, test.runtime);

    expect(test.ask).toHaveBeenCalledWith({ guildId: GUILD, channelId: CHANNEL });
    expect(startThread).toHaveBeenCalledWith({
      name: "how do I deploy this?",
      autoArchiveDuration: 1440,
    });
    expect(test.send.mock.calls.map((call) => call[0])).toEqual([
      { op: "upsert", threadId: THREAD, guildId: GUILD, parentChannelId: CHANNEL, createdBy: USER },
    ]);
    expect(test.enqueue).toHaveBeenCalledTimes(1);
    expect(test.tasks[0]?.containerId).toBe("discord:g1:c1:t1");

    await test.tasks[0]?.run();

    expect(requestSent()).toEqual({
      messageId: "m1",
      messageCreatedAt: SENT_AT,
      containerId: "discord:g1:c1:t1",
      scopeId: GUILD,
      channelId: THREAD,
      parentChannelId: CHANNEL,
      publicChannelIds: [],
      userId: USER,
      userDisplayName: "User",
      summonKind: "user-mention",
      content: `<@${BOT}> how do I deploy this?`,
      history: historyOf("m1"),
      anchorHistory: historyOf("m-1", "m0"),
      reference: null,
      attachments: [],
    });
    // The anchors are read before the thread is started, from the messages older than the summon; the thread's history after.
    expect(
      vi.mocked(fetchHistory).mock.calls.map((call) => [call[0].id, call[1] ?? 50, call[2]]),
    ).toEqual([
      [CHANNEL, 20, "m1"],
      [THREAD, 50, undefined],
    ]);
    expect(thread.sent.map((payload) => payload.content)).toEqual(["It deploys on Fridays."]);
    expect(parent.sent).toEqual([]);
  });

  it("answers in the channel, with no anchors, when the thread cannot be started", async () => {
    const parent = fakeChannel("text");
    vi.mocked(fetchHistory).mockResolvedValue(historyOf("m0", "m1"));
    const failure = new DiscordAPIError(
      { code: 50013, message: "Missing Permissions" },
      50013,
      403,
      "POST",
      "/channels/c1/messages/m1/threads",
      { files: [], body: {} },
    );
    const message = fakeSummon({
      channel: parent,
      mentionsBot: true,
      startThread: vi.fn<() => Promise<SendableChannels>>(async () => {
        throw failure;
      }),
    });
    const test = setup();

    await handleMessageCreate(message, test.client, test.runtime);
    await test.tasks[0]?.run();

    expect(test.tasks[0]?.containerId).toBe("discord:g1:c1");
    expect(requestSent()).toMatchObject({ channelId: CHANNEL, parentChannelId: null });
    expect(requestSent()).not.toHaveProperty("anchorHistory");
    expect(test.send).not.toHaveBeenCalled();
    expect(parent.sent.map((payload) => payload.content)).toEqual(["It deploys on Fridays."]);
  });

  it("answers in the channel, starting no thread, where the bot may not post in threads", async () => {
    const parent = fakeChannel("text", { botMayPostInThreads: false });
    const message = fakeSummon({ channel: parent, mentionsBot: true });
    vi.mocked(fetchHistory).mockResolvedValue(historyOf("m0"));
    const test = setup();

    await handleMessageCreate(message, test.client, test.runtime);
    await test.tasks[0]?.run();

    expect(spiesOf(message).startThread).not.toHaveBeenCalled();
    expect(test.tasks[0]?.containerId).toBe("discord:g1:c1");
    expect(parent.sent.map((payload) => payload.content)).toEqual(["It deploys on Fridays."]);
  });

  it("answers a reply to the bot in the channel, without starting a thread", async () => {
    const parent = fakeChannel("text");
    const message = fakeSummon({ channel: parent, repliesBot: true });
    vi.mocked(fetchHistory).mockResolvedValue(historyOf("bot-reply"));
    const test = setup();

    await handleMessageCreate(message, test.client, test.runtime);
    await test.tasks[0]?.run();

    expect(spiesOf(message).startThread).not.toHaveBeenCalled();
    expect(test.ask).not.toHaveBeenCalled();
    expect(requestSent().summonKind).toBe("reply-to-bot");
    expect(test.tasks[0]?.containerId).toBe("discord:g1:c1");
    expect(test.send).not.toHaveBeenCalled();
  });

  it("ignores a message that summons nobody", async () => {
    const test = setup();

    await handleMessageCreate(
      fakeSummon({ channel: fakeChannel("text") }),
      test.client,
      test.runtime,
    );

    expect(test.enqueue).not.toHaveBeenCalled();
  });

  describe("and the Worker's gate", () => {
    function summonThatWouldStartThread() {
      const parent = fakeChannel("text");
      const message = fakeSummon({ channel: parent, mentionsBot: true });
      return { parent, message };
    }

    it("starts no thread, and says nothing, where the Worker would not answer", async () => {
      const test = setup();
      test.ask.mockResolvedValue({ status: "ok", allowed: false });
      const { parent, message } = summonThatWouldStartThread();

      await handleMessageCreate(message, test.client, test.runtime);

      expect(spiesOf(message).startThread).not.toHaveBeenCalled();
      expect(test.enqueue).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
      expect(parent.sent).toEqual([]);
      expect(test.send).not.toHaveBeenCalled();
    });

    it("answers in the channel, starting no thread, when the Worker cannot say", async () => {
      const test = setup();
      test.ask.mockRejectedValue(new Error("Worker HTTP 503"));
      const { parent, message } = summonThatWouldStartThread();
      vi.mocked(fetchHistory).mockResolvedValue(historyOf("m0"));

      await handleMessageCreate(message, test.client, test.runtime);
      await test.tasks[0]?.run();

      expect(spiesOf(message).startThread).not.toHaveBeenCalled();
      expect(requestSent()).toMatchObject({ channelId: CHANNEL, parentChannelId: null });
      expect(parent.sent.map((payload) => payload.content)).toEqual(["It deploys on Fridays."]);
    });

    it("asks about the channel the summon was sent in, not one it would start", async () => {
      const test = setup();
      test.ask.mockResolvedValue({ status: "error", code: "invalid_body" });
      const { message } = summonThatWouldStartThread();

      await handleMessageCreate(message, test.client, test.runtime);

      expect(test.ask).toHaveBeenCalledTimes(1);
      expect(test.ask).toHaveBeenCalledWith({ guildId: GUILD, channelId: CHANNEL });
      // An answer the Runtime cannot read is no refusal: the summon is still answered, in the channel.
      expect(spiesOf(message).startThread).not.toHaveBeenCalled();
      expect(test.tasks[0]?.containerId).toBe("discord:g1:c1");
    });
  });
});

describe("a message in a thread", () => {
  function inThread(options: {
    content?: string;
    mentionsBot?: boolean;
    worker?: ReturnType<typeof fakeWorker>;
  }) {
    const thread = fakeChannel("thread");
    const message = fakeSummon({
      id: "m2",
      channel: thread,
      content: options.content ?? "anyone tried it?",
      mentionsBot: options.mentionsBot,
    });
    const test = setup(options.worker);
    return { ...test, thread, message };
  }

  it("is answered as thread-chat when the bot follows the thread, with no summon in it", async () => {
    const worker = fakeWorker();
    worker.sessions.set(THREAD, followed);
    const test = inThread({ worker });
    vi.mocked(fetchHistory).mockResolvedValue(historyOf("m1"));

    await handleMessageCreate(test.message, test.client, test.runtime);
    await test.tasks[0]?.run();

    expect(test.send.mock.calls.map((call) => call[0])).toEqual([
      { op: "get", threadId: THREAD, guildId: GUILD },
    ]);
    expect(requestSent()).toMatchObject({
      messageId: "m2",
      containerId: "discord:g1:c1:t1",
      channelId: THREAD,
      parentChannelId: CHANNEL,
      summonKind: "thread-chat",
      history: historyOf("m1"),
    });
    expect(requestSent()).not.toHaveProperty("anchorHistory");
    expect(test.thread.sent.map((payload) => payload.content)).toEqual(["It deploys on Fridays."]);
  });

  it("is ignored when the bot does not follow the thread", async () => {
    const test = inThread({});

    await handleMessageCreate(test.message, test.client, test.runtime);

    expect(test.enqueue).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("resumes an unfollowed thread on an explicit mention", async () => {
    const worker = fakeWorker();
    worker.sessions.set(THREAD, { ...followed, active: false });
    const test = inThread({ worker, content: `<@${BOT}> pick this up again`, mentionsBot: true });
    vi.mocked(fetchHistory).mockResolvedValue([]);

    await handleMessageCreate(test.message, test.client, test.runtime);
    await test.tasks[0]?.run();

    expect(opsOf(worker.send)).toEqual(["get", "upsert"]);
    expect(worker.send.mock.calls[1]?.[0]).toMatchObject({
      op: "upsert",
      threadId: THREAD,
      guildId: GUILD,
      createdBy: USER,
    });
    expect(requestSent().summonKind).toBe("user-mention");
  });

  it("stops following a thread once a reply paused it, until someone summons in it again", async () => {
    const worker = fakeWorker();
    worker.sessions.set(THREAD, followed);
    const test = inThread({ worker });
    vi.mocked(fetchHistory).mockResolvedValue([]);
    vi.mocked(generate).mockResolvedValueOnce(completed({ threadDeactivated: true }));

    await handleMessageCreate(test.message, test.client, test.runtime);
    await test.tasks[0]?.run();
    await handleMessageCreate(
      fakeSummon({ id: "m3", channel: test.thread }),
      test.client,
      test.runtime,
    );

    expect(generate).toHaveBeenCalledTimes(1);
    // The pause is noted from the result; the Worker is not asked again.
    expect(opsOf(worker.send)).toEqual(["get"]);
  });
});

describe("question cards in a followed thread", () => {
  /** A followed thread whose latest generation stopped on a question. */
  async function asked(): Promise<Harness & { thread: FakeChannel }> {
    const worker = fakeWorker();
    worker.sessions.set(THREAD, followed);
    const thread = fakeChannel("thread");
    const test = setup(worker);
    vi.mocked(fetchHistory).mockResolvedValue(historyOf("m1"));
    vi.mocked(generate).mockResolvedValueOnce(
      completed({ reply: "I found two ways.", askPrompt: ASK }),
    );

    await handleMessageCreate(fakeSummon({ id: "m1", channel: thread }), test.client, test.runtime);
    await test.tasks[0]?.run();

    return { ...test, thread };
  }

  function postedCard(test: { runtime: Runtime }): Message {
    const card = test.runtime.askCards.get(ASK.id)?.message;
    if (card === undefined || card === null) throw new Error("expected a posted card");
    return card;
  }

  /** The card as a later history fetch shows it, followed by the member's typed reply. */
  function cardThenReply(card: Message, replyId: string): HistoryMessage[] {
    return [
      ...historyOf("m1"),
      { ...botReply(card.id, 1), text: "I found two ways.\n\nWhich approach do you want?" },
      ...historyOf(replyId).map((entry, i, all) => ({
        ...entry,
        createdAt: SENT_AT + 2 + i + all.length,
      })),
    ];
  }

  it("replaces the reply and is recorded with the Worker, for the thread's guild", async () => {
    const test = await asked();
    const card = test.thread.sent[0];

    expect(test.thread.sent).toHaveLength(1);
    expect(card?.content).toBe(
      ["I found two ways.", "", ASK.question, "", "点击选项继续，也可以直接回复。"].join("\n"),
    );
    expect(card?.flags).toBe(MessageFlags.SuppressEmbeds);
    expect(card?.allowedMentions).toEqual({ parse: [] });
    const row = card?.components?.[0];
    expect(JSON.parse(JSON.stringify(row))).toMatchObject({
      components: [
        { custom_id: `xbl:ask:${ASK.id}:quick`, style: ButtonStyle.Primary },
        { custom_id: `xbl:ask:${ASK.id}:proper`, style: ButtonStyle.Secondary },
      ],
    });
    expect(test.send.mock.calls.at(-1)?.[0]).toEqual({
      op: "add_card",
      threadId: THREAD,
      guildId: GUILD,
      cardMessageId: "posted-1",
    });
    expect(postedCard(test).id).toBe("posted-1");
  });

  it("is still posted for an explicit summon when the Worker is unreachable", async () => {
    const thread = fakeChannel("thread");
    const test = setup();
    test.send.mockResolvedValue({ status: "error", code: "thread_state_failed" });
    vi.mocked(fetchHistory).mockResolvedValue([]);
    vi.mocked(generate).mockResolvedValueOnce(completed({ askPrompt: ASK }));

    await handleMessageCreate(
      fakeSummon({ id: "m1", channel: thread, content: `<@${BOT}> fix it`, mentionsBot: true }),
      test.client,
      test.runtime,
    );
    await test.tasks[0]?.run();

    expect(thread.sent).toHaveLength(1);
    expect(postedCard(test).id).toBe("posted-1");
    // Nothing was remembered along the way, so each lookup asks again.
    expect(opsOf(test.send)).toEqual(["get", "upsert", "get", "add_card"]);
  });

  it("goes when the user replies in text: deleted, cleared by id, and kept for the reply to read", async () => {
    const test = await asked();
    const card = postedCard(test);
    vi.mocked(fetchHistory).mockResolvedValue(cardThenReply(card, "m2"));

    await handleMessageCreate(
      fakeSummon({ id: "m2", channel: test.thread, content: "the proper one" }),
      test.client,
      test.runtime,
    );
    await test.tasks.at(-1)?.run();

    expect(spiesOf(card).delete).toHaveBeenCalledTimes(1);
    expect(test.send.mock.calls.at(-1)?.[0]).toEqual({
      op: "clear_cards",
      threadId: THREAD,
      guildId: GUILD,
      clearedIds: ["posted-1"],
    });
    const history = requestSent(1).history ?? [];
    expect(history.map((entry) => entry.id)).toEqual(["m1", card.id, "m2"]);
    expect(history[1]?.text).toContain("[可选项] Quick fix / Proper rewrite");
    expect(requestSent(1).summonKind).toBe("thread-chat");
    expect(test.thread.sent.at(-1)).toMatchObject({ content: "It deploys on Fridays." });
    expect(test.runtime.askCards.get(ASK.id)).toBeUndefined();
  });

  it("stays on record when its delete fails, and a later turn deletes it then", async () => {
    const test = await asked();
    const card = postedCard(test);
    // Discord still shows the card: the delete failed, so a fetch finds it.
    spiesOf(card).delete.mockRejectedValueOnce(new Error("Missing Access"));
    test.thread.stored.push(card);
    vi.mocked(fetchHistory).mockResolvedValue(cardThenReply(card, "m2"));

    await handleMessageCreate(
      fakeSummon({ id: "m2", channel: test.thread, content: "the proper one" }),
      test.client,
      test.runtime,
    );
    await test.tasks.at(-1)?.run();

    // The reply still reads the question; the Worker is not told the card is gone, because it is not.
    expect(opsOf(test.send)).not.toContain("clear_cards");
    expect(requestSent(1).history?.map((entry) => entry.id)).toEqual(["m1", card.id, "m2"]);
    expect(test.sessions.get(THREAD)?.pendingCardIds).toEqual(["posted-1"]);

    // Next turn: the card is no longer tracked here, found through the Worker's record, and deleted now.
    vi.mocked(fetchHistory).mockResolvedValue([
      ...cardThenReply(card, "m2"),
      botReply("a3", 5),
      ...historyOf("m3"),
    ]);
    await handleMessageCreate(
      fakeSummon({ id: "m3", channel: test.thread, content: "and now?" }),
      test.client,
      test.runtime,
    );
    await test.tasks.at(-1)?.run();

    expect(spiesOf(card).delete).toHaveBeenCalledTimes(2);
    expect(test.send.mock.calls.at(-1)?.[0]).toMatchObject({
      op: "clear_cards",
      clearedIds: ["posted-1"],
    });
    expect(test.sessions.get(THREAD)?.pendingCardIds).toEqual([]);
  });

  describe("and a click on it", () => {
    function clickTheCard(card: Message) {
      const interaction = click(`xbl:ask:${ASK.id}:proper`, card);
      return interaction;
    }

    it("joins the conversation's queue before anything is deleted, then deletes the card and continues there", async () => {
      const test = await asked();
      const card = postedCard(test);
      test.fakeClient.channels.fetch = vi.fn<(id: string) => Promise<SendableChannels | null>>(
        async () => test.thread.channel,
      );
      vi.mocked(fetchHistory).mockResolvedValue(historyOf("m1"));
      const interaction = clickTheCard(card);

      await handleComponentInteraction(interaction.asInteraction, test.client, test.runtime);

      // Acknowledged at once; the card itself waits for the conversation's turn.
      expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
      expect(interaction.reply).not.toHaveBeenCalled();
      expect(spiesOf(card).delete).not.toHaveBeenCalled();
      expect(test.enqueue).toHaveBeenLastCalledWith("discord:g1:c1:t1", expect.any(Function));

      await test.tasks.at(-1)?.run();

      expect(spiesOf(card).delete).toHaveBeenCalledTimes(1);
      expect(test.send.mock.calls.at(-1)?.[0]).toEqual({
        op: "clear_cards",
        threadId: THREAD,
        guildId: GUILD,
        clearedIds: ["posted-1"],
      });
      expect(requestSent(1)).toMatchObject({
        messageId: `m1:ask:${ASK.id}`,
        messageCreatedAt: CLICKED_AT,
        summonKind: "component",
        content: "[确认选择]: Proper rewrite",
        channelId: THREAD,
        parentChannelId: CHANNEL,
      });
      const history = requestSent(1).history ?? [];
      expect(history.map((entry) => entry.id)).toEqual(["m1", card.id]);
      expect(history[1]).toMatchObject({ isBot: true, authorId: BOT });
      expect(history[1]?.text).toContain(
        "点击选项继续，也可以直接回复。\n[可选项] Quick fix / Proper rewrite",
      );
      expect(test.thread.sent.filter((payload) => payload.components === undefined)).toHaveLength(
        1,
      );
    });

    it("clears the clicked card from the record by its id, and never a card that could not be deleted", async () => {
      const test = await asked();
      const card = postedCard(test);
      // The user replied in text instead, and the first card could not be deleted: Discord
      // keeps showing it, and it stays on record. That reply asked a second question.
      const LATER_ASK = { ...ASK, id: "p-2", question: "And the tests?" };
      spiesOf(card).delete.mockRejectedValueOnce(new Error("Missing Access"));
      test.thread.stored.push(card);
      vi.mocked(fetchHistory).mockResolvedValue(cardThenReply(card, "m2"));
      vi.mocked(generate).mockResolvedValueOnce(completed({ askPrompt: LATER_ASK }));
      await handleMessageCreate(
        fakeSummon({ id: "m2", channel: test.thread, content: "the proper one" }),
        test.client,
        test.runtime,
      );
      await test.tasks.at(-1)?.run();
      const laterCard = test.runtime.askCards.get(LATER_ASK.id)?.message;
      if (laterCard === undefined || laterCard === null) throw new Error("expected a second card");
      expect(test.sessions.get(THREAD)?.pendingCardIds).toEqual([card.id, laterCard.id]);

      // The user clicks the second card. Its delete fails again on the way, and still nothing
      // may clear the first card from the record: it is on Discord, and a later turn must retry it.
      spiesOf(card).delete.mockRejectedValueOnce(new Error("Missing Access"));
      test.fakeClient.channels.fetch = vi.fn<(id: string) => Promise<SendableChannels | null>>(
        async () => test.thread.channel,
      );
      await handleComponentInteraction(
        click(`xbl:ask:${LATER_ASK.id}:${ASK.options[0]?.id}`, laterCard).asInteraction,
        test.client,
        test.runtime,
      );
      await test.tasks.at(-1)?.run();

      expect(clearedIdsOf(test.send)).toEqual([[laterCard.id]]);
      expect(spiesOf(laterCard).delete).toHaveBeenCalledTimes(1);
      expect(test.sessions.get(THREAD)?.pendingCardIds).toEqual([card.id]);

      // A later turn retries the first card, and clears it once it is gone.
      vi.mocked(fetchHistory).mockResolvedValue([
        ...cardThenReply(card, "m2"),
        botReply("a3", 5),
        ...historyOf("m3"),
      ]);
      await handleMessageCreate(
        fakeSummon({ id: "m3", channel: test.thread, content: "and now?" }),
        test.client,
        test.runtime,
      );
      await test.tasks.at(-1)?.run();

      expect(clearedIdsOf(test.send).at(-1)).toEqual([card.id]);
      expect(test.sessions.get(THREAD)?.pendingCardIds).toEqual([]);
    });

    it("keeps its card on record when the delete fails, and still continues", async () => {
      const test = await asked();
      const card = postedCard(test);
      // Discord keeps showing the card: every delete fails.
      spiesOf(card).delete.mockRejectedValue(new Error("Missing Access"));
      test.thread.stored.push(card);
      test.fakeClient.channels.fetch = vi.fn<(id: string) => Promise<SendableChannels | null>>(
        async () => test.thread.channel,
      );
      vi.mocked(fetchHistory).mockResolvedValue(historyOf("m1"));

      await handleComponentInteraction(clickTheCard(card).asInteraction, test.client, test.runtime);
      await test.tasks.at(-1)?.run();

      expect(generate).toHaveBeenCalledTimes(2);
      expect(opsOf(test.send)).not.toContain("clear_cards");
      expect(test.sessions.get(THREAD)?.pendingCardIds).toEqual(["posted-1"]);
    });

    it("does nothing when a typed reply that ran first already deleted the card", async () => {
      const test = await asked();
      const card = postedCard(test);
      // The user typed a reply, then clicked the card as well: the reply is ahead in the queue.
      vi.mocked(fetchHistory).mockResolvedValue(cardThenReply(card, "m2"));
      await handleMessageCreate(
        fakeSummon({ id: "m2", channel: test.thread, content: "the proper one" }),
        test.client,
        test.runtime,
      );
      const interaction = clickTheCard(card);

      await handleComponentInteraction(interaction.asInteraction, test.client, test.runtime);
      expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
      await test.tasks.at(-2)?.run();
      await test.tasks.at(-1)?.run();

      // The card is deleted once, by the typed reply's cleanup, and only its generation runs.
      expect(spiesOf(card).delete).toHaveBeenCalledTimes(1);
      expect(generate).toHaveBeenCalledTimes(2);
      expect(requestSent(1).summonKind).toBe("thread-chat");
      expect(opsOf(test.send).filter((op) => op === "clear_cards")).toHaveLength(1);
    });

    it("is answered once when the user also types right after clicking", async () => {
      const test = await asked();
      const card = postedCard(test);
      test.fakeClient.channels.fetch = vi.fn<(id: string) => Promise<SendableChannels | null>>(
        async () => test.thread.channel,
      );
      vi.mocked(fetchHistory)
        .mockResolvedValueOnce(historyOf("m1"))
        .mockResolvedValue([
          ...historyOf("m1"),
          botReply(card.id, 1),
          ...historyOf("m4").map((e, i, a) => ({ ...e, createdAt: SENT_AT + 3 + i + a.length })),
        ]);
      await handleComponentInteraction(clickTheCard(card).asInteraction, test.client, test.runtime);
      await handleMessageCreate(
        fakeSummon({ id: "m4", channel: test.thread, content: "and the other one?" }),
        test.client,
        test.runtime,
      );

      // The click's turn comes first: the card is deleted and the choice answered; the typed message is answered after it.
      await test.tasks.at(-2)?.run();
      await test.tasks.at(-1)?.run();

      expect(spiesOf(card).delete).toHaveBeenCalledTimes(1);
      expect(generate).toHaveBeenCalledTimes(3);
      expect(requestSent(1).summonKind).toBe("component");
      expect(requestSent(2).summonKind).toBe("thread-chat");
      expect(requestSent(2).history?.map((entry) => entry.id)).toEqual(["m1", card.id, "m4"]);
      expect(opsOf(test.send).filter((op) => op === "clear_cards")).toHaveLength(1);
    });

    it("is refused while the first one still waits for its turn", async () => {
      const test = await asked();
      const card = postedCard(test);
      await handleComponentInteraction(clickTheCard(card).asInteraction, test.client, test.runtime);
      const second = click(`xbl:ask:${ASK.id}:quick`, card);

      await handleComponentInteraction(second.asInteraction, test.client, test.runtime);

      expect(second.deferUpdate).not.toHaveBeenCalled();
      expect(second.reply).toHaveBeenCalledTimes(1);
      expect(second.reply.mock.calls[0]?.[0]).toMatchObject({
        content: "正在处理你的选择，请稍候。",
      });
      expect(test.enqueue).toHaveBeenCalledTimes(2);
    });

    it("is refused for anyone but the user who was asked", async () => {
      const test = await asked();
      const card = postedCard(test);
      const interaction = click(`xbl:ask:${ASK.id}:proper`, card, "someone-else");

      await handleComponentInteraction(interaction.asInteraction, test.client, test.runtime);

      expect(interaction.reply).toHaveBeenCalledTimes(1);
      expect(spiesOf(card).delete).not.toHaveBeenCalled();
      expect(test.enqueue).toHaveBeenCalledTimes(1);
    });
  });
});

describe("a reply redone on request", () => {
  /** A followed thread whose latest turn asked for the bot's previous reply to be redone. */
  async function redone(): Promise<Harness & { thread: FakeChannel }> {
    const worker = fakeWorker();
    worker.sessions.set(THREAD, followed);
    const thread = fakeChannel("thread");
    const test = setup(worker);
    vi.mocked(fetchHistory).mockResolvedValue(historyOf("m1"));
    vi.mocked(generate).mockResolvedValueOnce(completed({ retriedLastReply: true }));

    await handleMessageCreate(
      fakeSummon({ id: "m2", channel: thread, content: "重试" }),
      test.client,
      test.runtime,
    );
    await test.tasks[0]?.run();

    return { ...test, thread };
  }

  /** The thread's history after the redo: the question, its answer, the redo request, the redone answer. */
  function afterRedo(): HistoryMessage[] {
    return [...historyOf("m1"), botReply("a1", 1), ...historyOf("m2"), botReply("a2", 3)];
  }

  it("marks the message that asked for it in the next turn's history", async () => {
    const test = await redone();
    vi.mocked(fetchHistory).mockResolvedValue([...afterRedo(), ...historyOf("m3")]);

    await handleMessageCreate(
      fakeSummon({ id: "m3", channel: test.thread, content: "再来一次" }),
      test.client,
      test.runtime,
    );
    await test.tasks.at(-1)?.run();

    const history = requestSent(1).history ?? [];
    expect(history.find((entry) => entry.id === "m2")).toMatchObject({ retryRequest: true });
    expect(history.filter((entry) => entry.retryRequest === true).map((entry) => entry.id)).toEqual(
      ["m2"],
    );
  });

  it("marks nothing in the history of another conversation", async () => {
    const test = await redone();
    const other = fakeChannel("thread", {});
    (other.channel as unknown as { id: string }).id = "t2";
    (other.channel as unknown as { parentId: string }).parentId = CHANNEL;
    test.sessions.set("t2", { ...followed, threadId: "t2" });
    vi.mocked(fetchHistory).mockResolvedValue([...afterRedo(), ...historyOf("m3")]);

    await handleMessageCreate(
      fakeSummon({ id: "m3", channel: other, content: "再来一次" }),
      test.client,
      test.runtime,
    );
    await test.tasks.at(-1)?.run();

    expect(requestSent(1).containerId).toBe("discord:g1:c1:t2");
    expect(requestSent(1).history?.filter((entry) => entry.retryRequest === true)).toEqual([]);
  });

  it("marks nothing for a reply that was not a redo", async () => {
    const worker = fakeWorker();
    worker.sessions.set(THREAD, followed);
    const thread = fakeChannel("thread");
    const test = setup(worker);
    vi.mocked(fetchHistory).mockResolvedValue(historyOf("m1"));
    await handleMessageCreate(
      fakeSummon({ id: "m2", channel: thread, content: "why?" }),
      test.client,
      test.runtime,
    );
    await test.tasks[0]?.run();
    vi.mocked(fetchHistory).mockResolvedValue([...afterRedo(), ...historyOf("m3")]);

    await handleMessageCreate(
      fakeSummon({ id: "m3", channel: thread, content: "and?" }),
      test.client,
      test.runtime,
    );
    await test.tasks.at(-1)?.run();

    expect(requestSent(1).history?.filter((entry) => entry.retryRequest === true)).toEqual([]);
  });
});

describe("a DM", () => {
  it("answers opted-in text in the DM's own container, as a plain turn", async () => {
    const dm = fakeChannel("dm");
    vi.mocked(handleDmMessage).mockImplementation(async (message, _env, enqueue) =>
      enqueue(message),
    );
    vi.mocked(fetchHistory).mockResolvedValue(historyOf("m0"));
    const test = setup();
    const message = fakeSummon({ id: "m1", channel: dm });

    await handleMessageCreate(message, test.client, test.runtime);
    await test.tasks[0]?.run();

    expect(test.tasks[0]?.containerId).toBe("discord:@me:dm1");
    expect(requestSent()).toMatchObject({
      scopeId: "dm",
      channelId: "dm1",
      parentChannelId: null,
      summonKind: "dm-chat",
      messageCreatedAt: SENT_AT,
      history: historyOf("m0"),
    });
    expect(requestSent()).not.toHaveProperty("publicChannelIds");
    expect(dm.sent.map((payload) => payload.content)).toEqual(["It deploys on Fridays."]);
    expect(test.send).not.toHaveBeenCalled();
  });
});

describe("a button this process cannot place", () => {
  it("is refused with an ephemeral notice, and nothing runs", async () => {
    const test = setup();
    const interaction = click(
      "xbl:regen:old-reply",
      fakeMessage({ id: "old-reply", channelId: CHANNEL, content: "old reply" }),
    );

    await handleComponentInteraction(interaction.asInteraction, test.client, test.runtime);

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(interaction.reply.mock.calls[0]?.[0]).toMatchObject({
      flags: MessageFlags.Ephemeral,
      content: "该按钮已失效。",
    });
    expect(test.enqueue).not.toHaveBeenCalled();
  });
});
