// Secret fields injected via `wrangler secret put` (remote) or `.dev.vars`
// (local). Var/binding types come from the generated worker-configuration.d.ts.
// Both the global `Env` and the `Cloudflare.Env` namespace (used by
// `cloudflare:test`'s `env`) are augmented with the same secret fields.
interface Env {
  DISCORD_BOT_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID: string;
  OPENROUTER_API_KEY: string;
  GATEWAY_CONTROL_TOKEN: string;
  BRAVE_SEARCH_API_KEY: string;
  JINA_API_KEY: string;
  GATEWAY_STATUS_TOKEN: string;
  BROWSER: Fetcher;
}

declare namespace Cloudflare {
  interface Env {
    DISCORD_BOT_TOKEN: string;
    DISCORD_PUBLIC_KEY: string;
    DISCORD_APPLICATION_ID: string;
    OPENROUTER_API_KEY: string;
    GATEWAY_CONTROL_TOKEN: string;
    BRAVE_SEARCH_API_KEY: string;
    JINA_API_KEY: string;
    /** Test-only: parsed D1 migrations, injected via vitest.config.ts. */
    TEST_MIGRATIONS?: { name: string; queries: string[] }[];
  }
}
