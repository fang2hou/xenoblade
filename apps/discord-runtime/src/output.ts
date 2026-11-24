import { MessageFlags, type Message, type SendableChannels } from "discord.js";

import { isClosingFence, parseOpeningFence, type CodeFence } from "./code-fences";

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
 * of the next one, so every chunk renders as well-formed Markdown. A fence
 * that cannot fit around content — a huge info string, a closing line too
 * long for a chunk — is not carried: its block is chunked as plain text
 * instead. Either way no chunk exceeds `max`.
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
 * A fenced code block left open where text is cut: the block as CommonMark
 * sees it, plus the two strings that carry it across a chunk boundary.
 */
interface Fence extends CodeFence {
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

/**
 * The fenced block this line opens, when the chunker can carry it across
 * boundaries. A fence is carried only if its opening line fits whole in a
 * chunk beside the room a piece needs for its own reopen and close; anything
 * tighter would force a cut through the fence itself. A block that is not
 * carried is chunked as plain text, which always fits. (`splitUnits` releases
 * a block whose closing line cannot fit for the same reason.)
 */
function carriedFence(line: string, max: number): Fence | null {
  const opened = parseOpeningFence(line);
  if (opened === null) return null;
  const reopen = `${opened.marker}${opened.info}\n`;
  const close = `\n${opened.marker}`;
  const roomForContent = max - reopen.length - close.length;
  return line.length <= roomForContent ? { ...opened, reopen, close } : null;
}

/**
 * Break text into the units a chunk boundary may fall between: one per line,
 * except that an opening fence line stays attached to the first line of its
 * block (so no chunk ends on an empty code block) and a line too long for any
 * chunk is hard-wrapped into pieces that each fit with their own fence copies.
 */
function splitUnits(text: string, max: number): Unit[] {
  const lines = text.split("\n");
  let units: Unit[] = [];
  let open: Fence | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const start = open;
    const fence: Fence | null = open === null ? carriedFence(line, max) : null;
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

  // A block whose closing line cannot fit whole in a chunk is not carried
  // either: hard-wrapping that line would scatter pieces that each read as a
  // fence of their own.
  const uncarried = new Set<Fence>();
  for (const unit of units) {
    const { start } = unit;
    if (
      start !== null &&
      unit.end === null &&
      unit.text.length > max - start.reopen.length - start.close.length
    ) {
      uncarried.add(start);
    }
  }
  if (uncarried.size > 0) {
    units = units.map((unit) => ({
      ...unit,
      start: unit.start !== null && uncarried.has(unit.start) ? null : unit.start,
      end: unit.end !== null && uncarried.has(unit.end) ? null : unit.end,
    }));
  }

  const sized: Unit[] = [];
  for (const unit of units) {
    // The fence spanning the line's interior: every piece after the first reopens inside it.
    const inner = unit.end ?? unit.start;
    // A piece inside a fence must leave room for its own reopen and close. A
    // carried fence always leaves some (see carriedFence), so the budget stays positive.
    const budget = inner === null ? max : max - inner.reopen.length - inner.close.length;
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

/**
 * A masked link as one atomic span. An angle-bracketed target may hold
 * anything but line breaks and angle brackets — Wikipedia URLs with
 * parentheses, for instance; a bare one may hold balanced parentheses.
 */
const MASKED_LINK_RE = /\[[^\]\n]*\]\((?:<[^<>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)\)/g;

/** Offsets of one hard-wrapped long line: [start, end) pairs of ≤ max chars. */
function hardWrapOffsets(paragraph: string, max: number): Array<{ start: number; end: number }> {
  // Spans of masked links — a cut inside one breaks it.
  const spans: Array<[number, number]> = [];
  for (const match of paragraph.matchAll(MASKED_LINK_RE)) {
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
