/**
 * Reply rendering for link hygiene (ADR-007 amendment): no sources footer is
 * appended — citations are the model's inline masked links. Bare URLs are
 * wrapped into masked links so Discord never renders preview cards for them.
 */

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

/** One bare URL; the lookbehinds skip masked-link targets and `<...>` forms. */
const BARE_URL_RE = /(?<!\]\()(?<!<)(https?:\/\/[^\s<>]+)/g;

/** Punctuation that belongs to the sentence, not the URL. */
const TRAILING_PUNCTUATION = ".,;:!?)】」』";

/**
 * Wrap bare URLs in masked-link markdown (`url` → `[url](url)`). Discord
 * renders a large preview card for every bare URL but not for masked links,
 * so this is the guarantee layer behind the model's own linking discipline.
 * URLs already inside `[label](url)` or `<...>` are left alone, and code
 * spans / fenced blocks are skipped so their contents stay verbatim.
 */
export function maskBareUrls(text: string): string {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((segment, i) =>
      i % 2 === 1 ? segment : segment.replace(BARE_URL_RE, (match) => maskUrl(match)),
    )
    .join("");
}

function maskUrl(url: string): string {
  let end = url.length;
  while (end > 0 && TRAILING_PUNCTUATION.includes(url[end - 1] ?? "")) {
    end -= 1;
  }
  const core = url.slice(0, end);
  const trailing = url.slice(end);
  return `[${core}](${core})${trailing}`;
}

/**
 * Render the final reply text: the model's answer with any self-rendered
 * sources footer stripped and bare URLs masked. The structured sources ride
 * the generation result into the durable source index instead of a footer.
 */
export function renderReply(reply: string): string {
  return maskBareUrls(stripModelSourcesFooter(reply));
}
