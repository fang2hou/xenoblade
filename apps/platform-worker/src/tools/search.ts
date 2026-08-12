import { jsonSchema, tool } from "ai";

// ── Brave API response shapes ─────────────────────────────────────────────

interface BraveSearchResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveSearchResult[];
  };
}

interface BraveAnswerResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

// ── Tool factory ───────────────────────────────────────────────────────────

/**
 * Create the Brave Search tool set: `web_search` for raw result listings and
 * `web_answer` for a synthesized grounded answer.
 *
 * Both tools are always present. When an API key is absent or the request
 * fails, they return a structured error object so the model can degrade
 * gracefully — no tool failure is fatal.
 */
export function createSearchTools(env: Env) {
  return {
    /**
     * Search the web and return the top 5 results with title, URL, and a
     * short description.
     */
    web_search: tool({
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
      execute: async ({ query }) => {
        const url =
          "https://api.search.brave.com/res/v1/web/search" +
          `?q=${encodeURIComponent(query)}&count=5`;

        try {
          const response = await fetch(url, {
            headers: {
              Accept: "application/json",
              "X-Subscription-Token": env.BRAVE_SEARCH_API_KEY,
            },
            signal: AbortSignal.timeout(10_000),
          });

          if (!response.ok) {
            console.log(
              JSON.stringify({ event: "brave_search_error", status: response.status }),
            );
            return { results: [], error: `Search returned HTTP ${response.status}` };
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
            JSON.stringify({ event: "brave_search_exception", error: String(error) }),
          );
          return { results: [], error: "Search request failed" };
        }
      },
    }),

    /**
     * Get a synthesized AI answer to a factual question, grounded in web
     * search results via Brave's chat completions endpoint.
     */
    web_answer: tool({
      description:
        "Get a synthesized AI answer to a factual question, grounded in web search results. " +
        "Use when you need a concise answer rather than a list of search results.",
      inputSchema: jsonSchema<{ query: string }>({
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The question to answer.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      }),
      execute: async ({ query }) => {
        try {
          const response = await fetch("https://api.search.brave.com/res/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              "X-Subscription-Token": env.BRAVE_ANSWER_API_KEY,
            },
            body: JSON.stringify({
              model: "auto",
              messages: [{ role: "user", content: query }],
            }),
            signal: AbortSignal.timeout(15_000),
          });

          if (!response.ok) {
            console.log(
              JSON.stringify({ event: "brave_answer_error", status: response.status }),
            );
            return { answer: null, error: `Answer returned HTTP ${response.status}` };
          }

          const data = (await response.json()) as BraveAnswerResponse;
          const answer = data?.choices?.[0]?.message?.content;
          if (answer && answer.trim()) {
            return { answer: answer.trim() };
          }
          return { answer: null, error: "Empty answer" };
        } catch (error) {
          console.log(
            JSON.stringify({ event: "brave_answer_exception", error: String(error) }),
          );
          return { answer: null, error: "Answer request failed" };
        }
      },
    }),
  };
}
