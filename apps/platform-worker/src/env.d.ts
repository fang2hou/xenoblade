/// <reference types="@cloudflare/workers-types" />

interface Env {
  DB: D1Database;
  BROWSER: Fetcher;
  /**
   * JSON: partial Record<ModelRole, ModelConfig[]>. Not set by
   * `wrangler.jsonc` — the chains in `packages/ai` apply unless a role is
   * overridden here.
   */
  MODEL_CONFIG?: string;
  /** Charm Hyper API key; when set, DeepSeek generation/summarization defaults route via Charm Hyper. */
  HYPER_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  INTERNAL_API_TOKEN: string;
  BRAVE_SEARCH_API_KEY: string;
  BRAVE_ANSWER_API_KEY: string;
  GITHUB_MCP_TOKEN: string;
  ARTIFICIAL_ANALYSIS_API_KEY: string;
  /** Optional owner-approved server administration gate (both required to enable). */
  ADMIN_GUILD_ID?: string;
  ADMIN_OWNER_USER_ID?: string;
}
