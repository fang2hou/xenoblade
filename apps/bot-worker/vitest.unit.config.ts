import { defineConfig } from "vitest/config";

// Pure-function unit tests: no Cloudflare pool, no D1 id, no external creds.
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
  },
});
