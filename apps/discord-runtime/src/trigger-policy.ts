import { MessageReferenceType, MessageType, type Message } from "discord.js";
import type { SummonKind } from "@xenoblade/contracts";

/** Outcome of evaluating a message against the summon matrix. */
export interface TriggerDecision {
  kind: SummonKind;
  /**
   * Set only for a bare mention (the message is just `<@botId>` with no other
   * content) when a recent prior message from the same user was found. The
   * caller should use this message's content as the trigger instead.
   */
  fallbackMessage?: Message;
}

/** Why Layer 1 deterministically skipped an un-summoned message in a followed thread. */
export type ThreadSkipReason = "reply-to-other" | "leading-mention" | "system-message";

/**
 * Whether a message is a user-authored chat message rather than a Discord
 * system event (thread rename, pin notice, member join). Test doubles that
 * omit `type` are treated as regular chat messages.
 */
function isChatMessage(message: Message): boolean {
  const type: MessageType | undefined = message.type;
  return type === undefined || type === MessageType.Default || type === MessageType.Reply;
}

/**
 * Whether `message.reference` represents a Discord reply rather than a
 * forwarded message (`MessageReferenceType.Forward`). Forwarding into a
 * thread shares material for discussion instead of addressing another user.
 */
function isReplyReference(message: Message): boolean {
  const reference = message.reference;
  if (!reference?.messageId) return false;
  return reference.type !== MessageReferenceType.Forward;
}

/**
 * Evaluate a Discord message against the summon matrix.
 *
 * Returns `null` for non-triggers (normal chat is ignored). Otherwise returns
 * the matching {@link SummonKind} and, for bare mentions, a fallback message.
 * Bot and webhook messages never trigger.
 *
 * Checks, in priority order:
 *  (a) direct user mention of the bot,
 *  (b) mention of a watched role,
 *  (c) a reply to one of the bot's messages.
 *
 * A bare mention — only `<@botId>` with no other text — falls back to the
 * user's most recent prior message in the same channel.
 *
 * Async because resolving a reply-to-bot may require one REST fetch when the
 * referenced message author is not already present in the payload.
 */
export async function evaluateTrigger(
  message: Message,
  botId: string,
  roleIds: readonly string[],
): Promise<TriggerDecision | null> {
  return evaluateTriggerInternal(message, botId, roleIds, undefined);
}

async function evaluateTriggerInternal(
  message: Message,
  botId: string,
  roleIds: readonly string[],
  knownReplyAuthorId: string | null | undefined,
): Promise<TriggerDecision | null> {
  // Never trigger on bot, webhook, or non-chat system messages.
  if (message.author.bot) return null;
  if (message.webhookId) return null;
  if (!isChatMessage(message)) return null;

  // (a) Direct user mention of the bot.
  if (message.mentions.users.has(botId)) {
    if (isBareMention(message.content)) {
      const fallback = await findLastUserMessage(message);
      if (fallback) {
        return { kind: "user-mention", fallbackMessage: fallback };
      }
    }
    return { kind: "user-mention" };
  }

  // (b) Mention of a watched role.
  if (roleIds.length > 0) {
    const mentionedRoles = message.mentions.roles;
    for (const roleId of roleIds) {
      if (mentionedRoles.has(roleId)) {
        return { kind: "role-mention" };
      }
    }
  }

  // (c) Reply to one of the bot's messages (never a forwarded message).
  if (isReplyReference(message)) {
    const replyAuthorId =
      knownReplyAuthorId !== undefined ? knownReplyAuthorId : await resolveReplyAuthorId(message);
    if (replyAuthorId === botId) {
      return { kind: "reply-to-bot" };
    }
  }

  return null;
}

/**
 * A message sent inside a thread resolves to one of four outcomes: nothing to
 * do (bot/webhook or unfollowed thread), deterministically skipped as
 * addressed to another participant in a followed thread, an explicit summon,
 * or ordinary chat in a thread the bot follows.
 */
export type ThreadTrigger =
  | { kind: "none" }
  | { kind: "skipped"; reason: ThreadSkipReason }
  | {
      kind: "summon";
      decision: TriggerDecision;
      /** True when the bot was not following the thread: the summon resumes it. */
      resume: boolean;
    }
  | { kind: "thread-chat" };

/**
 * Evaluate a message sent inside a thread.
 *
 * The summon matrix of {@link evaluateTrigger} comes first, so an explicit
 * summon is answered whether or not the bot follows the thread — and tells
 * the caller to resume following when it had stopped. In a followed thread,
 * an un-summoned message that is deterministically addressed to another user
 * (a reply to someone else, or a leading `@someone` / `@role` / `@everyone` /
 * `@here` mention) is skipped without unfollowing the thread; self-replies,
 * forwarded messages, and mid-sentence mentions pass through as `thread-chat`.
 * A bot's, webhook's, or non-chat system message never triggers.
 */
export async function evaluateThreadTrigger(
  message: Message,
  botId: string,
  roleIds: readonly string[],
  isFollowed: (threadId: string) => Promise<boolean>,
): Promise<ThreadTrigger> {
  // The follow covers what members say, not what posts itself: a bot's or a
  // webhook's message would otherwise answer itself in a followed thread.
  if (message.author.bot || message.webhookId) return { kind: "none" };
  if (!isChatMessage(message)) return { kind: "skipped", reason: "system-message" };

  // Resolve a reply's author at most once so explicit reply-to-bot and
  // Layer 1 reply-to-other never double-fetch the referenced message.
  const hasReply = isReplyReference(message);
  const needsReplyAuthor =
    hasReply &&
    !message.mentions.users.has(botId) &&
    !roleIds.some((roleId) => message.mentions.roles.has(roleId));
  const replyAuthorId = needsReplyAuthor ? await resolveReplyAuthorId(message) : undefined;

  const decision = await evaluateTriggerInternal(message, botId, roleIds, replyAuthorId);
  if (decision !== null) {
    return { kind: "summon", decision, resume: !(await isFollowed(message.channel.id)) };
  }

  if (!(await isFollowed(message.channel.id))) {
    return { kind: "none" };
  }

  // Layer 1 deterministic checks for followed threads:
  // 1. Reply to another user/bot (self-replies pass through as added context).
  if (hasReply && replyAuthorId !== message.author.id) {
    return { kind: "skipped", reason: "reply-to-other" };
  }

  // 2. Leading mention targeting another user, a non-watched role, or @everyone/@here.
  // Mid-sentence mentions (e.g. "summarize what @Alice said") pass through.
  if (hasLeadingOtherMention(message.content, message.author.id, botId, roleIds)) {
    return { kind: "skipped", reason: "leading-mention" };
  }

  return { kind: "thread-chat" };
}

/**
 * One leading mention token at the start of a message: `<@id>`, `<@!id>`,
 * `<@&roleId>`, or `@everyone` / `@here` followed by whitespace, punctuation,
 * or end of message.
 */
const LEADING_MENTION_TOKEN =
  /^(?:<@!?(\d+)>|<@&(\d+)>|@(everyone|here)(?=\s|$|[,.:;!?，。、：；！？]))/;

/** Separators allowed between multiple consecutive leading mentions (`@A @B`, `@A, @B`). */
const LEADING_MENTION_SEP = /^[\s,，、]+/;

/**
 * True when `content` opens with one or more mentions targeting someone other
 * than the author or the bot (and not a watched role). Mid-sentence mentions
 * return false because the user is talking *about* that person to the bot.
 */
export function hasLeadingOtherMention(
  content: string,
  authorId: string,
  botId: string,
  roleIds: readonly string[],
): boolean {
  let rest = content.trimStart();
  let sawOther = false;

  while (rest.length > 0) {
    const match = LEADING_MENTION_TOKEN.exec(rest);
    if (match === null) break;

    const userId = match[1];
    const roleId = match[2];
    const broadcast = match[3];

    if (userId !== undefined) {
      if (userId !== authorId && userId !== botId) sawOther = true;
    } else if (roleId !== undefined) {
      if (!roleIds.includes(roleId)) sawOther = true;
    } else if (broadcast !== undefined) {
      sawOther = true;
    }

    rest = rest.slice(match[0].length);
    const sep = LEADING_MENTION_SEP.exec(rest);
    if (sep === null) break;
    rest = rest.slice(sep[0].length);
  }

  return sawOther;
}

/**
 * A bare mention is a message whose text is only mention tokens
 * (`<@123>`, `<@&role>`, `<#channel>`) with nothing else. The bot then reads
 * the user's most recent prior message instead. Ported from the bot-worker
 * `isBareMention`.
 */
export function isBareMention(content: string): boolean {
  if (!/<@!?\d+>/.test(content)) return false;
  const stripped = content
    .replace(/<@!?\d+>/g, "")
    .replace(/<@&\d+>/g, "")
    .replace(/<#\d+>/g, "")
    .trim();
  return stripped.length === 0;
}

/**
 * Find the user's most recent prior message in the same channel, excluding the
 * current message. Returns `null` on fetch failure or when none exists.
 */
export async function findLastUserMessage(message: Message): Promise<Message | null> {
  try {
    const fetched = await message.channel?.messages.fetch({ limit: 20 });
    // discord.js returns newest-first; return the first prior match.
    for (const prior of fetched?.values() ?? []) {
      if (prior.id !== message.id && prior.author.id === message.author.id && !prior.author.bot) {
        return prior;
      }
    }
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "find_last_user_message_error",
        messageId: message.id,
        error: String(error),
      }),
    );
  }
  return null;
}

/**
 * Resolve the author id of the message being replied to. Uses the synchronous
 * `repliedUser` hint when present, otherwise fetches the referenced message via
 * REST once. Never throws — any fetch failure resolves to `null`.
 */
export async function resolveReplyAuthorId(message: Message): Promise<string | null> {
  if (message.mentions.repliedUser?.id) return message.mentions.repliedUser.id;

  const reference = message.reference;
  if (!reference?.messageId) return null;

  try {
    const referenced = await message.channel?.messages.fetch(reference.messageId);
    return referenced?.author?.id ?? null;
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "resolve_reply_to_bot_error",
        messageId: message.id,
        referenceId: reference.messageId,
        error: String(error),
      }),
    );
    return null;
  }
}

/**
 * Resolve whether a message is a reply to the bot. Uses the synchronous
 * `repliedUser` hint when present, otherwise fetches the referenced message via
 * REST once. Never throws — any fetch failure resolves to `false`.
 */
export async function resolveReplyToBot(message: Message, botId: string): Promise<boolean> {
  return (await resolveReplyAuthorId(message)) === botId;
}
