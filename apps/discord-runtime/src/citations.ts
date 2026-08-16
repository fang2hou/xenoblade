import type { GenerationSource } from "@xenoblade/contracts";

/**
 * A model-rendered sources footer: a trailing "Sources:" line (bold or plain)
 * followed only by short citation-entry lines. Lines are capped at 500 chars
 * so a mid-reply line starting with "sources:" that is followed by ordinary
 * prose is left alone. Colons are required — a reply merely mentioning the
 * word "sources" never matches.
 */
const MODEL_SOURCES_FOOTER_RE =
  /(?:^|\n)[ \t]*(?:\*\*)?sources(?:\*\*)?[ \t]*:(?:[^\n]{0,500}(?:\n[^\n]{0,500})*)?$/i;

/** Remove a model-rendered sources footer from a reply. */
export function stripModelSourcesFooter(reply: string): string {
  return reply.replace(MODEL_SOURCES_FOOTER_RE, "").trimEnd();
}

/**
 * Render the final reply text: the model's answer with any self-rendered
 * sources footer stripped, plus a single canonical footer line built from the
 * structured sources — appended only when sources exist.
 */
export function renderReply(reply: string, sources: readonly GenerationSource[]): string {
  const body = stripModelSourcesFooter(reply);
  if (sources.length === 0) return body;
  const links = sources
    .map((source) => `[${source.index}] [${source.title}](${source.url})`)
    .join(" · ");
  return `${body}\n\n**Sources:** ${links}`;
}
