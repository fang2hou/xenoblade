/// <reference types="@cloudflare/workers-types" />

interface Env {
  DB: D1Database;
  BROWSER: Fetcher;
  /** JSON: Record<ModelRole, ModelConfig[]>. Defines all model chains. */
  MODEL_CONFIG: string;
  OPENROUTER_API_KEY: string;
  INTERNAL_API_TOKEN: string;
  BRAVE_SEARCH_API_KEY: string;
  BRAVE_ANSWER_API_KEY: string;
  GITHUB_MCP_TOKEN: string;
  ARTIFICIAL_ANALYSIS_API_KEY: string;
}
