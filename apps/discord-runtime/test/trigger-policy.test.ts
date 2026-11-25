import { describe, expect, it, vi, type Mock } from "vitest";
import type { Message } from "discord.js";

import { evaluateThreadTrigger, evaluateTrigger, isBareMention } from "../src/trigger-policy";

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
    /** The message mentions the bot. */
    mentionsBot?: boolean;
    /** The message replies to one of the bot's messages. */
    repliesBot?: boolean;
    /** The message mentions a watched role. */
    mentionsRole?: string;
    /** Earlier messages of the same channel, newest first. */
    prior?: Array<{ id: string; authorId: string; bot: boolean }>;
  } = {},
): Message {
  const users = new Map<string, { id: string }>();
  if (options.mentionsBot) users.set(BOT, { id: BOT });
  const roles = new Map<string, { id: string }>();
  if (options.mentionsRole !== undefined)
    roles.set(options.mentionsRole, { id: options.mentionsRole });
  const prior = (options.prior ?? []).map(
    (message): [string, { id: string; author: { id: string; bot: boolean } }] => [
      message.id,
      { id: message.id, author: { id: message.authorId, bot: message.bot } },
    ],
  );
  const message = {
    id: "m1",
    content: options.content ?? "",
    author: { id: options.authorId ?? OWNER, bot: options.bot ?? false },
    webhookId: options.webhookId ?? null,
    mentions: { users, roles, repliedUser: options.repliesBot ? { id: BOT } : null },
    reference: options.repliesBot ? { messageId: "bot-message", channelId: "t1" } : null,
    channel: { id: "t1", messages: { fetch: async () => new Map(prior) } },
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
});
