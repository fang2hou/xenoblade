import type { Message, TextChannel, ThreadChannel } from "discord.js";
import type { HistoryMessage } from "@xenoblade/contracts";

/** Page size when fetching recent messages from Discord. */
const FETCH_LIMIT = 25;
/** Maximum number of messages returned to the Worker. */
const RETURN_LIMIT = 20;

/**
 * Fetch recent channel history and map it to wire {@link HistoryMessage}s.
 *
 * Fetches up to {@link FETCH_LIMIT} messages (discord.js returns newest-first),
 * drops messages with empty content, trims to {@link RETURN_LIMIT}, and returns
 * the result in chronological (oldest-first) order for the Worker.
 */
export async function fetchHistory(
  channel: TextChannel | ThreadChannel,
  limit: number = FETCH_LIMIT,
): Promise<HistoryMessage[]> {
  const fetched = await channel.messages.fetch({ limit });

  const recent = [...fetched.values()]
    .filter((msg) => msg.content.trim() !== "")
    .slice(0, RETURN_LIMIT)
    .reverse();

  return recent.map(toHistoryMessage);
}

function toHistoryMessage(message: Message): HistoryMessage {
  return {
    id: message.id,
    text: message.content,
    authorId: message.author.id,
    authorName:
      message.member?.displayName ||
      message.author.displayName ||
      message.author.username,
    isBot: message.author.bot,
    createdAt: message.createdTimestamp,
  };
}
