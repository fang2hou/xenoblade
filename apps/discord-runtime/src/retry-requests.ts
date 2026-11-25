/** Most conversations whose redo requests are remembered; the oldest is forgotten beyond this. */
const MAX_REMEMBERED_CONVERSATIONS = 512;

/** Most redo requests remembered for one conversation; the oldest is forgotten beyond this. */
const MAX_REMEMBERED_PER_CONVERSATION = 64;

/**
 * Which messages of a conversation only asked for the bot's previous reply to
 * be redone (`retry_last_reply`).
 *
 * The Worker reports each such turn when it completes; the request of every
 * later turn of the conversation marks those messages, so the Worker's retry
 * can walk back past them to the question that was actually asked. Nothing of
 * it is stored: a DM is never written anywhere (ADR-011), and a guild's stored
 * turn already names its prompt. What a restart forgets costs only that — in
 * a DM, a retry asked right after one that predates the restart reads the
 * earlier request as the prompt.
 */
export class RetryRequests {
  private readonly conversations = new Map<string, Set<string>>();

  /** Note that a message only asked for the bot's previous reply to be redone. */
  remember(containerId: string, messageId: string): void {
    let requests = this.conversations.get(containerId);
    if (requests === undefined) {
      requests = new Set();
      this.conversations.set(containerId, requests);
      if (this.conversations.size > MAX_REMEMBERED_CONVERSATIONS) {
        const oldest = this.conversations.keys().next().value;
        if (oldest !== undefined) this.conversations.delete(oldest);
      }
    }
    requests.delete(messageId);
    requests.add(messageId);
    if (requests.size > MAX_REMEMBERED_PER_CONVERSATION) {
      const oldest = requests.values().next().value;
      if (oldest !== undefined) requests.delete(oldest);
    }
  }

  /** Whether a message of the conversation only asked for a redo. */
  isRedoRequest(containerId: string, messageId: string): boolean {
    return this.conversations.get(containerId)?.has(messageId) ?? false;
  }
}
