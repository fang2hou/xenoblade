import { fileURLToPath } from "node:url";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Workers-runtime integration tests. Requires a real D1 id in wrangler.jsonc
// and runs under the Cloudflare vitest pool. Deterministic test bindings are
// provided so these run in CI without real secrets.
//
// `main` points at a discord-free test entry. The production entry (src/index.ts)
// statically imports @chat-adapter/discord, whose discord.js (CJS) dependency
// chain cannot be resolved by workerd's ESM loader. The test entry skips the
// webhook path entirely and reuses the discord-free gateway router, so the pool
// can load the worker. /webhooks/discord signature verification is owned by
// @chat-adapter/discord and validated via the deployed canary, not in-process.
//
// D1 migrations are read at config time (Node) and injected as a test-only
// TEST_MIGRATIONS binding, then applied per-worker in apply-migrations.ts.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrationsPath = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../packages/db/migrations",
      );
      const migrations = await readD1Migrations(migrationsPath);

      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        main: "./test/worker/test-entry.ts",
        miniflare: {
          bindings: {
            DISCORD_BOT_TOKEN: "test-bot-token",
            DISCORD_PUBLIC_KEY: "test-public-key",
            DISCORD_APPLICATION_ID: "test-app-id",
            OPENROUTER_API_KEY: "test-openrouter-key",
            GATEWAY_CONTROL_TOKEN: "test-control-token",
            GATEWAY_STATUS_TOKEN: "test-status-token",
            BRAVE_SEARCH_API_KEY: "test-brave-key",
            TEST_MIGRATIONS: migrations,
          },
        },
      };
    }),
  ],
  test: {
    include: ["test/worker/**/*.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
