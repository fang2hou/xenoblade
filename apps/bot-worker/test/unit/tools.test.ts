import { describe, it, expect, vi, afterEach } from "vitest";
import { createSearchTools } from "../../src/tools";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SearchResult {
  title: string;
  url: string;
  description: string;
}

interface WebSearchResult {
  results: SearchResult[];
  error?: string;
}

interface WebSearchTool {
  execute: (args: { query: string }) => Promise<WebSearchResult>;
}

interface SearchToolSet {
  webSearch: WebSearchTool;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// createSearchTools — configuration
// ---------------------------------------------------------------------------

describe("createSearchTools", () => {
  it("returns undefined when the API key is undefined", () => {
    expect(createSearchTools(undefined)).toBeUndefined();
  });

  it("returns undefined when the API key is an empty string", () => {
    expect(createSearchTools("")).toBeUndefined();
  });

  it("returns a ToolSet with webSearch when given a valid key", () => {
    const tools = createSearchTools("brave-api-key");
    expect(tools).toBeDefined();
    expect(tools).toHaveProperty("webSearch");
  });

  // -------------------------------------------------------------------------
  // webSearch.execute — Brave API call
  // -------------------------------------------------------------------------

  it("calls the Brave API with the correct URL, query encoding, and headers", async () => {
    const apiKey = "brave-secret-token";
    const tools = createSearchTools(apiKey) as unknown as SearchToolSet;
    const webSearch = tools.webSearch;

    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            web: {
              results: [
                {
                  title: "Xenoblade",
                  url: "https://xenoblade.example",
                  description: "JRPG",
                },
              ],
            },
          }),
        }) as unknown as Response,
    );
    globalThis.fetch = fetchMock;

    const result = await webSearch.execute({ query: "xenoblade chronicles" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://api.search.brave.com/res/v1/web/search?q=xenoblade%20chronicles&count=5&qtf=web",
    );
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/json");
    expect(headers["X-Subscription-Token"]).toBe(apiKey);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.title).toBe("Xenoblade");
    expect(result.results[0]?.url).toBe("https://xenoblade.example");
    expect(result.results[0]?.description).toBe("JRPG");
  });

  it("URL-encodes special characters in the query", async () => {
    const tools = createSearchTools("key") as unknown as SearchToolSet;

    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ web: { results: [] } }),
        }) as unknown as Response,
    );
    globalThis.fetch = fetchMock;

    await tools.webSearch.execute({ query: "异度神剑 & friends" });

    const [url] = fetchMock.mock.calls[0]!;
    // encodeURIComponent("异度神剑 & friends") encodes CJK, space, and &.
    expect(url).toContain("q=" + encodeURIComponent("异度神剑 & friends"));
  });

  it("caps the number of returned results at 5", async () => {
    const tools = createSearchTools("key") as unknown as SearchToolSet;

    const manyResults = Array.from({ length: 10 }, (_, i) => ({
      title: `Result ${i}`,
      url: `https://r${i}.com`,
      description: `desc ${i}`,
    }));

    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ web: { results: manyResults } }),
        }) as unknown as Response,
    );
    globalThis.fetch = fetchMock;

    const result = await tools.webSearch.execute({ query: "test" });
    expect(result.results).toHaveLength(5);
  });

  it("defaults missing fields to empty strings", async () => {
    const tools = createSearchTools("key") as unknown as SearchToolSet;

    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            web: {
              results: [{ title: "only title" }],
            },
          }),
        }) as unknown as Response,
    );
    globalThis.fetch = fetchMock;

    const result = await tools.webSearch.execute({ query: "test" });
    expect(result.results[0]?.title).toBe("only title");
    expect(result.results[0]?.url).toBe("");
    expect(result.results[0]?.description).toBe("");
  });

  it("returns an empty results array when web.results is absent", async () => {
    const tools = createSearchTools("key") as unknown as SearchToolSet;

    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({}),
        }) as unknown as Response,
    );
    globalThis.fetch = fetchMock;

    const result = await tools.webSearch.execute({ query: "test" });
    expect(result.results).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // webSearch.execute — error handling
  // -------------------------------------------------------------------------

  it("returns { error, results: [] } when fetch returns non-ok", async () => {
    const tools = createSearchTools("key") as unknown as SearchToolSet;

    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        ({
          ok: false,
          status: 429,
          json: async () => ({}),
        }) as unknown as Response,
    );
    globalThis.fetch = fetchMock;

    const result = await tools.webSearch.execute({ query: "test" });
    expect(result.error).toContain("429");
    expect(result.results).toEqual([]);
  });

  it("returns { error, results: [] } when fetch throws", async () => {
    const tools = createSearchTools("key") as unknown as SearchToolSet;

    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error("connection refused");
    });
    globalThis.fetch = fetchMock;

    const result = await tools.webSearch.execute({ query: "test" });
    expect(result.error).toBeDefined();
    expect(result.results).toEqual([]);
  });
});
