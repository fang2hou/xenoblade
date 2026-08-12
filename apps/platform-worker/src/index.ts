import type {
  ContextClearRequest,
  ContextClearResult,
  GenerationRequest,
  GenerationResult,
  HealthResponse,
  MemoryRequest,
  MemoryResponse,
} from "@xenoblade/contracts";

import { isInternalAuthorized } from "./auth";
import { clearUserContext } from "./db";
import { generate } from "./generation";
import { handleMemory } from "./memory";

const INTERNAL_PREFIX = "/internal/v1/";

/** JSON response helper. The type argument validates the body's contract shape. */
function json<T>(body: T, status = 200): Response {
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
    return (await request.json()) as T;
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
        return json<GenerationResult>(
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
        return json<ContextClearResult>({ status: "error", code: "invalid_body" }, 400);
      }
      try {
        const cleared = await clearUserContext(env.DB, req);
        return json<ContextClearResult>({ status: "ok", cleared });
      } catch (error) {
        console.log(JSON.stringify({ event: "context_clear_failed", error: String(error) }));
        return json<ContextClearResult>({ status: "error", code: "context_clear_failed" });
      }
    }

    // POST /internal/v1/memory
    if (request.method === "POST" && path === "/internal/v1/memory") {
      const req = await readJson<MemoryRequest>(request);
      if (req === null) {
        return json<MemoryResponse>({ status: "error", code: "invalid_body" }, 400);
      }
      return json(await handleMemory(env.DB, req));
    }

    return notFound();
  },
};
