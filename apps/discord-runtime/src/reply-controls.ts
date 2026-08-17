import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

import type { GenerationRequest, UiLanguage } from "@xenoblade/contracts";

/** Prefix shared by every reply-control customId (`xbl:<action>:<messageId>`). */
const CUSTOM_ID_PREFIX = "xbl";

/** Regenerate button emoji. */
export const REGENERATE_EMOJI = "🔁";
/** Delete button emoji. */
export const DELETE_EMOJI = "🗑️";

/**
 * Registry entry for one posted bot reply: everything needed to act on its
 * button controls later — the frozen original request (regenerate re-runs it
 * with the same shape), every posted chunk id (delete removes them all,
 * continuations included), and the head content to restore when a
 * regenerate fails.
 */
export interface ReplyEntry {
  request: GenerationRequest;
  /** Posted message ids, head chunk first. */
  chunkIds: string[];
  /** Head chunk text; a failed regenerate restores it in place. */
  headContent: string;
  /** UI language the reply's notices and button labels render in. */
  language: UiLanguage;
  /** True while an in-flight regenerate owns this reply (double-click guard). */
  busy: boolean;
}

/** Cap on tracked replies; the oldest entry is evicted beyond this. */
const MAX_TRACKED_REPLIES = 128;

/**
 * In-memory index of the bot's actionable replies, keyed by head message id.
 *
 * Bounded and FIFO, so a long-running container does not grow the map without
 * limit. Entries vanish on restart: buttons on old replies then fail closed
 * (ephemeral "expired" notice, no action) rather than mis-attributing an
 * action. The Worker's regenerate lease remains the durable race guard.
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

/** The control actions a reply button can request. */
export type ControlAction = "regenerate" | "delete";

/** Build a control customId: `xbl:<action>:<headMessageId>`. */
export function controlCustomId(action: ControlAction, headMessageId: string): string {
  const verb = action === "regenerate" ? "regen" : "del";
  return `${CUSTOM_ID_PREFIX}:${verb}:${headMessageId}`;
}

/**
 * Parse a component customId into a control action. Returns null for
 * anything outside the `xbl:` scheme (other component families or garbage).
 */
export function parseControlCustomId(customId: string): ControlAction | null {
  const parts = customId.split(":");
  if (parts.length !== 3 || parts[0] !== CUSTOM_ID_PREFIX || parts[2] === "") return null;
  if (parts[1] === "regen") return "regenerate";
  if (parts[1] === "del") return "delete";
  return null;
}

/** Label text the button row renders (from the i18n table). */
export interface ControlTexts {
  regenerate: string;
}

/** Options for {@link buildReplyControlsRow}. */
export interface ControlRowOptions {
  /** Render both buttons unclickable (regenerate in flight). */
  disabled?: boolean;
}

/**
 * Build the reply-control action row: Regenerate (🔁 + label, Secondary) and
 * Delete (🗑️, Danger), both carrying the head message id in their customIds.
 */
export function buildReplyControlsRow(
  texts: ControlTexts,
  headMessageId: string,
  options: ControlRowOptions = {},
): ActionRowBuilder<ButtonBuilder> {
  const disabled = options.disabled ?? false;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(controlCustomId("regenerate", headMessageId))
      .setLabel(texts.regenerate)
      .setEmoji(REGENERATE_EMOJI)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(controlCustomId("delete", headMessageId))
      .setEmoji(DELETE_EMOJI)
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}

/** What a control interaction should do, as decided by {@link resolveControlAction}. */
export type ControlDecision =
  | { action: ControlAction }
  | { action: "rejected"; reason: "expired" | "not-owner" | "busy" };
/**
 * Decide what a reply-control interaction should do against a tracked reply.
 * `null` when the customId is not one of ours — including a customId whose
 * embedded message id does not match the message the button actually fired
 * on; callers treat that like every other unresolvable button (graceful
 * ephemeral expiry, no action). Rejections carry a reason for the ephemeral
 * notice: buttons unknown to this process (restart, eviction) are expired,
 * non-owners and double-clicks are refused without side effects.
 */

export function resolveControlAction(
  entry: ReplyEntry | undefined,
  customId: string,
  messageId: string,
  userId: string,
): ControlDecision | null {
  const action = parseControlCustomId(customId);
  if (action === null) return null;
  if (!customId.endsWith(`:${messageId}`)) return null;
  if (entry === undefined) return { action: "rejected", reason: "expired" };
  if (userId !== entry.request.userId) return { action: "rejected", reason: "not-owner" };
  if (entry.busy) return { action: "rejected", reason: "busy" };
  return { action };
}
