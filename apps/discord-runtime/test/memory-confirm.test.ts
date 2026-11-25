import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ButtonStyle,
  MessageFlags,
  MessagePayload,
  type AttachmentBuilder,
  type Message,
  type MessageComponentInteraction,
  type MessageEditOptions,
  type SendableChannels,
} from "discord.js";
import type { GuildMemoryProposal, UiLanguage } from "@xenoblade/contracts";

import {
  buildMemoryConfirmCard,
  buildMemoryConfirmRow,
  GUILD_MEMORY_ATTACHMENT_NAME,
  handleMemoryConfirmInteraction,
  isMemoryConfirmCustomId,
  MEMORY_CONFIRM_WINDOW_MS,
  MemoryConfirmRegistry,
  memoryConfirmEdit,
  memoryCustomId,
  parseMemoryCustomId,
  postMemoryConfirmation,
  renderConfirmOutcome,
  resolveMemoryConfirmAction,
  type MemoryConfirmCard,
  type MemoryConfirmEntry,
  type MemoryConfirmTexts,
} from "../src/memory-confirm";
import { messages } from "../src/i18n";
import { resetLanguageCache } from "../src/language";
import { MAX_MESSAGE_LENGTH } from "../src/output";
import type { EnvConfig } from "../src/env";
import { parseAskCustomId } from "../src/ask-confirm";
import { parseSoulCustomId } from "../src/soul-confirm";

const env: EnvConfig = {
  discordBotToken: "test-token",
  discordApplicationId: "app-id",
  workerUrl: "https://worker",
  internalApiToken: "token",
  mentionRoleIds: [],
  healthPort: 8397,
};

type SaveProposal = Extract<GuildMemoryProposal, { action: "save" }>;

const SAVE: SaveProposal = {
  id: "p1",
  scope: "guild",
  guildId: "g1",
  action: "save",
  category: "fact",
  key: "favorite language",
  value: "Rust",
};

const PREFERENCE_SAVE: SaveProposal = {
  id: "p2",
  scope: "guild",
  guildId: "g1",
  action: "save",
  category: "preference",
  key: "reply style",
  value: "简短",
};

const DELETE: GuildMemoryProposal = {
  id: "p3",
  scope: "guild",
  guildId: "g1",
  action: "delete",
  category: "fact",
  key: "pet",
};

const DELETE_EVERYWHERE: GuildMemoryProposal = {
  id: "p4",
  scope: "guild",
  guildId: "g1",
  action: "delete",
  key: "old rule",
};

/** A card listing two saves and two deletes — the mixed case. */
const BATCH: GuildMemoryProposal[] = [SAVE, PREFERENCE_SAVE, DELETE, DELETE_EVERYWHERE];

/** Message id of the confirmation card. */
const CARD = "card-1";
const OWNER = "owner-1";
/** How long the slow channel of the deadline tests takes to post a card. */
const POST_DELAY_MS = 10_000;

const TEXTS = messages("zh").memoryConfirm;

/** What a card edit carries, as the handler hands it to `Message#edit`. */
interface EditCall {
  content: string;
  components: unknown[];
  flags: number;
  allowedMentions: { parse: string[] };
}

/** Options the channel's `send` received for the card. */
interface SendCall {
  content: string;
  flags: number;
  allowedMentions?: unknown;
  files?: AttachmentBuilder[];
  components: Array<{ toJSON: () => { components: Array<WireButton> } }>;
}

type WireButton = { custom_id?: string; label?: string; style: number };

/** The fields of a message request body this suite reads, as discord.js puts them on the wire. */
interface WireBody {
  content?: string | null;
  flags?: number;
  components?: unknown[];
  allowed_mentions?: { parse?: string[] };
}

/** What settling a card sends: new text, no buttons, no embeds, no mention parsing. */
function settledCard(content: string): EditCall {
  return {
    content,
    components: [],
    flags: MessageFlags.SuppressEmbeds,
    allowedMentions: { parse: [] },
  };
}

function fakeMessage(id: string, edits: MessageEditOptions[]): Message {
  const message = {
    id,
    channelId: "channel-1",
    edit: async (options: MessageEditOptions) => {
      edits.push(options);
      return message;
    },
  };
  return message as unknown as Message;
}

/** A channel whose only send returns the card's message. */
function fakeChannel(
  edits: MessageEditOptions[],
  fail = false,
): { channel: SendableChannels; sent: SendCall[] } {
  const sent: SendCall[] = [];
  const channel = {
    id: "channel-1",
    send: async (options: SendCall) => {
      if (fail) throw new Error("Missing Access");
      sent.push(options);
      return fakeMessage(CARD, edits);
    },
  };
  return { channel: channel as unknown as SendableChannels, sent };
}

/** A button click on the card, with the edits it may cause and its acks. */
function click(customId: string, options: { userId?: string; messageId?: string } = {}) {
  const edits: MessageEditOptions[] = [];
  const deferUpdate = vi.fn<() => Promise<void>>(async () => undefined);
  const reply = vi.fn<(options: unknown) => Promise<void>>(async () => undefined);
  const interaction = {
    customId,
    user: { id: options.userId ?? OWNER },
    message: fakeMessage(options.messageId ?? CARD, edits),
    deferUpdate,
    reply,
  };
  return {
    interaction: interaction as unknown as MessageComponentInteraction,
    edits,
    deferUpdate,
    reply,
  };
}

interface WorkerCall {
  url: string;
  body: unknown;
}

/**
 * Stand in for the Worker: settings resolve in `language`, and the apply route
 * answers through `apply`. Every request is recorded in `calls`.
 */
function stubWorker(
  options: { language?: UiLanguage; apply?: () => Promise<Response> } = {},
): WorkerCall[] {
  const calls: WorkerCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body === undefined ? null : JSON.parse(String(init.body)) });
      if (url.endsWith("/internal/v1/settings")) {
        return Response.json({
          status: "ok",
          settings: {
            chatOptin: false,
            learnOptin: false,
            chatOptinAt: null,
            learnOptinAt: null,
            language: options.language ?? "zh",
          },
        });
      }
      if (url.endsWith("/internal/v1/memory/guild/apply") && options.apply !== undefined) {
        return options.apply();
      }
      throw new Error(`Unexpected Worker call: ${url}`);
    }),
  );
  return calls;
}

/** A Worker answer with every proposal of the batch succeeding. */
const okApply = (): Promise<Response> =>
  Promise.resolve(
    Response.json({
      status: "ok",
      results: BATCH.map((proposal) => ({ id: proposal.id, ok: true })),
    }),
  );

/** A Worker answer where the proposals keyed in `failures` fail with that code and the rest succeed. */
function failingApply(
  proposals: readonly GuildMemoryProposal[],
  failures: Record<string, string>,
): () => Promise<Response> {
  return async () =>
    Response.json({
      status: "ok",
      results: proposals.map((proposal) => {
        const code = failures[proposal.id];
        return code === undefined
          ? { id: proposal.id, ok: true }
          : { id: proposal.id, ok: false, code };
      }),
    });
}

function applyCalls(calls: readonly WorkerCall[]): WorkerCall[] {
  return calls.filter((call) => call.url.endsWith("/internal/v1/memory/guild/apply"));
}

/** One proposal's Worker outcomes as the outcome texts read them. */
const applied = (id: string) => ({ id, ok: true });
const refused = (id: string, code: string) => ({ id, ok: false, code });
const missing = (id: string) => ({ id, ok: true, code: "not_found" });

function asEdit(options: MessageEditOptions): EditCall {
  return options as EditCall;
}

/** The card id the posted buttons carry. */
function cardIdOf(sent: readonly SendCall[]): string {
  const customId = sent[0]?.components[0]?.toJSON().components[0]?.custom_id;
  const parsed = customId === undefined ? null : parseMemoryCustomId(customId);
  if (parsed === null) throw new Error("the card's first button carries no memory customId");
  return parsed.cardId;
}

/** Post a card for `proposals` and hand back the registry that tracks it and the card's id. */
async function postedCard(proposals: readonly GuildMemoryProposal[] = BATCH) {
  const registry = new MemoryConfirmRegistry();
  const { channel, sent } = fakeChannel([]);
  await postMemoryConfirmation(channel, OWNER, proposals, TEXTS, registry);
  return { registry, cardId: cardIdOf(sent) };
}

/** The UTF-8 bytes a card carries as its attachment; throws when it has none. */
function attachedList(card: MemoryConfirmCard): { name: string | null; bytes: Buffer } {
  if (card.attachment === undefined) throw new Error("the card carries no attachment");
  const file = card.attachment.attachment;
  if (!Buffer.isBuffer(file)) throw new Error("the attachment is not a buffer");
  return { name: card.attachment.name, bytes: Buffer.from(file) };
}

/** The lines the card lists `saves` (fact entries) as: a numbered, labeled block per entry. */
function linesOf(saves: readonly SaveProposal[]): string {
  return saves
    .flatMap((save, offset) => {
      const n = offset + 1;
      return [`[${n}] 保存 · 类别：事实`, `[${n}] 键：${save.key}`, `[${n}] 值：${save.value}`];
    })
    .join("\n");
}

/** The card's list for BATCH, line for line. */
const BATCH_LINES = [
  "[1] 保存 · 类别：事实",
  "[1] 键：favorite language",
  "[1] 值：Rust",
  "[2] 保存 · 类别：偏好",
  "[2] 键：reply style",
  "[2] 值：简短",
  "[3] 删除 · 类别：事实",
  "[3] 键：pet",
  "[4] 删除 · 类别：事实和偏好",
  "[4] 键：old rule",
];

/** Four saves of the longest value a proposal can carry — more than one message holds. */
function longSaves(count: number): SaveProposal[] {
  return Array.from({ length: count }, (_, i): SaveProposal => {
    const n = i + 1;
    return { ...SAVE, key: `rule ${n}`, value: "保持冷静，结论先行。".repeat(50) };
  });
}

/** A tracked card as the resolver reads it. */
function trackedEntry(overrides: Partial<MemoryConfirmEntry> = {}): MemoryConfirmEntry {
  return {
    cardId: "c1",
    userId: OWNER,
    messageId: CARD,
    proposals: BATCH,
    texts: TEXTS,
    busy: false,
    expiresAt: Date.now() + MEMORY_CONFIRM_WINDOW_MS,
    timer: undefined,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetLanguageCache();
});

describe("memory confirmation customIds", () => {
  it("round-trips a choice and its card id", () => {
    expect(memoryCustomId("yes", "c1")).toBe("xbl:gmem:yes:c1");
    expect(memoryCustomId("no", "c1")).toBe("xbl:gmem:no:c1");
    expect(parseMemoryCustomId("xbl:gmem:yes:c1")).toEqual({ choice: "yes", cardId: "c1" });
    expect(parseMemoryCustomId("xbl:gmem:no:c1")).toEqual({ choice: "no", cardId: "c1" });
  });

  it("claims its whole family, so no memory button falls through to another handler", () => {
    expect(isMemoryConfirmCustomId("xbl:gmem:yes:c1")).toBe(true);
    expect(isMemoryConfirmCustomId("xbl:gmem:garbage")).toBe(true);
    expect(isMemoryConfirmCustomId("xbl:soul:yes:p1")).toBe(false);
    expect(isMemoryConfirmCustomId("xbl:ask:p1:yes")).toBe(false);
    expect(isMemoryConfirmCustomId("")).toBe(false);
  });

  it("rejects malformed ids, which then fail closed as expired", () => {
    for (const customId of [
      "xbl:gmem:maybe:c1",
      "xbl:gmem:yes:",
      "xbl:gmem:yes",
      "xbl:gmem:yes:c1:extra",
      "xbl:soul:yes:c1",
      "xbl:ask:yes:c1",
      "other:gmem:yes:c1",
      "",
    ]) {
      expect(parseMemoryCustomId(customId)).toBeNull();
    }
  });

  it("never collides with the question-card or soul families", () => {
    expect(parseAskCustomId("xbl:gmem:yes:c1")).toBeNull();
    expect(parseSoulCustomId("xbl:gmem:yes:c1")).toBeNull();
    expect(parseMemoryCustomId("xbl:ask:c1:yes")).toBeNull();
    expect(parseMemoryCustomId("xbl:ask:c1:no")).toBeNull();
    expect(parseMemoryCustomId("xbl:soul:yes:p1")).toBeNull();
  });
});

describe("buildMemoryConfirmRow", () => {
  function buttons(texts: MemoryConfirmTexts): WireButton[] {
    return buildMemoryConfirmRow(texts, "c1").toJSON().components as WireButton[];
  }

  it("renders 是 (Primary) and 不是 (Secondary), each carrying the card id", () => {
    const [yes, no] = buttons(TEXTS);
    expect(yes).toMatchObject({
      custom_id: "xbl:gmem:yes:c1",
      label: "是",
      style: ButtonStyle.Primary,
    });
    expect(no).toMatchObject({
      custom_id: "xbl:gmem:no:c1",
      label: "不是",
      style: ButtonStyle.Secondary,
    });
  });

  it("follows the user's UI language", () => {
    const [yes, no] = buttons(messages("en").memoryConfirm);
    expect(yes?.label).toBe("Yes");
    expect(no?.label).toBe("No");
  });
});

describe("memoryConfirmEdit", () => {
  it("replaces the text, removes the buttons, and keeps embeds and mentions off", () => {
    const message = { client: { options: {} } } as unknown as Message;
    const body = MessagePayload.create(message, memoryConfirmEdit("Settled.")).resolveBody()
      .body as WireBody | null;
    if (body === null) throw new Error("discord.js built no edit body");
    expect(body.content).toBe("Settled.");
    expect(body.flags).toBe(MessageFlags.SuppressEmbeds);
    expect(body.components).toEqual([]);
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });
});

describe("buildMemoryConfirmCard", () => {
  it("asks the question, states how many changes follow, and gives each its own numbered block", () => {
    const card = buildMemoryConfirmCard(TEXTS, BATCH);
    expect(card.attachment).toBeUndefined();
    expect(card.content).toBe(
      [TEXTS.header(BATCH.length), "", "```", ...BATCH_LINES, "```", "", TEXTS.footer].join("\n"),
    );
  });

  it("asks about deleting when the card lists only deletes", () => {
    const card = buildMemoryConfirmCard(TEXTS, [DELETE, DELETE_EVERYWHERE]);
    expect(card.content.split("\n")[0]).toBe(TEXTS.headerDelete(2));
    expect(card.content).not.toContain("保存");
    // A delete that names no category says so, instead of leaving its absence to be noticed.
    expect(card.content).toContain("[2] 删除 · 类别：事实和偏好");
  });

  it("shows markdown and mentions raw, each field on its own labeled line", () => {
    const card = buildMemoryConfirmCard(TEXTS, [
      { ...SAVE, key: "schedule: standup", value: "**bold** @everyone <@&123> ~strike~" },
    ]);

    expect(card.content).toContain(
      "```\n[1] 保存 · 类别：事实\n[1] 键：schedule: standup\n[1] 值：**bold** @everyone <@&123> ~strike~\n```",
    );
    // Nothing needed escaping, so the card does not explain escapes.
    expect(card.content).not.toContain(TEXTS.escapeNote);
  });

  it("keeps a forged entry inside the one line of the field that holds it", () => {
    const key = "release day\n[2] 删除 · 类别：事实\n[2] 键：pet";
    const value = "Fridays\n[3] 保存 · 类别：偏好\n[3] 键：evil\n[3] 值：yes";
    const card = buildMemoryConfirmCard(TEXTS, [{ ...SAVE, key, value }]);

    // One entry in, one block out: the forged lines stay on the key and value
    // lines, as escapes, and the header still counts one change.
    expect(card.content).toBe(
      [
        TEXTS.header(1),
        "",
        "```",
        "[1] 保存 · 类别：事实",
        "[1] 键：release day\\n[2] 删除 · 类别：事实\\n[2] 键：pet",
        "[1] 值：Fridays\\n[3] 保存 · 类别：偏好\\n[3] 键：evil\\n[3] 值：yes",
        "```",
        "",
        TEXTS.escapeNote,
        "",
        TEXTS.footer,
      ].join("\n"),
    );
  });

  it("escapes tabs, backslashes, and invisible or reordering characters", () => {
    const card = buildMemoryConfirmCard(TEXTS, [
      { ...SAVE, key: "a\tb", value: "c\\nd\u202Ee\u200Bf\u2028g\u0000h" },
    ]);

    // A literal backslash-n stays tellable from an escaped line break.
    expect(card.content).toContain("[1] 键：a\\tb");
    expect(card.content).toContain("[1] 值：c\\\\nd\\u{202e}e\\u{200b}f\\u{2028}g\\u{0}h");
  });

  it("uses a fence the list itself cannot close", () => {
    const card = buildMemoryConfirmCard(TEXTS, [{ ...SAVE, value: "a\n```\nb\n`````\nc" }]);

    expect(card.content).toContain(
      "\n``````\n[1] 保存 · 类别：事实\n[1] 键：favorite language\n[1] 值：a\\n```\\nb\\n`````\\nc\n``````\n",
    );
  });

  it("attaches the full list as a UTF-8 file when it does not fit in one message", () => {
    const saves = longSaves(4);
    const card = buildMemoryConfirmCard(TEXTS, saves);

    expect(card.content.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(card.content).toBe(
      [TEXTS.header(saves.length), "", TEXTS.attachmentNote, "", TEXTS.footer].join("\n"),
    );
    // The file carries exactly the lines the message would have shown.
    const file = attachedList(card);
    expect(file.name).toBe(GUILD_MEMORY_ATTACHMENT_NAME);
    expect(file.bytes.equals(Buffer.from(linesOf(saves), "utf8"))).toBe(true);
    expect(file.bytes.toString("utf8")).toBe(linesOf(saves));
  });

  it("keeps a long list's fields on single escaped lines in the file too", () => {
    const multiLine = "保持冷静，结论先行。".repeat(47) + "\n第二行";
    const saves = longSaves(4).map((save) => ({ ...save, value: multiLine }));
    const card = buildMemoryConfirmCard(TEXTS, saves);

    expect(card.content).toContain(TEXTS.attachmentNote);
    expect(card.content).toContain(TEXTS.escapeNote);
    // One entry is still one block of three lines in the file, not five.
    const file = attachedList(card).bytes.toString("utf8");
    expect(file).toContain(
      `[1] 保存 · 类别：事实\n[1] 键：rule 1\n[1] 值：${multiLine.replace("\n", "\\n")}\n[2] 保存`,
    );
    expect(file.split("\n")).toHaveLength(12);
  });

  it("keeps a list that just fits in the message inline", () => {
    // The inline card is header + fences + list + footer; find the largest
    // single entry that still fits and make sure it is not sent as a file.
    const probe = buildMemoryConfirmCard(TEXTS, [SAVE]);
    const overhead = probe.content.length - SAVE.key.length - SAVE.value.length;
    const fits = "字".repeat(MAX_MESSAGE_LENGTH - overhead - 1);
    const card = buildMemoryConfirmCard(TEXTS, [{ ...SAVE, key: "k", value: fits }]);

    expect(card.attachment).toBeUndefined();
    expect(card.content).toHaveLength(MAX_MESSAGE_LENGTH);
    expect(
      buildMemoryConfirmCard(TEXTS, [{ ...SAVE, key: "k", value: `${fits}字` }]).attachment,
    ).toBeDefined();
  });

  it("follows the user's UI language", () => {
    const card = buildMemoryConfirmCard(messages("en").memoryConfirm, BATCH);
    expect(card.content).toContain("Update this server's shared memory? 4 changes:");
    expect(card.content).toContain("[1] Save · category: fact");
    expect(card.content).toContain("[1] key: favorite language");
    expect(card.content).toContain("[1] value: Rust");
    expect(card.content).toContain("[2] Save · category: preference");
    expect(card.content).toContain("[3] Delete · category: fact");
    expect(card.content).toContain("[4] Delete · category: fact and preference");
    const single = buildMemoryConfirmCard(messages("en").memoryConfirm, [DELETE]);
    expect(single.content).toContain("Delete from this server's shared memory? 1 change:");
    // A plain entry needs no escapes, so the English card does not explain them either.
    expect(single.content).not.toContain("marks a line break");
  });
});

describe("postMemoryConfirmation", () => {
  it("posts the card with the full list, no mention parsing, suppressed embeds, both buttons, and tracks it", async () => {
    vi.useFakeTimers();
    const registry = new MemoryConfirmRegistry();
    const { channel, sent } = fakeChannel([]);

    await postMemoryConfirmation(channel, OWNER, BATCH, TEXTS, registry);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.content).toBe(buildMemoryConfirmCard(TEXTS, BATCH).content);
    // Keys and values may contain `@everyone` or a role mention.
    expect(sent[0]?.allowedMentions).toEqual({ parse: [] });
    expect(sent[0]?.files).toBeUndefined();
    expect(sent[0]?.flags).toBe(MessageFlags.SuppressEmbeds);
    const cardId = cardIdOf(sent);
    expect(sent[0]?.components[0]?.toJSON().components.map((button) => button.custom_id)).toEqual([
      `xbl:gmem:yes:${cardId}`,
      `xbl:gmem:no:${cardId}`,
    ]);
    expect(registry.get(cardId)).toMatchObject({
      cardId,
      userId: OWNER,
      messageId: CARD,
      proposals: BATCH,
      busy: false,
      expiresAt: Date.now() + MEMORY_CONFIRM_WINDOW_MS,
    });
  });

  it("opens the window before the send, so a slow post does not extend it", async () => {
    vi.useFakeTimers();
    const postedAt = Date.now();
    const registry = new MemoryConfirmRegistry();
    const sent: SendCall[] = [];
    const slow = {
      id: "channel-1",
      send: async (options: SendCall) => {
        sent.push(options);
        // A fake timer stands in for a slow Discord call; the test advances it.
        const posted = Promise.withResolvers<void>();
        setTimeout(posted.resolve, POST_DELAY_MS);
        await posted.promise;
        return fakeMessage(CARD, []);
      },
    };

    const posting = postMemoryConfirmation(
      slow as unknown as SendableChannels,
      OWNER,
      BATCH,
      TEXTS,
      registry,
    );
    await vi.advanceTimersByTimeAsync(POST_DELAY_MS);
    await posting;

    const cardId = cardIdOf(sent);
    expect(registry.get(cardId)?.expiresAt).toBe(postedAt + MEMORY_CONFIRM_WINDOW_MS);
    // The timer is set to fire at that deadline, not five minutes after the post.
    await vi.advanceTimersByTimeAsync(MEMORY_CONFIRM_WINDOW_MS - POST_DELAY_MS);
    expect(registry.get(cardId)).toBeUndefined();
  });

  it("sends the full list as a UTF-8 file when it does not fit in the message", async () => {
    vi.useFakeTimers();
    const registry = new MemoryConfirmRegistry();
    const saves = longSaves(5);
    const { channel, sent } = fakeChannel([]);

    await postMemoryConfirmation(channel, OWNER, saves, TEXTS, registry);

    expect(sent[0]?.content.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(sent[0]?.content).toContain(TEXTS.attachmentNote);
    expect(sent[0]?.allowedMentions).toEqual({ parse: [] });

    // What discord.js puts on the wire for the attachment: its name and its bytes.
    const payload = await MessagePayload.create({ client: { options: {} } } as unknown as Message, {
      files: sent[0]?.files,
    }).resolveFiles();
    expect(payload.files).toHaveLength(1);
    expect(payload.files?.[0]?.name).toBe(GUILD_MEMORY_ATTACHMENT_NAME);
    expect(payload.files?.[0]?.data).toEqual(Buffer.from(linesOf(saves), "utf8"));
  });

  it("posts nothing when there is nothing to confirm", async () => {
    vi.useFakeTimers();
    const registry = new MemoryConfirmRegistry();
    const { channel, sent } = fakeChannel([]);

    await postMemoryConfirmation(channel, OWNER, [], TEXTS, registry);

    expect(sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives every card its own id", async () => {
    vi.useFakeTimers();
    const { channel, sent } = fakeChannel([]);

    await postMemoryConfirmation(channel, OWNER, BATCH, TEXTS, new MemoryConfirmRegistry());
    await postMemoryConfirmation(channel, OWNER, BATCH, TEXTS, new MemoryConfirmRegistry());

    const [first, second] = sent;
    if (first === undefined || second === undefined) throw new Error("expected two cards");
    expect(cardIdOf([first])).not.toBe(cardIdOf([second]));
  });

  it("untracks the card when it cannot be posted, and arms no timer", async () => {
    vi.useFakeTimers();
    vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-1111-4111-8111-111111111111");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const registry = new MemoryConfirmRegistry();

    await postMemoryConfirmation(fakeChannel([], true).channel, OWNER, BATCH, TEXTS, registry);

    expect(registry.get("11111111-1111-4111-8111-111111111111")).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires the card once the window passes, and later clicks fail closed", async () => {
    vi.useFakeTimers();
    const calls = stubWorker();
    const registry = new MemoryConfirmRegistry();
    const cardEdits: MessageEditOptions[] = [];
    const { channel, sent } = fakeChannel(cardEdits);
    await postMemoryConfirmation(channel, OWNER, BATCH, TEXTS, registry);
    const cardId = cardIdOf(sent);

    await vi.advanceTimersByTimeAsync(MEMORY_CONFIRM_WINDOW_MS - 1);
    expect(cardEdits).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(cardEdits.map(asEdit)).toEqual([settledCard(TEXTS.expired)]);
    expect(registry.get(cardId)).toBeUndefined();

    const late = click(memoryCustomId("yes", cardId));
    await handleMemoryConfirmInteraction(late.interaction, env, registry);
    expect(applyCalls(calls)).toEqual([]);
    expect(late.reply).toHaveBeenCalledWith({
      content: TEXTS.expiredNotice,
      flags: MessageFlags.Ephemeral,
    });
  });

  it("leaves the card alone while its window is open", async () => {
    vi.useFakeTimers();
    const registry = new MemoryConfirmRegistry();
    const cardEdits: MessageEditOptions[] = [];
    const { channel, sent } = fakeChannel(cardEdits);
    await postMemoryConfirmation(channel, OWNER, BATCH, TEXTS, registry);
    const cardId = cardIdOf(sent);

    await vi.advanceTimersByTimeAsync(MEMORY_CONFIRM_WINDOW_MS - 1);

    expect(registry.get(cardId)).toBeDefined();
    expect(cardEdits).toEqual([]);
  });
});

describe("resolveMemoryConfirmAction", () => {
  const yes = memoryCustomId("yes", "c1");
  const no = memoryCustomId("no", "c1");

  it("maps the owner's 是 and 不是 to their actions", () => {
    expect(resolveMemoryConfirmAction(trackedEntry(), yes, CARD, OWNER)).toEqual({
      action: "confirm",
    });
    expect(resolveMemoryConfirmAction(trackedEntry(), no, CARD, OWNER)).toEqual({
      action: "cancel",
    });
  });

  it("refuses anyone but the owner, on either button", () => {
    for (const customId of [yes, no]) {
      expect(resolveMemoryConfirmAction(trackedEntry(), customId, CARD, "someone-else")).toEqual({
        action: "rejected",
        reason: "not-owner",
      });
    }
  });

  it("refuses clicks while the confirmed apply is in flight", () => {
    const busy = trackedEntry({ busy: true });
    expect(resolveMemoryConfirmAction(busy, yes, CARD, OWNER)).toEqual({
      action: "rejected",
      reason: "busy",
    });
    expect(resolveMemoryConfirmAction(busy, no, CARD, OWNER)).toEqual({
      action: "rejected",
      reason: "busy",
    });
  });

  it("expires cards this process cannot vouch for", () => {
    const expired = { action: "rejected", reason: "expired" };
    // Unknown card: restart, registry eviction, or already settled.
    expect(resolveMemoryConfirmAction(undefined, yes, CARD, OWNER)).toEqual(expired);
    // A button fired on a message other than its own card.
    expect(resolveMemoryConfirmAction(trackedEntry(), yes, "other-message", OWNER)).toEqual(
      expired,
    );
    // A card whose send has not resolved yet has no message to vouch for it.
    expect(resolveMemoryConfirmAction(trackedEntry({ messageId: null }), yes, CARD, OWNER)).toEqual(
      expired,
    );
    // A family customId that cannot be parsed.
    expect(resolveMemoryConfirmAction(trackedEntry(), "xbl:gmem:yes", CARD, OWNER)).toEqual(
      expired,
    );
  });

  it("expires a card at its deadline, whether or not the timer has run", () => {
    const expired = { action: "rejected", reason: "expired" };
    const deadline = Date.now() + 1_000;
    const due = trackedEntry({ expiresAt: deadline });

    expect(resolveMemoryConfirmAction(due, yes, CARD, OWNER)).toEqual({ action: "confirm" });
    // The clock reaches the deadline without a single timer firing.
    vi.spyOn(Date, "now").mockReturnValue(deadline);
    expect(resolveMemoryConfirmAction(due, yes, CARD, OWNER)).toEqual(expired);
    expect(resolveMemoryConfirmAction(due, no, CARD, OWNER)).toEqual(expired);
    expect(
      resolveMemoryConfirmAction(trackedEntry({ expiresAt: deadline - 1 }), yes, CARD, OWNER),
    ).toEqual(expired);
  });

  it("ignores customIds of another button family", () => {
    expect(resolveMemoryConfirmAction(trackedEntry(), "xbl:ask:c1:yes", CARD, OWNER)).toBeNull();
    expect(resolveMemoryConfirmAction(trackedEntry(), "xbl:soul:yes:c1", CARD, OWNER)).toBeNull();
    expect(resolveMemoryConfirmAction(undefined, "xbl:ask:c1:no", CARD, OWNER)).toBeNull();
  });
});

describe("MemoryConfirmRegistry", () => {
  function entry(cardId: string): MemoryConfirmEntry {
    return trackedEntry({ cardId });
  }

  it("registers, looks up, and removes entries by card id", () => {
    const registry = new MemoryConfirmRegistry();
    registry.register("c1", entry("c1"));
    expect(registry.get("c1")?.cardId).toBe("c1");
    registry.remove("c1");
    expect(registry.get("c1")).toBeUndefined();
  });

  it("evicts the oldest entry beyond the cap", () => {
    const registry = new MemoryConfirmRegistry();
    for (let i = 0; i < 129; i++) {
      registry.register(`c${i}`, entry(`c${i}`));
    }
    expect(registry.get("c0")).toBeUndefined();
    expect(registry.get("c1")?.cardId).toBe("c1");
    expect(registry.get("c128")?.cardId).toBe("c128");
  });

  it("an evicted card fails closed at once, and is still retired when its window ends", async () => {
    vi.useFakeTimers();
    const calls = stubWorker();
    const registry = new MemoryConfirmRegistry();
    const cardEdits: MessageEditOptions[] = [];
    const { channel, sent } = fakeChannel(cardEdits);
    await postMemoryConfirmation(channel, OWNER, BATCH, TEXTS, registry);
    const cardId = cardIdOf(sent);
    // 128 newer confirmations push the card's entry out of the registry.
    for (let i = 0; i < 128; i++) {
      registry.register(`newer-${i}`, entry(`newer-${i}`));
    }

    const evicted = click(memoryCustomId("yes", cardId));
    await handleMemoryConfirmInteraction(evicted.interaction, env, registry);
    expect(applyCalls(calls)).toEqual([]);
    expect(evicted.reply).toHaveBeenCalledWith({
      content: TEXTS.expiredNotice,
      flags: MessageFlags.Ephemeral,
    });

    await vi.advanceTimersByTimeAsync(MEMORY_CONFIRM_WINDOW_MS);
    expect(cardEdits.map(asEdit)).toEqual([settledCard(TEXTS.expired)]);
  });
});

describe("renderConfirmOutcome", () => {
  it("reports a batch that fully succeeded as saved", () => {
    expect(
      renderConfirmOutcome(
        { status: "ok", results: [applied("p1"), applied("p2"), applied("p3"), applied("p4")] },
        BATCH.length,
        TEXTS,
      ),
    ).toBe(TEXTS.saved);
    // A delete that matched nothing reached its end state: still saved.
    expect(
      renderConfirmOutcome(
        { status: "ok", results: [applied("p1"), applied("p2"), missing("p3"), applied("p4")] },
        BATCH.length,
        TEXTS,
      ),
    ).toBe(TEXTS.saved);
  });

  it("reports a batch that partly succeeded as partial", () => {
    expect(
      renderConfirmOutcome(
        {
          status: "ok",
          results: [applied("p1"), refused("p2", "memory_full"), missing("p3"), applied("p4")],
        },
        BATCH.length,
        TEXTS,
      ),
    ).toBe(TEXTS.savedPartial(3, 4));
  });

  it("points at the server's entry cap when the cap refused every change", () => {
    // The saves were refused for the cap and the deletes matched nothing: nothing changed.
    expect(
      renderConfirmOutcome(
        {
          status: "ok",
          results: [
            refused("p1", "memory_full"),
            refused("p2", "memory_full"),
            missing("p3"),
            missing("p4"),
          ],
        },
        BATCH.length,
        TEXTS,
      ),
    ).toBe(TEXTS.full);
    expect(
      renderConfirmOutcome({ status: "ok", results: [refused("p1", "memory_full")] }, 1, TEXTS),
    ).toBe(TEXTS.full);
  });

  it("reports a batch that changed nothing for any other reason as failed", () => {
    expect(
      renderConfirmOutcome(
        {
          status: "ok",
          results: [refused("p1", "memory_op_failed"), missing("p3"), missing("p4")],
        },
        3,
        TEXTS,
      ),
    ).toBe(TEXTS.failed);
    expect(renderConfirmOutcome({ status: "error", code: "invalid_body" }, 1, TEXTS)).toBe(
      TEXTS.failed,
    );
    expect(renderConfirmOutcome(null, 1, TEXTS)).toBe(TEXTS.failed);
  });

  it("says so when every delete matched nothing", () => {
    expect(
      renderConfirmOutcome({ status: "ok", results: [missing("p3"), missing("p4")] }, 2, TEXTS),
    ).toBe(TEXTS.nothingToDelete);
  });
});

describe("handleMemoryConfirmInteraction", () => {
  it("applies every listed proposal on 是 and retires the card with the success text", async () => {
    vi.useFakeTimers();
    const calls = stubWorker({ apply: okApply });
    const { registry, cardId } = await postedCard();
    const confirm = click(memoryCustomId("yes", cardId));

    await handleMemoryConfirmInteraction(confirm.interaction, env, registry);

    expect(applyCalls(calls)).toEqual([
      {
        url: "https://worker/internal/v1/memory/guild/apply",
        body: { proposals: BATCH, updatedBy: OWNER },
      },
    ]);
    expect(confirm.deferUpdate).toHaveBeenCalledTimes(1);
    expect(confirm.reply).not.toHaveBeenCalled();
    expect(confirm.edits.map(asEdit)).toEqual([settledCard(TEXTS.saved)]);
    expect(registry.get(cardId)).toBeUndefined();
  });

  it("acknowledges the click before it calls the Worker", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const calls = stubWorker({
      apply: async () => {
        order.push("apply");
        return okApply();
      },
    });
    const { registry, cardId } = await postedCard();
    const confirm = click(memoryCustomId("yes", cardId));
    confirm.deferUpdate.mockImplementation(async () => {
      order.push("acknowledge");
    });

    await handleMemoryConfirmInteraction(confirm.interaction, env, registry);

    expect(order).toEqual(["acknowledge", "apply"]);
    expect(applyCalls(calls)).toHaveLength(1);
  });

  it("drops the proposals on 不是 without calling the Worker", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<() => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);
    const { registry, cardId } = await postedCard();
    const decline = click(memoryCustomId("no", cardId));

    await handleMemoryConfirmInteraction(decline.interaction, env, registry);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(decline.deferUpdate).toHaveBeenCalledTimes(1);
    expect(decline.edits.map(asEdit)).toEqual([settledCard(TEXTS.cancelled)]);
    expect(registry.get(cardId)).toBeUndefined();
  });

  it.each([
    [
      "the Worker rejects the batch",
      async () => Response.json({ status: "error", code: "invalid_body" }),
    ],
    [
      "the Worker cannot be reached",
      async () => {
        throw new Error("Worker request failed");
      },
    ],
    [
      "every proposal fails on the Worker",
      failingApply(BATCH, {
        p1: "memory_op_failed",
        p2: "memory_op_failed",
        p3: "memory_op_failed",
        p4: "memory_op_failed",
      }),
    ],
  ])("shows the failure text and forgets the card when %s", async (_case, apply) => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    stubWorker({ apply });
    const { registry, cardId } = await postedCard();
    const confirm = click(memoryCustomId("yes", cardId));

    await handleMemoryConfirmInteraction(confirm.interaction, env, registry);

    expect(confirm.edits.map(asEdit)).toEqual([settledCard(TEXTS.failed)]);
    expect(registry.get(cardId)).toBeUndefined();
  });

  it("tells the user when part of the batch failed", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    stubWorker({ apply: failingApply(BATCH, { p2: "memory_op_failed", p3: "memory_op_failed" }) });
    const { registry, cardId } = await postedCard();
    const confirm = click(memoryCustomId("yes", cardId));

    await handleMemoryConfirmInteraction(confirm.interaction, env, registry);

    expect(confirm.edits.map(asEdit)).toEqual([settledCard(TEXTS.savedPartial(2, 4))]);
  });

  it("points at the server's entry cap when the cap refused every change", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    stubWorker({
      apply: failingApply(BATCH, {
        p1: "memory_full",
        p2: "memory_full",
        p3: "not_found",
        p4: "not_found",
      }),
    });
    const { registry, cardId } = await postedCard();
    const confirm = click(memoryCustomId("yes", cardId));

    await handleMemoryConfirmInteraction(confirm.interaction, env, registry);

    expect(confirm.edits.map(asEdit)).toEqual([settledCard(TEXTS.full)]);
  });

  it("refuses a second click while the confirmed apply is in flight", async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<void>();
    const calls = stubWorker({
      apply: async () => {
        await pending.promise;
        return okApply();
      },
    });
    const { registry, cardId } = await postedCard();
    const first = click(memoryCustomId("yes", cardId));

    const run = handleMemoryConfirmInteraction(first.interaction, env, registry);
    await vi.waitFor(() => expect(applyCalls(calls)).toHaveLength(1));

    const second = click(memoryCustomId("yes", cardId));
    await handleMemoryConfirmInteraction(second.interaction, env, registry);
    expect(second.reply).toHaveBeenCalledWith({
      content: TEXTS.busy,
      flags: MessageFlags.Ephemeral,
    });
    expect(second.deferUpdate).not.toHaveBeenCalled();
    expect(second.edits).toEqual([]);
    expect(first.edits).toEqual([]);

    pending.resolve();
    await run;
    expect(applyCalls(calls)).toHaveLength(1);
    expect(first.edits.map(asEdit)).toEqual([settledCard(TEXTS.saved)]);
  });

  it("refuses anyone but the owner, leaving the card pending", async () => {
    vi.useFakeTimers();
    const calls = stubWorker();
    const { registry, cardId } = await postedCard();
    const stranger = click(memoryCustomId("yes", cardId), { userId: "someone-else" });

    await handleMemoryConfirmInteraction(stranger.interaction, env, registry);

    expect(stranger.reply).toHaveBeenCalledWith({
      content: TEXTS.notOwner,
      flags: MessageFlags.Ephemeral,
    });
    expect(stranger.deferUpdate).not.toHaveBeenCalled();
    expect(applyCalls(calls)).toEqual([]);
    expect(stranger.edits).toEqual([]);
    expect(registry.get(cardId)).toBeDefined();
  });

  it("renders a refusal in the clicker's own language", async () => {
    vi.useFakeTimers();
    stubWorker({ language: "en" });
    const { registry, cardId } = await postedCard();
    const stranger = click(memoryCustomId("no", cardId), { userId: "someone-else" });

    await handleMemoryConfirmInteraction(stranger.interaction, env, registry);

    expect(stranger.reply).toHaveBeenCalledWith({
      content: messages("en").memoryConfirm.notOwner,
      flags: MessageFlags.Ephemeral,
    });
  });

  it("fails closed after a restart: an unknown card gets an ephemeral notice and nothing else", async () => {
    vi.useFakeTimers();
    const calls = stubWorker({ apply: okApply });
    const registry = new MemoryConfirmRegistry();
    const confirm = click(memoryCustomId("yes", "c-unknown"));

    await handleMemoryConfirmInteraction(confirm.interaction, env, registry);

    expect(confirm.reply).toHaveBeenCalledWith({
      content: TEXTS.expiredNotice,
      flags: MessageFlags.Ephemeral,
    });
    expect(confirm.deferUpdate).not.toHaveBeenCalled();
    expect(confirm.edits).toEqual([]);
    expect(applyCalls(calls)).toEqual([]);
  });

  it("fails closed for a memory-family button it cannot parse", async () => {
    vi.useFakeTimers();
    const calls = stubWorker({ apply: okApply });
    const { registry, cardId } = await postedCard();
    const stray = click("xbl:gmem:yes");

    await handleMemoryConfirmInteraction(stray.interaction, env, registry);

    expect(stray.reply).toHaveBeenCalledWith({
      content: TEXTS.expiredNotice,
      flags: MessageFlags.Ephemeral,
    });
    expect(applyCalls(calls)).toEqual([]);
    expect(stray.edits).toEqual([]);
    expect(registry.get(cardId)).toBeDefined();
  });

  it("no longer touches a settled card when its window would have ended", async () => {
    vi.useFakeTimers();
    stubWorker({ apply: okApply });
    const { registry, cardId } = await postedCard();
    const confirm = click(memoryCustomId("yes", cardId));
    await handleMemoryConfirmInteraction(confirm.interaction, env, registry);

    await vi.advanceTimersByTimeAsync(MEMORY_CONFIRM_WINDOW_MS + 1);

    expect(confirm.edits.map(asEdit)).toEqual([settledCard(TEXTS.saved)]);
  });

  it("fails closed at the deadline even before the expiry timer has run", async () => {
    vi.useFakeTimers();
    const calls = stubWorker({ apply: okApply });
    const registry = new MemoryConfirmRegistry();
    const cardEdits: MessageEditOptions[] = [];
    const { channel, sent } = fakeChannel(cardEdits);
    await postMemoryConfirmation(channel, OWNER, BATCH, TEXTS, registry);
    const cardId = cardIdOf(sent);
    // The deadline passes while the timer that retires the card is still pending.
    const entry = registry.get(cardId);
    if (entry === undefined) throw new Error("expected the posted card to be tracked");
    entry.expiresAt = Date.now() - 1;

    const late = click(memoryCustomId("yes", cardId));
    await handleMemoryConfirmInteraction(late.interaction, env, registry);

    expect(late.reply).toHaveBeenCalledWith({
      content: TEXTS.expiredNotice,
      flags: MessageFlags.Ephemeral,
    });
    expect(late.deferUpdate).not.toHaveBeenCalled();
    expect(applyCalls(calls)).toEqual([]);
    // Retiring the card is still the timer's job.
    expect(cardEdits).toEqual([]);
    await vi.advanceTimersByTimeAsync(MEMORY_CONFIRM_WINDOW_MS);
    expect(cardEdits.map(asEdit)).toEqual([settledCard(TEXTS.expired)]);
  });

  it("never writes the expired text over an apply still in flight when the window ends", async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<void>();
    const calls = stubWorker({
      apply: async () => {
        await pending.promise;
        return okApply();
      },
    });
    const { registry, cardId } = await postedCard();
    const confirm = click(memoryCustomId("yes", cardId));
    const run = handleMemoryConfirmInteraction(confirm.interaction, env, registry);
    await vi.waitFor(() => expect(applyCalls(calls)).toHaveLength(1));

    // The window ends while the Worker call is still pending.
    await vi.advanceTimersByTimeAsync(MEMORY_CONFIRM_WINDOW_MS);
    expect(confirm.edits).toEqual([]);
    // The card is dead to everyone else from here on, apply or no apply.
    const late = click(memoryCustomId("yes", cardId));
    await handleMemoryConfirmInteraction(late.interaction, env, registry);
    expect(late.reply).toHaveBeenCalledWith({
      content: TEXTS.expiredNotice,
      flags: MessageFlags.Ephemeral,
    });

    // The in-flight apply still gets the last word on the card.
    pending.resolve();
    await run;
    expect(confirm.edits.map(asEdit)).toEqual([settledCard(TEXTS.saved)]);
    expect(registry.get(cardId)).toBeUndefined();
  });
});
