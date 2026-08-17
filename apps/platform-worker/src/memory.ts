import type {
  MemoryCategory,
  MemoryProposalRequest,
  MemoryProposalResponse,
  MemoryRequest,
  MemoryResponse,
} from "@xenoblade/contracts";

import { clearUserMemory, getUserMemory, setUserMemory } from "./db";

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

/** Cap on confirmed fact+preference rows per user (ADR-013, follows ADR-012's sizing). */
const MAX_CONFIRMED_MEMORIES = 50;

/** Categories a proposal may write; persona stays command-configured (ADR-012). */
const PROPOSAL_CATEGORIES: readonly MemoryCategory[] = ["fact", "preference"];

/**
 * Execute user-confirmed memory proposals (ADR-013). The Runtime calls this
 * only after the user reacted ✅ on the confirmation message; each proposal
 * resolves independently so one bad item never blocks the rest. `save`
 * upserts (model-visible memory makes updates natural); `forget` deletes by
 * key, optionally restricted to one category. Never throws.
 */
export async function handleMemoryProposals(
  db: D1Database,
  req: MemoryProposalRequest,
): Promise<MemoryProposalResponse> {
  const results: Array<{ id: string; ok: boolean; code?: string }> = [];
  try {
    const existing = await getUserMemory(db, req.userId);
    // Keys known to exist, updated as the batch executes so a second save of
    // the same new key within one batch is an update, not another row.
    const knownKeys = new Set(existing.map((m) => `${m.category}\u0000${m.key}`));
    let confirmedCount = existing.filter(
      (m) => m.category === "fact" || m.category === "preference",
    ).length;
    for (const proposal of req.proposals) {
      const category = proposal.category;
      // The wire is unvalidated JSON: an unknown `action` must be rejected
      // outright, or it would fall through to the forget (delete) branch.
      const invalid =
        (proposal.action !== "save" && proposal.action !== "forget") ||
        (category !== undefined && !PROPOSAL_CATEGORIES.includes(category)) ||
        proposal.key === "" ||
        (proposal.action === "save" && (proposal.value === undefined || proposal.value === ""));
      if (invalid) {
        results.push({ id: proposal.id, ok: false, code: "invalid_proposal" });
        continue;
      }
      try {
        if (proposal.action === "save") {
          const saveCategory = category ?? "fact";
          const knownKey = `${saveCategory}\u0000${proposal.key}`;
          if (!knownKeys.has(knownKey) && confirmedCount >= MAX_CONFIRMED_MEMORIES) {
            results.push({ id: proposal.id, ok: false, code: "memory_full" });
            continue;
          }
          await setUserMemory(db, {
            userId: req.userId,
            category: saveCategory,
            key: proposal.key,
            value: proposal.value ?? "",
          });
          if (!knownKeys.has(knownKey)) {
            knownKeys.add(knownKey);
            confirmedCount += 1;
          }
          results.push({ id: proposal.id, ok: true });
        } else {
          const deleted = await clearUserMemory(db, {
            userId: req.userId,
            ...(proposal.category === undefined ? {} : { category: proposal.category }),
            key: proposal.key,
          });
          results.push({
            id: proposal.id,
            ok: true,
            ...(deleted === 0 ? { code: "not_found" } : {}),
          });
        }
      } catch (error) {
        console.log(
          JSON.stringify({
            event: "memory_proposal_error",
            action: proposal.action,
            error: String(error),
          }),
        );
        results.push({ id: proposal.id, ok: false, code: "memory_op_failed" });
      }
    }
    return { status: "ok", results };
  } catch (error) {
    console.log(JSON.stringify({ event: "memory_proposals_failed", error: String(error) }));
    return { status: "error", code: "memory_proposals_failed" };
  }
}
