import { jsonSchema, tool } from "ai";
import type { ToolSet } from "ai";

import type {
  GuildMemoryCategory,
  GuildMemoryProposal,
  MemoryCategory,
} from "@xenoblade/contracts";

import {
  clearUserMemory,
  DM_SCOPE,
  getGuildMemory,
  getUserMemory,
  MAX_USER_MEMORY_ENTRIES,
  setUserMemoryWithinCap,
  type MemorySaveOutcome,
} from "../db";
import { normalizeMemoryKey, normalizeMemoryValue } from "../memory";

/** What one memory tool may act on: the generation's user and scope. */
export interface MemoryToolContext {
  db: D1Database;
  /** The triggering user — the only user whose personal memory is reachable. */
  userId: string;
  /** The generation's scope: a guild id, or `"dm"`, where shared memory does not exist. */
  scopeId: string;
}

/** One stored entry as `memory_list` reports it. */
export interface MemoryEntry {
  scope: "user" | "guild";
  category: MemoryCategory;
  key: string;
  value: string;
}

export type MemoryListOutput =
  | { status: "ok"; memories: MemoryEntry[] }
  | { status: "rejected"; reason: "dm_not_allowed" };

type SaveProposal = Extract<GuildMemoryProposal, { action: "save" }>;
type DeleteProposal = Extract<GuildMemoryProposal, { action: "delete" }>;

export type MemorySaveOutput =
  | { status: "saved"; scope: "user"; category: GuildMemoryCategory; key: string; value: string }
  | { status: "proposed"; proposal: SaveProposal }
  | { status: "rejected"; reason: "dm_not_allowed" | "empty_key" | "empty_value" }
  | { status: "error"; code: "empty_key" | "empty_value" | "memory_full" | "memory_save_failed" };

export type MemoryDeleteOutput =
  | { status: "deleted"; scope: "user"; key: string; deletedCount: number }
  | { status: "not_found"; scope: "user"; key: string; deletedCount: 0 }
  | { status: "proposed"; proposal: DeleteProposal }
  | { status: "rejected"; reason: "dm_not_allowed" | "empty_key" }
  | { status: "error"; code: "empty_key" | "memory_delete_failed" };

/**
 * Create the memory tools.
 *
 * Memory has two tiers. `scope: "user"` is the triggering user's own personal
 * memory: the tools read and write it at once, and only ever for `userId`, so
 * no request can reach another user's memory. `scope: "guild"` is the current
 * guild's shared memory: its writes are deliberately stateless — they return a
 * proposal that travels back inside the generation result, and only the
 * Runtime's button-confirmed call to `POST /internal/v1/memory/guild/apply`
 * executes it — and they are refused in a DM.
 */
export function createMemoryTools(context: MemoryToolContext): ToolSet {
  const { db, userId, scopeId } = context;

  return {
    memory_list: tool({
      description:
        "List stored memory. `user` is the triggering user's own personal memory and `guild` is the current server's shared memory (refused in DMs); omit `scope` or pass `all` to list both. " +
        "Returns { status: 'ok', memories: [{ scope, category, key, value }] }. Use it to find the exact key before updating or deleting an entry.",
      inputSchema: jsonSchema<{ scope?: "user" | "guild" | "all" }>({
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["user", "guild", "all"],
            description: "Which memory to list. Defaults to all.",
          },
        },
        additionalProperties: false,
      }),
      execute: async ({ scope = "all" }): Promise<MemoryListOutput> => {
        if (scope === "guild" && scopeId === DM_SCOPE) {
          return { status: "rejected", reason: "dm_not_allowed" };
        }
        const memories: MemoryEntry[] = [];
        if (scope !== "guild") {
          memories.push(
            ...(await getUserMemory(db, userId)).map((memory): MemoryEntry => ({
              scope: "user",
              category: memory.category,
              key: memory.key,
              value: memory.value,
            })),
          );
        }
        if (scope !== "user" && scopeId !== DM_SCOPE) {
          memories.push(
            ...(await getGuildMemory(db, scopeId)).map((memory): MemoryEntry => ({
              scope: "guild",
              category: memory.category,
              key: memory.key,
              value: memory.value,
            })),
          );
        }
        return { status: "ok", memories };
      },
    }),

    memory_save: tool({
      description:
        "Save one memory entry: `key` is its stable label (reuse an existing key from memory_list to update that entry), `value` its content as one concise sentence in the user's language, `category` 'fact' (default) or 'preference'. " +
        `\`scope: 'user'\` saves to the triggering user's own personal memory, at once — only when they explicitly asked you to remember or update something about themselves. The result is final: { status: 'saved', ... } means it is stored now, and { status: 'error', code } means nothing changed (\`memory_full\`: their ${MAX_USER_MEMORY_ENTRIES}-entry limit is reached, so ask them to remove an entry first). ` +
        "`scope: 'guild'` proposes an entry for the current server's shared memory — only when the triggering user explicitly asked you to remember something for this server. It never saves by itself: a confirmation card with 是 / 不是 buttons follows your reply, and the entry is stored only after the user clicks 是. Never claim it is saved before that. Refused in DMs.",
      inputSchema: jsonSchema<{
        scope: "user" | "guild";
        key: string;
        value: string;
        category?: GuildMemoryCategory;
      }>({
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["user", "guild"],
            description:
              "'user' for the triggering user's own memory; 'guild' for this server's shared memory.",
          },
          key: {
            type: "string",
            description:
              "Short stable label for the entry (e.g. 'favorite language', 'pet', 'release day'). Reuse the key shown in memory_list to update it.",
          },
          value: {
            type: "string",
            description: "The content as one concise sentence, written in the user's language.",
          },
          category: {
            type: "string",
            enum: ["fact", "preference"],
            description:
              "fact = something that is true; preference = how you should behave. Defaults to fact.",
          },
        },
        required: ["scope", "key", "value"],
        additionalProperties: false,
      }),
      execute: async ({ scope, key, value, category }): Promise<MemorySaveOutput> => {
        const saveCategory = category ?? "fact";
        if (scope === "guild") {
          if (scopeId === DM_SCOPE) return { status: "rejected", reason: "dm_not_allowed" };
          const normalizedKey = normalizeMemoryKey(key);
          if (normalizedKey === null) return { status: "rejected", reason: "empty_key" };
          const normalizedValue = normalizeMemoryValue(value);
          if (normalizedValue === null) return { status: "rejected", reason: "empty_value" };
          return {
            status: "proposed",
            proposal: {
              id: crypto.randomUUID(),
              scope: "guild",
              guildId: scopeId,
              action: "save",
              category: saveCategory,
              key: normalizedKey,
              value: normalizedValue,
            },
          };
        }
        const normalizedKey = normalizeMemoryKey(key);
        if (normalizedKey === null) return { status: "error", code: "empty_key" };
        const normalizedValue = normalizeMemoryValue(value);
        if (normalizedValue === null) return { status: "error", code: "empty_value" };
        let outcome: MemorySaveOutcome;
        try {
          outcome = await setUserMemoryWithinCap(db, {
            userId,
            category: saveCategory,
            key: normalizedKey,
            value: normalizedValue,
          });
        } catch (error) {
          console.log(JSON.stringify({ event: "memory_save_error", scope, error: String(error) }));
          return { status: "error", code: "memory_save_failed" };
        }
        if (outcome === "memory_full") return { status: "error", code: "memory_full" };
        return {
          status: "saved",
          scope: "user",
          category: saveCategory,
          key: normalizedKey,
          value: normalizedValue,
        };
      },
    }),

    memory_delete: tool({
      description:
        "Delete memory entries by their exact `key` (see memory_list), optionally restricted to one `category` ('fact' or 'preference'); without `category` the key is removed from every category. " +
        "`scope: 'user'` deletes from the triggering user's own personal memory, at once — only when they explicitly asked you to forget something about themselves. The result is final: { status: 'deleted', deletedCount } means the entries are gone, { status: 'not_found' } means no entry had that key. " +
        "`scope: 'guild'` proposes deleting from the current server's shared memory. It never deletes by itself: a confirmation card with 是 / 不是 buttons follows your reply, and the entries are removed only after the user clicks 是. Refused in DMs.",
      inputSchema: jsonSchema<{
        scope: "user" | "guild";
        key: string;
        category?: GuildMemoryCategory;
      }>({
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["user", "guild"],
            description:
              "'user' for the triggering user's own memory; 'guild' for this server's shared memory.",
          },
          key: {
            type: "string",
            description:
              "The key of the entry to remove, as shown in memory_list. Omit category to remove the key from every category.",
          },
          category: {
            type: "string",
            enum: ["fact", "preference"],
            description: "Restrict the deletion to one category.",
          },
        },
        required: ["scope", "key"],
        additionalProperties: false,
      }),
      execute: async ({ scope, key, category }): Promise<MemoryDeleteOutput> => {
        const normalizedKey = normalizeMemoryKey(key);
        if (scope === "guild") {
          if (scopeId === DM_SCOPE) return { status: "rejected", reason: "dm_not_allowed" };
          if (normalizedKey === null) return { status: "rejected", reason: "empty_key" };
          return {
            status: "proposed",
            proposal: {
              id: crypto.randomUUID(),
              scope: "guild",
              guildId: scopeId,
              action: "delete",
              ...(category === undefined ? {} : { category }),
              key: normalizedKey,
            },
          };
        }
        // A blank key must never reach clearUserMemory: without a key it
        // clears the user's whole memory.
        if (normalizedKey === null) return { status: "error", code: "empty_key" };
        let deletedCount: number;
        try {
          deletedCount = await clearUserMemory(db, {
            userId,
            ...(category === undefined ? {} : { category }),
            key: normalizedKey,
          });
        } catch (error) {
          console.log(
            JSON.stringify({ event: "memory_delete_error", scope, error: String(error) }),
          );
          return { status: "error", code: "memory_delete_failed" };
        }
        return deletedCount > 0
          ? { status: "deleted", scope: "user", key: normalizedKey, deletedCount }
          : { status: "not_found", scope: "user", key: normalizedKey, deletedCount: 0 };
      },
    }),
  };
}
