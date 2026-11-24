import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ButtonStyle,
  MessageFlags,
  MessagePayload,
  type Message,
  type MessageComponentInteraction,
  type MessageEditOptions,
  type SendableChannels,
} from "discord.js";
import type { SoulProposal, UiLanguage } from "@xenoblade/contracts";

import {
  buildSoulConfirmRow,
  handleSoulConfirmInteraction,
  isSoulConfirmCustomId,
  parseSoulCustomId,
  postSoulConfirmation,
  renderSoulConfirmation,
  resolveSoulConfirmAction,
  SOUL_CONFIRM_WINDOW_MS,
  SoulConfirmRegistry,
  soulConfirmEdit,
  soulCustomId,
  type SoulConfirmEntry,
  type SoulConfirmTexts,
} from "../src/soul-confirm";
import { messages } from "../src/i18n";
import { resetLanguageCache } from "../src/language";
import type { EnvConfig } from "../src/env";
import { parseControlCustomId } from "../src/reply-controls";

const env: EnvConfig = {
  discordBotToken: "test-token",
  discordApplicationId: "app-id",
  workerUrl: "https://worker",
  internalApiToken: "token",
  mentionRoleIds: [],
  healthPort: 8397,
};

const PROPOSAL: SoulProposal = {
  id: "p-1",
  scopeId: "g1",
  content: "Be calm and precise.",
  summary: "Calm down the tone.",
};
/** Message id of the confirmation card. */
const CARD = "card-1";
const OWNER = "owner-1";

const TEXTS = messages("zh").soulConfirm;

/** What a card edit carries, as the handler hands it to `Message#edit`. */
interface EditCall {
  content: string;
  components: unknown[];
  flags: number;
}

/** Options the channel's `send` received for the card. */
interface SendCall {
  content: string;
  flags: number;
  components: Array<{ toJSON: () => { components: Array<WireButton> } }>;
}

type WireButton = { custom_id?: string; label?: string; style: number };

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

/** Post a card and hand back the registry that tracks it. */
async function postedRegistry(): Promise<SoulConfirmRegistry> {
  const registry = new SoulConfirmRegistry();
  await postSoulConfirmation(fakeChannel([]).channel, OWNER, PROPOSAL, TEXTS, registry);
  return registry;
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
      if (url.endsWith("/internal/v1/soul/apply") && options.apply !== undefined) {
        return options.apply();
      }
      throw new Error(`Unexpected Worker call: ${url}`);
    }),
  );
  return calls;
}

const okApply = (): Promise<Response> =>
  Promise.resolve(Response.json({ status: "ok", scopeId: PROPOSAL.scopeId }));

function applyCalls(calls: readonly WorkerCall[]): WorkerCall[] {
  return calls.filter((call) => call.url.endsWith("/internal/v1/soul/apply"));
}

function asEdit(options: MessageEditOptions): EditCall {
  return options as EditCall;
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetLanguageCache();
});

describe("soul confirmation customIds", () => {
  it("round-trips a choice and its proposal id", () => {
    expect(soulCustomId("yes", "p1")).toBe("xbl:soul:yes:p1");
    expect(soulCustomId("no", "p1")).toBe("xbl:soul:no:p1");
    expect(parseSoulCustomId("xbl:soul:yes:p1")).toEqual({ choice: "yes", proposalId: "p1" });
    expect(parseSoulCustomId("xbl:soul:no:p1")).toEqual({ choice: "no", proposalId: "p1" });
  });

  it("claims its whole family, so no soul button falls through to another handler", () => {
    expect(isSoulConfirmCustomId("xbl:soul:yes:p1")).toBe(true);
    expect(isSoulConfirmCustomId("xbl:soul:garbage")).toBe(true);
    expect(isSoulConfirmCustomId("xbl:regen:r1")).toBe(false);
    expect(isSoulConfirmCustomId("")).toBe(false);
  });

  it("rejects malformed ids, which then fail closed as expired", () => {
    for (const customId of [
      "xbl:soul:maybe:p1",
      "xbl:soul:yes:",
      "xbl:soul:yes",
      "xbl:soul:yes:p1:extra",
      "xbl:regen:yes:p1",
      "other:soul:yes:p1",
      "",
    ]) {
      expect(parseSoulCustomId(customId)).toBeNull();
    }
  });

  it("never collides with the reply-control family", () => {
    expect(parseControlCustomId("xbl:soul:yes:p1")).toBeNull();
    expect(parseSoulCustomId("xbl:regen:r1")).toBeNull();
    expect(parseSoulCustomId("xbl:del:r1")).toBeNull();
  });
});

describe("buildSoulConfirmRow", () => {
  function buttons(texts: SoulConfirmTexts): WireButton[] {
    return buildSoulConfirmRow(texts, PROPOSAL.id).toJSON().components as WireButton[];
  }

  it("renders 是 (Primary) and 不是 (Secondary), each carrying the proposal id", () => {
    const [yes, no] = buttons(TEXTS);
    expect(yes).toMatchObject({
      custom_id: "xbl:soul:yes:p-1",
      label: "是",
      style: ButtonStyle.Primary,
    });
    expect(no).toMatchObject({
      custom_id: "xbl:soul:no:p-1",
      label: "不是",
      style: ButtonStyle.Secondary,
    });
  });

  it("follows the user's UI language", () => {
    const [yes, no] = buttons(messages("en").soulConfirm);
    expect(yes?.label).toBe("Yes");
    expect(no?.label).toBe("No");
  });
});

describe("soulConfirmEdit", () => {
  it("replaces the text, removes the buttons, and keeps embeds suppressed", () => {
    const message = { client: { options: {} } } as unknown as Message;
    const body = MessagePayload.create(message, soulConfirmEdit("Settled.")).resolveBody().body as
      | (Omit<EditCall, "components"> & { components?: unknown[] })
      | null
      | undefined;
    if (body === null || body === undefined) throw new Error("discord.js built no edit body");
    expect(body.content).toBe("Settled.");
    expect(body.flags).toBe(MessageFlags.SuppressEmbeds);
    expect(body.components).toEqual([]);
  });
});

describe("renderSoulConfirmation", () => {
  it("asks the question, shows the change, and says when it takes effect", () => {
    const card = renderSoulConfirmation(TEXTS, PROPOSAL);
    expect(card).toBe(
      [
        "确实要更新本服务器的助手人设（soul）吗？",
        "",
        "变更摘要：Calm down the tone.",
        "",
        TEXTS.footer,
      ].join("\n"),
    );
  });

  it("still renders when the model gave no summary", () => {
    const card = renderSoulConfirmation(TEXTS, { ...PROPOSAL, summary: "  " });
    expect(card).toContain(TEXTS.header);
    expect(card).not.toContain("变更摘要：");
    expect(card.endsWith(TEXTS.footer)).toBe(true);
  });
});

describe("postSoulConfirmation", () => {
  it("posts the card with suppressed embeds and both buttons, and tracks it by proposal id", async () => {
    vi.useFakeTimers();
    const registry = new SoulConfirmRegistry();
    const { channel, sent } = fakeChannel([]);

    await postSoulConfirmation(channel, OWNER, PROPOSAL, TEXTS, registry);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.content).toContain(TEXTS.header);
    expect(sent[0]?.content).toContain("变更摘要：Calm down the tone.");
    expect(sent[0]?.flags).toBe(MessageFlags.SuppressEmbeds);
    expect(sent[0]?.components[0]?.toJSON().components.map((button) => button.custom_id)).toEqual([
      "xbl:soul:yes:p-1",
      "xbl:soul:no:p-1",
    ]);
    expect(registry.get(PROPOSAL.id)).toMatchObject({
      userId: OWNER,
      messageId: CARD,
      proposal: PROPOSAL,
      busy: false,
    });
  });

  it("untracks the proposal when the card cannot be posted", async () => {
    const registry = new SoulConfirmRegistry();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await postSoulConfirmation(fakeChannel([], true).channel, OWNER, PROPOSAL, TEXTS, registry);

    expect(registry.get(PROPOSAL.id)).toBeUndefined();
  });

  it("retires the card once the window passes, and later clicks fail closed", async () => {
    vi.useFakeTimers();
    const calls = stubWorker();
    const registry = new SoulConfirmRegistry();
    const cardEdits: MessageEditOptions[] = [];
    const { channel } = fakeChannel(cardEdits);
    await postSoulConfirmation(channel, OWNER, PROPOSAL, TEXTS, registry);

    await vi.advanceTimersByTimeAsync(SOUL_CONFIRM_WINDOW_MS - 1);
    expect(cardEdits).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(cardEdits.map(asEdit)).toEqual([
      { content: TEXTS.expired, components: [], flags: MessageFlags.SuppressEmbeds },
    ]);
    expect(registry.get(PROPOSAL.id)).toBeUndefined();

    const late = click(soulCustomId("yes", PROPOSAL.id));
    await handleSoulConfirmInteraction(late.interaction, env, registry);
    expect(applyCalls(calls)).toEqual([]);
    expect(late.reply).toHaveBeenCalledWith({
      content: TEXTS.expiredNotice,
      flags: MessageFlags.Ephemeral,
    });
  });

  it("leaves the card alone while its window is open", async () => {
    vi.useFakeTimers();
    const registry = new SoulConfirmRegistry();
    const cardEdits: MessageEditOptions[] = [];
    await postSoulConfirmation(fakeChannel(cardEdits).channel, OWNER, PROPOSAL, TEXTS, registry);

    await vi.advanceTimersByTimeAsync(SOUL_CONFIRM_WINDOW_MS - 1);

    expect(registry.get(PROPOSAL.id)).toBeDefined();
    expect(cardEdits).toEqual([]);
  });
});

describe("resolveSoulConfirmAction", () => {
  function entry(overrides: Partial<SoulConfirmEntry> = {}): SoulConfirmEntry {
    return {
      userId: OWNER,
      messageId: CARD,
      proposal: PROPOSAL,
      texts: TEXTS,
      busy: false,
      timer: undefined,
      ...overrides,
    };
  }

  it("maps the owner's 是 and 不是 to their actions", () => {
    expect(resolveSoulConfirmAction(entry(), "xbl:soul:yes:p-1", CARD, OWNER)).toEqual({
      action: "confirm",
    });
    expect(resolveSoulConfirmAction(entry(), "xbl:soul:no:p-1", CARD, OWNER)).toEqual({
      action: "cancel",
    });
  });

  it("refuses anyone but the owner, on either button", () => {
    for (const customId of ["xbl:soul:yes:p-1", "xbl:soul:no:p-1"]) {
      expect(resolveSoulConfirmAction(entry(), customId, CARD, "someone-else")).toEqual({
        action: "rejected",
        reason: "not-owner",
      });
    }
  });

  it("refuses clicks while the confirmed apply is in flight", () => {
    const busy = entry({ busy: true });
    expect(resolveSoulConfirmAction(busy, "xbl:soul:yes:p-1", CARD, OWNER)).toEqual({
      action: "rejected",
      reason: "busy",
    });
    expect(resolveSoulConfirmAction(busy, "xbl:soul:no:p-1", CARD, OWNER)).toEqual({
      action: "rejected",
      reason: "busy",
    });
  });

  it("expires cards this process cannot vouch for", () => {
    const expired = { action: "rejected", reason: "expired" };
    // Unknown proposal: restart, registry eviction, or already settled.
    expect(resolveSoulConfirmAction(undefined, "xbl:soul:yes:p-1", CARD, OWNER)).toEqual(expired);
    // A button fired on a message other than its own card.
    expect(resolveSoulConfirmAction(entry(), "xbl:soul:yes:p-1", "other-message", OWNER)).toEqual(
      expired,
    );
    // A card whose send has not resolved yet has no message to vouch for it.
    expect(
      resolveSoulConfirmAction(entry({ messageId: null }), "xbl:soul:yes:p-1", CARD, OWNER),
    ).toEqual(expired);
    // A family customId that cannot be parsed.
    expect(resolveSoulConfirmAction(entry(), "xbl:soul:yes", CARD, OWNER)).toEqual(expired);
  });

  it("ignores customIds of another button family", () => {
    expect(resolveSoulConfirmAction(entry(), "xbl:regen:p-1", CARD, OWNER)).toBeNull();
    expect(resolveSoulConfirmAction(undefined, "xbl:del:p-1", CARD, OWNER)).toBeNull();
  });
});

describe("SoulConfirmRegistry", () => {
  function entry(id: string): SoulConfirmEntry {
    return {
      userId: OWNER,
      messageId: CARD,
      proposal: { ...PROPOSAL, id },
      texts: TEXTS,
      busy: false,
      timer: undefined,
    };
  }

  it("registers, looks up, and removes entries by proposal id", () => {
    const registry = new SoulConfirmRegistry();
    registry.register("p1", entry("p1"));
    expect(registry.get("p1")?.proposal.id).toBe("p1");
    registry.remove("p1");
    expect(registry.get("p1")).toBeUndefined();
  });

  it("evicts the oldest entry beyond the cap", () => {
    const registry = new SoulConfirmRegistry();
    for (let i = 0; i < 129; i++) {
      registry.register(`p${i}`, entry(`p${i}`));
    }
    expect(registry.get("p0")).toBeUndefined();
    expect(registry.get("p1")?.proposal.id).toBe("p1");
    expect(registry.get("p128")?.proposal.id).toBe("p128");
  });

  it("an evicted card fails closed at once, and is still retired when its window ends", async () => {
    vi.useFakeTimers();
    const calls = stubWorker();
    const registry = new SoulConfirmRegistry();
    const cardEdits: MessageEditOptions[] = [];
    await postSoulConfirmation(fakeChannel(cardEdits).channel, OWNER, PROPOSAL, TEXTS, registry);
    // 128 newer confirmations push the card's entry out of the registry.
    for (let i = 0; i < 128; i++) {
      registry.register(`newer-${i}`, entry(`newer-${i}`));
    }

    const evicted = click(soulCustomId("yes", PROPOSAL.id));
    await handleSoulConfirmInteraction(evicted.interaction, env, registry);
    expect(applyCalls(calls)).toEqual([]);
    expect(evicted.reply).toHaveBeenCalledWith({
      content: TEXTS.expiredNotice,
      flags: MessageFlags.Ephemeral,
    });

    await vi.advanceTimersByTimeAsync(SOUL_CONFIRM_WINDOW_MS);
    expect(cardEdits.map(asEdit)).toEqual([
      { content: TEXTS.expired, components: [], flags: MessageFlags.SuppressEmbeds },
    ]);
  });
});

describe("handleSoulConfirmInteraction", () => {
  it("applies the proposal on 是 and retires the card with the success text", async () => {
    vi.useFakeTimers();
    const calls = stubWorker({ apply: okApply });
    const registry = await postedRegistry();
    const yes = click(soulCustomId("yes", PROPOSAL.id));

    await handleSoulConfirmInteraction(yes.interaction, env, registry);

    expect(applyCalls(calls)).toEqual([
      {
        url: "https://worker/internal/v1/soul/apply",
        body: { proposal: PROPOSAL, updatedBy: OWNER },
      },
    ]);
    expect(yes.deferUpdate).toHaveBeenCalledTimes(1);
    expect(yes.reply).not.toHaveBeenCalled();
    expect(yes.edits.map(asEdit)).toEqual([
      { content: TEXTS.applied, components: [], flags: MessageFlags.SuppressEmbeds },
    ]);
    expect(registry.get(PROPOSAL.id)).toBeUndefined();
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
    const registry = await postedRegistry();
    const yes = click(soulCustomId("yes", PROPOSAL.id));
    yes.deferUpdate.mockImplementation(async () => {
      order.push("acknowledge");
    });

    await handleSoulConfirmInteraction(yes.interaction, env, registry);

    expect(order).toEqual(["acknowledge", "apply"]);
    expect(applyCalls(calls)).toHaveLength(1);
  });

  it("drops the proposal on 不是 without calling the Worker", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<() => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);
    const registry = await postedRegistry();
    const no = click(soulCustomId("no", PROPOSAL.id));

    await handleSoulConfirmInteraction(no.interaction, env, registry);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(no.deferUpdate).toHaveBeenCalledTimes(1);
    expect(no.edits.map(asEdit)).toEqual([
      { content: TEXTS.cancelled, components: [], flags: MessageFlags.SuppressEmbeds },
    ]);
    expect(registry.get(PROPOSAL.id)).toBeUndefined();
  });

  it.each([
    [
      "the Worker rejects the proposal",
      async () => Response.json({ status: "error", code: "soul_apply_failed" }),
    ],
    [
      "the Worker cannot be reached",
      async () => {
        throw new Error("Worker request failed");
      },
    ],
  ])("shows the failure text and forgets the card when %s", async (_case, apply) => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    stubWorker({ apply });
    const registry = await postedRegistry();
    const yes = click(soulCustomId("yes", PROPOSAL.id));

    await handleSoulConfirmInteraction(yes.interaction, env, registry);

    expect(yes.edits.map(asEdit)).toEqual([
      { content: TEXTS.failed, components: [], flags: MessageFlags.SuppressEmbeds },
    ]);
    expect(registry.get(PROPOSAL.id)).toBeUndefined();
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
    const registry = await postedRegistry();
    const first = click(soulCustomId("yes", PROPOSAL.id));

    const run = handleSoulConfirmInteraction(first.interaction, env, registry);
    await vi.waitFor(() => expect(applyCalls(calls)).toHaveLength(1));

    const second = click(soulCustomId("yes", PROPOSAL.id));
    await handleSoulConfirmInteraction(second.interaction, env, registry);
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
    expect(first.edits.map(asEdit)).toEqual([
      { content: TEXTS.applied, components: [], flags: MessageFlags.SuppressEmbeds },
    ]);
  });

  it("refuses anyone but the owner, leaving the card pending", async () => {
    vi.useFakeTimers();
    const calls = stubWorker();
    const registry = await postedRegistry();
    const stranger = click(soulCustomId("yes", PROPOSAL.id), { userId: "someone-else" });

    await handleSoulConfirmInteraction(stranger.interaction, env, registry);

    expect(stranger.reply).toHaveBeenCalledWith({
      content: TEXTS.notOwner,
      flags: MessageFlags.Ephemeral,
    });
    expect(stranger.deferUpdate).not.toHaveBeenCalled();
    expect(applyCalls(calls)).toEqual([]);
    expect(stranger.edits).toEqual([]);
    expect(registry.get(PROPOSAL.id)).toBeDefined();
  });

  it("renders a refusal in the clicker's own language", async () => {
    vi.useFakeTimers();
    stubWorker({ language: "en" });
    const registry = await postedRegistry();
    const stranger = click(soulCustomId("no", PROPOSAL.id), { userId: "someone-else" });

    await handleSoulConfirmInteraction(stranger.interaction, env, registry);

    expect(stranger.reply).toHaveBeenCalledWith({
      content: messages("en").soulConfirm.notOwner,
      flags: MessageFlags.Ephemeral,
    });
  });

  it("fails closed after a restart: an unknown proposal gets an ephemeral notice and nothing else", async () => {
    vi.useFakeTimers();
    const calls = stubWorker({ apply: okApply });
    const registry = new SoulConfirmRegistry();
    const yes = click(soulCustomId("yes", PROPOSAL.id));

    await handleSoulConfirmInteraction(yes.interaction, env, registry);

    expect(yes.reply).toHaveBeenCalledWith({
      content: TEXTS.expiredNotice,
      flags: MessageFlags.Ephemeral,
    });
    expect(yes.deferUpdate).not.toHaveBeenCalled();
    expect(yes.edits).toEqual([]);
    expect(applyCalls(calls)).toEqual([]);
  });

  it("fails closed for a soul-family button it cannot parse", async () => {
    vi.useFakeTimers();
    const calls = stubWorker({ apply: okApply });
    const registry = await postedRegistry();
    const stray = click("xbl:soul:yes");

    await handleSoulConfirmInteraction(stray.interaction, env, registry);

    expect(stray.reply).toHaveBeenCalledWith({
      content: TEXTS.expiredNotice,
      flags: MessageFlags.Ephemeral,
    });
    expect(applyCalls(calls)).toEqual([]);
    expect(stray.edits).toEqual([]);
    expect(registry.get(PROPOSAL.id)).toBeDefined();
  });

  it("no longer touches a settled card when its window would have ended", async () => {
    vi.useFakeTimers();
    stubWorker({ apply: okApply });
    const registry = await postedRegistry();
    const yes = click(soulCustomId("yes", PROPOSAL.id));
    await handleSoulConfirmInteraction(yes.interaction, env, registry);

    await vi.advanceTimersByTimeAsync(SOUL_CONFIRM_WINDOW_MS + 1);

    expect(yes.edits.map(asEdit)).toEqual([
      { content: TEXTS.applied, components: [], flags: MessageFlags.SuppressEmbeds },
    ]);
  });
});
