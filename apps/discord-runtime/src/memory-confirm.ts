import type {
  Message,
  MessageReaction,
  PartialMessageReaction,
  PartialUser,
  SendableChannels,
  User,
} from "discord.js";
import type { MemoryProposal, MemoryProposalResponse } from "@xenoblade/contracts";

import { applyMemoryProposals } from "./ai-client";
import type { EnvConfig } from "./env";

/** Confirm (save/execute) affordance on memory confirmation messages. */
export const CONFIRM_EMOJI = "✅";
/** Cancel affordance on memory confirmation messages. */
export const CANCEL_EMOJI = "❌";

const VARIATION_SELECTOR = /\uFE0F/g;

/**
 * Compare a reaction emoji name against an affordance emoji, ignoring the
 * emoji variation selector: clients send emoji with or without U+FE0F
 * depending on platform, and both must match.
 */
export function isAffordanceEmoji(name: string | null | undefined, emoji: string): boolean {
  if (name === undefined || name === null) return false;
  return name.replace(VARIATION_SELECTOR, "") === emoji.replace(VARIATION_SELECTOR, "");
}
/** How long a confirmation message stays actionable (ADR-013). */
const CONFIRM_WINDOW_MS = 5 * 60 * 1000;

/** Cap on tracked confirmations; the oldest entry is evicted beyond this. */
const MAX_TRACKED_CONFIRMS = 128;

/** Strings the confirmation flow renders (from the i18n table). */
type ConfirmTexts = {
  header: string;
  saveLine: (label: string, key: string, value: string) => string;
  forgetLine: (label: string | null, key: string) => string;
  footer: string;
  saved: string;
  savedPartial: (ok: number, total: number) => string;
  full: string;
  cancelled: string;
  expired: string;
  failed: string;
  labelFact: string;
  labelPreference: string;
};

/** Registry entry for one posted confirmation message. */
export interface MemoryConfirmEntry {
  /** Only this user's reactions act (the user whose memory is at stake). */
  userId: string;
  channelId: string;
  proposals: MemoryProposal[];
  texts: ConfirmTexts;
  /** Marks the entry dead once acted on or expired. */
  settled: boolean;
}

/**
 * In-memory index of pending memory confirmations, keyed by message id.
 * Bounded and FIFO like {@link ReplyRegistry}. Entries vanish on restart:
 * reactions then go inert, which fails closed — nothing is written to
 * `user_memory` without a live confirmation.
 */
export class MemoryConfirmRegistry {
  private readonly entries = new Map<string, MemoryConfirmEntry>();

  register(messageId: string, entry: MemoryConfirmEntry): void {
    this.entries.set(messageId, entry);
    if (this.entries.size > MAX_TRACKED_CONFIRMS) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
  }

  get(messageId: string): MemoryConfirmEntry | undefined {
    return this.entries.get(messageId);
  }

  remove(messageId: string): void {
    this.entries.delete(messageId);
  }
}

/**
 * Decide what a reaction event should do against a tracked confirmation.
 * `null` when the event must be ignored: bot reactions (including the two the
 * bot itself adds), untracked or non-affordance emoji, settled entries, or
 * users other than the user whose memory would change.
 */
export function resolveConfirmAction(
  entry: MemoryConfirmEntry | undefined,
  emojiName: string | null | undefined,
  userId: string,
  isBot: boolean | undefined,
): "confirm" | "cancel" | null {
  if (isBot === true) return null;
  if (entry === undefined) return null;
  if (entry.settled) return null;
  if (userId !== entry.userId) return null;
  if (isAffordanceEmoji(emojiName, CONFIRM_EMOJI)) return "confirm";
  if (isAffordanceEmoji(emojiName, CANCEL_EMOJI)) return "cancel";
  return null;
}

/** Render the confirmation message body listing every proposal. */
export function renderConfirmation(
  proposals: readonly MemoryProposal[],
  texts: ConfirmTexts,
): string {
  const lines = proposals.map((proposal) => {
    const label =
      proposal.category === "preference"
        ? texts.labelPreference
        : proposal.category === "fact"
          ? texts.labelFact
          : null;
    return proposal.action === "save"
      ? texts.saveLine(label ?? texts.labelFact, proposal.key, proposal.value ?? "")
      : texts.forgetLine(label, proposal.key);
  });
  return [texts.header, ...lines.map((line) => `- ${line}`), "", texts.footer].join("\n");
}

/** Render the ✅ outcome line based on per-proposal results. */
export function renderConfirmOutcome(
  response: MemoryProposalResponse | null,
  total: number,
  texts: ConfirmTexts,
): string {
  if (response === null || response.status === "error") return texts.failed;
  const ok = response.results.filter((r) => r.ok).length;
  if (ok === total) return texts.saved;
  if (ok === 0) {
    return response.results.some((r) => r.code === "memory_full") ? texts.full : texts.failed;
  }
  return texts.savedPartial(ok, total);
}

/**
 * Post the memory confirmation message for a generation's proposals: react
 * ✅ / ❌, register it, and arm the expiry timer. Best-effort throughout — a
 * failed post or react is logged and never breaks the already-delivered reply.
 */
export async function postMemoryConfirmation(
  channel: SendableChannels,
  userId: string,
  proposals: readonly MemoryProposal[],
  texts: ConfirmTexts,
  registry: MemoryConfirmRegistry,
): Promise<void> {
  let message: Message;
  try {
    message = await channel.send(renderConfirmation(proposals, texts));
  } catch (error) {
    console.log(
      JSON.stringify({ event: "memory_confirm_post_error", userId, error: String(error) }),
    );
    return;
  }

  registry.register(message.id, {
    userId,
    channelId: message.channelId,
    proposals: [...proposals],
    texts,
    settled: false,
  });

  for (const emoji of [CONFIRM_EMOJI, CANCEL_EMOJI]) {
    await message.react(emoji).catch((error) => {
      console.log(
        JSON.stringify({
          event: "memory_confirm_react_error",
          messageId: message.id,
          emoji,
          error: String(error),
        }),
      );
    });
  }

  const timer = setTimeout(() => {
    const entry = registry.get(message.id);
    if (entry === undefined || entry.settled) return;
    entry.settled = true;
    registry.remove(message.id);
    void message.edit(entry.texts.expired).catch(() => undefined);
    console.log(JSON.stringify({ event: "memory_confirm_expired", messageId: message.id, userId }));
  }, CONFIRM_WINDOW_MS);
  timer.unref();
}

/**
 * messageReactionAdd path for memory confirmations (ADR-013): ✅ executes the
 * proposals against the Worker, ❌ drops them. Either way the message is
 * edited to its outcome and the entry is consumed. Count-only logging —
 * proposal text never reaches the logs.
 */
export async function handleMemoryConfirmReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  env: EnvConfig,
  registry: MemoryConfirmRegistry,
): Promise<void> {
  const messageId = reaction.message.id;
  const entry = registry.get(messageId);
  const action = resolveConfirmAction(entry, reaction.emoji?.name, user.id, user.bot);
  if (entry === undefined || action === null) return;

  entry.settled = true;
  registry.remove(messageId);

  const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;

  if (action === "cancel") {
    await message.edit(entry.texts.cancelled).catch(() => undefined);
    await clearConfirmReactions(message);
    console.log(JSON.stringify({ event: "memory_confirm_cancelled", messageId, userId: user.id }));
    return;
  }

  let response: MemoryProposalResponse | null = null;
  try {
    response = await applyMemoryProposals(
      { userId: entry.userId, proposals: entry.proposals },
      env.workerUrl,
      env.internalApiToken,
    );
  } catch (error) {
    console.log(
      JSON.stringify({ event: "memory_confirm_apply_error", messageId, error: String(error) }),
    );
  }

  await message
    .edit(renderConfirmOutcome(response, entry.proposals.length, entry.texts))
    .catch(() => undefined);
  await clearConfirmReactions(message);
  console.log(
    JSON.stringify({
      event: "memory_confirm_applied",
      messageId,
      userId: user.id,
      proposals: entry.proposals.length,
      ok:
        response !== null && response.status === "ok"
          ? response.results.filter((r) => r.ok).length
          : 0,
    }),
  );
}

/** Remove the two affordance reactions once a confirmation is settled. */
async function clearConfirmReactions(message: Message): Promise<void> {
  for (const emoji of [CONFIRM_EMOJI, CANCEL_EMOJI]) {
    const affordance = message.reactions.cache.find((r) => isAffordanceEmoji(r.emoji?.name, emoji));
    if (affordance === undefined) continue;
    await affordance.remove().catch(() => undefined);
    await affordance.users.remove(message.client.user.id).catch(() => undefined);
  }
}
