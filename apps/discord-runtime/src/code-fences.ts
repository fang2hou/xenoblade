/**
 * CommonMark fenced code blocks. A fence is a run of three or more backticks
 * or tildes at the start of a line, indented by at most three spaces; the
 * block ends at a line of the same character, at least as long, holding
 * nothing else. A line indented four or more spaces is code content, never a
 * fence. Lines are matched with CRLF endings the same as LF.
 */

/** A fenced code block as its opening line declares it. */
export interface CodeFence {
  /** The opening fence characters: three or more backticks or tildes. */
  marker: string;
  /** The info string after them on the opening line, e.g. a language tag. */
  info: string;
}

/** A run of reply text that is either prose or fenced code. */
export interface CodeSegment {
  text: string;
  /** True for a fenced block, fence lines included. */
  code: boolean;
}

const OPENING_FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSING_FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** The fenced block this line opens, or null when it is not an opening fence. */
export function parseOpeningFence(line: string): CodeFence | null {
  const text = line.endsWith("\r") ? line.slice(0, -1) : line;
  const match = OPENING_FENCE_RE.exec(text);
  if (match === null) return null;
  const marker = match[1] ?? "";
  const info = (match[2] ?? "").trim();
  // CommonMark: a backtick fence's info string may not contain a backtick.
  // Such a line is inline code, not the start of a block.
  if (marker.startsWith("`") && info.includes("`")) return null;
  return { marker, info };
}

/** Does this line close `fence`? */
export function isClosingFence(line: string, fence: CodeFence): boolean {
  const text = line.endsWith("\r") ? line.slice(0, -1) : line;
  const match = CLOSING_FENCE_RE.exec(text);
  if (match === null) return false;
  const marker = match[1] ?? "";
  return marker[0] === fence.marker[0] && marker.length >= fence.marker.length;
}

/**
 * Split text into alternating prose and fenced-code segments. An unterminated
 * block runs to the end of the text, as Discord renders it.
 */
export function splitCodeSegments(text: string): CodeSegment[] {
  const segments: CodeSegment[] = [];
  let current: CodeSegment | null = null;
  let open: CodeFence | null = null;

  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    // A line can close only a block that was already open; an opening fence is never its own close.
    const closes = open !== null && isClosingFence(line, open);
    if (open === null) open = parseOpeningFence(line);
    if (current === null || current.code !== (open !== null)) {
      current = { text: "", code: open !== null };
      segments.push(current);
    }
    // Each line carries the break that follows it, so segments join back to the text.
    current.text += i === lines.length - 1 ? line : `${line}\n`;
    if (closes) open = null;
  }
  return segments;
}
