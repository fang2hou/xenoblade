import type {
  GuildMemoryApplyRequest,
  GuildMemoryApplyResponse,
  GuildMemoryCategory,
  GuildMemoryProposal,
  MemoryRequest,
  MemoryResponse,
} from "@xenoblade/contracts";

import {
  clearGuildMemory,
  clearUserMemory,
  DM_SCOPE,
  getUserMemory,
  setGuildMemory,
  setUserMemory,
} from "./db";

/**
 * Handle a memory command (get/set/clear) against the `user_memory` table.
 *
 * `set` and `clear` return the user's full post-operation memory list so the
 * caller can reconcile state without a follow-up `get`. Never throws — a
 * failure returns `{ status: "error", code }`.
 */
export async function handleMemory(db: D1Database, req: MemoryRequest): Promise<MemoryResponse> {
  try {
    if (req.op === "get") {
      return { status: "ok", memories: await getUserMemory(db, req.userId) };
    }

    if (req.op === "set") {
      await setUserMemory(db, {
        userId: req.userId,
        category: req.category,
        key: req.key,
        value: req.value,
      });
      return { status: "ok", memories: await getUserMemory(db, req.userId) };
    }

    // clear
    await clearUserMemory(db, {
      userId: req.userId,
      category: req.category,
      key: req.key,
    });
    return { status: "ok", memories: await getUserMemory(db, req.userId) };
  } catch (error) {
    console.log(JSON.stringify({ event: "memory_op_error", op: req.op, error: String(error) }));
    return { status: "error", code: "memory_op_failed" };
  }
}

// ── Normalization ─────────────────────────────────────────────────────────

/** Longest memory key that is stored or proposed. */
export const MAX_MEMORY_KEY_CHARS = 64;
/** Longest memory value that is stored or proposed. */
export const MAX_MEMORY_VALUE_CHARS = 500;

/** Trimmed text, cut to `max` code points; null when nothing remains. */
function normalizeClamped(text: string, max: number): string | null {
  const chars = Array.from(text.trim());
  if (chars.length === 0) return null;
  return chars.slice(0, max).join("");
}

/**
 * Normalized form of a memory key: trimmed, cut to
 * {@link MAX_MEMORY_KEY_CHARS} code points, null when empty. One of the two
 * normalizations every memory write goes through — see
 * {@link normalizeMemoryValue} for how the result is used.
 */
export function normalizeMemoryKey(key: string): string | null {
  return normalizeClamped(key, MAX_MEMORY_KEY_CHARS);
}

/**
 * Normalized form of a memory value: trimmed, cut to
 * {@link MAX_MEMORY_VALUE_CHARS} code points, null when empty. A memory tool
 * applies it once, when it saves an entry or creates a proposal; a guild
 * proposal then shows that result to the user verbatim, and applying it
 * stores the same bytes, refusing anything that is not already in this form.
 */
export function normalizeMemoryValue(value: string): string | null {
  return normalizeClamped(value, MAX_MEMORY_VALUE_CHARS);
}

// ── Guild memory proposal extraction ──────────────────────────────────────

/** Structural slice of the AI SDK tool-result shape this extraction reads. */
interface ToolResultLike {
  toolName: string;
  output?: unknown;
}

/** Only these tools' outputs carry a guild memory proposal. */
const GUILD_MEMORY_TOOL_NAMES: Record<"memory_save" | "memory_delete", true> = {
  memory_save: true,
  memory_delete: true,
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isGuildMemoryCategory(value: unknown): value is GuildMemoryCategory {
  return value === "fact" || value === "preference";
}

/** A proposal as it comes back from a tool result or off the wire. */
function isGuildMemoryProposal(value: unknown): value is GuildMemoryProposal {
  if (typeof value !== "object" || value === null) return false;
  if (!("id" in value) || !isNonEmptyString(value.id)) return false;
  if (!("scope" in value) || value.scope !== "guild") return false;
  if (!("guildId" in value) || !isNonEmptyString(value.guildId)) return false;
  if (!("key" in value) || !isNonEmptyString(value.key)) return false;
  if (!("action" in value)) return false;
  if (value.action === "save") {
    return (
      "category" in value &&
      isGuildMemoryCategory(value.category) &&
      "value" in value &&
      isNonEmptyString(value.value)
    );
  }
  if (value.action === "delete") {
    return (
      !("category" in value) ||
      value.category === undefined ||
      isGuildMemoryCategory(value.category)
    );
  }
  return false;
}

/** A `memory_save` / `memory_delete` output that carries a proposal (refused and direct-write outputs carry none). */
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
 * Extract the guild memory proposals of a generation from its tool results,
 * in the order the model proposed them. Only `memory_save` / `memory_delete`
 * outputs carry proposals; every other tool result is ignored. Malformed
 * outputs are dropped rather than fatal — the confirmation card simply never
 * sees them.
 */
export function extractGuildMemoryProposals(
  toolResults: readonly ToolResultLike[],
): GuildMemoryProposal[] {
  const proposals: GuildMemoryProposal[] = [];
  for (const { toolName, output } of toolResults) {
    if (!Object.hasOwn(GUILD_MEMORY_TOOL_NAMES, toolName) || !isProposedOutput(output)) continue;
    if (isGuildMemoryProposal(output.proposal)) proposals.push(output.proposal);
  }
  return proposals;
}

// ── Guild memory apply handler ────────────────────────────────────────────

function isGuildMemoryApplyRequest(value: unknown): value is GuildMemoryApplyRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "updatedBy" in value &&
    isNonEmptyString(value.updatedBy) &&
    "proposals" in value &&
    Array.isArray(value.proposals) &&
    value.proposals.every(isGuildMemoryProposal)
  );
}

/**
 * Execute one confirmed proposal against `guild_memory`.
 *
 * The card showed `key` and `value` exactly, and the memory tool already
 * applied {@link normalizeMemoryKey} / {@link normalizeMemoryValue} when it
 * created the proposal: bytes that are not in that form were never shown to
 * the user, so they are refused rather than quietly stored in another form.
 * A delete that matched nothing still succeeded — the entry is gone — and
 * carries `not_found` so the caller can say so. Throws when D1 fails.
 */
async function applyProposal(
  db: D1Database,
  proposal: GuildMemoryProposal,
  updatedBy: string,
): Promise<{ ok: boolean; code?: string }> {
  if (proposal.guildId === DM_SCOPE) return { ok: false, code: "dm_not_allowed" };
  if (normalizeMemoryKey(proposal.key) !== proposal.key) {
    return { ok: false, code: "invalid_key" };
  }
  if (proposal.action === "delete") {
    const deleted = await clearGuildMemory(db, {
      guildId: proposal.guildId,
      ...(proposal.category === undefined ? {} : { category: proposal.category }),
      key: proposal.key,
    });
    return { ok: true, ...(deleted === 0 ? { code: "not_found" } : {}) };
  }
  if (normalizeMemoryValue(proposal.value) !== proposal.value) {
    return { ok: false, code: "invalid_value" };
  }
  const outcome = await setGuildMemory(db, {
    guildId: proposal.guildId,
    category: proposal.category,
    key: proposal.key,
    value: proposal.value,
    updatedBy,
    now: Date.now(),
  });
  return outcome === "memory_full" ? { ok: false, code: "memory_full" } : { ok: true };
}

/**
 * Execute the proposals a user confirmed on a guild memory card. The Runtime
 * calls this only after the user clicked 是; each proposal resolves
 * independently, so one refused or failed item never blocks the rest. Never
 * throws — a malformed request returns `{ status: "error", code }`.
 */
export async function handleGuildMemoryApply(
  db: D1Database,
  req: unknown,
): Promise<GuildMemoryApplyResponse> {
  if (!isGuildMemoryApplyRequest(req)) return { status: "error", code: "invalid_body" };
  const results: Array<{ id: string; ok: boolean; code?: string }> = [];
  for (const proposal of req.proposals) {
    try {
      results.push({ id: proposal.id, ...(await applyProposal(db, proposal, req.updatedBy)) });
    } catch (error) {
      console.log(
        JSON.stringify({
          event: "guild_memory_proposal_error",
          action: proposal.action,
          error: String(error),
        }),
      );
      results.push({ id: proposal.id, ok: false, code: "memory_op_failed" });
    }
  }
  // Count-only log — memory text never reaches the logs.
  console.log(
    JSON.stringify({
      event: "guild_memory_applied",
      updatedBy: req.updatedBy,
      proposals: req.proposals.length,
      ok: results.filter((result) => result.ok).length,
    }),
  );
  return { status: "ok", results };
}
