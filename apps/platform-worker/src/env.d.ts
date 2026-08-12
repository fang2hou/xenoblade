/// <reference types="@cloudflare/workers-types" />

// Secret fields are injected via `wrangler secret put` (remote) or `.dev.vars`
// (local). Var/binding types (DB, BROWSER, GENERATION_MODEL,
// SUMMARIZATION_MODEL) mirror wrangler.jsonc. This file is the authoritative
// Env declaration — do NOT run `wrangler types` (it would generate a
// conflicting, incomplete Env that omits secrets).
interface Env {
  DB: D1Database;
  BROWSER: Fetcher;
  GENERATION_MODEL: string;
  GENERATION_FALLBACK_MODEL: string;
  SUMMARIZATION_MODEL: string;
  VISION_MODEL: string;
  OPENROUTER_API_KEY: string;
  INTERNAL_API_TOKEN: string;
  BRAVE_SEARCH_API_KEY: string;
  BRAVE_ANSWER_API_KEY: string;
  GITHUB_MCP_TOKEN: string;
  ARTIFICIAL_ANALYSIS_API_KEY: string;
}
