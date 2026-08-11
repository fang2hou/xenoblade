import { describe, it, expect } from "vitest";
import {
  SESSION_TTL_MS,
  MAX_CONTEXT_MESSAGES,
  MAX_CONTEXT_CHARS,
  type SelectableMessage,
  normalizeText,
  tokenize,
  hasContinuationWord,
  recencyScore,
  tokenOverlapRatio,
  relevanceScore,
  selectRelevantMessages,
  parseOneShotDirective,
} from "../../src/context-policy";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a SelectableMessage with sensible defaults. */
const msg = (
  id: string,
  text: string,
  timestampMs: number,
  authorId = "u1",
  authorName = "User",
  isBot = false,
): SelectableMessage => ({ id, text, timestampMs, authorId, authorName, isBot });

// ---------------------------------------------------------------------------
// normalizeText
// ---------------------------------------------------------------------------

describe("normalizeText", () => {
  it("strips user mentions <@id>", () => {
    expect(normalizeText("<@123> hello")).toBe("hello");
    expect(normalizeText("<@9999999> hi <@1>")).toBe("hi");
  });

  it("strips nickname mentions <@!id>", () => {
    expect(normalizeText("<@!123> hello")).toBe("hello");
  });

  it("strips role mentions <@&id>", () => {
    expect(normalizeText("<@&456> ping everyone")).toBe("ping everyone");
  });

  it("strips channel mentions <#id>", () => {
    expect(normalizeText("go to <#789> now")).toBe("go to now");
  });

  it("strips http and https URLs", () => {
    expect(normalizeText("check https://example.com/page?q=1 out")).toBe("check out");
    expect(normalizeText("see http://foo.bar/x")).toBe("see");
  });

  it("strips custom and animated emoji", () => {
    expect(normalizeText("wow <:smile:123> nice")).toBe("wow nice");
    expect(normalizeText("dance <a:groove:456>!")).toBe("dance !");
  });

  it("applies NFKC normalisation (fullwidth to ASCII)", () => {
    expect(normalizeText("ＡＢＣ")).toBe("ABC");
    expect(normalizeText("１２３")).toBe("123");
  });

  it("collapses repeated whitespace and trims", () => {
    expect(normalizeText("  hello   world  ")).toBe("hello world");
    expect(normalizeText("a\t\nb")).toBe("a b");
  });

  it("preserves regular text", () => {
    expect(normalizeText("Hello World")).toBe("Hello World");
    expect(normalizeText("你好世界")).toBe("你好世界");
  });

  it("returns empty string for mention-only input", () => {
    expect(normalizeText("<@123>")).toBe("");
    expect(normalizeText("<@1> <#2> https://x.com")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

describe("tokenize", () => {
  it("splits Latin words on whitespace", () => {
    expect(tokenize("hello world foo")).toEqual(["hello", "world", "foo"]);
  });

  it("extracts adjacent CJK bigrams", () => {
    // 世界你好 → bigrams 世界, 界你, 你好
    expect(tokenize("世界你好")).toEqual(["世界", "界你", "你好"]);
  });

  it("keeps a single CJK character as-is", () => {
    expect(tokenize("猫")).toEqual(["猫"]);
  });

  it("handles mixed Latin and CJK", () => {
    expect(tokenize("hello 世界")).toEqual(["hello", "世界"]);
  });

  it("lowercases Latin before tokenising", () => {
    expect(tokenize("Hello WORLD")).toEqual(["hello", "world"]);
  });

  it("filters English stopwords", () => {
    expect(tokenize("the cat is on the mat")).toEqual(["cat", "mat"]);
    expect(tokenize("what is it")).toEqual([]);
  });

  it("filters Chinese single-character stopwords", () => {
    // 的 is a stopword → filtered when alone
    expect(tokenize("的")).toEqual([]);
    // 我 is a stopword
    expect(tokenize("我")).toEqual([]);
  });

  it("does not filter CJK bigrams that happen to contain a stopword character", () => {
    // 我的 → bigram "我的" — 的 alone is a stopword but the bigram is not
    expect(tokenize("我的")).toEqual(["我的"]);
  });

  it("deduplicates tokens preserving first-occurrence order", () => {
    expect(tokenize("hello hello world")).toEqual(["hello", "world"]);
    // 世界世界 → bigrams 世界, 界世, 世界 → dedup → [世界, 界世]
    expect(tokenize("世界世界")).toEqual(["世界", "界世"]);
  });

  it("removes punctuation", () => {
    expect(tokenize("hello, world!")).toEqual(["hello", "world"]);
    expect(tokenize("hello-world test_case")).toEqual(["helloworld", "test_case"]);
  });

  it("returns empty array for empty or whitespace-only input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });

  it("strips Discord noise before tokenising", () => {
    expect(tokenize("<@123> hello world")).toEqual(["hello", "world"]);
  });
});

// ---------------------------------------------------------------------------
// hasContinuationWord
// ---------------------------------------------------------------------------

describe("hasContinuationWord", () => {
  it("detects English continuation words", () => {
    expect(hasContinuationWord("what about this?")).toBe(true);
    expect(hasContinuationWord("continue please")).toBe(true);
    expect(hasContinuationWord("why did you say that")).toBe(true);
    expect(hasContinuationWord("that is correct")).toBe(true);
  });

  it("detects multi-word English phrases", () => {
    expect(hasContinuationWord("how about lunch")).toBe(true);
    expect(hasContinuationWord("what about dinner")).toBe(true);
  });

  it("detects Chinese continuation words", () => {
    expect(hasContinuationWord("继续说")).toBe(true);
    expect(hasContinuationWord("这些是什么")).toBe(true);
    expect(hasContinuationWord("它的颜色")).toBe(true);
    expect(hasContinuationWord("刚才那个")).toBe(true);
    expect(hasContinuationWord("为什么不行")).toBe(true);
  });

  it("returns false for text without continuation words", () => {
    expect(hasContinuationWord("the weather is nice")).toBe(false);
    expect(hasContinuationWord("今天天气不错")).toBe(false);
    expect(hasContinuationWord("a simple question")).toBe(false);
  });

  it("does not false-positive on substrings (word boundary)", () => {
    // "it" inside "with" must NOT trigger
    expect(hasContinuationWord("I agree with you")).toBe(false);
    // "sit" contains "it" but no word boundary match
    expect(hasContinuationWord("sit down")).toBe(false);
  });

  it("is case-insensitive for English words", () => {
    expect(hasContinuationWord("Continue reading")).toBe(true);
    expect(hasContinuationWord("WHY not")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// recencyScore
// ---------------------------------------------------------------------------

describe("recencyScore", () => {
  it("returns 1 when the message is from now", () => {
    expect(recencyScore(1000, 1000)).toBe(1);
  });

  it("returns 1 for future timestamps", () => {
    expect(recencyScore(2000, 1000)).toBe(1);
  });

  it("returns 0 for messages older than the TTL", () => {
    expect(recencyScore(0, SESSION_TTL_MS)).toBe(0);
    expect(recencyScore(0, SESSION_TTL_MS + 1)).toBe(0);
  });

  it("decays linearly between now and TTL", () => {
    // Halfway through the TTL → 0.5
    expect(recencyScore(0, SESSION_TTL_MS / 2)).toBeCloseTo(0.5);
    // Quarter → 0.75
    expect(recencyScore(0, SESSION_TTL_MS / 4)).toBeCloseTo(0.75);
  });

  it("is always in [0, 1]", () => {
    for (let t = 0; t <= SESSION_TTL_MS; t += 60_000) {
      const score = recencyScore(0, t);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// tokenOverlapRatio
// ---------------------------------------------------------------------------

describe("tokenOverlapRatio", () => {
  it("returns 1 for identical token sets", () => {
    expect(tokenOverlapRatio(["a", "b"], ["a", "b"])).toBe(1);
    expect(tokenOverlapRatio(["a", "b"], ["b", "a"])).toBe(1);
  });

  it("returns 0 for completely disjoint sets", () => {
    expect(tokenOverlapRatio(["a"], ["b"])).toBe(0);
    expect(tokenOverlapRatio(["x", "y"], ["p", "q"])).toBe(0);
  });

  it("computes Jaccard similarity for partial overlap", () => {
    // intersection {b}, union {a, b, c} → 1/3
    expect(tokenOverlapRatio(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
    // intersection {a, b}, union {a, b, c, d} → 2/4 = 0.5
    expect(tokenOverlapRatio(["a", "b"], ["a", "b", "c", "d"])).toBeCloseTo(0.5);
  });

  it("returns 0 when both sets are empty", () => {
    expect(tokenOverlapRatio([], [])).toBe(0);
  });

  it("ignores duplicate tokens within a set", () => {
    expect(tokenOverlapRatio(["a", "a", "b"], ["a", "b"])).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// relevanceScore
// ---------------------------------------------------------------------------

describe("relevanceScore", () => {
  it("returns 1 for full overlap and max recency", () => {
    expect(relevanceScore(["a", "b"], ["a", "b"], 1)).toBeCloseTo(1);
  });

  it("returns 0 for no overlap and zero recency", () => {
    expect(relevanceScore(["a"], ["b"], 0)).toBe(0);
  });

  it("computes 0.75 * overlap + 0.25 * recency", () => {
    // overlap 1/3, recency 0.5 → 0.75 * 0.333… + 0.25 * 0.5 = 0.375
    expect(relevanceScore(["a", "b"], ["a", "c"], 0.5)).toBeCloseTo(0.375);
  });

  it("weights overlap more than recency", () => {
    const highOverlapLowRecency = relevanceScore(["a", "b"], ["a", "b"], 0);
    const lowOverlapHighRecency = relevanceScore(["a"], ["b"], 1);
    expect(highOverlapLowRecency).toBeGreaterThan(lowOverlapHighRecency);
  });
});

// ---------------------------------------------------------------------------
// selectRelevantMessages
// ---------------------------------------------------------------------------

describe("selectRelevantMessages", () => {
  it("excludes the current message by id", () => {
    const current = msg("c", "alpha beta", 1000, "u1");
    const candidates = [
      msg("c", "alpha beta", 999, "u1"), // same id as current
      msg("m1", "alpha beta gamma", 950, "u2"),
    ];
    const result = selectRelevantMessages(candidates, current, 1000);
    expect(result.every((m) => m.id !== "c")).toBe(true);
  });

  it("excludes messages with empty text", () => {
    const current = msg("c", "alpha", 1000);
    const candidates = [msg("empty", "   ", 950), msg("m1", "alpha beta", 900)];
    const result = selectRelevantMessages(candidates, current, 1000);
    expect(result.find((m) => m.id === "empty")).toBeUndefined();
  });

  it("filters out candidates below the relevance threshold", () => {
    const current = msg("c", "cat dog", 10_000);
    const candidates = [
      msg("relevant", "cat dog bird", 9900), // high overlap
      msg("irrelevant", "fish turtle", 9950), // no overlap
    ];
    const result = selectRelevantMessages(candidates, current, 10_000);
    expect(result.map((m) => m.id)).toEqual(["relevant"]);
  });

  it("returns at most MAX_CONTEXT_MESSAGES (8)", () => {
    const current = msg("c", "alpha beta", 20_000);
    const candidates = Array.from({ length: 12 }, (_, i) =>
      msg(`m${i}`, "alpha beta gamma", 20_000 - 100 - i),
    );
    const result = selectRelevantMessages(candidates, current, 20_000);
    expect(result.length).toBe(MAX_CONTEXT_MESSAGES);
  });

  it("returns results in oldest-first (timestamp ascending) order", () => {
    const current = msg("c", "alpha beta", 10_000);
    const candidates = [
      msg("newest", "alpha beta gamma", 9900),
      msg("oldest", "alpha beta gamma", 9500),
      msg("middle", "alpha beta gamma", 9700),
    ];
    const result = selectRelevantMessages(candidates, current, 10_000);
    const timestamps = result.map((m) => m.timestampMs);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
  });

  it("includes most recent bot reply and same-author message on continuation word", () => {
    // Current text "继续" has no token overlap with candidates.
    const current = msg("c", "继续", 10_000, "alice");
    const candidates = [
      msg("bot1", "unrelated stuff", 9800, "bot", "Bot", true),
      msg("alice1", "something else", 9600, "alice"),
      msg("bob1", "different topic", 9400, "bob"),
    ];
    const result = selectRelevantMessages(candidates, current, 10_000);
    const ids = result.map((m) => m.id);
    // Without continuation these would all be below threshold.
    // With "继续" the most-recent bot reply and same-author message are forced in.
    expect(ids).toContain("bot1");
    expect(ids).toContain("alice1");
  });

  it("does not duplicate continuation-forced messages already above threshold", () => {
    const current = msg("c", "继续 shared", 10_000, "alice");
    const candidates = [
      // This bot message shares "shared" → high overlap → above threshold
      msg("bot1", "shared context", 9800, "bot", "Bot", true),
      // This alice message shares "shared" → above threshold
      msg("alice1", "shared topic", 9600, "alice"),
    ];
    const result = selectRelevantMessages(candidates, current, 10_000);
    const ids = result.map((m) => m.id);
    // Each appears exactly once
    expect(ids.filter((id) => id === "bot1")).toHaveLength(1);
    expect(ids.filter((id) => id === "alice1")).toHaveLength(1);
  });

  it("trims from the oldest end when total characters exceed the cap", () => {
    const current = msg("c", "shared", 10_000);
    // Each message is 2100 chars → 3 × 2100 = 6300 > 6000 cap.
    // Oldest (m0) should be removed → 4200 ≤ 6000.
    const longText = (marker: string) => `shared ${marker.repeat(2093)}`;
    const candidates = [
      msg("m0", longText("a"), 100),
      msg("m1", longText("b"), 200),
      msg("m2", longText("c"), 300),
    ];
    const result = selectRelevantMessages(candidates, current, 10_000);
    expect(result.map((m) => m.id)).toEqual(["m1", "m2"]);
    const totalChars = result.reduce((sum, m) => sum + [...m.text].length, 0);
    expect(totalChars).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
  });

  it("returns empty array when no candidates are relevant", () => {
    const current = msg("c", "unique tokens here", 10_000);
    const candidates = [
      msg("m1", "completely different words", 9900),
      msg("m2", "no overlap whatsoever", 9800),
    ];
    const result = selectRelevantMessages(candidates, current, 10_000);
    expect(result).toEqual([]);
  });

  it("returns empty array for empty candidates", () => {
    const current = msg("c", "hello", 1000);
    expect(selectRelevantMessages([], current, 1000)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseOneShotDirective
// ---------------------------------------------------------------------------

describe("parseOneShotDirective", () => {
  it.each([
    "不用参考之前的",
    "不要参考之前的",
    "忽略之前的上下文",
    "不参考上下文",
    "不用参考上下文",
    "不要参考上下文",
    "忽略之前的",
    "不要之前",
    "不用之前",
  ])("returns true for directive %p", (phrase) => {
    expect(parseOneShotDirective(phrase)).toBe(true);
  });

  it("returns true when a directive is embedded in larger text", () => {
    expect(parseOneShotDirective("嗯，不用参考之前的了，直接回答")).toBe(true);
    expect(parseOneShotDirective("please 不用参考之前的 thanks")).toBe(true);
  });

  it("returns false for casual text without directives", () => {
    expect(parseOneShotDirective("你好")).toBe(false);
    expect(parseOneShotDirective("what happened before?")).toBe(false);
    expect(parseOneShotDirective("参考一下这个")).toBe(false);
    expect(parseOneShotDirective("之前的聊天很有趣")).toBe(false);
    expect(parseOneShotDirective("hello world")).toBe(false);
    expect(parseOneShotDirective("")).toBe(false);
  });

  it("handles NFKC fullwidth variants", () => {
    // Fullwidth colon U+FF1A → ASCII colon under NFKC
    expect(parseOneShotDirective("：不用参考之前的")).toBe(true);
    // Fullwidth space U+3000 → regular space under NFKC, then trimmed
    expect(parseOneShotDirective("\u3000不用参考之前的\u3000")).toBe(true);
    // Fullwidth Latin letters → ASCII under NFKC (robustness check)
    expect(parseOneShotDirective("不用参考之前的")).toBe(true);
  });

  it("handles extra whitespace around the directive", () => {
    expect(parseOneShotDirective("  不用参考之前的  ")).toBe(true);
    // Newlines around (not inside) the directive are collapsed/trimmed away
    expect(parseOneShotDirective("\n\n不用参考之前的\n")).toBe(true);
  });
});
