import type { Message } from "chat";

/** Maximum number of messages returned to the AI. */
const MAX_MESSAGES = 30;
/** Maximum total Unicode characters across the returned history. */
const MAX_CHARACTERS = 12_000;
/** Maximum estimated tokens (chars / 2, rounded up) across the history. */
const MAX_TOKENS = 6_000;
/** Page size used when fetching recent thread messages. */
const FETCH_LIMIT = 30;

/**
 * Minimal structural view of a Chat SDK thread. Only the fields consumed by
 * {@link getBoundedHistory} are required; intentionally avoids depending on a
 * SDK `Thread` named export that may not exist.
 */
export interface HistoryThread {
  readonly id: string;
  readonly adapter: {
    fetchMessages(
      threadId: string,
      options: { limit: number },
    ): Promise<{ messages: Message[]; nextCursor?: string }>;
  };
}

/**
 * De-duplicate messages by id, keeping the LAST occurrence in its original
 * position. Guards against repeated ids from pagination or the appended current
 * message.
 */
function dedupeByLastOccurrence(messages: Message[]): Message[] {
  const result: Message[] = [];
  const seen = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (seen.has(msg.id)) {
      continue;
    }
    seen.add(msg.id);
    result.push(msg);
  }
  result.reverse();
  return result;
}

/**
 * Build a bounded, text-only history for an AI generation.
 *
 * 1. Fetch the most recent 30 messages via the thread adapter.
 * 2. Ensure the current message is present, then de-duplicate by id (keeping
 *    the last occurrence).
 * 3. Select from newest to oldest while the buffer stays under all three caps
 *    (30 messages, 12,000 Unicode characters, 6,000 estimated tokens), skipping
 *    any message with empty trimmed text. Stop as soon as a cap would break.
 * 4. Return the selection in chronological (oldest-first) order.
 *
 * The current message is the newest, so it is always retained and older
 * messages are dropped first.
 */
export async function getBoundedHistory(
  thread: HistoryThread,
  currentMessage: Message,
): Promise<Message[]> {
  const page = await thread.adapter.fetchMessages(thread.id, {
    limit: FETCH_LIMIT,
  });
  const fetched = page.messages;

  const hasCurrent = fetched.some((msg) => msg.id === currentMessage.id);
  const combined = hasCurrent ? fetched : [...fetched, currentMessage];
  const messages = dedupeByLastOccurrence(combined);

  const selected: Message[] = [];
  let totalChars = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.text.trim() === "") {
      continue;
    }
    const candidateChars = totalChars + [...msg.text].length;
    const candidateTokens = Math.ceil(candidateChars / 2);
    if (selected.length >= MAX_MESSAGES) {
      break;
    }
    if (candidateChars > MAX_CHARACTERS) {
      break;
    }
    if (candidateTokens > MAX_TOKENS) {
      break;
    }
    selected.push(msg);
    totalChars = candidateChars;
  }

  selected.reverse();
  return selected;
}
