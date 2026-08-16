import type { GenerationSource } from "@xenoblade/contracts";

/** Structural slice of the AI SDK tool-result shape this extraction reads. */
interface ToolResultLike {
  toolName: string;
  output?: unknown;
}

/** The first-party search tool whose results become citation sources. */
const SEARCH_TOOL_NAME = "web_search";

function isSearchOutput(value: unknown): value is { results: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "results" in value &&
    Array.isArray(value.results)
  );
}

/**
 * Extract ordered citation sources from a generation's tool results.
 *
 * Only `web_search` results carry URLs. Indices are assigned sequentially
 * across invocations, in the order the model saw the results, so inline [n]
 * markers in the reply line up with the numbered footer the Runtime appends.
 * Results without a URL are dropped (nothing to link); a missing or empty
 * title falls back to the URL itself. Entries are neither reordered nor
 * deduplicated — the numbering must mirror the model's view exactly.
 */
export function extractSources(toolResults: readonly ToolResultLike[]): GenerationSource[] {
  const sources: GenerationSource[] = [];
  for (const toolResult of toolResults) {
    if (toolResult.toolName !== SEARCH_TOOL_NAME) continue;
    if (!isSearchOutput(toolResult.output)) continue;
    for (const result of toolResult.output.results) {
      if (typeof result !== "object" || result === null || !("url" in result)) continue;
      const url = result.url;
      if (typeof url !== "string" || url === "") continue;
      const title =
        "title" in result && typeof result.title === "string" && result.title !== ""
          ? result.title
          : url;
      sources.push({ index: sources.length + 1, title, url });
    }
  }
  return sources;
}
