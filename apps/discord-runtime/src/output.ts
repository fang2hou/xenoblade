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
      for (const offset of hardWrapOffsets(paragraph, max)) {
        chunks.push(paragraph.slice(offset.start, offset.end));
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

/** Offsets of one hard-wrapped long line: [start, end) pairs of ≤ max chars. */
function hardWrapOffsets(paragraph: string, max: number): Array<{ start: number; end: number }> {
  // Spans of masked links — a cut inside `[label](url)` breaks the link and
  // resurfaces a bare-URL fragment (and its preview card).
  const spans: Array<[number, number]> = [];
  for (const match of paragraph.matchAll(/\[[^\]\n]*\]\([^)\s]*\)/g)) {
    const start = match.index;
    if (start === undefined) continue;
    spans.push([start, start + match[0].length]);
  }

  const offsets: Array<{ start: number; end: number }> = [];
  let start = 0;
  while (paragraph.length - start > max) {
    let end = start + max;
    // Never cut inside a masked link: pull the cut back to the link's start.
    for (const [spanStart, spanEnd] of spans) {
      if (end > spanStart && end < spanEnd) {
        end = spanStart;
        break;
      }
    }
    // Degenerate case (link itself longer than max, or at position 0): cut
    // anyway — a broken link is better than an unpostable message.
    if (end <= start) {
      end = start + max;
    }
    offsets.push({ start, end });
    start = end;
  }
  offsets.push({ start, end: paragraph.length });
  return offsets;
}
