import type {
  ContextClearRequest,
  ContextRestoreRequest,
  ContextTruncateRequest,
  GenerationRequest,
  HealthResponse,
  MemoryProposalRequest,
  MemoryRequest,
  SettingsRequest,
  UsageSummaryResponse,
} from "@xenoblade/contracts";

import { isInternalAuthorized } from "./auth";
import { clearUserContext, getUsageSummary, restoreUserContext, truncateUserContext } from "./db";
import { generate } from "./generation";
import { handleMemory, handleMemoryProposals } from "./memory";
import { handleSettings } from "./settings";

const INTERNAL_PREFIX = "/internal/v1/";

/** JSON response helper. */
function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function notFound(): Response {
  return new Response(null, { status: 404 });
}

function unauthorized(): Response {
  return new Response(null, { status: 401 });
}

/** Parse a JSON request body, or null when it is absent/malformed. */
async function readJson<T>(request: Request): Promise<T | null> {
  try {
    const body: unknown = await request.json();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON boundary: caller validates via generate()/clearUserContext()
    return body as T;
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;

    // Everything outside /internal/v1/* is opaque to the public internet.
    if (!path.startsWith(INTERNAL_PREFIX)) {
      return notFound();
    }

    // All internal routes require a valid Bearer token.
    if (!isInternalAuthorized(request, env.INTERNAL_API_TOKEN)) {
      return unauthorized();
    }

    // GET /internal/v1/health
    if (request.method === "GET" && path === "/internal/v1/health") {
      const body: HealthResponse = { status: "ok", timestamp: Date.now() };
      return json(body);
    }

    // POST /internal/v1/generations
    if (request.method === "POST" && path === "/internal/v1/generations") {
      const req = await readJson<GenerationRequest>(request);
      if (req === null) {
        return json(
          {
            status: "error",
            requestId: crypto.randomUUID(),
            code: "invalid_body",
            message: "Invalid request body",
            retryable: false,
          },
          400,
        );
      }
      return json(await generate(env, req));
    }

    // POST /internal/v1/context/clear
    if (request.method === "POST" && path === "/internal/v1/context/clear") {
      const req = await readJson<ContextClearRequest>(request);
      if (req === null) {
        return json({ status: "error", code: "invalid_body" }, 400);
      }
      try {
        const cleared = await clearUserContext(env.DB, req);
        return json({ status: "ok", cleared });
      } catch (error) {
        console.log(JSON.stringify({ event: "context_clear_failed", error: String(error) }));
        return json({ status: "error", code: "context_clear_failed" });
      }
    }

    // POST /internal/v1/context/truncate (ADR-014: undo-able truncation)
    if (request.method === "POST" && path === "/internal/v1/context/truncate") {
      const req = await readJson<ContextTruncateRequest>(request);
      if (req === null) {
        return json({ status: "error", code: "invalid_body" }, 400);
      }
      try {
        const outcome = await truncateUserContext(env.DB, {
          scopeId: req.scopeId,
          containerId: req.containerId,
          userId: req.userId,
        });
        return json({ status: "ok", ...outcome });
      } catch (error) {
        console.log(JSON.stringify({ event: "context_truncate_failed", error: String(error) }));
        return json({ status: "error", code: "context_truncate_failed" });
      }
    }

    // POST /internal/v1/context/restore (ADR-014: pop the newest truncation)
    if (request.method === "POST" && path === "/internal/v1/context/restore") {
      const req = await readJson<ContextRestoreRequest>(request);
      if (req === null) {
        return json({ status: "error", code: "invalid_body" }, 400);
      }
      try {
        const outcome = await restoreUserContext(env.DB, {
          scopeId: req.scopeId,
          containerId: req.containerId,
          userId: req.userId,
        });
        return json({ status: "ok", ...outcome });
      } catch (error) {
        console.log(JSON.stringify({ event: "context_restore_failed", error: String(error) }));
        return json({ status: "error", code: "context_restore_failed" });
      }
    }

    // GET /internal/v1/usage?userId=&scopeId=
    if (request.method === "GET" && path === "/internal/v1/usage") {
      const params = new URL(request.url).searchParams;
      const userId = params.get("userId");
      const scopeId = params.get("scopeId");
      if (userId === null || userId === "" || scopeId === null || scopeId === "") {
        return json({ status: "error", code: "invalid_params" }, 400);
      }
      try {
        const summary = await getUsageSummary(env.DB, { userId, scopeId, now: Date.now() });
        const body: UsageSummaryResponse = { status: "ok", ...summary };
        return json(body);
      } catch (error) {
        console.log(JSON.stringify({ event: "usage_query_failed", error: String(error) }));
        const body: UsageSummaryResponse = { status: "error", code: "usage_query_failed" };
        return json(body);
      }
    }

    // POST /internal/v1/memory
    if (request.method === "POST" && path === "/internal/v1/memory") {
      const req = await readJson<MemoryRequest>(request);
      if (req === null) {
        return json({ status: "error", code: "invalid_body" }, 400);
      }
      return json(await handleMemory(env.DB, req));
    }

    // POST /internal/v1/memory/proposals (ADR-013: confirmed intent writes)
    if (request.method === "POST" && path === "/internal/v1/memory/proposals") {
      const req = await readJson<MemoryProposalRequest>(request);
      if (req === null) {
        return json({ status: "error", code: "invalid_body" }, 400);
      }
      return json(await handleMemoryProposals(env.DB, req));
    }

    // POST /internal/v1/settings
    if (request.method === "POST" && path === "/internal/v1/settings") {
      const req = await readJson<SettingsRequest>(request);
      if (req === null) {
        return json({ status: "error", code: "invalid_body" }, 400);
      }
      return json(await handleSettings(env.DB, req));
    }

    return notFound();
  },
};
