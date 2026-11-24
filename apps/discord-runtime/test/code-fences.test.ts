import { describe, expect, it } from "vitest";

import { isClosingFence, parseOpeningFence, splitCodeSegments } from "../src/code-fences";

const BACKTICKS = { marker: "```", info: "" };
const FOUR_BACKTICKS = { marker: "````", info: "md" };

describe("parseOpeningFence", () => {
  it("reads the marker and the info string of an opening fence", () => {
    expect(parseOpeningFence("```ts")).toEqual({ marker: "```", info: "ts" });
    expect(parseOpeningFence("  ~~~ sh ")).toEqual({ marker: "~~~", info: "sh" });
    expect(parseOpeningFence("````md")).toEqual(FOUR_BACKTICKS);
  });

  it("opens on a CRLF line as on an LF line", () => {
    expect(parseOpeningFence("```ts\r")).toEqual({ marker: "```", info: "ts" });
    expect(parseOpeningFence("~~~sh\r")).toEqual({ marker: "~~~", info: "sh" });
  });

  it("opens no backtick fence whose info string holds a backtick", () => {
    expect(parseOpeningFence("```foo`bar")).toBeNull();
    // A tilde fence's info string may hold anything.
    expect(parseOpeningFence("~~~foo`bar")).toEqual({ marker: "~~~", info: "foo`bar" });
  });

  it("opens only with at most three leading spaces", () => {
    expect(parseOpeningFence("   ```ts")).not.toBeNull();
    expect(parseOpeningFence("    ```ts")).toBeNull();
  });

  it("returns null for ordinary text and for a fence that does not start the line", () => {
    expect(parseOpeningFence("code")).toBeNull();
    expect(parseOpeningFence("text ```ts")).toBeNull();
    expect(parseOpeningFence("``ts")).toBeNull();
  });
});

describe("isClosingFence", () => {
  it("closes on the same character, at least as long, with nothing else", () => {
    expect(isClosingFence("```", BACKTICKS)).toBe(true);
    expect(isClosingFence("```   ", BACKTICKS)).toBe(true);
    expect(isClosingFence("````", BACKTICKS)).toBe(true);
    expect(isClosingFence("~~~", FOUR_BACKTICKS)).toBe(false);
    expect(isClosingFence("```", FOUR_BACKTICKS)).toBe(false);
    expect(isClosingFence("```ts", BACKTICKS)).toBe(false);
  });

  it("closes only with at most three leading spaces — deeper indentation is code content", () => {
    expect(isClosingFence("   ```", BACKTICKS)).toBe(true);
    expect(isClosingFence("    ```", BACKTICKS)).toBe(false);
  });

  it("closes on a CRLF line as on an LF line", () => {
    expect(isClosingFence("```\r", BACKTICKS)).toBe(true);
    expect(isClosingFence("```   \r", BACKTICKS)).toBe(true);
    expect(isClosingFence("~~~\r", BACKTICKS)).toBe(false);
  });
});

describe("splitCodeSegments", () => {
  it("alternates prose and fenced code, fence lines included in the code", () => {
    expect(splitCodeSegments("before\n```ts\nlet x;\n```\nafter")).toEqual([
      { text: "before\n", code: false },
      { text: "```ts\nlet x;\n```\n", code: true },
      { text: "after", code: false },
    ]);
  });

  it("reads a CRLF text the same way, keeping its line endings", () => {
    expect(splitCodeSegments("before\r\n```ts\r\nlet x;\r\n```\r\nafter")).toEqual([
      { text: "before\r\n", code: false },
      { text: "```ts\r\nlet x;\r\n```\r\n", code: true },
      { text: "after", code: false },
    ]);
  });

  it("leaves an inline triple-backtick span holding a backtick as prose", () => {
    expect(splitCodeSegments("```foo`bar\nsee https://a.com")).toEqual([
      { text: "```foo`bar\nsee https://a.com", code: false },
    ]);
  });

  it("keeps a shorter fence line inside a longer fence as code", () => {
    const block = "````md\n```\ninner\n````\n";
    expect(splitCodeSegments(`${block}after`)).toEqual([
      { text: block, code: true },
      { text: "after", code: false },
    ]);
  });

  it("runs an unterminated block to the end of the text", () => {
    expect(splitCodeSegments("before\n~~~\nlet x;")).toEqual([
      { text: "before\n", code: false },
      { text: "~~~\nlet x;", code: true },
    ]);
  });

  it("does not let an opening fence close itself", () => {
    expect(splitCodeSegments("```\nlet x;\n```")).toEqual([
      { text: "```\nlet x;\n```", code: true },
    ]);
  });

  it("joins back to the text for a lone fence line and for text without fences", () => {
    expect(splitCodeSegments("```\nlet x;")).toEqual([{ text: "```\nlet x;", code: true }]);
    expect(splitCodeSegments("plain `inline` text")).toEqual([
      { text: "plain `inline` text", code: false },
    ]);
  });
});
