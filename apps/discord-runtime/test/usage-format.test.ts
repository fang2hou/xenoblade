import { describe, expect, it } from "vitest";
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
      "en",
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
    const text = formatUsageSummary(summary(), "en");
    expect(text).not.toContain("Top tools");
    expect(text.split("\n")).toHaveLength(7);
  });

  it("derives the window label from windowMs", () => {
    const text = formatUsageSummary(summary({ windowMs: 12 * 60 * 60 * 1000 }), "en");
    expect(text).toContain("**You — last 12h**");
    expect(text).toContain("**Server — last 12h**");
  });
});

describe("formatUsageSummary zh", () => {
  it("renders the localized labels", () => {
    const text = formatUsageSummary(
      summary({
        user: {
          messages: 1,
          generations: 1,
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          topTools: [{ tool: "web_search", count: 2 }],
        },
      }),
      "zh",
    );
    expect(text).toContain("**你 — 最近 24 小时**");
    expect(text).toContain("**服务器 — 最近 24 小时**");
    expect(text).toContain("生成次数:");
    expect(text).toContain("常用工具");
  });
});
