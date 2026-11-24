import type { GenerationRequest, HistoryMessage } from "@xenoblade/contracts";

import { DM_SCOPE } from "./db";

// ── Context budgets ───────────────────────────────────────────────────────

const MAX_CONTEXT_MESSAGES = 40;
const MAX_CONTEXT_CHARS = 24_000;
const MAX_CONTEXT_TOKENS = 12_000;

// ── Types ─────────────────────────────────────────────────────────────────

export interface ContextDecision {
  mode: "none" | "thread" | "channel";
  messages: HistoryMessage[];
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * A real Discord thread carries a four-segment container id
 * (`discord:<guild>:<channel>:<thread>`); channels and DMs use three segments.
 */
export function isThreadContainer(containerId: string): boolean {
  return containerId.split(":").length >= 4;
}

/**
 * Scripts whose characters take roughly one token each. Every other
 * character counts as Latin-style text, about four to a token.
 */
const ONE_TOKEN_SCRIPTS = /\p{scx=Han}|\p{scx=Hiragana}|\p{scx=Katakana}|\p{scx=Hangul}/u;

/**
 * Rough token estimate for context budgeting only. Counting every character
 * as a quarter of a token under-budgeted Chinese conversations fourfold, so
 * CJK characters count as one token each.
 */
function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (ONE_TOKEN_SCRIPTS.test(char)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/**
 * Trim from the oldest end until every budget is satisfied: at most
 * {@link MAX_CONTEXT_MESSAGES} messages, {@link MAX_CONTEXT_CHARS} Unicode
 * chars, and {@link MAX_CONTEXT_TOKENS} estimated tokens. The most recent
 * messages are always preferred.
 */
function enforceLimits(messages: HistoryMessage[]): HistoryMessage[] {
  const result: HistoryMessage[] = [];
  let totalChars = 0;
  let totalTokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (result.length >= MAX_CONTEXT_MESSAGES) break;
    const message = messages[i];
    if (message === undefined) continue;
    const chars = Array.from(message.text).length;
    const tokens = estimateTokens(message.text);
    if (totalChars + chars > MAX_CONTEXT_CHARS) break;
    if (totalTokens + tokens > MAX_CONTEXT_TOKENS) break;
    totalChars += chars;
    totalTokens += tokens;
    result.push(message);
  }
  result.reverse();
  return result;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Build context from the history provided in the request.
 *
 * - Excludes the current message and anything older than `resetAt`.
 * - **Thread**: every surviving message.
 * - **Channel**: every surviving message in a guild — when someone asks about
 *   what another member just said, the whole recent conversation is what makes
 *   the question answerable. A DM keeps only the requesting user's messages
 *   and the bot's replies (defense in depth, ADR-011 §3).
 * - An empty result degrades to `mode: "none"` so generation answers only the
 *   current message.
 */
export function buildContext(req: GenerationRequest, resetAt: number): ContextDecision {
  if (req.history.length === 0) {
    return { mode: "none", messages: [] };
  }

  const isThread = isThreadContainer(req.containerId);
  const filtered = req.history.filter(
    (m) => m.id !== req.messageId && (resetAt <= 0 || m.createdAt >= resetAt),
  );
  if (filtered.length === 0) {
    return { mode: "none", messages: [] };
  }

  const candidates =
    req.scopeId === DM_SCOPE
      ? filtered.filter((m) => m.isBot || m.authorId === req.userId)
      : filtered;

  const capped = enforceLimits(candidates);
  if (capped.length === 0) {
    return { mode: "none", messages: [] };
  }
  return { mode: isThread ? "thread" : "channel", messages: capped };
}
