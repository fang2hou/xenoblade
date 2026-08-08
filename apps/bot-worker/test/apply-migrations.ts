/// <reference types="@cloudflare/vitest-pool-workers/types" />
// Per-worker setup: apply the D1 migrations injected via the TEST_MIGRATIONS
// binding (see vitest.config.ts) before any test runs. Runs inside the worker.
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
