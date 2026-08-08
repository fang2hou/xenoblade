/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const BASE = "http://xenoblade.test";

describe("gateway routing & auth", () => {
  it("returns 404 for GET /gateway/status with no token", async () => {
    const res = await SELF.fetch(`${BASE}/gateway/status`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for POST /gateway/connect with no control token", async () => {
    const res = await SELF.fetch(`${BASE}/gateway/connect`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("returns 404 for POST /gateway/disconnect with no control token", async () => {
    const res = await SELF.fetch(`${BASE}/gateway/disconnect`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("returns 404 for unknown routes", async () => {
    const res = await SELF.fetch(`${BASE}/nope`);
    expect(res.status).toBe(404);
  });

  it("returns status JSON with the status token and never echoes secrets", async () => {
    const res = await SELF.fetch(`${BASE}/gateway/status`, {
      headers: { "x-gateway-status-token": env.GATEWAY_STATUS_TOKEN },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(env.GATEWAY_STATUS_TOKEN);
    expect(body).not.toContain(env.GATEWAY_CONTROL_TOKEN);
    const json = JSON.parse(body) as { status: string; sessionId: string | null };
    expect(typeof json.status).toBe("string");
  });

  // /webhooks/discord signature verification is owned by @chat-adapter/discord
  // and is not exercised in the in-process pool (see vitest.config.ts `main`).
  // It is validated via the deployed canary (scripts/e2e.sh) instead.
});
