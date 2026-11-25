import {
  ChannelType,
  type DMChannel,
  type Message,
  type Snowflake,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
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
 * the result in chronological (oldest-first) order for the Worker. With
 * `before`, only messages older than that message's id are fetched — never
 * the message itself, nor anything posted after it.
 *
 * For a thread started from a parent-channel message, Discord's
 * `GET /channels/{threadId}/messages` omits the starter message (returning only
 * an empty `ThreadStarterMessage` stub). When the thread's fetched window has
 * room and no `before` cursor was requested, the starter message is fetched via
 * `fetchStarterMessage()` and prepended chronologically without duplicating it.
 */
export async function fetchHistory(
  channel: TextChannel | ThreadChannel | DMChannel,
  limit: number = FETCH_LIMIT,
  before?: Snowflake,
): Promise<HistoryMessage[]> {
  const fetched = await channel.messages.fetch({
    limit,
    ...(before === undefined ? {} : { before }),
  });

  const recent = [...fetched.values()]
    .filter((msg) => msg.content.trim() !== "")
    .slice(0, RETURN_LIMIT)
    .toReversed()
    .map(toHistoryMessage);

  if (before === undefined && recent.length < RETURN_LIMIT && canFetchStarter(channel)) {
    const alreadyPresent = recent.some((entry) => entry.id === channel.id);
    if (!alreadyPresent) {
      const starter = await fetchStarterSafely(channel);
      if (starter !== null && !recent.some((entry) => entry.id === starter.id)) {
        const entry = toStarterHistoryMessage(starter);
        if (entry !== null) {
          return [entry, ...recent]
            .toSorted((a, b) => a.createdAt - b.createdAt)
            .slice(-RETURN_LIMIT);
        }
      }
    }
  }

  return recent;
}

function canFetchStarter(
  channel: TextChannel | ThreadChannel | DMChannel,
): channel is ThreadChannel {
  return (
    "isThread" in channel &&
    typeof channel.isThread === "function" &&
    channel.isThread() &&
    channel.type !== ChannelType.PrivateThread &&
    "fetchStarterMessage" in channel &&
    typeof channel.fetchStarterMessage === "function"
  );
}

/**
 * Fetch a thread's starter message, degrading cleanly to `null` when the thread
 * was not created from a message, the starter was deleted (404 / 10008), or the
 * bot lacks access to read it.
 */
async function fetchStarterSafely(thread: ThreadChannel): Promise<Message | null> {
  try {
    return (await thread.fetchStarterMessage()) ?? null;
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "thread_starter_fetch_skipped",
        threadId: thread.id,
        error: error instanceof Error ? error.name : typeof error,
      }),
    );
    return null;
  }
}

/** Name the conversation shows for an author: server nickname, display name, then username. */
export function authorDisplayName(message: {
  member?: { displayName: string } | null;
  author: { displayName: string | null; username: string };
}): string {
  return message.member?.displayName || message.author.displayName || message.author.username;
}

function formatStarterText(message: Message): string {
  const base = message.content.trim();
  const attachmentRefs =
    message.attachments && message.attachments.size > 0
      ? [...message.attachments.values()].map((att) =>
          att.contentType?.startsWith("image/")
            ? `[Image: ${att.url}]`
            : `[Attachment: ${att.name ?? att.url}]`,
        )
      : [];
  if (attachmentRefs.length === 0) return message.content;
  return base === ""
    ? attachmentRefs.join("\n")
    : `${message.content}\n${attachmentRefs.join("\n")}`;
}

function toStarterHistoryMessage(message: Message): HistoryMessage | null {
  const text = formatStarterText(message);
  if (text.trim() === "") return null;
  return {
    id: message.id,
    text,
    authorId: message.author.id,
    authorName: authorDisplayName(message),
    isBot: message.author.bot,
    createdAt: message.createdTimestamp,
  };
}

function toHistoryMessage(message: Message): HistoryMessage {
  return {
    id: message.id,
    text: message.content,
    authorId: message.author.id,
    authorName: authorDisplayName(message),
    isBot: message.author.bot,
    createdAt: message.createdTimestamp,
  };
}
