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
  | "component"
  /** Non-command DM text from a chat-opted-in user (ADR-011). */
  | "dm-chat";

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
  /**
   * When set, this request regenerates the reply for the given original
   * message id. Dedup claims the once-per-message regenerate slot instead of
   * `messageId`, so exactly one re-run is allowed per original trigger.
   */
  regenerateOf?: string;
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
      /** Citation sources captured from search tool invocations, in the
       * order the model saw them; `index` matches inline [n] markers. */
      sources: GenerationSource[];
      /** Memory changes the model proposed via the remember/forget tools,
       * awaiting the user's reaction confirmation (ADR-013). The Runtime
       * posts one confirmation message and executes nothing until confirmed. */
      memoryProposals?: MemoryProposal[];
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

/** One citation source, numbered in the order the model saw them. */
export interface GenerationSource {
  index: number;
  title: string;
  url: string;
}

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

// ── Memory Proposals (intent-based writes, ADR-013) ───────────────────────

/** One memory change the model proposed during a generation. */
export interface MemoryProposal {
  /** Client-side id for matching confirmation results back to proposals. */
  id: string;
  action: "save" | "forget";
  /** Required for `save` (fact or preference). Omit on `forget` to delete
   * the key in every category. */
  category?: MemoryCategory;
  /** Stable memory key; `save` upserts, `forget` deletes matching rows. */
  key: string;
  /** New content for `save` proposals; absent on `forget`. */
  value?: string;
}

/** Execute confirmed proposals against `user_memory` (reaction-gated). */
export type MemoryProposalRequest = {
  userId: string;
  proposals: MemoryProposal[];
};

export type MemoryProposalResponse =
  | {
      status: "ok";
      /** One outcome per request proposal, request order preserved. */
      results: Array<{ id: string; ok: boolean; code?: string }>;
    }
  | { status: "error"; code: string };

// ── User Settings ─────────────────────────────────────────────────────────

/** UI language for runtime-rendered notices. Chat replies are NOT affected. */
export type UiLanguage = "zh" | "en";

/** Per-user opt-in flags (ADR-011 DM chat, ADR-012 auto memory). Default OFF. */
export interface UserSettings {
  chatOptin: boolean;
  learnOptin: boolean;
  /** When the opt-in was last enabled; null while off or never enabled. */
  chatOptinAt: number | null;
  learnOptinAt: number | null;
  /** UI language for bot notices; defaults to zh. */
  language: UiLanguage;
}

export type SettingsRequest =
  | { op: "get"; userId: string }
  | {
      op: "set";
      userId: string;
      /** Enable (`true`) or disable (`false`) DM chat; omit to leave unchanged. */
      chatOptin?: boolean;
      /** Enable (`true`) or disable (`false`) auto memory; omit to leave unchanged. */
      learnOptin?: boolean;
      /** Set the UI language for notices; omit to leave unchanged. */
      language?: UiLanguage;
    };

export type SettingsResponse =
  | { status: "ok"; settings: UserSettings }
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

// ── Context Truncate / Restore (ADR-014) ──────────────────────────────────

/** Push an undo-able truncation: messages older than now leave context. */
export interface ContextTruncateRequest {
  userId: string;
  scopeId: string;
  containerId: string;
}

export type ContextTruncateResult =
  | { status: "ok"; truncatedAt: number; remainingUndos: number }
  | { status: "error"; code: string };

/** Pop the newest undo-able truncation; never crosses a hard-reset floor. */
export interface ContextRestoreRequest {
  userId: string;
  scopeId: string;
  containerId: string;
}

export type ContextRestoreResult =
  | { status: "ok"; restored: boolean; remainingUndos: number }
  | { status: "error"; code: string };

// ── Health ────────────────────────────────────────────────────────────────

export interface HealthResponse {
  status: "ok";
  timestamp: number;
}
