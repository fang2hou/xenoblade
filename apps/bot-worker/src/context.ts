import type { Message, Thread } from "chat";

import { getBoundedHistory, isRealDiscordThread } from "./history";
import {
  selectRelevantMessages,
  MAX_FORCED_CHANNEL_MESSAGES,
  MAX_CONTEXT_CHARS,
  type SelectableMessage,
} from "./context-policy";

export type ContextMode = "none" | "thread" | "channel";

export interface ContextDecision {
  mode: ContextMode;
  /** true when the caller forces full history (reply, thread, active session). */
  forced: boolean;
  reason: string;
  messages: Message[];
}

export interface BuildContextParams {
  thread: Thread;
  message: Message;
  forceContext: boolean;
  resetAt: number;
  now: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract epoch milliseconds from a Chat SDK message. */
function messageTimestampMs(message: Message): number {
  const dateSent = message.metadata?.dateSent;
  if (dateSent instanceof Date) {
    return dateSent.getTime();
  }
  if (typeof dateSent === "number") {
    return dateSent;
  }
  if (typeof dateSent === "string") {
    const parsed = Date.parse(dateSent);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function toSelectable(message: Message): SelectableMessage {
  return {
    id: message.id,
    text: message.text,
    timestampMs: messageTimestampMs(message),
    authorId: message.author.userId,
    authorName: message.author.fullName || message.author.userName,
    isBot: message.author.isBot === true || message.author.isMe,
  };
}

/** Exclude messages older than resetAt; always keep the current message. */
function filterByResetAt(messages: Message[], resetAt: number, currentId: string): Message[] {
  if (resetAt <= 0) {
    return messages;
  }
  return messages.filter((m) => m.id === currentId || messageTimestampMs(m) >= resetAt);
}
/** Keep only messages from the requesting user or the bot. */
function filterToUserAndBot(messages: Message[], userId: string): Message[] {
  return messages.filter(
    (m) => m.author.userId === userId || m.author.isMe || m.author.isBot === true,
  );
}

/** Trim from the oldest end while total Unicode chars exceed the cap. */
function enforceCharCap(messages: Message[], maxChars: number): Message[] {
  let total = 0;
  const result: Message[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const chars = [...messages[i].text].length;
    if (total + chars > maxChars) {
      break;
    }
    total += chars;
    result.push(messages[i]);
  }
  result.reverse();
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a {@link ContextDecision} for the current message.
 *
 * - **Forced** (reply-to-bot, real thread, or active session): include all
 *   resetAt-filtered history. Channel mode additionally restricts to the same
 *   user and bot, capped at {@link MAX_FORCED_CHANNEL_MESSAGES}.
 * - **Non-forced** (fresh channel mention): use relevance scoring to select up
 *   to 8 topically related messages.
 * - History fetch errors degrade to `mode: "none"` so generation answers only
 *   the current message.
 */
export async function buildContext(params: BuildContextParams): Promise<ContextDecision> {
  const { thread, message, forceContext, resetAt, now } = params;
  const isThread = isRealDiscordThread(thread.id);
  const mode: ContextMode = isThread ? "thread" : "channel";

  let history: Message[];
  try {
    history = await getBoundedHistory(thread, message);
  } catch (error) {
    console.log(JSON.stringify({ event: "history_fetch_error", error: String(error) }));
    return { mode: "none", forced: false, reason: "history_error", messages: [] };
  }

  if (forceContext) {
    const filtered = filterByResetAt(history, resetAt, message.id);
    if (isThread) {
      return { mode, forced: true, reason: "forced_thread", messages: filtered };
    }
    // Channel: only the user's own messages and bot replies, most recent 12.
    const userBot = filterToUserAndBot(filtered, message.author.userId);
    const limited = userBot.slice(-MAX_FORCED_CHANNEL_MESSAGES);
    return { mode, forced: true, reason: "forced_channel", messages: limited };
  }

  // Relevance scoring path — used for fresh channel mentions.
  const current = toSelectable(message);
  const candidates = history.filter((m) => m.id !== message.id).map(toSelectable);
  const selected = selectRelevantMessages(candidates, current, now);
  const selectedIds = new Set(selected.map((s) => s.id));
  const selectedMessages = history.filter((m) => selectedIds.has(m.id));
  const capped = enforceCharCap(selectedMessages, MAX_CONTEXT_CHARS);
  return { mode, forced: false, reason: "relevant", messages: capped };
}

/**
 * Format context messages as an untrusted reference block for the final user
 * message. Returns an empty string when there are no messages.
 */
export function formatContextBlock(messages: readonly Message[]): string {
  if (messages.length === 0) {
    return "";
  }
  const lines = messages.map((m) => {
    const name = m.author.fullName || m.author.userName || "User";
    return `${name}: ${m.text}`;
  });
  return `\n\n[Relevant Discord context]\n${lines.join("\n")}`;
}

/**
 * Post a reply to the correct conversation target.
 *
 * Real Discord threads (four-segment IDs) post inside the thread; main
 * channels and DMs (three-segment IDs) post as top-level channel messages.
 */
export async function postToConversation(
  thread: Thread,
  content: string | ReadableStream<string>,
): Promise<void> {
  if (isRealDiscordThread(thread.id)) {
    await thread.post(content);
  } else {
    await thread.channel.post(content);
  }
}
