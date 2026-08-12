import type { SendableChannels } from "discord.js";

/** Discord's per-message character limit. */
const MAX_MESSAGE_LENGTH = 2000;

/** Send a single typing indicator to a channel. Never throws. */
export async function sendTyping(channel: SendableChannels): Promise<void> {
  try {
    await channel.sendTyping();
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "send_typing_error",
        channelId: channel.id,
        error: String(error),
      }),
    );
  }
}

/**
 * Post a reply to a channel, splitting content into ≤2000-char chunks when
 * needed. Chunks are split on newline boundaries first, then hard-wrapped.
 *
 * No streaming, no edit loop — one typing indicator earlier, then a single
 * complete post here.
 */
export async function postReply(
  target: SendableChannels,
  content: string,
): Promise<void> {
  if (content.trim() === "") {
    throw new Error("postReply: content is empty after trim");
  }
  const chunks = sliceIntoChunks(content, MAX_MESSAGE_LENGTH);
  for (const chunk of chunks) {
    await target.send(chunk);
  }
}

/**
 * Split text into chunks no larger than `max`, preferring newline boundaries so
 * replies stay readable. Long single-line paragraphs are hard-wrapped.
 */
function sliceIntoChunks(text: string, max: number): string[] {
  if (text.length <= max) return [text];

  const chunks: string[] = [];
  let current = "";

  for (const paragraph of text.split("\n")) {
    if (paragraph.length > max) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < paragraph.length; i += max) {
        chunks.push(paragraph.slice(i, i + max));
      }
      continue;
    }

    const candidate = current ? `${current}\n${paragraph}` : paragraph;
    if (candidate.length > max) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}
