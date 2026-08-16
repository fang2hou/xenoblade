import { describe, it, expect } from "vitest";
import type { UsageSummary } from "@xenoblade/contracts";

import { formatUsageSummary } from "../src/usage";

function summary(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return {
    windowMs: 24 * 60 * 60 * 1000,
    user: {
      messages: 0,
      generations: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      topTools: [],
    },
    guild: {
      messages: 0,
      generations: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      topTools: [],
    },
    ...overrides,
  };
}

describe("formatUsageSummary", () => {
  it("renders both subjects with counts and grouped token numbers", () => {
    const text = formatUsageSummary(
      summary({
        user: {
          messages: 5,
          generations: 3,
          inputTokens: 12345,
          outputTokens: 6789,
          cacheReadTokens: 100,
          cacheWriteTokens: 0,
          topTools: [
            { tool: "web_search", count: 6 },
            { tool: "read_url", count: 2 },
          ],
        },
        guild: {
          messages: 51,
          generations: 42,
          inputTokens: 1234567,
          outputTokens: 234567,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          topTools: [{ tool: "web_search", count: 12 }],
        },
      }),
    );

    expect(text).toBe(
      [
        "**You — last 24h**",
        "Generations: 3 · Messages: 5",
        "Tokens: 12,345 in · 6,789 out · 100 cache read · 0 cache write",
        "Top tools: web_search ×6 · read_url ×2",
        "",
        "**Server — last 24h**",
        "Generations: 42 · Messages: 51",
        "Tokens: 1,234,567 in · 234,567 out · 0 cache read · 0 cache write",
        "Top tools: web_search ×12",
      ].join("\n"),
    );
  });

  it("omits the top tools line when no tools were invoked", () => {
    const text = formatUsageSummary(summary());

    expect(text).not.toContain("Top tools");
    expect(text.split("\n")).toHaveLength(7);
  });

  it("derives the window label from windowMs", () => {
    const text = formatUsageSummary(summary({ windowMs: 12 * 60 * 60 * 1000 }));

    expect(text).toContain("**You — last 12h**");
    expect(text).toContain("**Server — last 12h**");
  });
});
