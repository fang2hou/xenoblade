import type { SettingsRequest, SettingsResponse } from "@xenoblade/contracts";

import { getUserSettings, setUserSettings } from "./db";

/**
 * Handle a settings command (get/set) against the `user_settings` table.
 *
 * `set` applies only the flags present in the request (absent flags keep their
 * current value) and returns the full post-operation settings. Never throws —
 * a failure returns `{ status: "error", code }`.
 */
export async function handleSettings(
  db: D1Database,
  req: SettingsRequest,
): Promise<SettingsResponse> {
  try {
    if (req.op === "get") {
      return { status: "ok", settings: await getUserSettings(db, req.userId) };
    }

    if (req.chatOptin !== undefined || req.learnOptin !== undefined) {
      await setUserSettings(db, {
        userId: req.userId,
        chatOptin: req.chatOptin,
        learnOptin: req.learnOptin,
      });
    }
    return { status: "ok", settings: await getUserSettings(db, req.userId) };
  } catch (error) {
    console.log(JSON.stringify({ event: "settings_op_error", op: req.op, error: String(error) }));
    return { status: "error", code: "settings_op_failed" };
  }
}
