import type { Message, SendableChannels } from "discord.js";

import { MAX_MESSAGE_LENGTH, postReply, sliceIntoChunks } from "./output";
import { stagedMilestones } from "./i18n";

/**
 * Timer plumbing for staged status. Injectable so tests can drive milestones
 * deterministically; the default uses ambient Node timers, which also works
 * under host-level fake timers.
 */
export interface StatusScheduler {
  setTimeout(callback: () => void, ms: number): NodeJS.Timeout;
  clearTimeout(handle: NodeJS.Timeout): void;
}

/** Production scheduler backed by ambient Node timers. */
export const nodeScheduler: StatusScheduler = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/** One status stage: applied after `afterMs` of elapsed generation time. */
export interface StatusMilestone {
  afterMs: number;
  text: string;
}

/** Hard cap on placeholder edits per generation (ADR-003 amendment). */
const MAX_EDITS = 4;

/** Backoff before a single retry of a rate-limited edit. */
const RATE_LIMIT_RETRY_DELAY_MS = 1_000;

/** Default escalation ladder (zh); callers pass per-user localized milestones. */
const DEFAULT_MILESTONES: StatusMilestone[] = stagedMilestones("zh");

export interface StagedStatusOptions {
  scheduler?: StatusScheduler;
  milestones?: StatusMilestone[];
}

function log(event: string, channelId: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, channelId, ...extra }));
}

/**
 * Staged status placeholder for one generation (ADR-003 amendment): after a
 * coarse elapsed-time milestone, post a single placeholder and escalate its
 * text at later milestones. Capped at `MAX_EDITS` edits per generation, one of
 * which is reserved for the final replacement in `settle`.
 *
 * The typing-indicator keepalive in `runGeneration` continues to run; this
 * complements it once the placeholder exists.
 */
export class StagedStatus {
  private readonly channel: SendableChannels;
  private readonly scheduler: StatusScheduler;
  private readonly milestones: StatusMilestone[];
  private placeholder: Message | null = null;
  private edits = 0;
  private settled = false;
  private timers: NodeJS.Timeout[] = [];
  /** Serializes placeholder mutations so a milestone can never interleave with settle. */
  private queue: Promise<void> = Promise.resolve();

  constructor(channel: SendableChannels, options: StagedStatusOptions = {}) {
    this.channel = channel;
    this.scheduler = options.scheduler ?? nodeScheduler;
    this.milestones = options.milestones ?? DEFAULT_MILESTONES;
  }

  /** Schedule the milestone ladder. Call once, before the generation call. */
  start(): void {
    if (this.settled) return;
    for (const milestone of this.milestones) {
      this.timers.push(
        this.scheduler.setTimeout(() => {
          this.runExclusive(() => this.applyMilestone(milestone.text)).catch((error) => {
            log("staged_milestone_error", this.channel.id, { error: String(error) });
          });
        }, milestone.afterMs),
      );
    }
  }

  /**
   * Replace the placeholder with the final content: edit it to the first
   * chunk and post continuation chunks (>2000 chars) as new messages. With no
   * placeholder (fast generations) this behaves like `postReply`. Edit
   * failures fall back to posting the full content as new messages and
   * removing the stale placeholder.
   *
   * Returns every message making up the final reply, head chunk first — the
   * settled placeholder (or first fresh post) followed by continuations — so
   * callers can attach reply affordances (🔁/🗑) to it.
   */
  settle(content: string): Promise<Message[]> {
    this.settled = true;
    this.clearTimers();
    return this.runExclusive(() => this.applySettled(content));
  }

  /** Stop staging and delete the placeholder, if any (silent outcomes). */
  dismiss(): Promise<void> {
    this.settled = true;
    this.clearTimers();
    return this.runExclusive(async () => {
      const placeholder = this.placeholder;
      this.placeholder = null;
      if (placeholder) {
        await placeholder.delete().catch((error) => {
          log("staged_placeholder_delete_error", this.channel.id, { error: String(error) });
        });
      }
    });
  }

  private clearTimers(): void {
    for (const timer of this.timers) this.scheduler.clearTimeout(timer);
    this.timers = [];
  }

  /** Queue `step` after any pending mutation; keep the chain alive on failure. */
  private runExclusive<T>(step: () => Promise<T>): Promise<T> {
    const run = this.queue.then(step);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async applyMilestone(text: string): Promise<void> {
    if (this.settled) return;
    if (!this.placeholder) {
      try {
        this.placeholder = await this.channel.send(text);
        log("staged_placeholder_posted", this.channel.id);
      } catch (error) {
        // Cosmetic; the next milestone retries with its own stage text.
        log("staged_placeholder_error", this.channel.id, { error: String(error) });
      }
      return;
    }
    if (this.edits >= MAX_EDITS - 1) {
      log("staged_edit_cap_reached", this.channel.id, { edits: this.edits });
      return;
    }
    if (await this.editPlaceholder(this.placeholder, text)) {
      log("staged_placeholder_edited", this.channel.id, { edits: this.edits });
    }
  }

  private async applySettled(content: string): Promise<Message[]> {
    const placeholder = this.placeholder;
    this.placeholder = null;
    if (!placeholder) {
      // Fast path: no placeholder was ever posted; behave exactly like postReply.
      return postReply(this.channel, content);
    }
    const chunks = sliceIntoChunks(content, MAX_MESSAGE_LENGTH);
    const head = chunks[0];
    if (head !== undefined && (await this.editPlaceholder(placeholder, head))) {
      log("staged_placeholder_settled", this.channel.id, { edits: this.edits });
      const posted: Message[] = [placeholder];
      for (const chunk of chunks.slice(1)) posted.push(await this.channel.send(chunk));
      return posted;
    }
    // Never leave the user without the reply or a stale placeholder.
    log("staged_settle_fallback", this.channel.id);
    const posted = await postReply(this.channel, content);
    await placeholder.delete().catch((error) => {
      log("staged_placeholder_delete_error", this.channel.id, { error: String(error) });
    });
    return posted;
  }

  /**
   * Edit the placeholder to `text`, retrying once after a backoff on rate
   * limits. Only completed edits count toward the cap. Returns success.
   */
  private async editPlaceholder(message: Message, text: string): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        await new Promise<void>((resolve) => {
          this.scheduler.setTimeout(resolve, RATE_LIMIT_RETRY_DELAY_MS);
        });
      }
      try {
        await message.edit(text);
        this.edits += 1;
        return true;
      } catch (error) {
        const rateLimited = attempt === 0 && isRateLimitError(error);
        log("staged_edit_error", this.channel.id, {
          error: String(error),
          retrying: rateLimited,
        });
        if (!rateLimited) return false;
      }
    }
    return false;
  }
}

/** Match discord.js `DiscordAPIError` (status 429) and @discordjs/rest `RateLimitError`. */
function isRateLimitError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ((error as { status?: unknown }).status === 429) return true;
  return (error as { name?: unknown }).name === "RateLimitError";
}
