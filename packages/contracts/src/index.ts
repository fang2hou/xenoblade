/**
 * Wire types for communication between Discord Runtime (gateway host) and
 * Platform Worker (Cloudflare). All types are JSON-serializable.
 *
 * This package is the single source of truth for the request/response contract.
 * Both apps import from here; CI contract tests verify compatibility.
 */

// ── Discord Message Envelope ──────────────────────────────────────────────

export interface DiscordAttachment {
  id: string;
  url: string;
  contentType: string | null;
  size: number;
}

export interface DiscordMessageEnvelope {
  messageId: string;
  guildId: string | null;
  channelId: string;
  parentChannelId: string | null;
  threadId: string | null;
  /** Stable conversation key: `discord:<guildId|@me>:<channelId>[:<threadId>]` */
  containerId: string;
  /** `"dm"` or guild ID. */
  scopeId: string;
  author: { id: string; displayName: string; isBot: boolean };
  content: string;
  mentions: string[];
  mentionedRoleIds: string[];
  reference: null | {
    messageId: string;
    channelId: string;
    authorId: string | null;
  };
  attachments: DiscordAttachment[];
  createdAt: string;
}

// ── Summon Kind ───────────────────────────────────────────────────────────

export type SummonKind =
  | "user-mention"
  | "role-mention"
  | "reply-to-bot"
  | "slash-command"
  | "component";

// ── History (context) ─────────────────────────────────────────────────────

export interface HistoryMessage {
  id: string;
  text: string;
  authorId: string;
  authorName: string;
  isBot: boolean;
  createdAt: number;
}

// ── Generation ────────────────────────────────────────────────────────────

export interface GenerationRequest {
  messageId: string;
  containerId: string;
  scopeId: string;
  channelId: string;
  userId: string;
  userDisplayName: string;
  summonKind: SummonKind;
  content: string;
  history: HistoryMessage[];
  reference: DiscordMessageEnvelope["reference"];
  attachments: DiscordAttachment[];
  /** When true, hints the pipeline that the user is asking about recent events. */
  searchHint?: boolean;
}

export interface GenerationUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs: number;
}

export type GenerationResult =
  | {
      status: "completed";
      requestId: string;
      reply: string;
      usage: GenerationUsage;
    }
  | {
      status: "rejected";
      requestId: string;
      code: "duplicate" | "disabled" | "budget_exceeded";
    }
  | {
      status: "error";
      requestId: string;
      code: string;
      message: string;
      retryable: boolean;
    };

// ── Usage ─────────────────────────────────────────────────────────────────

/** One tool and its invocation count over the usage window. */
export interface UsageToolCount {
  tool: string;
  count: number;
}

/** Aggregated usage for one subject (a user or a guild) over the window. */
export interface UsageSubjectSummary {
  /** Deduped trigger messages processed (one `interactions` row each). */
  messages: number;
  /** Interactions that completed with a reply. */
  generations: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Most-invoked tools in the window, count descending. */
  topTools: UsageToolCount[];
}

/** Rolling-window usage for the requesting user and their guild. */
export interface UsageSummary {
  windowMs: number;
  user: UsageSubjectSummary;
  guild: UsageSubjectSummary;
}

export type UsageSummaryResponse =
  | ({ status: "ok" } & UsageSummary)
  | { status: "error"; code: string };

// ── User Memory ───────────────────────────────────────────────────────────

export type MemoryCategory = "persona" | "preference" | "fact";

export interface UserMemory {
  category: MemoryCategory;
  key: string;
  value: string;
  updatedAt: number;
}

export type MemoryRequest =
  | { op: "get"; userId: string }
  | {
      op: "set";
      userId: string;
      category: MemoryCategory;
      key: string;
      value: string;
    }
  | { op: "clear"; userId: string; category?: MemoryCategory; key?: string };

export type MemoryResponse =
  | { status: "ok"; memories: UserMemory[] }
  | { status: "error"; code: string };

// ── Context Clear ─────────────────────────────────────────────────────────

export interface ContextClearRequest {
  userId: string;
  scopeId: string;
  containerId: string;
  /** `user` = this user in this container; `channel` = all users in this container; `all` = this user everywhere. */
  scope: "user" | "channel" | "all";
  /** If set, only clear messages older than `Date.now() - beforeMs`. */
  beforeMs?: number;
}

export type ContextClearResult =
  | { status: "ok"; cleared: number }
  | { status: "error"; code: string };

// ── Health ────────────────────────────────────────────────────────────────

export interface HealthResponse {
  status: "ok";
  timestamp: number;
}
