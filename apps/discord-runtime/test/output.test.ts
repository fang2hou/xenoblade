import { describe, it, expect } from "vitest";

import { sliceIntoChunks } from "../src/output";

describe("sliceIntoChunks link safety", () => {
  it("never splits inside a masked link when hard-wrapping a long line", () => {
    const link = `[来源](https://example.com/a/very/long/path?query=${"x".repeat(160)})`;
    const paragraph = `${"front ".repeat(200)} ${link} ${"tail ".repeat(200)}`;
    const chunks = sliceIntoChunks(paragraph, 2000);

    // The link survives intact in exactly one chunk.
    expect(chunks.filter((chunk) => chunk.includes(link))).toHaveLength(1);
    // No chunk ends with a dangling masked-link opener (cut inside a link).
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/\]\([^)]*$/);
    }
  });

  it("keeps every chunk within the limit", () => {
    const paragraph = "https://example.com/".repeat(120);
    const chunks = sliceIntoChunks(paragraph, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });

  it("still prefers newline boundaries for multi-paragraph text", () => {
    const text = `${"a".repeat(1500)}\n${"b".repeat(1500)}`;
    expect(sliceIntoChunks(text, 2000)).toEqual(["a".repeat(1500), "b".repeat(1500)]);
  });

  it("returns short text as a single chunk", () => {
    expect(sliceIntoChunks("short", 2000)).toEqual(["short"]);
  });
});
