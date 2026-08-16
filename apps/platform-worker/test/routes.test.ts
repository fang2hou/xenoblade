import { describe, it, expect } from "vitest";

import worker from "../src/index";
import { createTestD1 } from "./helpers/d1";

const TOKEN = "test-internal-token";

function makeEnv(): Env {
  // The usage route only reads DB and INTERNAL_API_TOKEN; the remaining Env
  // fields are model/tool secrets the route never touches.
  return { DB: createTestD1(), INTERNAL_API_TOKEN: TOKEN } as Env;
}

async function callUsage(
  env: Env,
  query: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const request = new Request(`https://worker/internal/v1/usage${query}`, { headers });
  return worker.fetch(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- bridging undici Request to the workers-types signature
    request as unknown as Parameters<typeof worker.fetch>[0],
    env,
    {} as ExecutionContext,
  );
}

describe("GET /internal/v1/usage", () => {
  it("rejects requests without a bearer token", async () => {
    const response = await callUsage(makeEnv(), "?userId=u1&scopeId=g1");
    expect(response.status).toBe(401);
  });

  it("rejects a wrong bearer token", async () => {
    const response = await callUsage(makeEnv(), "?userId=u1&scopeId=g1", {
      Authorization: "Bearer nope",
    });
    expect(response.status).toBe(401);
  });

  it("requires both userId and scopeId params", async () => {
    const env = makeEnv();
    expect((await callUsage(env, "", authHeaders())).status).toBe(400);
    expect((await callUsage(env, "?userId=u1", authHeaders())).status).toBe(400);
    expect((await callUsage(env, "?scopeId=g1", authHeaders())).status).toBe(400);

    const body = (await (await callUsage(env, "", authHeaders())).json()) as {
      status: string;
      code: string;
    };
    expect(body).toEqual({ status: "error", code: "invalid_params" });
  });

  it("returns the aggregated summary for the requesting user and guild", async () => {
    const env = makeEnv();
    env.DB.prepare(
      `INSERT INTO interactions
         (id, container_id, scope_id, user_id, summon_kind, model, status,
          input_tokens, output_tokens, created_at)
       VALUES ('i1', 'discord:g1:c1', 'g1', 'u1', 'user-mention', 'test/model',
               'completed', 120, 30, ?1)`,
    )
      .bind(Date.now())
      .run();

    const response = await callUsage(env, "?userId=u1&scopeId=g1", authHeaders());
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      status: string;
      windowMs: number;
      user: { messages: number; generations: number; inputTokens: number };
      guild: { messages: number };
    };
    expect(body.status).toBe("ok");
    expect(body.windowMs).toBe(24 * 60 * 60 * 1000);
    expect(body.user).toMatchObject({ messages: 1, generations: 1, inputTokens: 120 });
    expect(body.guild.messages).toBe(1);
  });
});

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}` };
}
