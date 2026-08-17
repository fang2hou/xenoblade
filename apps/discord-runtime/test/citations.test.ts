import { describe, it, expect } from "vitest";

import { renderReply, stripModelSourcesFooter } from "../src/citations";

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
  it("returns the body with no footer and no masking needed", () => {
    expect(renderReply("Plain answer.")).toBe("Plain answer.");
  });

  it("strips a model-rendered footer and zh 来源 footers", () => {
    expect(renderReply("Answer [来源](https://a).\n**Sources:**\n[1] A — https://a")).toBe(
      "Answer [来源](https://a).",
    );
    expect(renderReply("回答。\n来源：https://a")).toBe("回答。");
  });

  it("masks bare URLs so Discord renders no preview cards", () => {
    expect(renderReply("Read https://example.com/page for details.")).toBe(
      "Read [https://example.com/page](https://example.com/page) for details.",
    );
  });

  it("keeps sentence punctuation outside the masked URL", () => {
    expect(renderReply("See https://example.com/a, then https://example.com/b!")).toBe(
      "See [https://example.com/a](https://example.com/a), then [https://example.com/b](https://example.com/b)!",
    );
  });

  it("leaves masked links and angle-bracket URLs untouched", () => {
    const text = "See [来源](https://a/x?y=1) and <https://b/z>.";
    expect(renderReply(text)).toBe(text);
  });

  it("leaves URLs inside code fences and inline code verbatim", () => {
    const fenced = "Example:\n```\ncurl https://example.com/api\n```\ndone";
    expect(renderReply(fenced)).toBe(fenced);
    expect(renderReply("run `npm view https://example.com` now")).toBe(
      "run `npm view https://example.com` now",
    );
  });
});
