// Secret fields are injected via `wrangler secret put` (remote) or `.dev.vars`
// (local). Var/binding types (DB, BROWSER, GENERATION_MODEL,
// SUMMARIZATION_MODEL) mirror wrangler.jsonc. Declaring the full Env surface
// here keeps every binding and secret visible without running `wrangler types`.
// (Runtime globals such as D1Database and Fetcher are ambient across the
// monorepo compilation.)
interface Env {
  DB: D1Database;
  BROWSER: Fetcher;
  GENERATION_MODEL: string;
  SUMMARIZATION_MODEL: string;
  OPENROUTER_API_KEY: string;
  INTERNAL_API_TOKEN: string;
  BRAVE_SEARCH_API_KEY: string;
  BRAVE_ANSWER_API_KEY: string;
  GITHUB_MCP_TOKEN: string;
  ARTIFICIAL_ANALYSIS_API_KEY: string;
}
