import { MessageFlags, type Message, type SendableChannels } from "discord.js";

/** Discord's per-message character limit. */
export const MAX_MESSAGE_LENGTH = 2000;

/**
 * Message payload for bot reply text. `SuppressEmbeds` is what stops Discord
 * from rendering link preview cards — masked links alone do not — so reply
 * text is never sent or edited without it: here, or in `replyControlsEdit`
 * when the edit also carries the control row.
 */
export function replyPayload(content: string): {
  content: string;
  flags: MessageFlags.SuppressEmbeds;
} {
  return { content, flags: MessageFlags.SuppressEmbeds };
}

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
 * needed. Chunks are split on newline boundaries first, then hard-wrapped,
 * and a code fence spanning two chunks is closed and reopened across the
 * boundary (see {@link sliceIntoChunks}). Returns the posted messages, head
 * chunk first — callers use them to attach reply controls and to delete the
 * whole reply later.
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
    posted.push(await target.send(replyPayload(chunk)));
  }
  return posted;
}

/**
 * Split text into chunks no larger than `max`, preferring newline boundaries so
 * replies stay readable. Long single-line paragraphs are hard-wrapped.
 *
 * A chunk boundary that falls inside a fenced code block closes the block at
 * the end of the chunk and reopens it — language tag included — at the start
 * of the next one, so every chunk renders as well-formed Markdown.
 */
export function sliceIntoChunks(text: string, max: number): string[] {
  if (text.length <= max) return [text];

  const chunks: string[] = [];
  let current: { body: string; open: Fence | null } | null = null;

  for (const unit of splitUnits(text, max)) {
    // A chunk that ends inside a fence is closed synthetically; reserve that room.
    const cost = unit.text.length + (unit.end === null ? 0 : unit.end.close.length);
    if (current !== null && current.body.length + unit.sep.length + cost > max) {
      chunks.push(current.open === null ? current.body : `${current.body}${current.open.close}`);
      current = null;
    }
    // A blank line never opens a chunk on its own: nothing could follow it there.
    if (current === null && unit.text.trim() === "" && unit.start === null) continue;
    const prefix = unit.start === null ? "" : unit.start.reopen;
    current = {
      body: current === null ? `${prefix}${unit.text}` : `${current.body}${unit.sep}${unit.text}`,
      open: unit.end,
    };
  }
  if (current !== null) {
    chunks.push(current.open === null ? current.body : `${current.body}${current.open.close}`);
  }
  return chunks;
}

/**
 * A fenced code block left open where text is cut, holding the two strings
 * that carry it across a chunk boundary.
 */
interface Fence {
  /** What a chunk starting inside the block begins with: the opening line plus a newline, e.g. "```ts\n". */
  reopen: string;
  /** What a chunk ending inside the block is closed with: a newline plus the bare fence characters, e.g. "\n```". */
  close: string;
}

/**
 * Text that has to stay inside one chunk, plus the fences spanning it. A
 * chunk starting inside `start` reopens it; a chunk ending inside `end` is
 * closed.
 */
interface Unit {
  text: string;
  /** Separator from the previous unit: a newline, or nothing between the pieces of one hard-wrapped line. */
  sep: string;
  start: Fence | null;
  end: Fence | null;
}

const OPENING_FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** The fenced block this line opens, or null when it is ordinary text. */
function parseOpeningFence(line: string): Fence | null {
  const match = OPENING_FENCE_RE.exec(line);
  if (match === null) return null;
  const marker = match[1] ?? "";
  return { reopen: `${marker}${(match[2] ?? "").trim()}\n`, close: `\n${marker}` };
}

/** Does this line close `fence`? Same character, at least as long, nothing else. */
function isClosingFence(line: string, fence: Fence): boolean {
  const body = line.trim();
  const marker = fence.close.slice(1);
  return body.length >= marker.length && body === marker[0]?.repeat(body.length);
}

/**
 * Break text into the units a chunk boundary may fall between: one per line,
 * except that an opening fence line stays attached to the first line of its
 * block (so no chunk ends on an empty code block) and a line too long for any
 * chunk is hard-wrapped into pieces that each fit with their own fence copies.
 */
function splitUnits(text: string, max: number): Unit[] {
  const lines = text.split("\n");
  const units: Unit[] = [];
  let open: Fence | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const start = open;
    const fence: Fence | null = open === null ? parseOpeningFence(line) : null;
    if (fence !== null) {
      const first = lines[i + 1];
      if (first !== undefined && !isClosingFence(first, fence)) {
        i += 1;
        units.push({ text: `${line}\n${first}`, sep: "\n", start: null, end: fence });
        open = fence;
        continue;
      }
      open = fence;
    } else if (open !== null && isClosingFence(line, open)) {
      open = null;
    }
    units.push({ text: line, sep: "\n", start, end: open });
  }

  const sized: Unit[] = [];
  for (const unit of units) {
    // The fence spanning the line's interior: every piece after the first reopens inside it.
    const inner = unit.end ?? unit.start;
    const overhead = inner === null ? 0 : inner.reopen.length + inner.close.length;
    const budget = Math.max(1, max - overhead);
    if (unit.text.length <= budget) {
      sized.push(unit);
      continue;
    }
    const offsets = hardWrapOffsets(unit.text, budget);
    for (const [n, offset] of offsets.entries()) {
      const first = n === 0;
      const last = n === offsets.length - 1;
      sized.push({
        text: unit.text.slice(offset.start, offset.end),
        sep: first ? unit.sep : "",
        start: first ? unit.start : inner,
        end: last ? unit.end : inner,
      });
    }
  }
  return sized;
}

/** Offsets of one hard-wrapped long line: [start, end) pairs of ≤ max chars. */
function hardWrapOffsets(paragraph: string, max: number): Array<{ start: number; end: number }> {
  // Spans of masked links — a cut inside `[label](<url>)` breaks the link.
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
