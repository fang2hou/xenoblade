import { jsonSchema, tool } from "ai";
import type { ToolSet } from "ai";

import type {
  GuildMemoryCategory,
  GuildMemoryProposal,
  MemoryCategory,
} from "@xenoblade/contracts";

import {
  clearUserMemoryEntries,
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

type ListInput = { scope?: "user" | "guild" | "all" };
type SaveInput = {
  scope: "user" | "guild";
  key: string;
  value: string;
  category?: GuildMemoryCategory;
};
type DeleteInput = { scope: "user" | "guild"; key: string; category?: GuildMemoryCategory };

export type MemoryListOutput =
  | { status: "ok"; memories: MemoryEntry[] }
  | { status: "rejected"; reason: "dm_not_allowed" }
  | { status: "error"; code: "invalid_input" };

type SaveProposal = Extract<GuildMemoryProposal, { action: "save" }>;
type DeleteProposal = Extract<GuildMemoryProposal, { action: "delete" }>;

export type MemorySaveOutput =
  | { status: "saved"; scope: "user"; category: GuildMemoryCategory; key: string; value: string }
  | { status: "proposed"; proposal: SaveProposal }
  | { status: "rejected"; reason: "dm_not_allowed" | "empty_key" | "empty_value" }
  | {
      status: "error";
      code: "invalid_input" | "empty_key" | "empty_value" | "memory_full" | "memory_save_failed";
    };

export type MemoryDeleteOutput =
  | { status: "deleted"; scope: "user"; key: string; deletedCount: number }
  | { status: "not_found"; scope: "user"; key: string; deletedCount: 0 }
  | { status: "proposed"; proposal: DeleteProposal }
  | { status: "rejected"; reason: "dm_not_allowed" | "empty_key" }
  | { status: "error"; code: "invalid_input" | "empty_key" | "memory_delete_failed" };

/**
 * A model does not have to honor the input schema, so every tool checks its
 * arguments before acting; a call that does not match changes nothing.
 */
const INVALID_INPUT = { status: "error", code: "invalid_input" } as const;

function isWriteScope(value: unknown): value is "user" | "guild" {
  return value === "user" || value === "guild";
}

function isListScope(value: unknown): value is ListInput["scope"] {
  return value === undefined || isWriteScope(value) || value === "all";
}

function isOptionalCategory(value: unknown): value is GuildMemoryCategory | undefined {
  return value === undefined || value === "fact" || value === "preference";
}

function isListInput(value: unknown): value is ListInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return "scope" in value ? isListScope(value.scope) : true;
}

function isSaveInput(value: unknown): value is SaveInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return (
    "scope" in value &&
    isWriteScope(value.scope) &&
    "key" in value &&
    typeof value.key === "string" &&
    "value" in value &&
    typeof value.value === "string" &&
    ("category" in value ? isOptionalCategory(value.category) : true)
  );
}

function isDeleteInput(value: unknown): value is DeleteInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return (
    "scope" in value &&
    isWriteScope(value.scope) &&
    "key" in value &&
    typeof value.key === "string" &&
    ("category" in value ? isOptionalCategory(value.category) : true)
  );
}

/**
 * Create the memory tools.
 *
 * Memory has two tiers. `scope: "user"` is the triggering user's own personal
 * memory: the tools read and write it at once, and only ever for `userId`, so
 * no request can reach another user's memory; persona entries stay with the
 * `/persona` command, so the tools neither save nor delete them. `scope:
 * "guild"` is the current guild's shared memory: its writes are deliberately
 * stateless — they return a proposal that travels back inside the generation
 * result, and only the Runtime's button-confirmed call to
 * `POST /internal/v1/memory/guild/apply` executes it — and they are refused
 * in a DM.
 */
export function createMemoryTools(context: MemoryToolContext): ToolSet {
  const { db, userId, scopeId } = context;

  return {
    memory_list: tool({
      description:
        "List stored memory. `user` is the triggering user's own personal memory and `guild` is the current server's shared memory (refused in DMs); omit `scope` or pass `all` to list both. " +
        "Returns { status: 'ok', memories: [{ scope, category, key, value }] }. Use it to find the exact key before updating or deleting an entry.",
      inputSchema: jsonSchema<ListInput>({
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
      execute: async (args: unknown): Promise<MemoryListOutput> => {
        if (!isListInput(args)) return INVALID_INPUT;
        const scope = args.scope ?? "all";
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
      inputSchema: jsonSchema<SaveInput>({
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
      execute: async (args: unknown): Promise<MemorySaveOutput> => {
        if (!isSaveInput(args)) return INVALID_INPUT;
        const { scope, key, value, category } = args;
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
        "Delete memory entries by their exact `key` (see memory_list), optionally restricted to one `category` ('fact' or 'preference'); without `category` the key is removed from both. " +
        "`scope: 'user'` deletes from the triggering user's own personal memory, at once — only when they explicitly asked you to forget something about themselves. The result is final: { status: 'deleted', deletedCount } means the entries are gone, { status: 'not_found' } means no entry had that key. " +
        "`scope: 'guild'` proposes deleting from the current server's shared memory. It never deletes by itself: a confirmation card with 是 / 不是 buttons follows your reply, and the entries are removed only after the user clicks 是. Refused in DMs.",
      inputSchema: jsonSchema<DeleteInput>({
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
              "The key of the entry to remove, as shown in memory_list. Omit category to remove the key from both.",
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
      execute: async (args: unknown): Promise<MemoryDeleteOutput> => {
        if (!isDeleteInput(args)) return INVALID_INPUT;
        const { scope, key, category } = args;
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
        // A blank key must never become a delete without one: that would
        // clear every fact and preference the user holds.
        if (normalizedKey === null) return { status: "error", code: "empty_key" };
        let deletedCount: number;
        try {
          deletedCount = await clearUserMemoryEntries(db, {
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
