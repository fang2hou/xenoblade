import { jsonSchema, tool } from "ai";
import type { ToolSet } from "ai";

import type { MemoryProposal } from "@xenoblade/contracts";

/** Hard caps applied at proposal time; longer input is truncated, not rejected. */
const MAX_KEY_CHARS = 64;
const MAX_VALUE_CHARS = 500;

function clamp(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

/**
 * Create the memory intent tools (ADR-013).
 *
 * `remember` proposes saving (or updating) one memory about the current user;
 * `forget` proposes deleting one. Both are deliberately stateless: they write
 * nothing during generation — the proposal travels back inside the generation
 * result, and only the Runtime's user-confirmed reaction executes it via
 * `POST /internal/v1/memory/proposals`. A failed model-chain attempt therefore
 * leaves no orphaned durable state behind.
 */
export function createMemoryTools(): ToolSet {
  return {
    remember: tool({
      description:
        "Propose saving a durable memory about the current user — a stable fact or preference they explicitly asked you to remember, or a new value for one you already know. " +
        "Nothing is saved until the user confirms it in a follow-up message. " +
        "Call this only on explicit user intent (they said remember/update/note this about me), consolidate related items into one call, and never store anything about other people.",
      inputSchema: jsonSchema<{ key: string; value: string; category?: "fact" | "preference" }>({
        type: "object",
        properties: {
          key: {
            type: "string",
            description:
              "Short stable label for the memory (e.g. 'favorite language', 'pet'). Reuse the key shown in your known-memory list to update it.",
          },
          value: {
            type: "string",
            description:
              "The memory content as one concise sentence, written in the language the user used.",
          },
          category: {
            type: "string",
            enum: ["fact", "preference"],
            description:
              "fact = something true about the user; preference = how they want you to behave. Defaults to fact.",
          },
        },
        required: ["key", "value"],
        additionalProperties: false,
      }),
      execute: async ({
        key,
        value,
        category,
      }): Promise<{ status: string; proposal: MemoryProposal }> => {
        const proposal: MemoryProposal = {
          id: crypto.randomUUID(),
          action: "save",
          category: category ?? "fact",
          key: clamp(key, MAX_KEY_CHARS),
          value: clamp(value, MAX_VALUE_CHARS),
        };
        return { status: "proposed", proposal };
      },
    }),

    forget: tool({
      description:
        "Propose deleting a memory about the current user that they explicitly asked you to forget. " +
        "Nothing is deleted until the user confirms it in a follow-up message.",
      inputSchema: jsonSchema<{ key: string; category?: "fact" | "preference" }>({
        type: "object",
        properties: {
          key: {
            type: "string",
            description:
              "The key of the memory to remove, as shown in your known-memory list. Omit category to remove the key from every category.",
          },
          category: {
            type: "string",
            enum: ["fact", "preference"],
            description: "Restrict the deletion to one category.",
          },
        },
        required: ["key"],
        additionalProperties: false,
      }),
      execute: async ({ key, category }): Promise<{ status: string; proposal: MemoryProposal }> => {
        const proposal: MemoryProposal = {
          id: crypto.randomUUID(),
          action: "forget",
          ...(category === undefined ? {} : { category }),
          key: clamp(key, MAX_KEY_CHARS),
        };
        return { status: "proposed", proposal };
      },
    }),
  };
}
