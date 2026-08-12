import type { MemoryRequest, MemoryResponse } from "@xenoblade/contracts";

import { clearUserMemory, getUserMemory, setUserMemory } from "./db";

/**
 * Handle a memory command (get/set/clear) against the `user_memory` table.
 *
 * `set` and `clear` return the user's full post-operation memory list so the
 * caller can reconcile state without a follow-up `get`. Never throws — a
 * failure returns `{ status: "error", code }`.
 */
export async function handleMemory(
  db: D1Database,
  req: MemoryRequest,
): Promise<MemoryResponse> {
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
