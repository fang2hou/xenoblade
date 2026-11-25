import { jsonSchema, tool } from "ai";
import type { ToolSet } from "ai";

import { DM_SCOPE, getGuildAllowlist } from "../db";
import { isRecord } from "../guards";
import {
  getIndexedMessageContext,
  getRecentIndexedMessages,
  searchIndexedMessages,
  type IndexedMessage,
} from "../history-index";

/** What a history tool may read: the generation's guild, and the channel it runs in. */
export interface HistoryToolContext {
  db: D1Database;
  /** The generation's scope: a guild id, or `"dm"`, which has no history. */
  scopeId: string;
  /** Channel the generation runs in — a thread's own id inside a thread. */
  channelId: string;
  /** Parent channel when `channelId` is a thread, else null. */
  parentChannelId: string | null;
}

/** One stored message as a history tool reports it; `createdAt` is ISO 8601. */
export interface HistoryToolMessage {
  messageId: string;
  channelId: string;
  authorId: string;
  authorName: string;
  isBot: boolean;
  content: string;
  replyToId: string | null;
  createdAt: string;
}

export interface HistoryContextMessage extends HistoryToolMessage {
  isAnchor: boolean;
}

export type HistoryToolError =
  | "invalid_input"
  | "invalid_time_range"
  | "no_parent_channel"
  | "message_not_found"
  | "history_read_failed";

export type HistoryToolOutput = { messages: HistoryToolMessage[] } | { error: HistoryToolError };

export type HistoryContextOutput =
  | { messages: HistoryContextMessage[] }
  | { error: HistoryToolError };

const DEFAULT_RECENT_LIMIT = 20;
const MAX_RECENT_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 25;
const DEFAULT_CONTEXT_NEIGHBORS = 5;
const MAX_CONTEXT_NEIGHBORS = 15;

/**
 * Longest message text one tool result carries — per message, and for all of
 * them together. Without it a single call could flood the model's context
 * with fifty 4,000-character messages.
 */
const MAX_MESSAGE_CHARS = 1_000;
const MAX_TOTAL_CHARS = 24_000;
const TRUNCATED_MARK = "…[truncated]";

/** Longest search text and author filter a call may carry. */
const MAX_QUERY_CHARS = 500;
const MAX_AUTHOR_CHARS = 100;

/** Longest id or time bound a call may name. */
const MAX_SHORT_ARG_CHARS = 64;

/** `channel_id` value that means the parent channel of the current thread. */
const PARENT_CHANNEL = "parent";

const INVALID_INPUT = { error: "invalid_input" } as const;
const INVALID_TIME_RANGE = { error: "invalid_time_range" } as const;
const READ_FAILED = { error: "history_read_failed" } as const;

type RecentInput = { channel_id?: string; before_message_id?: string; limit?: number };
type SearchInput = {
  query: string;
  channel_id?: string;
  author_name?: string;
  after?: string;
  before?: string;
  limit?: number;
};
type ContextInput = { message_id: string; before?: number; after?: number };

/** A history tool's reach: the generation's guild and channel, and the guild's channel allowlist. */
interface HistoryScope extends HistoryToolContext {
  allowedChannels: () => Promise<string[] | null>;
}

type HistoryToolName = "get_recent_messages" | "search_chat_history" | "get_message_context";

/**
 * A model does not have to honor the input schema, so every tool checks its
 * arguments before reading; a call that does not match answers `invalid_input`.
 */
function isIdArg(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= MAX_SHORT_ARG_CHARS;
}

function isCountArg(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isTextArg(value: unknown, maxChars: number): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= maxChars;
}

function isRecentArgs(input: unknown): input is RecentInput {
  if (!isRecord(input)) return false;
  return (
    (input.channel_id === undefined || isIdArg(input.channel_id)) &&
    (input.before_message_id === undefined || isIdArg(input.before_message_id)) &&
    (input.limit === undefined || isCountArg(input.limit))
  );
}

function isSearchArgs(input: unknown): input is SearchInput {
  if (!isRecord(input)) return false;
  return (
    isTextArg(input.query, MAX_QUERY_CHARS) &&
    (input.channel_id === undefined || isIdArg(input.channel_id)) &&
    (input.author_name === undefined || isTextArg(input.author_name, MAX_AUTHOR_CHARS)) &&
    (input.after === undefined || isTextArg(input.after, MAX_SHORT_ARG_CHARS)) &&
    (input.before === undefined || isTextArg(input.before, MAX_SHORT_ARG_CHARS)) &&
    (input.limit === undefined || isCountArg(input.limit))
  );
}

function isContextArgs(input: unknown): input is ContextInput {
  if (!isRecord(input)) return false;
  return (
    isIdArg(input.message_id) &&
    (input.before === undefined || isCountArg(input.before)) &&
    (input.after === undefined || isCountArg(input.after))
  );
}

/** A count argument as it is used: absent means `fallback`; the value is floored and kept within [min, max]. */
function clampCount(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * A time bound as epoch ms: a digit string is epoch ms itself, anything else
 * a date. JavaScript reads a zone-less date-time in the machine's local zone,
 * so one is read as UTC here — the zone the index keeps. Null when unparseable.
 */
function toEpochMs(value: string): number | null {
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text);
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(text) ? `${text}Z` : text);
  return Number.isFinite(ms) ? ms : null;
}

/** The longest message text of a result with `count` messages, under the total budget. */
function contentCap(count: number): number {
  return Math.max(1, Math.min(MAX_MESSAGE_CHARS, Math.floor(MAX_TOTAL_CHARS / Math.max(1, count))));
}

/**
 * One stored message as the model sees it, its text cut to `cap` characters.
 */
function toToolMessage(message: IndexedMessage, cap: number): HistoryToolMessage {
  const text = message.content;
  return {
    messageId: message.messageId,
    channelId: message.channelId,
    authorId: message.authorId,
    authorName: message.authorName,
    isBot: message.isBot,
    content:
      text.length <= cap ? text : `${Array.from(text).slice(0, cap).join("")}${TRUNCATED_MARK}`,
    replyToId: message.replyToId,
    createdAt: new Date(message.createdAt).toISOString(),
  };
}

function toToolMessages(messages: readonly IndexedMessage[]): HistoryToolMessage[] {
  const cap = contentCap(messages.length);
  return messages.map((message) => toToolMessage(message, cap));
}

/** One metadata-only log line per history read: ids, counts, and timing — never a query, a name, or message text. */
function logRead(
  toolName: HistoryToolName,
  scope: HistoryToolContext,
  channelId: string | undefined,
  startedAt: number,
  results: number,
): void {
  console.log(
    JSON.stringify({
      event: "history_read",
      tool: toolName,
      scopeId: scope.scopeId,
      ...(channelId === undefined ? {} : { channelId }),
      results,
      durationMs: Date.now() - startedAt,
    }),
  );
}

function logReadFailed(
  toolName: HistoryToolName,
  scope: HistoryToolContext,
  startedAt: number,
  error: unknown,
): void {
  console.log(
    JSON.stringify({
      event: "history_read_failed",
      tool: toolName,
      scopeId: scope.scopeId,
      // The error's name only: a database error can quote the statement or its values.
      error: error instanceof Error ? error.name : typeof error,
      durationMs: Date.now() - startedAt,
    }),
  );
}

function createRecentMessagesTool(scope: HistoryScope) {
  return tool({
    description:
      "Read recent messages of one public channel in this server — the last 90 days, oldest first. " +
      '`channel_id` defaults to the current channel; inside a thread, `channel_id: "parent"` reads the thread\'s parent channel. ' +
      "To page further back, pass a message id from an earlier result as `before_message_id`. " +
      "Returns { messages: [{ messageId, channelId, authorId, authorName, isBot, content, replyToId, createdAt }] }, where createdAt is ISO 8601 and isBot marks Xenoblade's own replies. " +
      "Use it for what was said recently; to find something older or in another channel, search_chat_history is faster.",
    inputSchema: jsonSchema<RecentInput>({
      type: "object",
      properties: {
        channel_id: {
          type: "string",
          description:
            'Channel to read. Defaults to the current channel; "parent" reads the parent channel of the thread this conversation runs in.',
        },
        before_message_id: {
          type: "string",
          description:
            "A message id from an earlier result: only messages older than it are returned.",
        },
        limit: {
          type: "number",
          description: "How many messages to return, at most 50. Defaults to 20.",
        },
      },
      additionalProperties: false,
    }),
    execute: async (input: unknown): Promise<HistoryToolOutput> => {
      if (!isRecentArgs(input)) return INVALID_INPUT;
      const channelId =
        input.channel_id === PARENT_CHANNEL
          ? scope.parentChannelId
          : (input.channel_id ?? scope.channelId);
      if (channelId === null) return { error: "no_parent_channel" };
      const limit = clampCount(input.limit, DEFAULT_RECENT_LIMIT, 1, MAX_RECENT_LIMIT);
      const startedAt = Date.now();
      try {
        const messages = await getRecentIndexedMessages(scope.db, {
          guildId: scope.scopeId,
          channelId,
          allowedChannels: await scope.allowedChannels(),
          ...(input.before_message_id === undefined
            ? {}
            : { beforeMessageId: input.before_message_id }),
          limit,
          now: startedAt,
        });
        logRead("get_recent_messages", scope, channelId, startedAt, messages.length);
        return { messages: toToolMessages(messages) };
      } catch (error) {
        logReadFailed("get_recent_messages", scope, startedAt, error);
        return READ_FAILED;
      }
    },
  });
}

function createSearchTool(scope: HistoryScope) {
  return tool({
    description:
      "Search the last 90 days of this server's public channels. Put in `query` the keywords exactly as they were written — names, terms, numbers. " +
      "Every keyword must appear in a message, so a few precise keywords work while a whole question usually finds nothing. " +
      "Narrow with `channel_id`, `author_name` (part of a display name), and `after` / `before` (ISO 8601 date or date-time, or epoch milliseconds). " +
      "Returns { messages: [...] }, best matches first, each with a `messageId` that get_message_context can expand.",
    inputSchema: jsonSchema<SearchInput>({
      type: "object",
      properties: {
        query: {
          type: "string",
          maxLength: MAX_QUERY_CHARS,
          description: "The keywords to find, as they were written in the messages.",
        },
        channel_id: {
          type: "string",
          description: "Search this channel only. Omit to search the whole server.",
        },
        author_name: {
          type: "string",
          maxLength: MAX_AUTHOR_CHARS,
          description: "Only messages whose author's display name contains this text.",
        },
        after: {
          type: "string",
          description:
            "Only messages sent after this time: ISO 8601 (2026-11-01, or 2026-11-01T08:00:00Z) or epoch milliseconds.",
        },
        before: {
          type: "string",
          description: "Only messages sent before this time, in the same formats as `after`.",
        },
        limit: {
          type: "number",
          description: "How many messages to return, at most 25. Defaults to 10.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    }),
    execute: async (input: unknown): Promise<HistoryToolOutput> => {
      if (!isSearchArgs(input)) return INVALID_INPUT;
      const afterMs = input.after === undefined ? undefined : toEpochMs(input.after);
      const beforeMs = input.before === undefined ? undefined : toEpochMs(input.before);
      if (afterMs === null || beforeMs === null) return INVALID_TIME_RANGE;
      if (afterMs !== undefined && beforeMs !== undefined && afterMs >= beforeMs) {
        return INVALID_TIME_RANGE;
      }
      const limit = clampCount(input.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
      const startedAt = Date.now();
      try {
        const messages = await searchIndexedMessages(scope.db, {
          guildId: scope.scopeId,
          query: input.query,
          ...(input.channel_id === undefined ? {} : { channelId: input.channel_id }),
          ...(input.author_name === undefined ? {} : { authorName: input.author_name }),
          ...(afterMs === undefined ? {} : { afterMs }),
          ...(beforeMs === undefined ? {} : { beforeMs }),
          allowedChannels: await scope.allowedChannels(),
          limit,
          now: startedAt,
        });
        logRead("search_chat_history", scope, input.channel_id, startedAt, messages.length);
        return { messages: toToolMessages(messages) };
      } catch (error) {
        logReadFailed("search_chat_history", scope, startedAt, error);
        return READ_FAILED;
      }
    },
  });
}

function createMessageContextTool(scope: HistoryScope) {
  return tool({
    description:
      "Read the conversation around one stored message — the `messageId` of a search_chat_history or get_recent_messages result. " +
      "Returns up to `before` earlier and `after` later messages of the same channel, oldest first, with `isAnchor: true` marking the requested one. " +
      "Use it after a search, to see what a match was about: what it answered, and what followed it.",
    inputSchema: jsonSchema<ContextInput>({
      type: "object",
      properties: {
        message_id: {
          type: "string",
          description: "The messageId of the message to expand.",
        },
        before: {
          type: "number",
          description: "Earlier messages of the same channel to include, 0 to 15. Defaults to 5.",
        },
        after: {
          type: "number",
          description: "Later messages of the same channel to include, 0 to 15. Defaults to 5.",
        },
      },
      required: ["message_id"],
      additionalProperties: false,
    }),
    execute: async (input: unknown): Promise<HistoryContextOutput> => {
      if (!isContextArgs(input)) return INVALID_INPUT;
      const startedAt = Date.now();
      try {
        const context = await getIndexedMessageContext(scope.db, {
          guildId: scope.scopeId,
          messageId: input.message_id,
          before: clampCount(input.before, DEFAULT_CONTEXT_NEIGHBORS, 0, MAX_CONTEXT_NEIGHBORS),
          after: clampCount(input.after, DEFAULT_CONTEXT_NEIGHBORS, 0, MAX_CONTEXT_NEIGHBORS),
          allowedChannels: await scope.allowedChannels(),
          now: startedAt,
        });
        logRead("get_message_context", scope, context[0]?.channelId, startedAt, context.length);
        if (context.length === 0) return { error: "message_not_found" };
        const cap = contentCap(context.length);
        return {
          messages: context.map((message) => ({
            ...toToolMessage(message, cap),
            isAnchor: message.isAnchor,
          })),
        };
      } catch (error) {
        logReadFailed("get_message_context", scope, startedAt, error);
        return READ_FAILED;
      }
    },
  });
}

/**
 * The three read-only history tools of one generation: `get_recent_messages`,
 * `search_chat_history`, and `get_message_context`.
 *
 * They read only stored messages of the generation's guild, within the last
 * 90 days, in the channels of the guild's allowlist — resolved once per
 * generation, at the first read. A DM has no guild history to reach, so a DM
 * generation gets none of these tools.
 */
export function createHistoryTools(context: HistoryToolContext): ToolSet {
  const { scopeId, db } = context;
  if (scopeId === DM_SCOPE) return {};

  let allowlist: Promise<string[] | null> | undefined;
  const scope: HistoryScope = {
    ...context,
    allowedChannels: () => {
      if (allowlist === undefined) allowlist = getGuildAllowlist(db, scopeId);
      return allowlist;
    },
  };
  return {
    get_recent_messages: createRecentMessagesTool(scope),
    search_chat_history: createSearchTool(scope),
    get_message_context: createMessageContextTool(scope),
  };
}
