import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActionRow,
  ButtonStyle,
  DiscordAPIError,
  MessageFlags,
  MessagePayload,
  type ButtonComponent,
  type Message,
  type MessageComponentInteraction,
  type MessageCreateOptions,
  type MessageEditOptions,
} from "discord.js";
import type { AskUserPrompt, GenerationRequest, UiLanguage } from "@xenoblade/contracts";

import {
  ASK_CARD_WINDOW_MS,
  AskPromptRegistry,
  askCustomId,
  buildAskCard,
  buildAskRow,
  dismissPendingCards,
  handleAskInteraction,
  isAskCustomId,
  parseAskCustomId,
  postAskCard,
  resolveAskAction,
  settleChoice,
  type AskClaim,
  type AskEntry,
  type ReadableChannel,
} from "../src/ask-confirm";
import { parseMemoryCustomId } from "../src/memory-confirm";
import { parseSoulCustomId } from "../src/soul-confirm";
import { messages } from "../src/i18n";
import { resetLanguageCache } from "../src/language";
import { MAX_MESSAGE_LENGTH } from "../src/output";
import type { EnvConfig } from "../src/env";
import type { Mock } from "vitest";

/** discord.js types the row's constructor private, though it builds rows from API data with it. */
const Row = ActionRow as unknown as new (data: object) => ActionRow<ButtonComponent>;

const env: EnvConfig = {
  discordBotToken: "test-token",
  discordApplicationId: "app-id",
  workerUrl: "https://worker",
  internalApiToken: "token",
  mentionRoleIds: [],
  healthPort: 8397,
};

const OWNER = "owner-1";
/** Message id of the question card. */
const CARD = "card-1";

const PROMPT: AskUserPrompt = {
  id: "p-1",
  question: "Which approach do you want?",
  options: [
    { id: "quick", label: "Quick fix" },
    { id: "proper", label: "Proper rewrite" },
    { id: "later", label: "Ask me later" },
  ],
  contextNote: "The proper rewrite takes about a day.",
};

const REQUEST: GenerationRequest = {
  messageId: "m1",
  containerId: "discord:g1:c1:t1",
  scopeId: "g1",
  channelId: "t1",
  parentChannelId: "c1",
  userId: OWNER,
  userDisplayName: "Owner",
  summonKind: "user-mention",
  content: "fix the bug",
  history: [],
  reference: null,
  attachments: [],
};

const CARD_PARAMS = {
  prompt: PROMPT,
  reply: "I found two ways.",
  request: REQUEST,
  language: "zh" as UiLanguage,
};

/** Options the channel's `send` received for the card. */
type SendCall = MessageCreateOptions;

type WireButton = { custom_id?: string; label?: string; style: number };

/** The fields of a message request body this suite reads, as discord.js puts them on the wire. */
interface WireBody {
  content?: string | null;
  flags?: number;
  components?: Array<{ components: WireButton[] }>;
  allowed_mentions?: { parse?: string[] };
}

/** The delete and edit calls a fake message received. */
interface MessageSpies {
  delete: Mock<() => Promise<Message>>;
  edit: Mock<(options: unknown) => Promise<Message>>;
}

const messageSpies = new WeakMap<Message, MessageSpies>();

/** A bot message as the handlers use it: it can be deleted and edited, and it knows when it was said. */
function fakeMessage(
  options: { id?: string; content?: string; components?: unknown[] } = {},
): Message {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double standing in for a discord.js Message
  const message = {} as Message;
  const spies: MessageSpies = {
    delete: vi.fn<() => Promise<Message>>(async () => message),
    edit: vi.fn<(payload: unknown) => Promise<Message>>(async () => message),
  };
  Object.assign(message, {
    id: options.id ?? CARD,
    channelId: "t1",
    content: options.content ?? "Which approach do you want?",
    components: options.components ?? [],
    createdTimestamp: 1000,
    author: { id: "bot", displayName: "Xenoblade", username: "xenoblade" },
    member: null,
    // What a message payload reads to resolve its request body.
    client: { options: {} },
    ...spies,
  });
  messageSpies.set(message, spies);
  return message;
}

/** The delete and edit spies of a fake message. */
function spiesOf(message: Message): MessageSpies {
  const spies = messageSpies.get(message);
  if (spies === undefined) throw new Error("not a fake message");
  return spies;
}

/** A posted card as Discord hands it back: its buttons are real components. */
function postedCard(id: string, labels: readonly string[], promptId = "p-9"): Message {
  const row = new Row({
    id: 1,
    type: 1,
    components: [
      { id: 1, type: 2, style: 2, label: "Unrelated", custom_id: "xbl:soul:yes:x" },
      ...labels.map((label, i) => ({
        id: i + 2,
        type: 2,
        style: i === 0 ? 1 : 2,
        label,
        custom_id: askCustomId(promptId, `o${i}`),
      })),
    ],
  });
  return fakeMessage({ id, content: "Go on?", components: [row] });
}

/** A channel that reads back the cards in `stored`, and answers nothing for any other message. */
function fakeChannel(
  options: { send?: () => Promise<Message>; stored?: Message[]; failSend?: boolean } = {},
): {
  channel: ReadableChannel;
  sent: SendCall[];
  send: Mock<(payload: SendCall) => Promise<Message>>;
  fetch: Mock<(id: string) => Promise<Message>>;
} {
  const sent: SendCall[] = [];
  const send = vi.fn<(payload: SendCall) => Promise<Message>>(async (payload) => {
    if (options.failSend) throw new Error("Missing Access");
    sent.push(payload);
    return options.send ? await options.send() : fakeMessage();
  });
  const fetch = vi.fn<(id: string) => Promise<Message>>(async (id) => {
    const found = (options.stored ?? []).find((message) => message.id === id);
    if (found === undefined) throw unknownMessage();
    return found;
  });
  const channel = { id: "t1", send, messages: { fetch } };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double standing in for a discord.js channel
  return { channel: channel as unknown as ReadableChannel, sent, send, fetch };
}

function unknownMessage(): DiscordAPIError {
  return new DiscordAPIError(
    { code: 10008, message: "Unknown Message" },
    10008,
    404,
    "DELETE",
    "/channels/t1/messages/card-1",
    { files: [], body: {} },
  );
}

/** When the click happened, as Discord timestamps interactions. */
const CLICKED_AT = 4242;

/** A button click on a card, with its acks and refusals. */
function click(customId: string, options: { userId?: string; card?: Message } = {}) {
  const deferUpdate = vi.fn<() => Promise<void>>(async () => undefined);
  const reply = vi.fn<(payload: unknown) => Promise<void>>(async () => undefined);
  const interaction = {
    customId,
    user: { id: options.userId ?? OWNER },
    message: options.card ?? fakeMessage(),
    createdTimestamp: CLICKED_AT,
    deferUpdate,
    reply,
  };
  return {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double standing in for a discord.js interaction
    interaction: interaction as unknown as MessageComponentInteraction,
    deferUpdate,
    reply,
  };
}

/** The handler's view of the Runtime: the registry, and where an acknowledged click is handed to the conversation's queue. */
function runtime(registry: AskPromptRegistry) {
  const confirm = vi.fn<(claim: AskClaim) => void>();
  return { ask: { env, registry, confirm }, confirm };
}

/** The claim a click on `optionId` of the posted card would hand over. */
function claimOf(registry: AskPromptRegistry, optionId: string): AskClaim {
  const entry = registry.get("p-1");
  if (entry === undefined || entry.message === null) {
    throw new Error("expected a posted, tracked card");
  }
  const option = PROMPT.options.find((candidate) => candidate.id === optionId);
  if (option === undefined) throw new Error(`no such option: ${optionId}`);
  return { entry, option, answeredAt: CLICKED_AT };
}

/** Post a card for `PROMPT` and hand back what was posted. */
async function post(options: Parameters<typeof fakeChannel>[0] = {}) {
  const registry = new AskPromptRegistry();
  const discord = fakeChannel(options);
  const card = await postAskCard(discord.channel, CARD_PARAMS, registry);
  return { registry, ...discord, card };
}

/** Stand in for the Worker: settings resolve in `language`. */
function stubLanguage(language: UiLanguage): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      if (String(input).endsWith("/internal/v1/settings")) {
        return Response.json({
          status: "ok",
          settings: {
            chatOptin: false,
            learnOptin: false,
            chatOptinAt: null,
            learnOptinAt: null,
            language,
          },
        });
      }
      throw new Error(`Unexpected Worker call: ${String(input)}`);
    }),
  );
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetLanguageCache();
});

describe("question-card customIds", () => {
  it("round-trips a prompt id and an option id", () => {
    expect(askCustomId("p1", "a")).toBe("xbl:ask:p1:a");
    expect(parseAskCustomId("xbl:ask:p1:a")).toEqual({ promptId: "p1", optionId: "a" });
  });

  it("claims its whole family, so no question button falls through to another handler", () => {
    expect(isAskCustomId("xbl:ask:p1:a")).toBe(true);
    expect(isAskCustomId("xbl:ask:garbage")).toBe(true);
    expect(isAskCustomId("xbl:soul:yes:p1")).toBe(false);
    expect(isAskCustomId("")).toBe(false);
  });

  it("rejects malformed ids, which then fail closed as expired", () => {
    for (const customId of [
      "xbl:ask:p1",
      "xbl:ask:p1:",
      "xbl:ask::a",
      "xbl:ask:p1:a:extra",
      "xbl:soul:yes:p1",
      "xbl:gmem:yes:c1",
      "other:ask:p1:a",
      "",
    ]) {
      expect(parseAskCustomId(customId)).toBeNull();
    }
  });

  it("never collides with the memory and soul families", () => {
    expect(parseAskCustomId("xbl:gmem:yes:c1")).toBeNull();
    expect(parseAskCustomId("xbl:soul:yes:p1")).toBeNull();
    expect(parseMemoryCustomId("xbl:ask:c1:yes")).toBeNull();
    expect(parseSoulCustomId("xbl:ask:p1:yes")).toBeNull();
  });
});

describe("buildAskCard", () => {
  const texts = messages("zh").askConfirm;

  it("shows the lead-in, the question, its note, and how to answer", () => {
    expect(buildAskCard(texts, "  I found two ways.  ", PROMPT)).toBe(
      [
        "I found two ways.",
        "",
        "Which approach do you want?",
        "",
        "补充：The proper rewrite takes about a day.",
        "",
        "点击选项继续，也可以直接回复。",
      ].join("\n"),
    );
  });

  it("starts with the question when the model said nothing before asking", () => {
    const question = { ...PROMPT, contextNote: undefined };

    expect(buildAskCard(texts, "", question)).toBe(
      ["Which approach do you want?", "", "点击选项继续，也可以直接回复。"].join("\n"),
    );
    expect(buildAskCard(texts, " \n ", question)).toBe(buildAskCard(texts, "", question));
  });

  it("leaves out a note that is blank", () => {
    expect(buildAskCard(texts, "", { ...PROMPT, contextNote: "  " })).not.toContain("补充");
  });

  it("gives up the lead-in first when the card would not fit one message", () => {
    const card = buildAskCard(texts, "x".repeat(5000), PROMPT);

    expect(card).toHaveLength(MAX_MESSAGE_LENGTH);
    expect(
      card.endsWith(
        "Which approach do you want?\n\n补充：The proper rewrite takes about a day.\n\n点击选项继续，也可以直接回复。",
      ),
    ).toBe(true);
    expect(card.startsWith("x")).toBe(true);
  });

  it("fits a message even with the longest question and note", () => {
    const longest: AskUserPrompt = {
      ...PROMPT,
      question: "q".repeat(500),
      contextNote: "n".repeat(500),
    };

    const card = buildAskCard(texts, "lead-in", longest);

    expect(card.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(card).toContain("lead-in");
  });

  it("defensively clamps even an unclamped oversized question to 2000 chars", () => {
    const oversized: AskUserPrompt = {
      ...PROMPT,
      question: "q".repeat(2500),
      contextNote: "n".repeat(500),
    };

    const card = buildAskCard(texts, "lead-in", oversized);
    expect(card.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
  });
});

describe("buildAskRow", () => {
  function buttons(prompt: AskUserPrompt): WireButton[] {
    return buildAskRow(prompt).toJSON().components as WireButton[];
  }

  it("renders one button per option, the recommended one primary", () => {
    expect(buttons(PROMPT)).toEqual([
      { type: 2, custom_id: "xbl:ask:p-1:quick", label: "Quick fix", style: ButtonStyle.Primary },
      {
        type: 2,
        custom_id: "xbl:ask:p-1:proper",
        label: "Proper rewrite",
        style: ButtonStyle.Secondary,
      },
      {
        type: 2,
        custom_id: "xbl:ask:p-1:later",
        label: "Ask me later",
        style: ButtonStyle.Secondary,
      },
    ]);
  });
});

describe("postAskCard", () => {
  it("posts one message with embeds suppressed and no mention parsing, one row of buttons", async () => {
    const { sent } = await post();

    expect(sent).toHaveLength(1);
    const body = MessagePayload.create(fakeMessage(), sent[0] ?? {}).resolveBody()
      .body as unknown as WireBody | null;
    expect(body?.flags).toBe(MessageFlags.SuppressEmbeds);
    expect(body?.allowed_mentions).toEqual({ parse: [] });
    expect(body?.components?.[0]?.components.map((button) => button.custom_id)).toEqual([
      "xbl:ask:p-1:quick",
      "xbl:ask:p-1:proper",
      "xbl:ask:p-1:later",
    ]);
    expect(body?.content).toContain("I found two ways.");
  });

  it("tracks the question for its owner and arms the expiry", async () => {
    const { card, registry } = await post();

    expect(card?.id).toBe(CARD);
    const entry = registry.get("p-1");
    expect(entry).toMatchObject({
      userId: OWNER,
      request: REQUEST,
      language: "zh",
      message: { id: CARD },
    });
    expect(entry?.expiresAt).toBeLessThanOrEqual(Date.now() + ASK_CARD_WINDOW_MS);
  });

  it("tracks nothing when the card cannot be posted", async () => {
    const { registry } = await post({ failSend: true });

    expect(registry.get("p-1")).toBeUndefined();
  });
});

describe("resolveAskAction", () => {
  function entry(overrides: Partial<AskEntry> = {}): AskEntry {
    return {
      prompt: PROMPT,
      userId: OWNER,
      request: REQUEST,
      language: "zh",
      message: fakeMessage(),
      busy: false,
      expiresAt: 2000,
      timer: undefined,
      ...overrides,
    };
  }

  it("maps the owner's click on an option to that option", () => {
    expect(resolveAskAction(entry(), "xbl:ask:p-1:proper", CARD, OWNER, 1000)).toEqual({
      action: "choose",
      option: { id: "proper", label: "Proper rewrite" },
    });
  });

  it("expires a card this process cannot resolve", () => {
    expect(resolveAskAction(undefined, "xbl:ask:p-1:proper", CARD, OWNER, 1000)).toEqual(
      rejected("expired"),
    );
    // The card is not yet posted, as when a click races the send.
    expect(
      resolveAskAction(entry({ message: null }), "xbl:ask:p-1:proper", CARD, OWNER, 1000),
    ).toEqual(rejected("expired"));
    // A button that fires on a message other than its own card.
    expect(resolveAskAction(entry(), "xbl:ask:p-1:proper", "other-message", OWNER, 1000)).toEqual(
      rejected("expired"),
    );
    // An option the question does not offer.
    expect(resolveAskAction(entry(), "xbl:ask:p-1:other", CARD, OWNER, 1000)).toEqual(
      rejected("expired"),
    );
    // A family customId that cannot be parsed.
    expect(resolveAskAction(entry(), "xbl:ask:p-1", CARD, OWNER, 1000)).toEqual(
      rejected("expired"),
    );
  });

  it("expires a card at its deadline, whether or not the timer has fired", () => {
    expect(resolveAskAction(entry(), "xbl:ask:p-1:proper", CARD, OWNER, 1999)).toMatchObject({
      action: "choose",
    });
    expect(resolveAskAction(entry(), "xbl:ask:p-1:proper", CARD, OWNER, 2000)).toEqual(
      rejected("expired"),
    );
  });

  it("refuses users other than the one who was asked", () => {
    expect(resolveAskAction(entry(), "xbl:ask:p-1:proper", CARD, "someone-else", 1000)).toEqual(
      rejected("not-owner"),
    );
  });

  it("refuses a click while one is being carried out", () => {
    expect(
      resolveAskAction(entry({ busy: true }), "xbl:ask:p-1:proper", CARD, OWNER, 1000),
    ).toEqual(rejected("busy"));
  });

  it("ignores customIds of another button family", () => {
    expect(resolveAskAction(entry(), "xbl:soul:yes:p-1", CARD, OWNER, 1000)).toBeNull();
    expect(resolveAskAction(undefined, "xbl:gmem:yes:c1", CARD, OWNER, 1000)).toBeNull();
  });
});

function rejected(reason: "expired" | "not-owner" | "busy") {
  return { action: "rejected", reason };
}

describe("AskPromptRegistry", () => {
  const entry = (id: string): AskEntry => ({
    prompt: { ...PROMPT, id },
    userId: OWNER,
    request: REQUEST,
    language: "zh",
    message: null,
    busy: false,
    expiresAt: 2000,
    timer: undefined,
  });

  it("registers, looks up, and removes questions by prompt id", () => {
    const registry = new AskPromptRegistry();
    registry.register("p1", entry("p1"));
    expect(registry.get("p1")?.prompt.id).toBe("p1");
    registry.remove("p1");
    expect(registry.get("p1")).toBeUndefined();
  });

  it("lists the cards posted in a channel, and only those that are posted", () => {
    const registry = new AskPromptRegistry();
    registry.register("p1", { ...entry("p1"), message: fakeMessage({ id: "c1" }) });
    registry.register("p2", entry("p2"));
    registry.register("p3", {
      ...entry("p3"),
      message: { ...fakeMessage({ id: "c9" }), channelId: "other" } as unknown as Message,
    });

    expect(registry.inChannel("t1").map((tracked) => tracked.prompt.id)).toEqual(["p1"]);
  });

  it("evicts the oldest question beyond the cap", () => {
    const registry = new AskPromptRegistry();
    for (let i = 0; i < 129; i++) registry.register(`p${i}`, entry(`p${i}`));

    expect(registry.get("p0")).toBeUndefined();
    expect(registry.get("p1")?.prompt.id).toBe("p1");
    expect(registry.get("p128")?.prompt.id).toBe("p128");
  });
});

describe("handleAskInteraction", () => {
  it("claims the click and acknowledges it, leaving the card and the choice to the conversation's queue", async () => {
    const { registry } = await post();
    const entry = registry.get("p-1");
    if (entry === undefined || entry.message === null) {
      throw new Error("expected the posted card to be tracked");
    }
    const run = runtime(registry);
    const { interaction, deferUpdate, reply } = click("xbl:ask:p-1:proper", {
      card: entry.message,
    });

    await handleAskInteraction(interaction, run.ask);

    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
    // Nothing is deleted or settled outside the queue, where a typed reply's cleanup runs too.
    expect(spiesOf(entry.message).delete).not.toHaveBeenCalled();
    expect(registry.get("p-1")).toBe(entry);
    expect(entry.busy).toBe(true);
    expect(run.confirm).toHaveBeenCalledTimes(1);
    expect(run.confirm.mock.calls[0]?.[0]).toMatchObject({
      entry,
      option: { id: "proper", label: "Proper rewrite" },
      answeredAt: CLICKED_AT,
    });
  });

  it("hands a click over once: a second one on the same card is refused while the first waits", async () => {
    const { registry } = await post();
    const card = registry.get("p-1")?.message ?? null;
    const run = runtime(registry);
    await handleAskInteraction(
      click("xbl:ask:p-1:proper", { card: card ?? undefined }).interaction,
      run.ask,
    );
    const second = click("xbl:ask:p-1:quick", { card: card ?? undefined });

    await handleAskInteraction(second.interaction, run.ask);

    expect(run.confirm).toHaveBeenCalledTimes(1);
    expect(second.deferUpdate).not.toHaveBeenCalled();
    expect(second.reply).toHaveBeenCalledTimes(1);
    expect(await refusedWith(second.reply)).toBe(messages("zh").askConfirm.busy);
  });

  it("refuses a click that lands while the first is still being carried out", async () => {
    const { registry } = await post();
    const entry = registry.get("p-1");
    if (entry === undefined || entry.message === null) {
      throw new Error("expected the posted card to be tracked");
    }
    entry.busy = true;
    const run = runtime(registry);
    const { interaction, deferUpdate, reply } = click("xbl:ask:p-1:proper");

    await handleAskInteraction(interaction, run.ask);

    expect(deferUpdate).not.toHaveBeenCalled();
    expect(await refusedWith(reply)).toBe(messages("zh").askConfirm.busy);
    expect(spiesOf(entry.message).delete).not.toHaveBeenCalled();
    expect(run.confirm).not.toHaveBeenCalled();
  });

  it("refuses anyone but the user who was asked, leaving the card for them", async () => {
    const { registry } = await post();
    const entry = registry.get("p-1");
    if (entry === undefined || entry.message === null) {
      throw new Error("expected the posted card to be tracked");
    }
    const run = runtime(registry);
    const { interaction, deferUpdate, reply } = click("xbl:ask:p-1:proper", {
      userId: "someone-else",
    });

    await handleAskInteraction(interaction, run.ask);

    expect(await refusedWith(reply)).toBe(messages("zh").askConfirm.notOwner);
    expect(deferUpdate).not.toHaveBeenCalled();
    expect(spiesOf(entry.message).delete).not.toHaveBeenCalled();
    expect(registry.get("p-1")).toBe(entry);
    expect(entry.busy).toBe(false);
    expect(run.confirm).not.toHaveBeenCalled();
  });

  it("fails closed on a card this process no longer tracks, as after a restart", async () => {
    const run = runtime(new AskPromptRegistry());
    const card = postedCard(CARD, ["A", "B"]);
    const { interaction, deferUpdate, reply } = click("xbl:ask:p-1:proper", { card });

    await handleAskInteraction(interaction, run.ask);

    expect(await refusedWith(reply)).toBe(messages("zh").askConfirm.expiredNotice);
    expect(deferUpdate).not.toHaveBeenCalled();
    expect(spiesOf(card).delete).not.toHaveBeenCalled();
    expect(run.confirm).not.toHaveBeenCalled();
  });

  it("fails closed on a button that fires on a message other than its card", async () => {
    const { registry } = await post();
    const run = runtime(registry);
    const { interaction, reply } = click("xbl:ask:p-1:proper", {
      card: fakeMessage({ id: "forged" }),
    });

    await handleAskInteraction(interaction, run.ask);

    expect(await refusedWith(reply)).toBe(messages("zh").askConfirm.expiredNotice);
    expect(run.confirm).not.toHaveBeenCalled();
  });

  it("ignores the customIds of other button families", async () => {
    const run = runtime(new AskPromptRegistry());
    const { interaction, deferUpdate, reply } = click("xbl:soul:yes:p-1");

    await handleAskInteraction(interaction, run.ask);

    expect(deferUpdate).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(run.confirm).not.toHaveBeenCalled();
  });

  it("refuses in the clicker's own language", async () => {
    stubLanguage("en");
    const run = runtime(new AskPromptRegistry());
    const refusal = click("xbl:ask:p-1:proper");

    await handleAskInteraction(refusal.interaction, run.ask);

    expect(await refusedWith(refusal.reply)).toBe(messages("en").askConfirm.expiredNotice);
  });
});

describe("settleChoice", () => {
  it("deletes the card, settles the question, and turns the choice into the continuation's request", async () => {
    const { registry } = await post();
    const claim = claimOf(registry, "proper");
    const card = claim.entry.message;
    if (card === null) throw new Error("expected a posted card");

    const settled = await settleChoice(registry, claim);

    expect(spiesOf(card).delete).toHaveBeenCalledTimes(1);
    expect(registry.get("p-1")).toBeUndefined();
    expect(settled).toEqual({
      request: {
        ...REQUEST,
        messageId: "m1:ask:p-1",
        messageCreatedAt: CLICKED_AT,
        summonKind: "component",
        content: "[确认选择]: Proper rewrite",
        history: [],
      },
      card: {
        id: CARD,
        authorId: "bot",
        authorName: "Xenoblade",
        isBot: true,
        createdAt: 1000,
        text: "Which approach do you want?\n[可选项] Quick fix / Proper rewrite / Ask me later",
      },
      cardDeleted: true,
    });
  });

  it("puts the choice in words in the card's language", async () => {
    const registry = new AskPromptRegistry();
    await postAskCard(
      fakeChannel().channel,
      { prompt: PROMPT, reply: "", request: REQUEST, language: "en" },
      registry,
    );

    const settled = await settleChoice(registry, claimOf(registry, "quick"));

    expect(settled?.request.content).toBe("[Choice]: Quick fix");
  });

  it("answers null, and touches nothing, when a typed reply that ran first already settled the card", async () => {
    const { registry } = await post();
    const claim = claimOf(registry, "proper");
    const card = claim.entry.message;
    if (card === null) throw new Error("expected a posted card");
    // What a typed reply's cleanup leaves behind: the question settled, its card deleted.
    registry.remove("p-1");

    expect(await settleChoice(registry, claim)).toBeNull();

    expect(spiesOf(card).delete).not.toHaveBeenCalled();
    expect(loggedEvents()).not.toContain("ask_card_answered");
  });

  it("counts a card that is already gone as deleted", async () => {
    const { registry } = await post();
    const claim = claimOf(registry, "quick");
    const card = claim.entry.message;
    if (card === null) throw new Error("expected a posted card");
    spiesOf(card).delete.mockRejectedValue(unknownMessage());

    const settled = await settleChoice(registry, claim);

    expect(settled?.cardDeleted).toBe(true);
    expect(loggedEvents()).not.toContain("ask_card_delete_error");
  });

  it("carries the choice out, and keeps the card on record, when the card cannot be deleted", async () => {
    const { registry } = await post();
    const claim = claimOf(registry, "quick");
    const card = claim.entry.message;
    if (card === null) throw new Error("expected a posted card");
    spiesOf(card).delete.mockRejectedValue(new Error("Missing Access"));

    const settled = await settleChoice(registry, claim);

    expect(settled).toMatchObject({
      cardDeleted: false,
      request: { content: "[确认选择]: Quick fix" },
    });
    expect(registry.get("p-1")).toBeUndefined();
    expect(loggedEvents()).toContain("ask_card_delete_error");
  });
});

/** Every structured event logged since the console spy was armed. */
function loggedEvents(): string[] {
  return vi
    .mocked(console.log)
    .mock.calls.map((line) => (JSON.parse(String(line[0])) as { event: string }).event);
}

/** The ephemeral text a refused click replied with. */
async function refusedWith(reply: Mock<(payload: unknown) => Promise<void>>): Promise<string> {
  expect(reply).toHaveBeenCalledTimes(1);
  const payload = reply.mock.calls[0]?.[0] as { content: string; flags: number };
  expect(payload.flags).toBe(MessageFlags.Ephemeral);
  return payload.content;
}

describe("question card expiry", () => {
  it("forgets an unanswered card at the window's end and drops its buttons, keeping the question", async () => {
    vi.useFakeTimers();
    const { registry } = await post();
    const card = registry.get("p-1")?.message;
    if (card === undefined || card === null) throw new Error("expected a posted card");

    await vi.advanceTimersByTimeAsync(ASK_CARD_WINDOW_MS - 1);
    expect(registry.get("p-1")).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(registry.get("p-1")).toBeUndefined();
    expect(spiesOf(card).delete).not.toHaveBeenCalled();
    expect(spiesOf(card).edit).toHaveBeenCalledTimes(1);
  });

  it("renders the card unclickable without letting a mention parse or a link preview show", async () => {
    vi.useFakeTimers();
    const { registry } = await post();
    const card = registry.get("p-1")?.message;
    if (card === undefined || card === null) throw new Error("expected a posted card");

    await vi.advanceTimersByTimeAsync(ASK_CARD_WINDOW_MS);

    const edit = spiesOf(card).edit.mock.calls[0]?.[0] as MessageEditOptions;
    const body = MessagePayload.create(card, edit).resolveBody().body as unknown as WireBody | null;
    expect(body?.components).toEqual([]);
    expect(body?.flags).toBe(MessageFlags.SuppressEmbeds);
    expect(body?.allowed_mentions).toEqual({ parse: [] });
  });

  it("keeps a card tracked while its click is being carried out", async () => {
    vi.useFakeTimers();
    const { registry } = await post();
    const entry = registry.get("p-1");
    if (entry === undefined || entry.message === null) {
      throw new Error("expected a posted card");
    }
    entry.busy = true;

    await vi.advanceTimersByTimeAsync(ASK_CARD_WINDOW_MS);

    expect(spiesOf(entry.message).edit).not.toHaveBeenCalled();
  });
});

describe("dismissPendingCards", () => {
  /** The card as the bot's turn: its text with its options spelled out. */
  const CARD_TURN = {
    id: CARD,
    text: "Which approach do you want?\n[可选项] Quick fix / Proper rewrite / Ask me later",
    authorId: "bot",
    authorName: "Xenoblade",
    isBot: true,
    createdAt: 1000,
  };

  it("deletes the cards the process tracks and hands them back as the bot's turns", async () => {
    const { registry } = await post();
    const card = registry.get("p-1")?.message;
    if (card === undefined || card === null) throw new Error("expected a posted card");
    const discord = fakeChannel();

    const dismissed = await dismissPendingCards(discord.channel, registry, []);

    expect(dismissed).toEqual({ turns: [CARD_TURN], deletedIds: [CARD] });
    expect(spiesOf(card).delete).toHaveBeenCalledTimes(1);
    expect(registry.get("p-1")).toBeUndefined();
    expect(discord.fetch).not.toHaveBeenCalled();
  });

  it("deletes a card only the Worker remembers, reading its options off its buttons", async () => {
    const orphan = postedCard("card-9", ["Plan A", "Plan B"]);
    const discord = fakeChannel({ stored: [orphan] });

    const dismissed = await dismissPendingCards(discord.channel, new AskPromptRegistry(), [
      "card-9",
    ]);

    expect(discord.fetch).toHaveBeenCalledWith("card-9");
    expect(spiesOf(orphan).delete).toHaveBeenCalledTimes(1);
    expect(dismissed).toMatchObject({
      turns: [{ id: "card-9", text: "Go on?\n[可选项] Plan A / Plan B", isBot: true }],
    });
    expect(dismissed.deletedIds).toEqual(["card-9"]);
  });

  it("counts a remembered card that is already gone as deleted", async () => {
    const discord = fakeChannel({ stored: [] });

    const dismissed = await dismissPendingCards(discord.channel, new AskPromptRegistry(), [
      "card-9",
    ]);

    expect(dismissed).toEqual({ turns: [], deletedIds: ["card-9"] });
  });

  it("keeps a card whose delete failed on record, so a later turn tries again", async () => {
    const { registry } = await post();
    const card = registry.get("p-1")?.message;
    if (card === undefined || card === null) throw new Error("expected a posted card");
    spiesOf(card).delete.mockRejectedValue(new Error("Missing Access"));
    const discord = fakeChannel();

    const dismissed = await dismissPendingCards(discord.channel, registry, []);

    // Its question still reaches the model, but Discord still shows the card: it is not reported gone.
    expect(dismissed).toEqual({ turns: [CARD_TURN], deletedIds: [] });
    expect(registry.get("p-1")).toBeUndefined();
    expect(loggedEvents()).toContain("ask_card_delete_error");
  });

  it("keeps a remembered card alone when Discord cannot be reached to fetch it", async () => {
    const discord = fakeChannel({ stored: [] });
    discord.fetch.mockRejectedValue(new Error("Socket hang up"));

    const dismissed = await dismissPendingCards(discord.channel, new AskPromptRegistry(), [
      "card-9",
    ]);

    expect(dismissed).toEqual({ turns: [], deletedIds: [] });
  });

  it("splits the two when one card is deleted and another is not", async () => {
    const gone = postedCard("card-gone", ["A"]);
    const stuck = postedCard("card-stuck", ["B"]);
    spiesOf(stuck).delete.mockRejectedValue(new Error("Missing Access"));
    const discord = fakeChannel({ stored: [gone, stuck] });

    const dismissed = await dismissPendingCards(discord.channel, new AskPromptRegistry(), [
      "card-gone",
      "card-stuck",
    ]);

    expect(dismissed.deletedIds).toEqual(["card-gone"]);
    expect(dismissed.turns.map((turn) => turn.id)).toEqual(["card-gone", "card-stuck"]);
  });

  it("reads nothing when no card is waiting", async () => {
    const discord = fakeChannel();

    expect(await dismissPendingCards(discord.channel, new AskPromptRegistry(), [])).toEqual({
      turns: [],
      deletedIds: [],
    });
    expect(discord.fetch).not.toHaveBeenCalled();
  });
});
