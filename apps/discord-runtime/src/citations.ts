/**
 * Reply rendering for link hygiene (ADR-007 amendment): no sources footer is
 * appended — citations are the model's inline masked links. Discord renders a
 * preview card for every URL it can unfurl in message content — bare URLs and
 * `[label](url)` masked links alike — unless the target sits in angle brackets
 * or the message carries `SuppressEmbeds`. This module puts every URL outside
 * code behind angle brackets; the send path adds the flag (see `replyPayload`).
 */

import { splitCodeSegments } from "./code-fences";

/**
 * A model-rendered sources footer: a trailing "Sources:" / "来源:" line (bold
 * or plain) followed only by short citation-entry lines. Lines are capped at
 * 500 chars so a mid-reply line starting with "sources:" that is followed by
 * ordinary prose is left alone. Colons are required — a reply merely
 * mentioning the word "sources" never matches.
 */
const MODEL_SOURCES_FOOTER_RE =
  /(?:^|\n)[ \t]*(?:\*\*)?(?:sources|来源|來源)(?:\*\*)?[ \t]*[:：](?:[^\n]{0,500}(?:\n[^\n]{0,500})*)?$/i;

/** Remove a model-rendered sources footer from a reply. */
export function stripModelSourcesFooter(reply: string): string {
  return reply.replace(MODEL_SOURCES_FOOTER_RE, "").trimEnd();
}

/**
 * One masked link or bare URL, leftmost first: a URL used as its own link
 * label is consumed with that link instead of being masked a second time. A
 * link target may contain one level of balanced parentheses
 * (Wikipedia-style); the bare branch's lookbehinds skip `<...>` forms and
 * targets the link branch rejected (whitespace in the destination).
 */
const LINK_OR_URL_RE =
  /\[([^\]\n]*)\]\((<?)(https?:\/\/[^\s<>()]*(?:\([^\s()<>]*\)[^\s<>()]*)*)>?\)|(?<!\]\()(?<!<)(https?:\/\/[^\s<>]+)/g;

/** Punctuation that belongs to the sentence, not the URL. */
const TRAILING_PUNCTUATION = ".,;:!?)】」』";

/**
 * Put every URL outside code behind angle brackets: bare URLs become masked
 * links (`url` → `[url](<url>)`) and a model-written `[label](url)` becomes
 * `[label](<url>)`. Discord renders a preview card for both forms as-is; the
 * angle brackets are what stop it. Links already using `<...>` are left
 * alone, and code — fenced blocks of any kind, inline spans — is skipped so
 * its contents stay verbatim.
 */
export function maskBareUrls(text: string): string {
  return splitCodeSegments(text)
    .map((segment) => (segment.code ? segment.text : maskProse(segment.text)))
    .join("");
}

/** Mask the links of a prose run, leaving its inline code spans verbatim. */
function maskProse(prose: string): string {
  return prose
    .split(/(`[^`\n]*`)/g)
    .map((segment, i) => (i % 2 === 1 ? segment : segment.replace(LINK_OR_URL_RE, maskLinkOrUrl)))
    .join("");
}

function maskLinkOrUrl(
  match: string,
  label: string | undefined,
  angle: string | undefined,
  url: string | undefined,
  bare: string | undefined,
): string {
  if (bare !== undefined) return maskUrl(bare);
  return angle === "<" ? match : `[${label}](<${url}>)`;
}

/**
 * Mask a bare URL. Sentence punctuation that trails it stays outside the
 * link, except a `)` that closes an earlier `(` of the URL itself
 * (Wikipedia-style `...(series)`), which stays part of it.
 */
function maskUrl(url: string): string {
  let end = url.length;
  while (end > 0 && TRAILING_PUNCTUATION.includes(url[end - 1] ?? "")) {
    const head = url.slice(0, end);
    if (url[end - 1] === ")" && head.split("(").length >= head.split(")").length) break;
    end -= 1;
  }
  const core = url.slice(0, end);
  const trailing = url.slice(end);
  return `[${core}](<${core}>)${trailing}`;
}

/**
 * Render the final reply text: the model's answer with any self-rendered
 * sources footer stripped and bare URLs masked. The structured sources ride
 * the generation result into the durable source index instead of a footer.
 */
export function renderReply(reply: string): string {
  return maskBareUrls(stripModelSourcesFooter(reply));
}
