import { describe, it, expect } from "vitest";
import type { GenerationSource } from "@xenoblade/contracts";

import { renderReply, stripModelSourcesFooter } from "../src/citations";

function source(index: number, title: string, url: string): GenerationSource {
  return { index, title, url };
}

describe("stripModelSourcesFooter", () => {
  it("strips a single-line bold footer", () => {
    expect(stripModelSourcesFooter("Answer.\n**Sources:** [a](https://a)")).toBe("Answer.");
  });

  it("strips a multi-line numbered list footer", () => {
    const reply = "Answer.\n**Sources:**\n[1] a — https://a\n[2] b — https://b";
    expect(stripModelSourcesFooter(reply)).toBe("Answer.");
  });

  it("strips plain and bold variants with surrounding blank lines", () => {
    expect(stripModelSourcesFooter("Answer.\n\nSources: [a](https://a)\n")).toBe("Answer.");
    expect(stripModelSourcesFooter("Answer.\n\n**Sources**:\n[a](https://a)")).toBe("Answer.");
  });

  it("strips a footer that is the entire reply", () => {
    expect(stripModelSourcesFooter("**Sources:** [a](https://a)")).toBe("");
  });

  it("keeps mid-reply mentions of sources followed by prose", () => {
    const reply = [
      "The config defines several sources:",
      " ".repeat(10) + "x".repeat(600), // long prose line after the mention
      "More body text.",
    ].join("\n");
    expect(stripModelSourcesFooter(reply)).toBe(reply);
  });

  it("keeps replies that merely mention the word sources without a colon", () => {
    expect(stripModelSourcesFooter("See the sources list in the docs")).toBe(
      "See the sources list in the docs",
    );
  });
});

describe("renderReply", () => {
  it("appends a single canonical footer from structured sources", () => {
    const text = renderReply("See [1] and [2].", [
      source(1, "A", "https://a"),
      source(2, "B", "https://b"),
    ]);
    expect(text).toBe("See [1] and [2].\n\n**Sources:** [1] [A](https://a) · [2] [B](https://b)");
  });

  it("replaces a model-rendered footer with the canonical one", () => {
    const text = renderReply("Answer [1].\n**Sources:**\n[1] Some Site — https://a", [
      source(1, "Some Site", "https://a"),
    ]);
    expect(text).toBe("Answer [1].\n\n**Sources:** [1] [Some Site](https://a)");
  });

  it("adds no footer when the source list is empty", () => {
    expect(renderReply("Plain answer.", [])).toBe("Plain answer.");
    expect(renderReply("Plain answer.\n**Sources:** [a](https://a)", [])).toBe("Plain answer.");
  });
});
