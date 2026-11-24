import type { SoulApplyRequest, SoulApplyResponse, SoulProposal } from "@xenoblade/contracts";

import { DM_SCOPE } from "./db";

// ── Soul scope keys & limits ──────────────────────────────────────────────

/** Scope key of the global fallback soul, read when a guild has no soul of its own. */
export const DEFAULT_SOUL_SCOPE = "default";

/** Longest soul text that is stored or proposed. */
export const MAX_SOUL_CHARS = 2_000;

/**
 * Built-in persona and voice, used wherever no customized soul applies. It
 * sets character and tone only; the safety and formatting rules in the system
 * prompt always take precedence over it.
 */
export const DEFAULT_SOUL = [
  "You are Xenoblade, an AI companion living in a Discord group — shared by everyone in a server, or one person's own in a private chat. You are a peer in the conversation, not a support agent.",
  "Be lively: bring energy and curiosity, and react the way a quick, friendly group member would. A light joke or a genuine reaction fits when the moment allows it.",
  'Sound natural, like a person typing in chat: plain wording, short sentences, a relaxed rhythm. No stiff service boilerplate such as "好的！非常高兴为您解答" — no flattering openers, no canned apologies, no formal sign-offs.',
  "Lead with the point: give the conclusion or the answer first, then only the detail that earns its place. Never pad and never restate the question.",
  "Stay grounded: say what you know, and say plainly when you don't. Never invent facts, sources, or abilities.",
  "When the request is ambiguous, give your best reading and ask one short question back instead of guessing at length.",
].join("\n");

// ── D1 access (bot_soul) ──────────────────────────────────────────────────

/** The soul in effect for a scope. */
export interface BotSoul {
  content: string;
  /** True when `content` is the built-in {@link DEFAULT_SOUL}. */
  isDefault: boolean;
}

type SoulRow = { content: string };

const BUILTIN_SOUL: BotSoul = { content: DEFAULT_SOUL, isDefault: true };

/**
 * Read the soul in effect for a scope, as one query.
 *
 * - Guild scope: the guild's own row, else the `default` row, else
 *   {@link DEFAULT_SOUL}.
 * - DM scope ({@link DM_SCOPE}): the `default` row, else {@link DEFAULT_SOUL}
 *   — a guild's soul never reaches a DM.
 *
 * Fail-safe: any D1 error returns {@link DEFAULT_SOUL}, so an unreadable table
 * degrades to the built-in voice instead of failing the generation.
 */
export async function getBotSoul(db: D1Database, scopeId: string): Promise<BotSoul> {
  try {
    const row = await db
      .prepare(
        `SELECT content FROM bot_soul
          WHERE scope_id IN (?1, ?2)
          ORDER BY scope_id = ?1 DESC
          LIMIT 1`,
      )
      .bind(scopeId === DM_SCOPE ? DEFAULT_SOUL_SCOPE : scopeId, DEFAULT_SOUL_SCOPE)
      .first<SoulRow>();
    if (row === null) return BUILTIN_SOUL;
    return { content: row.content, isDefault: false };
  } catch (error) {
    console.log(JSON.stringify({ event: "soul_read_error", error: String(error) }));
    return BUILTIN_SOUL;
  }
}

/**
 * Trimmed soul text, cut to {@link MAX_SOUL_CHARS} code points; null when
 * nothing remains. The single normalization every soul write goes through,
 * applied once when `soul_update` creates a proposal: the confirmation card
 * shows that result verbatim, and applying it stores the same bytes.
 */
export function normalizeSoul(content: string): string | null {
  const chars = Array.from(content.trim());
  if (chars.length === 0) return null;
  return chars.slice(0, MAX_SOUL_CHARS).join("");
}

/**
 * Upsert a scope's soul. The content is trimmed and cut to
 * {@link MAX_SOUL_CHARS}; an empty soul is rejected, because it would leave a
 * scope with no voice at all. `scopeId` names the row's owner — a guild id, or
 * {@link DEFAULT_SOUL_SCOPE} for the global fallback; the `"dm"` scope never
 * owns a row.
 */
export async function setBotSoul(
  db: D1Database,
  entry: { scopeId: string; content: string; updatedBy?: string; now: number },
): Promise<void> {
  const content = normalizeSoul(entry.content);
  if (content === null) throw new Error("setBotSoul: soul content is empty");
  await db
    .prepare(
      `INSERT INTO bot_soul (scope_id, content, updated_by, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(scope_id) DO UPDATE SET
         content = excluded.content,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    )
    .bind(entry.scopeId, content, entry.updatedBy ?? null, entry.now)
    .run();
}

// ── System prompt segment ─────────────────────────────────────────────────

/** Render a soul as the system-prompt segment the model follows. */
export function formatSoulSegment(content: string): string {
  return [
    "## Your soul (persona and voice)",
    "The text below is your soul: who you are and how you speak in this conversation. Follow it in every reply. It shapes character and tone only — the safety, privacy, and formatting rules above always take precedence over it.",
    content,
  ].join("\n");
}

// ── Proposal extraction ───────────────────────────────────────────────────

/** Structural slice of the AI SDK tool-result shape this extraction reads. */
interface ToolResultLike {
  toolName: string;
  output?: unknown;
}

/** Only `soul_update` outputs carry a proposal. */
const SOUL_UPDATE_TOOL = "soul_update";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** A proposal as it comes back from a tool result or off the wire. */
function isSoulProposal(value: unknown): value is SoulProposal {
  if (typeof value !== "object" || value === null) return false;
  return (
    "id" in value &&
    isNonEmptyString(value.id) &&
    "scopeId" in value &&
    isNonEmptyString(value.scopeId) &&
    "content" in value &&
    typeof value.content === "string" &&
    "summary" in value &&
    typeof value.summary === "string"
  );
}

/** A `soul_update` output that carries a proposal (refused calls carry none). */
function isProposedOutput(value: unknown): value is { proposal: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    value.status === "proposed" &&
    "proposal" in value
  );
}

/**
 * Extract the soul proposal of a generation from its tool results. The model
 * may call `soul_update` more than once in one run; the latest valid proposal
 * is the one it settled on, so that is the one returned. `undefined` when no
 * call proposed anything (no call, or a call the tool refused).
 */
export function extractSoulProposal(
  toolResults: readonly ToolResultLike[],
): SoulProposal | undefined {
  let latest: SoulProposal | undefined;
  for (const { toolName, output } of toolResults) {
    if (toolName !== SOUL_UPDATE_TOOL || !isProposedOutput(output)) continue;
    if (isSoulProposal(output.proposal)) latest = output.proposal;
  }
  return latest;
}

// ── Apply handler ─────────────────────────────────────────────────────────

function isSoulApplyRequest(value: unknown): value is SoulApplyRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "updatedBy" in value &&
    isNonEmptyString(value.updatedBy) &&
    "proposal" in value &&
    isSoulProposal(value.proposal)
  );
}

/**
 * Execute a user-confirmed soul proposal. The Runtime calls this only after
 * the user clicked 是 on the confirmation card, which showed
 * `proposal.content` verbatim — so exactly those bytes are stored; content
 * that is not already normalized is refused, never quietly rewritten. The
 * chat flow can only ever target a guild, so the two reserved scope keys are
 * refused: `"dm"` never owns a row, and the global `default` soul is
 * operator-managed, not something a chat confirmation may overwrite. Never
 * throws — a failure returns `{ status: "error", code }`.
 */
export async function handleSoulApply(db: D1Database, req: unknown): Promise<SoulApplyResponse> {
  if (!isSoulApplyRequest(req)) return { status: "error", code: "invalid_body" };
  const { proposal } = req;
  if (proposal.scopeId === DM_SCOPE || proposal.scopeId === DEFAULT_SOUL_SCOPE) {
    return { status: "error", code: "invalid_scope" };
  }
  // The card showed `proposal.content` exactly, and `normalizeSoul` is the
  // one normalization the tool already applied when it created the proposal:
  // content that is not already in that form was never shown to the user, so
  // it is refused rather than quietly stored in a different form.
  if (normalizeSoul(proposal.content) !== proposal.content) {
    return { status: "error", code: "invalid_content" };
  }
  try {
    await setBotSoul(db, {
      scopeId: proposal.scopeId,
      content: proposal.content,
      updatedBy: req.updatedBy,
      now: Date.now(),
    });
  } catch (error) {
    console.log(JSON.stringify({ event: "soul_apply_error", error: String(error) }));
    return { status: "error", code: "soul_apply_failed" };
  }
  console.log(
    JSON.stringify({
      event: "soul_applied",
      scopeId: proposal.scopeId,
      updatedBy: req.updatedBy,
    }),
  );
  return { status: "ok", scopeId: proposal.scopeId };
}
