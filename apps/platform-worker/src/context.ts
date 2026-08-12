import type { GenerationRequest, HistoryMessage } from "@xenoblade/contracts";

// ── Context budgets ───────────────────────────────────────────────────────

const MAX_CONTEXT_MESSAGES = 20;
const MAX_CONTEXT_CHARS = 8000;
const MAX_CONTEXT_TOKENS = 4000;

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

/** Rough token estimate (~4 Unicode chars/token) for context budgeting only. */
function estimateTokens(text: string): number {
  return Math.ceil(Array.from(text).length / 4);
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
    const chars = Array.from(messages[i].text).length;
    const tokens = estimateTokens(messages[i].text);
    if (totalChars + chars > MAX_CONTEXT_CHARS) break;
    if (totalTokens + tokens > MAX_CONTEXT_TOKENS) break;
    totalChars += chars;
    totalTokens += tokens;
    result.push(messages[i]);
  }
  result.reverse();
  return result;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Build context from the history provided in the request.
 *
 * - Excludes the current message and anything older than `resetAt`.
 * - **Thread**: all surviving messages (within limits).
 * - **Channel**: only the requesting user's messages and bot replies.
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

  const candidates = isThread
    ? filtered
    : filtered.filter((m) => m.isBot || m.authorId === req.userId);

  const capped = enforceLimits(candidates);
  if (capped.length === 0) {
    return { mode: "none", messages: [] };
  }
  return { mode: isThread ? "thread" : "channel", messages: capped };
}

/**
 * Format context messages as an untrusted reference block appended to the
 * final user message. Returns an empty string when there are no messages.
 */
export function formatContextBlock(messages: readonly HistoryMessage[]): string {
  if (messages.length === 0) {
    return "";
  }
  const lines = messages.map((m) => `${m.authorName}: ${m.text}`);
  return `\n\n[Relevant Discord context]\n${lines.join("\n")}`;
}
