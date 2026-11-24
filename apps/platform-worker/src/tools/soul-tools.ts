import { jsonSchema, tool } from "ai";
import type { ToolSet } from "ai";

import type { SoulProposal } from "@xenoblade/contracts";

import { DM_SCOPE } from "../db";
import { getBotSoul, MAX_SOUL_CHARS, normalizeSoul } from "../soul";

/** Longest change summary shown on a confirmation card. */
const MAX_SUMMARY_CHARS = 300;

/** What `soul_read` reports back to the model. */
export interface SoulReadOutput {
  scopeId: string;
  content: string;
  /** True when no custom soul applies here and the built-in one is in effect. */
  isDefault: boolean;
}

/** A `soul_update` call either proposes a change or is refused outright. */
export type SoulUpdateOutput =
  | { status: "proposed"; proposal: SoulProposal }
  | { status: "rejected"; reason: "dm_not_allowed" | "empty_content" };

/**
 * `soul_read`: show the soul in effect for the generation's scope. Reads D1
 * at call time; writes nothing.
 */
export function createSoulReadTool(env: Env, scopeId: string) {
  return tool({
    description:
      "Show the soul you currently follow in this conversation: the persona and voice guidance that decides who you are and how you speak here. " +
      "Takes no input and returns { scopeId, content, isDefault }, where isDefault is true when nobody has customized the soul for this scope. " +
      "Use it when the user asks about your persona, character, or tone — and before soul_update, so a new soul keeps everything that should stay.",
    inputSchema: jsonSchema<Record<string, never>>({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    execute: async (): Promise<SoulReadOutput> => {
      const soul = await getBotSoul(env.DB, scopeId);
      return { scopeId, content: soul.content, isDefault: soul.isDefault };
    },
  });
}

/**
 * `soul_update`: propose a new soul for the generation's scope.
 *
 * Deliberately stateless — it writes nothing during generation. The proposal
 * travels back inside the generation result, and only the Runtime's
 * button-confirmed call to `POST /internal/v1/soul/apply` stores it, so a
 * failed model-chain attempt leaves no orphaned soul behind. DM generations
 * are refused: the soul is server-owned and cannot be edited from a DM.
 */
export function createSoulUpdateTool(scopeId: string) {
  return tool({
    description:
      "Propose a new soul for this server: the persona and voice you will follow in every later reply here. " +
      "Call it only when the user explicitly asks to change your persona, character, or tone, and only in a server — it is refused in DMs. " +
      "Nothing changes until the user confirms a follow-up card with a 是 / 不是 button, so never claim the soul is updated before they do. " +
      "The card shows the user the full content and the summary, and the content is saved exactly as written there: content is the complete new soul (it replaces the current one), and summary is one or two short, specific, honest sentences in the user's language saying what changes about your persona or tone.",
    inputSchema: jsonSchema<{ content: string; summary: string }>({
      type: "object",
      properties: {
        content: {
          type: "string",
          description: `The complete new soul as plain text, at most ${MAX_SOUL_CHARS} characters.`,
        },
        summary: {
          type: "string",
          description:
            "One or two sentences in the user's language saying what changes about your persona or tone.",
        },
      },
      required: ["content", "summary"],
      additionalProperties: false,
    }),
    execute: async ({ content, summary }): Promise<SoulUpdateOutput> => {
      if (scopeId === DM_SCOPE) return { status: "rejected", reason: "dm_not_allowed" };
      const normalized = normalizeSoul(content);
      if (normalized === null) return { status: "rejected", reason: "empty_content" };
      return {
        status: "proposed",
        proposal: {
          id: crypto.randomUUID(),
          scopeId,
          content: normalized,
          summary: Array.from(summary.trim()).slice(0, MAX_SUMMARY_CHARS).join(""),
        },
      };
    },
  });
}

/** The soul tool set for one generation: `soul_read` and `soul_update`. */
export function createSoulTools(env: Env, scopeId: string): ToolSet {
  return {
    soul_read: createSoulReadTool(env, scopeId),
    soul_update: createSoulUpdateTool(scopeId),
  };
}
