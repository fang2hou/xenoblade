import { describe, expect, it, vi, type Mock } from "vitest";
import { MessageReferenceType, MessageType, type Message } from "discord.js";

import {
  evaluateThreadTrigger,
  evaluateTrigger,
  hasLeadingOtherMention,
  isBareMention,
} from "../src/trigger-policy";

const BOT = "123";
const OWNER = "u1";

/** Whether the bot follows the thread of every message in a test. */
type IsFollowed = (threadId: string) => Promise<boolean>;

/** A message as the summon matrix reads it. */
function fakeMessage(
  options: {
    content?: string;
    authorId?: string;
    bot?: boolean;
    webhookId?: string | null;
    type?: MessageType;
    /** The message mentions the bot. */
    mentionsBot?: boolean;
    /** Other user ids mentioned in the message. */
    mentionsUsers?: string[];
    /** The message replies to one of the bot's messages. */
    repliesBot?: boolean;
    /** Author id of the replied-to message (when simulating a reply to any user). */
    repliedUserId?: string | null;
    /** Explicit message reference override (e.g. reply without repliedUser hint, or Forward). */
    reference?: { messageId: string; channelId?: string; type?: MessageReferenceType } | null;
    /** Referenced message returned when `channel.messages.fetch(id)` is called. */
    referencedMessage?: { id: string; author: { id: string; bot: boolean } } | null;
    /** Optional spy invoked whenever `channel.messages.fetch` is called. */
    onFetch?: () => void;
    /** The message mentions a watched role. */
    mentionsRole?: string;
    /** Earlier messages of the same channel, newest first. */
    prior?: Array<{ id: string; authorId: string; bot: boolean }>;
  } = {},
): Message {
  const users = new Map<string, { id: string }>();
  if (options.mentionsBot) users.set(BOT, { id: BOT });
  for (const id of options.mentionsUsers ?? []) users.set(id, { id });
  const roles = new Map<string, { id: string }>();
  if (options.mentionsRole !== undefined)
    roles.set(options.mentionsRole, { id: options.mentionsRole });
  const prior = (options.prior ?? []).map(
    (message): [string, { id: string; author: { id: string; bot: boolean } }] => [
      message.id,
      { id: message.id, author: { id: message.authorId, bot: message.bot } },
    ],
  );
  const repliedUser =
    options.repliedUserId !== undefined
      ? options.repliedUserId === null
        ? null
        : { id: options.repliedUserId }
      : options.repliesBot
        ? { id: BOT }
        : null;
  const reference =
    options.reference !== undefined
      ? options.reference
      : repliedUser !== null
        ? { messageId: "ref-message", channelId: "t1", type: MessageReferenceType.Default }
        : null;
  const fetch = vi.fn<(arg: unknown) => Promise<unknown>>(async (arg) => {
    options.onFetch?.();
    if (typeof arg === "string") {
      if (options.referencedMessage === null) throw new Error("Unknown Message");
      return options.referencedMessage;
    }
    return new Map(prior);
  });
  const message = {
    id: "m1",
    content: options.content ?? "",
    type: options.type,
    author: { id: options.authorId ?? OWNER, bot: options.bot ?? false },
    webhookId: options.webhookId ?? null,
    mentions: { users, roles, repliedUser },
    reference,
    channel: { id: "t1", messages: { fetch } },
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double standing in for a discord.js Message
  return message as unknown as Message;
}

/** Whether the bot follows the thread of every message in a test. */
function followed(active: boolean): { isFollowed: Mock<IsFollowed> } {
  const isFollowed = vi.fn<IsFollowed>(async () => active);
  return { isFollowed };
}

describe("evaluateTrigger", () => {
  it("answers a direct mention, a watched role, and a reply to the bot", async () => {
    expect(
      await evaluateTrigger(fakeMessage({ mentionsBot: true, content: `<@${BOT}> hi` }), BOT, []),
    ).toEqual({
      kind: "user-mention",
    });
    expect(
      await evaluateTrigger(
        fakeMessage({ content: "<@&r9> deploy help", mentionsRole: "r9" }),
        BOT,
        ["r9"],
      ),
    ).toEqual({
      kind: "role-mention",
    });
    expect(
      await evaluateTrigger(fakeMessage({ repliesBot: true, content: "and now?" }), BOT, []),
    ).toEqual({
      kind: "reply-to-bot",
    });
  });

  it("ignores ordinary chat, other roles, and replies to other members", async () => {
    expect(await evaluateTrigger(fakeMessage({ content: "anyone around?" }), BOT, [])).toBeNull();
    expect(await evaluateTrigger(fakeMessage({ content: "<@&r9> hi" }), BOT, ["r1"])).toBeNull();
    expect(await evaluateTrigger(fakeMessage({ content: "lol" }), BOT, [])).toBeNull();
  });

  it("never triggers on a bot's or a webhook's message, whatever it says", async () => {
    expect(
      await evaluateTrigger(fakeMessage({ bot: true, mentionsBot: true }), BOT, []),
    ).toBeNull();
    expect(
      await evaluateTrigger(fakeMessage({ webhookId: "w1", mentionsBot: true }), BOT, []),
    ).toBeNull();
  });

  it("still answers a bare mention when the user said nothing before it", async () => {
    expect(
      await evaluateTrigger(fakeMessage({ mentionsBot: true, content: `<@${BOT}>` }), BOT, []),
    ).toEqual({
      kind: "user-mention",
    });
  });
});

describe("isBareMention", () => {
  it("is true for a message made only of mention tokens", () => {
    expect(isBareMention("<@123>")).toBe(true);
    expect(isBareMention("  <@!123> <@&456> <#789> ")).toBe(true);
  });

  it("is false for a mention with words, and for a message without a user mention", () => {
    expect(isBareMention("<@123> hello")).toBe(false);
    expect(isBareMention("hello")).toBe(false);
    expect(isBareMention("<@&456>")).toBe(false);
    expect(isBareMention("")).toBe(false);
  });
});

describe("evaluateThreadTrigger", () => {
  it("answers an un-mentioned message in a thread the bot follows as thread-chat", async () => {
    const { isFollowed } = followed(true);

    const trigger = await evaluateThreadTrigger(
      fakeMessage({ content: "anyone tried it?" }),
      BOT,
      [],
      isFollowed,
    );

    expect(trigger).toEqual({ kind: "thread-chat" });
    expect(isFollowed).toHaveBeenCalledWith("t1");
  });

  it("ignores an un-mentioned message in a thread the bot does not follow", async () => {
    const { isFollowed } = followed(false);

    expect(
      await evaluateThreadTrigger(
        fakeMessage({ content: "anyone tried it?" }),
        BOT,
        [],
        isFollowed,
      ),
    ).toEqual({
      kind: "none",
    });
  });

  it("answers a mention in a thread without asking it to resume when the bot already follows it", async () => {
    const { isFollowed } = followed(true);

    const trigger = await evaluateThreadTrigger(
      fakeMessage({ mentionsBot: true, content: `<@${BOT}> and here?` }),
      BOT,
      [],
      isFollowed,
    );

    expect(trigger).toEqual({ kind: "summon", decision: { kind: "user-mention" }, resume: false });
  });

  it("answers a mention in a thread the bot had stopped following, and resumes it", async () => {
    const { isFollowed } = followed(false);

    const trigger = await evaluateThreadTrigger(
      fakeMessage({ mentionsBot: true, content: `<@${BOT}> pick this up again` }),
      BOT,
      [],
      isFollowed,
    );

    expect(trigger).toEqual({ kind: "summon", decision: { kind: "user-mention" }, resume: true });
  });

  it("resumes on a reply to the bot, which summons it as much as a mention does", async () => {
    const { isFollowed } = followed(false);

    const trigger = await evaluateThreadTrigger(
      fakeMessage({ repliesBot: true, content: "go on" }),
      BOT,
      [],
      isFollowed,
    );

    expect(trigger).toMatchObject({
      kind: "summon",
      resume: true,
      decision: { kind: "reply-to-bot" },
    });
  });

  it("never triggers on a bot's or a webhook's message, even in a followed thread", async () => {
    const { isFollowed } = followed(true);

    expect(
      await evaluateThreadTrigger(fakeMessage({ bot: true, content: "done" }), BOT, [], isFollowed),
    ).toEqual({
      kind: "none",
    });
    expect(
      await evaluateThreadTrigger(
        fakeMessage({ webhookId: "w1", content: "Deployed." }),
        BOT,
        [],
        isFollowed,
      ),
    ).toEqual({ kind: "none" });
    expect(isFollowed).not.toHaveBeenCalled();
  });

  it("keeps a bare mention's fallback message", async () => {
    const prior = [{ id: "m0", authorId: OWNER, bot: false }];
    const { isFollowed } = followed(true);

    const trigger = await evaluateThreadTrigger(
      fakeMessage({ mentionsBot: true, content: `<@${BOT}>`, prior }),
      BOT,
      [],
      isFollowed,
    );

    expect(trigger).toMatchObject({
      kind: "summon",
      decision: { kind: "user-mention", fallbackMessage: { id: "m0" } },
    });
  });

  it("skips a reply to another user in a followed thread without double-fetching", async () => {
    const { isFollowed } = followed(true);

    expect(
      await evaluateThreadTrigger(
        fakeMessage({ content: "agreed!", repliedUserId: "u2" }),
        BOT,
        [],
        isFollowed,
      ),
    ).toEqual({ kind: "skipped", reason: "reply-to-other" });

    // Without repliedUser hint, resolves author via one REST fetch.
    const onFetch = vi.fn<() => void>();
    const msg = fakeMessage({
      content: "makes sense",
      repliedUserId: null,
      reference: { messageId: "other-msg", type: MessageReferenceType.Default },
      referencedMessage: { id: "other-msg", author: { id: "u2", bot: false } },
      onFetch,
    });
    expect(await evaluateThreadTrigger(msg, BOT, [], isFollowed)).toEqual({
      kind: "skipped",
      reason: "reply-to-other",
    });
    expect(onFetch).toHaveBeenCalledTimes(1);
  });

  it("skips a reply whose target message was deleted or cannot be fetched", async () => {
    const { isFollowed } = followed(true);
    const msg = fakeMessage({
      content: "what about that?",
      repliedUserId: null,
      reference: { messageId: "deleted-msg", type: MessageReferenceType.Default },
      referencedMessage: null,
    });

    expect(await evaluateThreadTrigger(msg, BOT, [], isFollowed)).toEqual({
      kind: "skipped",
      reason: "reply-to-other",
    });
  });

  it("allows a self-reply and a forwarded message through as thread-chat", async () => {
    const { isFollowed } = followed(true);

    expect(
      await evaluateThreadTrigger(
        fakeMessage({ content: "adding context: Node 24", repliedUserId: OWNER }),
        BOT,
        [],
        isFollowed,
      ),
    ).toEqual({ kind: "thread-chat" });

    expect(
      await evaluateThreadTrigger(
        fakeMessage({
          content: "check this error",
          repliedUserId: null,
          reference: {
            messageId: "fwd-msg",
            channelId: "other-ch",
            type: MessageReferenceType.Forward,
          },
        }),
        BOT,
        [],
        isFollowed,
      ),
    ).toEqual({ kind: "thread-chat" });
  });

  it("still summons when replying to another user while explicitly mentioning the bot", async () => {
    const { isFollowed } = followed(true);

    expect(
      await evaluateThreadTrigger(
        fakeMessage({
          content: `<@${BOT}> is she right?`,
          mentionsBot: true,
          repliedUserId: "u2",
        }),
        BOT,
        [],
        isFollowed,
      ),
    ).toEqual({ kind: "summon", decision: { kind: "user-mention" }, resume: false });
  });

  it("skips messages starting with @other, @non-watched-role, @everyone, or @here", async () => {
    const { isFollowed } = followed(true);

    for (const content of [
      "<@999> what do you think?",
      "  <@!999> <@888>, take a look",
      "<@&777> heads up",
      "@everyone meeting in 5",
      "@here anyone free?",
    ]) {
      expect(
        await evaluateThreadTrigger(fakeMessage({ content }), BOT, ["r9"], isFollowed),
      ).toEqual({ kind: "skipped", reason: "leading-mention" });
    }
  });

  it("allows mid-sentence mentions of other users and leading self-mentions through", async () => {
    const { isFollowed } = followed(true);

    expect(
      await evaluateThreadTrigger(
        fakeMessage({
          content: "帮我总结一下 <@999> 刚才说的方案",
          mentionsUsers: ["999"],
        }),
        BOT,
        [],
        isFollowed,
      ),
    ).toEqual({ kind: "thread-chat" });

    expect(
      await evaluateThreadTrigger(
        fakeMessage({ authorId: "111", content: "<@111> note to self" }),
        BOT,
        [],
        isFollowed,
      ),
    ).toEqual({ kind: "thread-chat" });
  });

  it("skips non-chat Discord system messages without querying session state", async () => {
    const { isFollowed } = followed(true);

    expect(
      await evaluateThreadTrigger(
        fakeMessage({ content: "renamed thread", type: MessageType.ChannelNameChange }),
        BOT,
        [],
        isFollowed,
      ),
    ).toEqual({ kind: "skipped", reason: "system-message" });
    expect(isFollowed).not.toHaveBeenCalled();
  });
});

describe("hasLeadingOtherMention", () => {
  it("distinguishes leading mentions from mid-sentence mentions", () => {
    expect(hasLeadingOtherMention("<@999> hi", "111", BOT, ["r9"])).toBe(true);
    expect(hasLeadingOtherMention("<@111> <@999> look", "111", BOT, ["r9"])).toBe(true);
    expect(hasLeadingOtherMention("<@&900> help", "111", BOT, ["900"])).toBe(false);
    expect(hasLeadingOtherMention("ask <@999> later", "111", BOT, ["r9"])).toBe(false);
    expect(hasLeadingOtherMention("email me at foo@here.com", "111", BOT, ["r9"])).toBe(false);
  });
});
