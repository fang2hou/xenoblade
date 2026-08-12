import type { Message } from "discord.js";
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
  // Never trigger on bot or webhook messages.
  if (message.author.bot) return null;
  if (message.webhookId) return null;

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

  // (c) Reply to one of the bot's messages.
  if (message.reference?.messageId) {
    if (await resolveReplyToBot(message, botId)) {
      return { kind: "reply-to-bot" };
    }
  }

  return null;
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
export async function findLastUserMessage(
  message: Message,
): Promise<Message | null> {
  try {
    const fetched = await message.channel?.messages.fetch({ limit: 20 });
    // discord.js returns newest-first; return the first prior match.
    for (const prior of fetched?.values() ?? []) {
      if (
        prior.id !== message.id &&
        prior.author.id === message.author.id &&
        !prior.author.bot
      ) {
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
 * Resolve whether a message is a reply to the bot. Uses the synchronous
 * `repliedUser` hint when present, otherwise fetches the referenced message via
 * REST once. Never throws — any fetch failure resolves to `false`.
 */
export async function resolveReplyToBot(
  message: Message,
  botId: string,
): Promise<boolean> {
  if (message.mentions.repliedUser?.id === botId) return true;

  const reference = message.reference;
  if (!reference?.messageId) return false;

  try {
    const referenced = await message.channel?.messages.fetch(
      reference.messageId,
    );
    return referenced?.author.id === botId;
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "resolve_reply_to_bot_error",
        messageId: message.id,
        referenceId: reference.messageId,
        error: String(error),
      }),
    );
    return false;
  }
}
