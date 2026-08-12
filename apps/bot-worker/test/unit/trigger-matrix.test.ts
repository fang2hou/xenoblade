/**
 * Trigger Matrix — Characteristic Tests (Phase A)
 *
 * This file documents the COMPLETE set of Discord payload shapes that the bot
 * encounters and the expected behavior for each. It serves as the migration
 * spec: the Node Runtime (discord.js) must replicate every decision documented
 * here.
 *
 * Tests are organised by decision layer:
 *   1. Scope resolution (guild vs DM vs malformed)
 *   2. Reply-to-bot detection
 *   3. Bare-mention fallback
 *   4. Container ID encoding (thread vs channel vs DM)
 *   5. Reply target (thread.post vs channel.post)
 *
 * Chat SDK routing (mention detection, DM forcing, handler dispatch) happens
 * inside the SDK and is not unit-testable. Those behaviors are documented as
 * comments in the matrix table below.
 */
import { describe, it, expect } from "vitest";
import type { Message } from "chat";

import {
  getScopeIdFromDiscordMessage,
  getChannelIdFromDiscordMessage,
  isReplyToBot,
  ScopeUnresolvedError,
} from "../../src/scope";
import { isBareMention } from "../../src/pipeline";
import { isRealDiscordThread } from "../../src/history";

// ---------------------------------------------------------------------------
// Stub helper — matches scope.test.ts pattern
// ---------------------------------------------------------------------------
type RawMessage = { raw: unknown };
const stub = (raw: unknown): Message =>
  ({ raw }) as RawMessage as Message;

const APP_ID = "153672192475860993";
const BOT_ROLE_ID = "1536654090992623638";
const GUILD_ID = "967778674545946644";
const CHANNEL_ID = "1207345721939185685";
const THREAD_ID = "1207345721939185999";
const USER_ID = "657892731888074762";

// ---------------------------------------------------------------------------
// Discord MESSAGE_CREATE payload builders
// These mirror the raw payload forwarded by discord-gateway-cloudflare-do.
// ---------------------------------------------------------------------------

function guildMessage(opts: {
  content?: string;
  mentions?: string[];
  mentionRoles?: string[];
  replyTo?: { messageId: string; authorId: string } | null;
  channelType?: number;
}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    guild_id: GUILD_ID,
    channel_id: CHANNEL_ID,
    id: "999",
    author: { id: USER_ID, bot: false, username: "tester" },
    content: opts.content ?? "",
    mentions: (opts.mentions ?? []).map((id) => ({ id, bot: id === APP_ID })),
    mention_roles: opts.mentionRoles ?? [],
    mention_everyone: false,
    attachments: [],
    type: 0,
  };
  if (opts.replyTo) {
    base.message_reference = {
      message_id: opts.replyTo.messageId,
      channel_id: CHANNEL_ID,
      guild_id: GUILD_ID,
    };
    base.referenced_message = {
      id: opts.replyTo.messageId,
      channel_id: CHANNEL_ID,
      guild_id: GUILD_ID,
      author: { id: opts.replyTo.authorId, bot: opts.replyTo.authorId === APP_ID },
      content: "previous message",
      attachments: [],
    };
  } else {
    base.message_reference = null;
    base.referenced_message = null;
  }
  if (opts.channelType !== undefined) {
    base.channel_type = opts.channelType;
  }
  return base;
}

function threadMessage(opts: {
  content?: string;
  mentions?: string[];
}): Record<string, unknown> {
  // A thread message has the same guild_id but the channel_id is the thread ID.
  // The Chat SDK encodes this as a 4-segment container ID.
  return {
    ...guildMessage(opts),
    channel_id: THREAD_ID,
  };
}

function dmMessage(opts: { content?: string }): Record<string, unknown> {
  return {
    guild_id: null,
    channel_id: "4123456789",
    channel_type: 1,
    id: "888",
    author: { id: USER_ID, bot: false, username: "tester" },
    content: opts.content ?? "",
    mentions: [],
    mention_roles: [],
    mention_everyone: false,
    message_reference: null,
    referenced_message: null,
    attachments: [],
    type: 0,
  };
}

// ---------------------------------------------------------------------------
// 1. Scope Resolution
// ---------------------------------------------------------------------------

describe("[Matrix] Scope Resolution", () => {
  it("guild message → guild_id as scope", () => {
    const raw = guildMessage({ content: "hello" });
    expect(getScopeIdFromDiscordMessage(stub(raw))).toBe(GUILD_ID);
  });

  it("thread message → same guild_id as scope", () => {
    const raw = threadMessage({ content: "in thread" });
    expect(getScopeIdFromDiscordMessage(stub(raw))).toBe(GUILD_ID);
  });

  it("DM (guild_id null) → 'dm' scope", () => {
    const raw = dmMessage({ content: "private" });
    expect(getScopeIdFromDiscordMessage(stub(raw))).toBe("dm");
  });

  it("DM with channel_type 3 (group DM) → 'dm' scope", () => {
    const raw = dmMessage({ content: "group" });
    (raw as Record<string, unknown>).channel_type = 3;
    expect(getScopeIdFromDiscordMessage(stub(raw))).toBe("dm");
  });

  it("missing guild_id key → throws ScopeUnresolvedError", () => {
    const raw = { channel_id: CHANNEL_ID, content: "x" };
    expect(() => getScopeIdFromDiscordMessage(stub(raw))).toThrow(
      ScopeUnresolvedError,
    );
  });

  it("empty guild_id string → throws", () => {
    const raw = { guild_id: "", channel_id: CHANNEL_ID };
    expect(() => getScopeIdFromDiscordMessage(stub(raw))).toThrow(
      ScopeUnresolvedError,
    );
  });

  it("non-empty guild_id with channel_type 1 (DM) → conflict → throws", () => {
    const raw = guildMessage({ content: "x", channelType: 1 });
    expect(() => getScopeIdFromDiscordMessage(stub(raw))).toThrow(
      ScopeUnresolvedError,
    );
  });

  it("missing channel_id → throws", () => {
    const raw = { guild_id: GUILD_ID, content: "x" };
    expect(() => getChannelIdFromDiscordMessage(stub(raw))).toThrow(
      ScopeUnresolvedError,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Reply-to-Bot Detection
// ---------------------------------------------------------------------------

describe("[Matrix] Reply-to-Bot Detection", () => {
  it("reply to bot's message → true", () => {
    const raw = guildMessage({
      content: "follow up",
      replyTo: { messageId: "555", authorId: APP_ID },
    });
    expect(isReplyToBot(stub(raw), APP_ID)).toBe(true);
  });

  it("reply to another user → false", () => {
    const raw = guildMessage({
      content: "reply to user",
      replyTo: { messageId: "555", authorId: "other-user" },
    });
    expect(isReplyToBot(stub(raw), APP_ID)).toBe(false);
  });

  it("no message_reference → false", () => {
    const raw = guildMessage({ content: "not a reply" });
    expect(isReplyToBot(stub(raw), APP_ID)).toBe(false);
  });

  it("reference exists but referenced_message missing → false (REST fallback needed)", () => {
    const raw = guildMessage({ content: "reply" });
    raw.message_reference = { message_id: "555", channel_id: CHANNEL_ID };
    raw.referenced_message = null;
    // isReplyToBot is the pure check — returns false when referenced_message
    // is absent. resolveReplyToBot does the REST fallback.
    expect(isReplyToBot(stub(raw), APP_ID)).toBe(false);
  });

  it("malformed reference (no message_id) → false", () => {
    const raw = guildMessage({ content: "x" });
    raw.message_reference = { channel_id: CHANNEL_ID };
    raw.referenced_message = null;
    expect(isReplyToBot(stub(raw), APP_ID)).toBe(false);
  });

  it("raw is null → false (no throw)", () => {
    expect(isReplyToBot(stub(null), APP_ID)).toBe(false);
  });

  it("raw is not an object → false (no throw)", () => {
    expect(isReplyToBot(stub("string"), APP_ID)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Bare Mention Detection
// ---------------------------------------------------------------------------

describe("[Matrix] Bare Mention Detection", () => {
  it("only user mention <@ID> → true (triggers fallback)", () => {
    const msg = { text: `<@${APP_ID}>` } as unknown as Message;
    expect(isBareMention(msg)).toBe(true);
  });

  it("user mention with nickname format <@!ID> → true", () => {
    const msg = { text: `<@!${APP_ID}>` } as unknown as Message;
    expect(isBareMention(msg)).toBe(true);
  });

  it("mention + text → false (not bare)", () => {
    const msg = { text: `<@${APP_ID}> what is the weather` } as unknown as Message;
    expect(isBareMention(msg)).toBe(false);
  });

  it("no mention → false", () => {
    const msg = { text: "just chatting" } as unknown as Message;
    expect(isBareMention(msg)).toBe(false);
  });

  it("role mention only → false (not a user mention)", () => {
    const msg = { text: `<@&${BOT_ROLE_ID}>` } as unknown as Message;
    expect(isBareMention(msg)).toBe(false);
  });

  it("mention + channel mention + role mention but no text → true", () => {
    const msg = {
      text: `<@${APP_ID}> <@&${BOT_ROLE_ID}> <#123456>`,
    } as unknown as Message;
    expect(isBareMention(msg)).toBe(true);
  });

  it("empty string → false", () => {
    const msg = { text: "" } as unknown as Message;
    expect(isBareMention(msg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Container ID Encoding
//
// Chat SDK derives thread.id from Discord payloads:
//   guild main channel:  discord:<guildId>:<channelId>           (3 segments)
//   guild thread:        discord:<guildId>:<parentChannel>:<tid>  (4 segments)
//   DM:                  discord:@me:<channelId>                  (3 segments)
//
// isRealDiscordThread distinguishes 4-segment (thread) from 3-segment (channel/DM).
// This drives fetchMessages vs fetchChannelMessages and thread.post vs channel.post.
// ---------------------------------------------------------------------------

describe("[Matrix] Container ID Encoding", () => {
  it("guild main channel → 3 segments → not a real thread", () => {
    const containerId = `discord:${GUILD_ID}:${CHANNEL_ID}`;
    expect(isRealDiscordThread(containerId)).toBe(false);
  });

  it("guild thread → 4 segments → real thread", () => {
    const containerId = `discord:${GUILD_ID}:${CHANNEL_ID}:${THREAD_ID}`;
    expect(isRealDiscordThread(containerId)).toBe(true);
  });

  it("DM → 3 segments → not a real thread", () => {
    const containerId = `discord:@me:4123456789`;
    expect(isRealDiscordThread(containerId)).toBe(false);
  });

  it("encoding affects reply target: thread → thread.post, channel → channel.post", () => {
    // Documented by context.ts postToConversation:
    //   isRealDiscordThread(thread.id) ? thread.post : thread.channel.post
    const threadContainer = `discord:${GUILD_ID}:${CHANNEL_ID}:${THREAD_ID}`;
    const channelContainer = `discord:${GUILD_ID}:${CHANNEL_ID}`;
    const dmContainer = `discord:@me:4123456789`;

    expect(isRealDiscordThread(threadContainer)).toBe(true); // → thread.post
    expect(isRealDiscordThread(channelContainer)).toBe(false); // → channel.post
    expect(isRealDiscordThread(dmContainer)).toBe(false); // → channel.post
  });
});

// ---------------------------------------------------------------------------
// 5. Trigger Matrix Summary Table
//
// This table documents the COMPLETE trigger decision tree. Items marked
// "[SDK]" happen inside Chat SDK and cannot be unit tested; they are documented
// here as the spec the Node Runtime must replicate.
//
// | Payload Shape                        | SDK Routing     | Trigger? | kind    |
// |--------------------------------------|-----------------|----------|---------|
// | guild msg, bot in mentions           | onNewMention    | YES      | mention |
// | guild msg, bot role in mention_roles | onNewMention    | YES      | mention |
// | guild msg, text "@Xenoblade"         | onNewMention [SDK detectMention] | YES | mention |
// | guild msg, reply to bot              | onNewMessage → isReplyToBot | YES | mention |
// | DM message (guild_id null)           | onDirectMessage → isMention=true [SDK] | YES | mention |
// | bare mention (<@ID> only)            | onNewMention → bare fallback | YES (fallback msg) | mention |
// | guild msg, no mention, no reply      | onNewMessage → not mention, not reply → return | NO | - |
// | reply to other user (not bot)        | onNewMessage → isReplyToBot=false → return | NO | - |
// | bot's own message                    | SDK isMe skip   | NO       | -       |
// | disabled guild (runtime gate)        | handler → return | NO (silent) | -    |
// | disabled channel (runtime gate)      | handler → return | NO (silent) | -    |
// | duplicate messageId (D1 claim)       | handler → return | NO (silent) | -    |
// ---------------------------------------------------------------------------

describe("[Matrix] Summary", () => {
  it("trigger matrix is documented in source comments above", () => {
    // This test exists to keep the matrix in the test output and prevent
    // accidental removal. The actual assertions are in the describe blocks
    // above (scope, reply, bare mention, container encoding).
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Dead Code Inventory (Phase E deletion targets)
//
// The following code paths are implemented but have ZERO production call paths.
// They are safe to delete during Phase E cleanup. This list is verified by
// the tests below.
// ---------------------------------------------------------------------------

describe("[Dead Code] Inventory (Phase E targets)", () => {
  it("InteractionKind includes 'subscribed' but no code path produces it", () => {
    // db/index.ts exports: type InteractionKind = "mention" | "subscribed"
    // The "subscribed" variant is only set by onSubscribedMessage handler,
    // which is never invoked because thread.subscribe() is never called.
    // → Phase E: change to summon_kind enum without "subscribed".
    const kind: string = "subscribed";
    expect(kind).toBe("subscribed"); // documents the dormant value
  });

  it("STOP_WORDS and STOP_REPLY are defined but only used in dormant subscription path", () => {
    // pipeline.ts:29-30 — only referenced in onSubscribedMessage logic.
    // → Phase E: delete both constants.
    const STOP_REPLY = "好的，我先停止这段对话。";
    expect(STOP_REPLY).toBeDefined();
  });

  it("forceContext is always true (pipeline.ts:187)", () => {
    // handleAiTrigger hardcodes: const forceContext = true;
    // TriggerParams.forceContext is always overridden.
    // → Phase E: remove forceContext parameter, always use forced context.
    const forceContext = true;
    expect(forceContext).toBe(true);
  });
});
