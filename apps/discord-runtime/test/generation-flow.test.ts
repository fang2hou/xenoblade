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

/** The Worker client a `ThreadSessions` sends with. */
type Send = NonNullable<ThreadSessionsOptions["send"]>;

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

const ok = (session: ThreadSession | null): ThreadSessionResponse => ({ status: "ok", session });

/** What a Worker holding thread sessions in memory answers to one request. */
function respond(
  req: ThreadSessionRequest,
  sessions: Map<string, ThreadSession>,
): ThreadSessionResponse {
  const current = sessions.get(req.threadId);
  if (req.op === "get") return ok(current ?? null);
  if (req.op === "upsert" || (req.op === "set_active" && current === undefined)) {
    const created: ThreadSession = {
      threadId: req.threadId,
      guildId: req.guildId,
      parentChannelId: req.parentChannelId,
      active: req.op === "upsert" ? true : req.active,
      pendingCardIds: current?.pendingCardIds ?? [],
    };
    sessions.set(req.threadId, created);
    return ok(created);
  }
  if (current === undefined) return ok(null);
  if (req.op === "set_active") {
    const updated = { ...current, active: req.active };
    sessions.set(req.threadId, updated);
    return ok(updated);
  }
  const pendingCardIds =
    req.op === "add_card" ? [...current.pendingCardIds, req.cardMessageId] : [];
  const updated = { ...current, pendingCardIds };
  sessions.set(req.threadId, updated);
  return ok(updated);
}

/** A Worker holding thread sessions in memory, and a record of what it was asked. */
function fakeWorker(): {
  sessions: Map<string, ThreadSession>;
  send: Mock<Send>;
} {
  const sessions = new Map<string, ThreadSession>();
  const send = vi.fn<Send>(async (req) => respond(req, sessions));
  return { sessions, send };
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

/** An object carrying a discord.js class's prototype, so the Runtime's `instanceof` checks hold. */
function withPrototype(prototype: object, fields: object): SendableChannels {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double carrying a discord.js class's prototype
  return Object.assign(Object.create(prototype) as object, fields) as SendableChannels;
}

interface FakeChannel {
  channel: SendableChannels;
  sent: MessageCreateOptions[];
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
    createdTimestamp: 1000,
    author: { id: BOT, bot: true, displayName: "Xenoblade", username: "xenoblade" },
    member: null,
    // What a message payload reads to resolve its request body.
    client: { options: {} },
    ...spies,
  });
  messageSpies.set(message, spies);
  return message;
}

/** A channel the flow can post to and read back; whatever it posts comes back as a bot message. */
function fakeChannel(kind: "text" | "thread" | "dm"): FakeChannel {
  const id = kind === "thread" ? THREAD : kind === "dm" ? "dm1" : CHANNEL;
  const sent: MessageCreateOptions[] = [];
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
      fetch: vi.fn<(messageId: string) => Promise<Message>>(async () => {
        throw new Error("Unknown Message");
      }),
    },
    guild: { id: GUILD, channels: { cache: new Map() }, roles: { everyone: null } },
  };
  const channel =
    kind === "thread"
      ? withPrototype(ThreadChannel.prototype, {
          ...common,
          type: ChannelType.PublicThread,
          parentId: CHANNEL,
        })
      : kind === "dm"
        ? withPrototype(DMChannel.prototype, { ...common, type: ChannelType.DM, guild: null })
        : withPrototype(TextChannel.prototype, { ...common, type: ChannelType.GuildText });
  return { channel, sent };
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
    createdAt: 1000 + i,
  }));
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
    memoryConfirms: new MemoryConfirmRegistry(),
    soulConfirms: new SoulConfirmRegistry(),
    threadSessions: new ThreadSessions({
      workerUrl: env.workerUrl,
      token: env.internalApiToken,
      send: worker.send,
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

/** A button click on a card, with its acks. */
function click(customId: string, card: Message, userId = USER) {
  const interaction = {
    customId,
    user: { id: userId },
    message: card,
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
    // The anchors are read before the thread is started; the thread's history after.
    expect(vi.mocked(fetchHistory).mock.calls.map((call) => [call[0].id, call[1] ?? 50])).toEqual([
      [CHANNEL, 20],
      [THREAD, 50],
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

  it("answers a reply to the bot in the channel, without starting a thread", async () => {
    const parent = fakeChannel("text");
    const message = fakeSummon({ channel: parent, repliesBot: true });
    vi.mocked(fetchHistory).mockResolvedValue(historyOf("bot-reply"));
    const test = setup();

    await handleMessageCreate(message, test.client, test.runtime);
    await test.tasks[0]?.run();

    expect(spiesOf(message).startThread).not.toHaveBeenCalled();
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

    expect(opsOf(test.send)).toEqual(["get"]);
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

  it("replace the reply and are recorded with the Worker", async () => {
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
      cardMessageId: "posted-1",
    });
    expect(postedCard(test).id).toBe("posted-1");
  });

  it("are still posted for an explicit summon when the Worker is unreachable", async () => {
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

  it("go when the user replies in text, and the reply still reads the question", async () => {
    const test = await asked();
    const card = postedCard(test);
    const cardInThread: HistoryMessage = {
      ...historyOf("m1")[0]!,
      id: card.id,
      text: "I found two ways.\n\nWhich approach do you want?",
      authorId: BOT,
      authorName: "Xenoblade",
      isBot: true,
      createdAt: 1500,
    };
    vi.mocked(fetchHistory).mockResolvedValue([...historyOf("m1"), cardInThread]);

    await handleMessageCreate(
      fakeSummon({ id: "m2", channel: test.thread, content: "the proper one" }),
      test.client,
      test.runtime,
    );
    await test.tasks.at(-1)?.run();

    expect(spiesOf(card).delete).toHaveBeenCalledTimes(1);
    expect(test.send.mock.calls.at(-1)?.[0]).toEqual({ op: "clear_cards", threadId: THREAD });
    const history = requestSent(1).history ?? [];
    expect(history.map((entry) => entry.id)).toEqual(["m1", card.id]);
    expect(history[1]?.text).toContain("[可选项] Quick fix / Proper rewrite");
    expect(requestSent(1).summonKind).toBe("thread-chat");
    expect(test.thread.sent.at(-1)).toMatchObject({ content: "It deploys on Fridays." });
    expect(test.runtime.askCards.get(ASK.id)).toBeUndefined();
  });

  it("continue from a click: the card is deleted, its record cleared, and the choice becomes the next turn", async () => {
    const test = await asked();
    const card = postedCard(test);
    test.fakeClient.channels.fetch = vi.fn<(id: string) => Promise<SendableChannels | null>>(
      async () => test.thread.channel,
    );
    vi.mocked(fetchHistory).mockResolvedValue(historyOf("m1"));
    const interaction = click(`xbl:ask:${ASK.id}:proper`, card);

    await handleComponentInteraction(interaction.asInteraction, test.client, test.runtime);
    await test.tasks.at(-1)?.run();

    expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(spiesOf(card).delete).toHaveBeenCalledTimes(1);
    expect(test.send.mock.calls.at(-1)?.[0]).toEqual({ op: "clear_cards", threadId: THREAD });
    expect(test.enqueue).toHaveBeenLastCalledWith("discord:g1:c1:t1", expect.any(Function));
    expect(requestSent(1)).toMatchObject({
      messageId: `m1:ask:${ASK.id}`,
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
    expect(test.thread.sent.filter((payload) => payload.components === undefined)).toHaveLength(1);
  });

  it("are clickable for the asked user alone: another member's click does nothing", async () => {
    const test = await asked();
    const card = postedCard(test);
    const interaction = click(`xbl:ask:${ASK.id}:proper`, card, "someone-else");

    await handleComponentInteraction(interaction.asInteraction, test.client, test.runtime);

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(spiesOf(card).delete).not.toHaveBeenCalled();
    expect(test.enqueue).toHaveBeenCalledTimes(1);
  });

  it("are not clicked twice: a second click is refused and runs nothing more", async () => {
    const test = await asked();
    const card = postedCard(test);
    await handleComponentInteraction(
      click(`xbl:ask:${ASK.id}:proper`, card).asInteraction,
      test.client,
      test.runtime,
    );
    const continuations = test.enqueue.mock.calls.length;
    const second = click(`xbl:ask:${ASK.id}:quick`, card);

    await handleComponentInteraction(second.asInteraction, test.client, test.runtime);

    expect(second.deferUpdate).not.toHaveBeenCalled();
    expect(second.reply).toHaveBeenCalledTimes(1);
    expect(test.enqueue).toHaveBeenCalledTimes(continuations);
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
