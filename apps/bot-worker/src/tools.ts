import { jsonSchema } from "ai";
import type { ToolSet } from "ai";

interface BraveSearchResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveSearchResult[];
  };
}

/**
 * Create a Brave Search tool set for use with `streamText`.
 *
 * Returns `undefined` when no API key is configured, so the bot runs without
 * web search in that case. When enabled, the model can call `webSearch` to
 * retrieve up to 5 results for a query.
 */
export function createSearchTools(apiKey: string | undefined): ToolSet | undefined {
  if (!apiKey) {
    return undefined;
  }

  return {
    webSearch: {
      description:
        "Search the web for current information, recent events, or facts you are unsure about. " +
        "Returns titles, URLs, and short descriptions for the top results.",
      inputSchema: jsonSchema<{ query: string }>({
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query (be concise and specific).",
          },
        },
        required: ["query"],
        additionalProperties: false,
      }),
      execute: async ({ query }: { query: string }) => {
        const url =
          `https://api.search.brave.com/res/v1/web/search` +
          `?q=${encodeURIComponent(query)}&count=5&qtf=web`;

        try {
          const response = await fetch(url, {
            headers: {
              Accept: "application/json",
              "X-Subscription-Token": apiKey,
            },
            signal: AbortSignal.timeout(10_000),
          });

          if (!response.ok) {
            console.log(
              JSON.stringify({
                event: "brave_search_error",
                status: response.status,
              }),
            );
            return { error: `Search returned HTTP ${response.status}`, results: [] };
          }

          const data = (await response.json()) as BraveSearchResponse;
          const results = (data?.web?.results ?? []).slice(0, 5).map((r) => ({
            title: r.title ?? "",
            url: r.url ?? "",
            description: r.description ?? "",
          }));

          return { results };
        } catch (error) {
          console.log(
            JSON.stringify({
              event: "brave_search_exception",
              error: String(error),
            }),
          );
          return { error: "Search request failed", results: [] };
        }
      },
    },
  } as unknown as ToolSet;
}
