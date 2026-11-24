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
      "Answer [来源](<https://a>).",
    );
    expect(renderReply("回答。\n来源：https://a")).toBe("回答。");
  });

  it("masks bare URLs so Discord renders no preview cards", () => {
    expect(renderReply("Read https://example.com/page for details.")).toBe(
      "Read [https://example.com/page](<https://example.com/page>) for details.",
    );
  });

  it("keeps sentence punctuation outside the masked URL", () => {
    expect(renderReply("See https://example.com/a, then https://example.com/b!")).toBe(
      "See [https://example.com/a](<https://example.com/a>), then [https://example.com/b](<https://example.com/b>)!",
    );
  });

  it("keeps a balanced closing parenthesis that belongs to the URL", () => {
    const url = "https://en.wikipedia.org/wiki/Xenoblade_Chronicles_(series)";
    expect(renderReply(`See ${url}.`)).toBe(`See [${url}](<${url}>).`);
  });

  it("still strips an unbalanced closing parenthesis after a bare URL", () => {
    expect(renderReply("(see https://example.com/a)")).toBe(
      "(see [https://example.com/a](<https://example.com/a>))",
    );
  });

  it("wraps a model-written masked link target in angle brackets", () => {
    expect(renderReply("See [来源](https://a/x?y=1).")).toBe("See [来源](<https://a/x?y=1>).");
    expect(renderReply("[Foo](https://en.wikipedia.org/wiki/Foo_(bar))")).toBe(
      "[Foo](<https://en.wikipedia.org/wiki/Foo_(bar)>)",
    );
  });

  it("does not mask a URL that is its own link label a second time", () => {
    expect(renderReply("[https://a.com](https://a.com)")).toBe("[https://a.com](<https://a.com>)");
  });

  it("leaves angle-bracketed masked links and URLs untouched", () => {
    const text = "See [来源](<https://a/x?y=1>) and <https://b/z>.";
    expect(renderReply(text)).toBe(text);
  });

  it("leaves links inside code fences and inline code verbatim", () => {
    const fenced = "Example:\n```\ncurl https://example.com/api\n[a](https://a.com)\n```\ndone";
    expect(renderReply(fenced)).toBe(fenced);
    expect(renderReply("run `npm view https://example.com [a](https://a.com)` now")).toBe(
      "run `npm view https://example.com [a](https://a.com)` now",
    );
  });

  it("leaves links inside tilde and longer backtick fences verbatim, terminated or not", () => {
    const blocks = [
      "~~~sh\ncurl https://example.com/api\n[a](https://a.com)\n~~~",
      "````md\n```ts\nopen https://example.com\n```\n````",
      "```ts\nopen https://example.com",
    ];
    for (const block of blocks) {
      expect(renderReply(block)).toBe(block);
    }
  });

  it("still masks the links in the prose around such fences", () => {
    expect(renderReply("see https://a.com\n~~~\nkeep https://b.com\n~~~\nand https://c.com")).toBe(
      "see [https://a.com](<https://a.com>)\n~~~\nkeep https://b.com\n~~~\nand [https://c.com](<https://c.com>)",
    );
  });
});
