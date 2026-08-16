import type { GenerationRequest } from "@xenoblade/contracts";

/** Regenerate affordance added to fresh bot replies. */
export const REGENERATE_EMOJI = "🔁";
/** Delete affordance added to fresh bot replies. */
export const DELETE_EMOJI = "🗑️";

/** Reaction affordance sets a reply can carry. */
export type ReplyControls = "full" | "delete-only";

/**
 * Registry entry for one posted bot reply: everything needed to act on its
 * reaction affordances later — the frozen original request (regenerate
 * re-runs it with the same shape) and every posted chunk id (delete removes
 * them all, continuations included).
 */
export interface ReplyEntry {
  request: GenerationRequest;
  /** Posted message ids, head chunk first. */
  chunkIds: string[];
  /** False once the regenerate claim is spent (delete-only replies). */
  regenerable: boolean;
}

/** Cap on tracked replies; the oldest entry is evicted beyond this. */
const MAX_TRACKED_REPLIES = 128;

/**
 * In-memory index of the bot's actionable replies, keyed by head message id.
 *
 * Bounded and FIFO, so a long-running container does not grow the map without
 * limit. Entries vanish on restart: reactions then go inert, which fails
 * closed (no regenerate, no delete) rather than mis-attributing an action.
 * The Worker's `claimRegenerate` remains the durable bound.
 */
export class ReplyRegistry {
  private readonly entries = new Map<string, ReplyEntry>();

  register(headMessageId: string, entry: ReplyEntry): void {
    this.entries.set(headMessageId, entry);
    if (this.entries.size > MAX_TRACKED_REPLIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
  }

  get(headMessageId: string): ReplyEntry | undefined {
    return this.entries.get(headMessageId);
  }

  remove(headMessageId: string): void {
    this.entries.delete(headMessageId);
  }
}

const VARIATION_SELECTOR = /\uFE0F/g;

/**
 * Compare a reaction emoji name against an affordance emoji, ignoring the
 * emoji variation selector: clients send 🗑 with or without U+FE0F depending
 * on platform, and both must match.
 */

export function isAffordanceEmoji(name: string | null | undefined, emoji: string): boolean {
  if (name === undefined || name === null) return false;
  return name.replace(VARIATION_SELECTOR, "") === emoji.replace(VARIATION_SELECTOR, "");
}

/**
 * Decide what a reaction event should do against a tracked reply. `null` when
 * the event must be ignored: bot reactions (including the affordances the bot
 * itself adds), untracked or non-affordance emoji, or users other than the
 * trigger author.
 */
export function resolveAffordanceAction(
  entry: ReplyEntry | undefined,
  emojiName: string | null | undefined,
  userId: string,
  isBot: boolean | undefined,
): "regenerate" | "delete" | null {
  if (isBot === true) return null;
  if (entry === undefined) return null;
  if (userId !== entry.request.userId) return null;
  if (entry.regenerable && isAffordanceEmoji(emojiName, REGENERATE_EMOJI)) {
    return "regenerate";
  }
  if (isAffordanceEmoji(emojiName, DELETE_EMOJI)) return "delete";
  return null;
}
