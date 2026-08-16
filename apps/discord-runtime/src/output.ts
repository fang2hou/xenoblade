import type { Message, SendableChannels } from "discord.js";

/** Discord's per-message character limit. */
export const MAX_MESSAGE_LENGTH = 2000;

/** Send a typing indicator to a channel. Never throws. */
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
 * Returns the posted messages, head chunk first — callers use them to attach
 * reaction affordances and to delete the whole reply later.
 *
 * No streaming, no edit loop — one typing indicator earlier, then a single
 * complete post here.
 */
export async function postReply(target: SendableChannels, content: string): Promise<Message[]> {
  if (content.trim() === "") {
    throw new Error("postReply: content is empty after trim");
  }
  const chunks = sliceIntoChunks(content, MAX_MESSAGE_LENGTH);
  const posted: Message[] = [];
  for (const chunk of chunks) {
    posted.push(await target.send(chunk));
  }
  return posted;
}

/**
 * Split text into chunks no larger than `max`, preferring newline boundaries so
 * replies stay readable. Long single-line paragraphs are hard-wrapped.
 */
export function sliceIntoChunks(text: string, max: number): string[] {
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
