import type { DMChannel, Message, TextChannel, ThreadChannel } from "discord.js";
import type { HistoryMessage } from "@xenoblade/contracts";

/** Page size when fetching recent messages from Discord. */
const FETCH_LIMIT = 50;
/**
 * Maximum number of messages returned to the Worker — the Worker's own
 * context budget keeps at most 40, so nothing fetched is left unused because
 * of this cap.
 */
const RETURN_LIMIT = 40;

/**
 * Fetch recent channel history and map it to wire {@link HistoryMessage}s.
 *
 * Fetches up to {@link FETCH_LIMIT} messages (discord.js returns newest-first),
 * drops messages with empty content, trims to {@link RETURN_LIMIT}, and returns
 * the result in chronological (oldest-first) order for the Worker.
 */
export async function fetchHistory(
  channel: TextChannel | ThreadChannel | DMChannel,
  limit: number = FETCH_LIMIT,
): Promise<HistoryMessage[]> {
  const fetched = await channel.messages.fetch({ limit });

  const recent = [...fetched.values()]
    .filter((msg) => msg.content.trim() !== "")
    .slice(0, RETURN_LIMIT)
    .toReversed();

  return recent.map(toHistoryMessage);
}

function toHistoryMessage(message: Message): HistoryMessage {
  return {
    id: message.id,
    text: message.content,
    authorId: message.author.id,
    authorName:
      message.member?.displayName || message.author.displayName || message.author.username,
    isBot: message.author.bot,
    createdAt: message.createdTimestamp,
  };
}
