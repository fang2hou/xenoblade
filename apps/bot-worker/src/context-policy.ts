/**
 * Pure-function module for Discord context relevance scoring and one-shot
 * directive parsing.
 *
 * No I/O, no imports from `chat` or `@xenoblade/db`. Only standard JavaScript
 * APIs are used so every function is trivially unit-testable.
 */

// ---------------------------------------------------------------------------
// Tunable constants
// ---------------------------------------------------------------------------

/** Session TTL: 30 minutes in milliseconds. */
export const SESSION_TTL_MS = 30 * 60 * 1000;

/** Minimum relevance score for a candidate message to enter the context window. */
export const RELEVANCE_THRESHOLD = 0.35;

/** Maximum number of messages selected by relevance scoring. */
export const MAX_CONTEXT_MESSAGES = 8;

/** Maximum messages retained in a forced channel context (reply-to-bot, etc.). */
export const MAX_FORCED_CHANNEL_MESSAGES = 12;

/** Maximum total Unicode characters across the selected context messages. */
export const MAX_CONTEXT_CHARS = 6_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal, serialisable view of a Discord message used for relevance scoring.
 * Intentionally local — does NOT import `Message` from `chat`.
 */
export interface SelectableMessage {
  readonly id: string;
  readonly text: string;
  readonly timestampMs: number;
  readonly authorId: string;
  readonly authorName: string;
  readonly isBot: boolean;
}

// ---------------------------------------------------------------------------
// Word lists
// ---------------------------------------------------------------------------

/**
 * Common English and Chinese function words removed before relevance scoring.
 * All entries are lowercase; the tokenizer lowercases before consulting this
 * table.
 */
const STOPWORDS: Record<string, true> = {
  // English
  the: true,
  a: true,
  an: true,
  is: true,
  are: true,
  was: true,
  were: true,
  be: true,
  been: true,
  to: true,
  of: true,
  in: true,
  on: true,
  at: true,
  for: true,
  and: true,
  or: true,
  but: true,
  not: true,
  no: true,
  yes: true,
  i: true,
  you: true,
  he: true,
  she: true,
  it: true,
  we: true,
  they: true,
  me: true,
  him: true,
  her: true,
  us: true,
  them: true,
  my: true,
  your: true,
  his: true,
  its: true,
  our: true,
  their: true,
  this: true,
  that: true,
  these: true,
  those: true,
  do: true,
  does: true,
  did: true,
  will: true,
  would: true,
  can: true,
  could: true,
  should: true,
  what: true,
  when: true,
  where: true,
  why: true,
  how: true,
  which: true,
  who: true,
  // Chinese
  的: true,
  了: true,
  是: true,
  在: true,
  我: true,
  你: true,
  他: true,
  她: true,
  它: true,
  们: true,
  和: true,
  与: true,
  或: true,
  但: true,
  不: true,
  没: true,
  有: true,
  也: true,
  都: true,
  就: true,
  还: true,
  又: true,
  已: true,
  吗: true,
  呢: true,
  吧: true,
  啊: true,
  哦: true,
  嗯: true,
  这: true,
  那: true,
  个: true,
  些: true,
  里: true,
  上: true,
  下: true,
};

/**
 * Words and phrases that signal the current message is a continuation of a
 * prior exchange. When detected, {@link selectRelevantMessages} guarantees the
 * most recent bot reply and same-author message are included even if their
 * relevance score is below threshold.
 *
 * Order matters — {@link LATIN_CONTINUATION_RE} relies on deterministic
 * iteration order for stable regex compilation.
 */
const CONTINUATION_WORDS: Record<string, true> = {
  这些: true,
  那个: true,
  它: true,
  上面: true,
  刚才: true,
  继续: true,
  为什么: true,
  还有: true,
  那里: true,
  这里: true,
  this: true,
  that: true,
  it: true,
  continue: true,
  why: true,
  "how about": true,
  "what about": true,
};

// ---------------------------------------------------------------------------
// Text normalisation
// ---------------------------------------------------------------------------

/** Unicode code-point ranges treated as CJK for tokenisation purposes. */
const CJK_RANGES = "\\u4e00-\\u9fff\\u3400-\\u4dbf\\u3000-\\u303f\\uff00-\\uffef";

/** Matches a maximal run of CJK characters or a maximal run of Latin/digit/_. */
const TOKEN_PATTERN = new RegExp(`[${CJK_RANGES}]+|[a-z0-9_]+`, "g");

/** Removes every character that is not a word char, CJK, or whitespace. */
const PUNCTUATION_PATTERN = new RegExp(`[^\\w\\s${CJK_RANGES}]`, "g");

/** Mentions, roles, channels, URLs, and custom emoji stripped before scoring. */
const DISCORD_NOISE_PATTERNS: readonly RegExp[] = [
  /<@!\d+>/g, // nickname mention  <@!123>
  /<@\d+>/g, // user mention       <@123>
  /<@&\d+>/g, // role mention       <@&123>
  /<#\d+>/g, // channel mention     <#123>
  /https?:\/\/\S+/g, // URLs
  /<a?:\w+:\d+>/g, // custom emoji  <:name:123> / <a:name:123>
];

/**
 * Strip Discord-specific noise (mentions, role/channel tags, custom emoji) and
 * URLs from `text`, apply NFKC normalisation, and collapse whitespace.
 *
 * Lowercasing is intentionally NOT performed here — it happens inside
 * {@link tokenize} so that callers like {@link hasContinuationWord} can perform
 * case-sensitive matching when needed.
 */
export function normalizeText(text: string): string {
  let result = text.normalize("NFKC");
  for (const pattern of DISCORD_NOISE_PATTERNS) {
    result = result.replace(pattern, "");
  }
  return result.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Tokenisation
// ---------------------------------------------------------------------------

/**
 * Split `text` into normalised, deduplicated tokens suitable for relevance
 * scoring.
 *
 * 1. {@link normalizeText} the input.
 * 2. Remove remaining punctuation (keep word chars, CJK, spaces).
 * 3. Lowercase.
 * 4. Extract tokens — Latin/digit runs become word tokens; CJK runs become
 *    adjacent character bigrams (a single CJK character is kept as-is).
 * 5. Filter out {@link STOPWORDS} and empty strings.
 * 6. Deduplicate, preserving first-occurrence order.
 */
export function tokenize(text: string): string[] {
  const cleaned = normalizeText(text).replace(PUNCTUATION_PATTERN, "").toLowerCase();

  const raw: string[] = [];
  for (const match of cleaned.matchAll(TOKEN_PATTERN)) {
    const segment = match[0];
    if (/[a-z0-9_]/.test(segment[0]!)) {
      raw.push(segment);
    } else {
      const chars = [...segment];
      if (chars.length === 1) {
        raw.push(chars[0]!);
      } else {
        for (let i = 0; i < chars.length - 1; i++) {
          raw.push(chars[i]! + chars[i + 1]!);
        }
      }
    }
  }

  return [
    ...new Set(
      raw.filter((t) => t.length > 0 && !Object.prototype.hasOwnProperty.call(STOPWORDS, t)),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Continuation detection
// ---------------------------------------------------------------------------

/**
 * Pre-compiled word-boundary regex for Latin continuation words
 * (case-insensitive). Word boundaries prevent false positives such as "it"
 * inside "with".
 */
const LATIN_CONTINUATION_RE = new RegExp(
  Object.keys(CONTINUATION_WORDS)
    .filter((w) => /^[a-z]/.test(w))
    .map((w) => `\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`)
    .join("|"),
  "i",
);

/** CJK continuation words checked via plain substring inclusion. */
const CJK_CONTINUATION_WORDS = Object.keys(CONTINUATION_WORDS).filter((w) => !/^[a-z]/.test(w));

/**
 * Detect whether `text` references a prior message ("it", "继续", "that", …).
 *
 * Latin words are matched with word boundaries to avoid false positives;
 * CJK words are matched as substrings because tokenisation produces bigrams
 * that split multi-character words.
 */
export function hasContinuationWord(text: string): boolean {
  const normalized = normalizeText(text);
  if (LATIN_CONTINUATION_RE.test(normalized)) return true;
  return CJK_CONTINUATION_WORDS.some((w) => normalized.includes(w));
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Linear recency decay over {@link SESSION_TTL_MS}.
 *
 * Returns `1` for now or the future, `0` for anything older than the TTL, and a
 * linearly interpolated value in `[0, 1]` in between.
 */
export function recencyScore(timestampMs: number, nowMs: number): number {
  const elapsed = nowMs - timestampMs;
  if (elapsed < 0) return 1;
  if (elapsed > SESSION_TTL_MS) return 0;
  return 1 - elapsed / SESSION_TTL_MS;
}

/**
 * Jaccard similarity between two token sets: `|A ∩ B| / |A ∪ B|`.
 * Returns `0` when the union is empty.
 */
export function tokenOverlapRatio(candidateTokens: string[], currentTokens: string[]): number {
  const candidateSet = new Set(candidateTokens);
  const currentSet = new Set(currentTokens);
  let intersection = 0;
  for (const t of candidateSet) {
    if (currentSet.has(t)) intersection++;
  }
  const union = candidateSet.size + currentSet.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

/**
 * Blend token overlap and recency into a single relevance score.
 *
 * `score = 0.75 * tokenOverlapRatio + 0.25 * recency`
 *
 * Named separately because the 0.75 / 0.25 weighting is a tunable policy
 * constant that would be opaque if inlined.
 */
export function relevanceScore(
  candidateTokens: string[],
  currentTokens: string[],
  recency: number,
): number {
  return 0.75 * tokenOverlapRatio(candidateTokens, currentTokens) + 0.25 * recency;
}

// ---------------------------------------------------------------------------
// Message selection
// ---------------------------------------------------------------------------

/**
 * Select the most relevant candidate messages for the current message's context
 * window.
 *
 * 1. Exclude the current message (by id) and any with empty text.
 * 2. Score every remaining candidate by token overlap + recency.
 * 3. Keep candidates scoring `>=` {@link RELEVANCE_THRESHOLD}, take the top
 *    {@link MAX_CONTEXT_MESSAGES} by score.
 * 4. If the current message contains a continuation word, force-include the
 *    most recent bot reply and same-author message (added only if not already
 *    selected and distinct).
 * 5. Sort the result oldest-first.
 * 6. Enforce {@link MAX_CONTEXT_CHARS} by trimming from the oldest end.
 */
export function selectRelevantMessages(
  candidates: readonly SelectableMessage[],
  current: SelectableMessage,
  nowMs: number,
): SelectableMessage[] {
  const pool = candidates.filter((m) => m.id !== current.id && m.text.trim() !== "");
  const currentTokens = tokenize(current.text);

  const scored = pool
    .map((m) => ({
      message: m,
      score: relevanceScore(tokenize(m.text), currentTokens, recencyScore(m.timestampMs, nowMs)),
    }))
    .filter((s) => s.score >= RELEVANCE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CONTEXT_MESSAGES);

  const selectedIds = new Set(scored.map((s) => s.message.id));

  if (hasContinuationWord(current.text)) {
    const byRecency = [...pool].sort((a, b) => b.timestampMs - a.timestampMs);
    const recentBot = byRecency.find((m) => m.isBot);
    const recentSameAuthor = byRecency.find((m) => m.authorId === current.authorId);
    for (const extra of [recentBot, recentSameAuthor]) {
      if (extra && !selectedIds.has(extra.id)) {
        scored.push({ message: extra, score: 0 });
        selectedIds.add(extra.id);
      }
    }
  }

  scored.sort((a, b) => a.message.timestampMs - b.message.timestampMs);

  let totalChars = scored.reduce((sum, s) => sum + [...s.message.text].length, 0);
  while (scored.length > 0 && totalChars > MAX_CONTEXT_CHARS) {
    const removed = scored.shift()!;
    totalChars -= [...removed.message.text].length;
  }

  return scored.map((s) => s.message);
}

// ---------------------------------------------------------------------------
// One-shot directive parsing
// ---------------------------------------------------------------------------

/** Phrases that trigger a one-shot "ignore prior context" directive. */
const ONE_SHOT_DIRECTIVES = [
  "不用参考之前的",
  "不要参考之前的",
  "忽略之前的上下文",
  "不参考上下文",
  "不用参考上下文",
  "不要参考上下文",
  "忽略之前的",
  "不要之前",
  "不用之前",
] as const;

/**
 * Detect a one-shot "don't use prior context" directive in `text`.
 *
 * The match is conservative: only the exact phrases listed in
 * {@link ONE_SHOT_DIRECTIVES} trigger it, never a casual mention of "before" or
 * "previous". NFKC normalisation and whitespace collapsing make the check
 * robust to fullwidth and compatibility character variants. This directive only
 * affects the current request — persistent clearing is done via `/clear-context`.
 */
export function parseOneShotDirective(text: string): boolean {
  const normalized = normalizeText(text)
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
  return ONE_SHOT_DIRECTIVES.some((d) => normalized.includes(d));
}
