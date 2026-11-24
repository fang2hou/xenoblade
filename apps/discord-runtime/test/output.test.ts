import { describe, it, expect } from "vitest";
import { MessageFlags } from "discord.js";
import type { SendableChannels } from "discord.js";

import { postReply, sliceIntoChunks } from "../src/output";

describe("postReply", () => {
  it("sends every chunk with SuppressEmbeds so Discord renders no link preview cards", async () => {
    const sent: Array<{ content: string; flags?: number }> = [];
    const channel = {
      send: async (options: { content: string; flags?: number }) => {
        sent.push(options);
        return { id: `m${sent.length}` };
      },
    } as unknown as SendableChannels;

    const content = ["a".repeat(1_500), "b".repeat(1_500)].join("\n");
    const posted = await postReply(channel, content);

    expect(sent).toEqual([
      { content: "a".repeat(1_500), flags: MessageFlags.SuppressEmbeds },
      { content: "b".repeat(1_500), flags: MessageFlags.SuppressEmbeds },
    ]);
    expect(posted.map((message) => message.id)).toEqual(["m1", "m2"]);
  });
});

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

describe("sliceIntoChunks code fences", () => {
  it("closes an open code block at a chunk boundary and reopens it with its language tag", () => {
    const text = [
      "Intro.",
      "```ts",
      "const a = 1;",
      "const b = 2;",
      "const c = 3;",
      "const d = 4;",
      "const e = 5;",
      "```",
      "Outro.",
    ].join("\n");

    expect(sliceIntoChunks(text, 60)).toEqual([
      "Intro.\n```ts\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```",
      "```ts\nconst d = 4;\nconst e = 5;\n```\nOutro.",
    ]);
  });

  it("closes and reopens around hard-wrapped pieces inside a code block", () => {
    expect(sliceIntoChunks("```js\n" + "x".repeat(100) + "\n```", 60)).toEqual([
      "```js\n" + "x".repeat(44) + "\n```",
      "```js\n" + "x".repeat(50) + "\n```",
      "```js\n" + "x".repeat(6) + "\n```",
    ]);
  });

  it("never ends a chunk right after an opening fence line", () => {
    const text = ["a".repeat(30), "```py", "print(1)", "```", "b".repeat(30)].join("\n");

    expect(sliceIntoChunks(text, 40)).toEqual([
      "a".repeat(30),
      "```py\nprint(1)\n```",
      "b".repeat(30),
    ]);
  });

  it("closes an unterminated code block at the end of every chunk", () => {
    expect(sliceIntoChunks("```\n" + "a".repeat(70), 40)).toEqual([
      "```\n" + "a".repeat(28) + "\n```",
      "```\n" + "a".repeat(32) + "\n```",
      "```\n" + "a".repeat(10) + "\n```",
    ]);
  });

  it("reads tilde fences too", () => {
    const text = ["~~~sh", "echo one", "echo two", "echo three", "~~~"].join("\n");

    expect(sliceIntoChunks(text, 27)).toEqual([
      "~~~sh\necho one\necho two\n~~~",
      "~~~sh\necho three\n~~~",
    ]);
  });

  it("treats a shorter fence line inside a longer fence as code, not as its close", () => {
    const text = ["````md", "```ts", "let x;", "```", "````", "after"].join("\n");

    expect(sliceIntoChunks(text, 24)).toEqual([
      "````md\n```ts\nlet x;\n````",
      "````md\n```\n````\nafter",
    ]);
  });

  it("keeps every chunk within the limit and fence-balanced on mixed content", () => {
    const max = 80;
    const text = [
      "plain line ".repeat(40),
      "```ts",
      `const url = "https://example.com/${"p".repeat(200)}";`,
      "const short = 1;",
      "```",
      "between",
      "````md",
      "```",
      "inner",
      "````",
      "~~~",
      "tilde ".repeat(30),
      "~~~",
      "[link](<https://example.com/" + "q".repeat(60) + ">) and " + "tail ".repeat(40),
    ].join("\n");
    const chunks = sliceIntoChunks(text, max);

    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(max);
      expect(endsInsideFence(chunk)).toBe(false);
    }
    // Every non-fence line survives, in order, with nothing duplicated.
    const content = (value: string) =>
      value
        .split("\n")
        .filter((line) => !FENCE_LINE.test(line))
        .join("");
    expect(chunks.map(content).join("")).toBe(content(text));
  });
});

const FENCE_LINE = /^ {0,3}(([`~])\2{2,})(.*)$/;

describe("sliceIntoChunks blank lines", () => {
  it("never emits a chunk made of blank lines alone", () => {
    // A blank line that cannot share a chunk with what follows is dropped,
    // not flushed as an empty message Discord would refuse.
    expect(sliceIntoChunks("x".repeat(24) + "\n\n", 24)).toEqual(["x".repeat(24)]);
    expect(sliceIntoChunks("\n" + "x".repeat(24) + "\n\n" + "y".repeat(24), 24)).toEqual([
      "x".repeat(24),
      "y".repeat(24),
    ]);
  });
});

/** Independent line tracker: is a fenced block still open at the end of `chunk`? */
function endsInsideFence(chunk: string): boolean {
  let open: string | null = null;
  for (const line of chunk.split("\n")) {
    const match = FENCE_LINE.exec(line);
    if (match === null) continue;
    const marker = match[1] ?? "";
    const rest = match[3] ?? "";
    if (open === null) {
      open = marker;
    } else if (rest.trim() === "" && marker[0] === open[0] && marker.length >= open.length) {
      open = null;
    }
  }
  return open !== null;
}
