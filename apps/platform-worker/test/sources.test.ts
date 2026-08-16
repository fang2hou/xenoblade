import { describe, it, expect } from "vitest";

import { extractSources } from "../src/sources";

describe("extractSources", () => {
  it("returns empty for no tool results", () => {
    expect(extractSources([])).toEqual([]);
  });

  it("numbers web_search results sequentially across invocations", () => {
    const sources = extractSources([
      {
        toolName: "web_search",
        output: {
          results: [
            { title: "First", url: "https://a", description: "x" },
            { title: "Second", url: "https://b", description: "x" },
          ],
        },
      },
      {
        toolName: "web_search",
        output: {
          results: [{ title: "Third", url: "https://c", description: "x" }],
        },
      },
    ]);

    expect(sources).toEqual([
      { index: 1, title: "First", url: "https://a" },
      { index: 2, title: "Second", url: "https://b" },
      { index: 3, title: "Third", url: "https://c" },
    ]);
  });

  it("ignores non-search tools — only web_search carries URLs", () => {
    const sources = extractSources([
      { toolName: "web_answer", output: { answer: "42", results: [{ url: "https://x" }] } },
      { toolName: "read_url", output: { text: "…", url: "https://y" } },
      { toolName: "web_search", output: { results: [{ title: "Kept", url: "https://z" }] } },
    ]);

    expect(sources).toEqual([{ index: 1, title: "Kept", url: "https://z" }]);
  });

  it("drops results without a URL and falls back to the URL for missing titles", () => {
    const sources = extractSources([
      {
        toolName: "web_search",
        output: {
          results: [
            { title: "No URL", description: "x" },
            { title: "", url: "https://empty-title" },
            { url: "https://no-title" },
            { title: "Good", url: "https://good" },
          ],
        },
      },
    ]);

    expect(sources).toEqual([
      { index: 1, title: "https://empty-title", url: "https://empty-title" },
      { index: 2, title: "https://no-title", url: "https://no-title" },
      { index: 3, title: "Good", url: "https://good" },
    ]);
  });

  it("ignores malformed tool output shapes", () => {
    const sources = extractSources([
      { toolName: "web_search", output: "not an object" },
      { toolName: "web_search", output: null },
      { toolName: "web_search", output: {} },
      { toolName: "web_search", output: { results: "not a list" } },
      { toolName: "web_search", output: { results: [null, 7, "str"] } },
    ]);

    expect(sources).toEqual([]);
  });
});
