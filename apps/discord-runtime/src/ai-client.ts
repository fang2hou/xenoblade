import type {
  ContextClearRequest,
  ContextClearResult,
  GenerationRequest,
  GenerationResult,
  MemoryRequest,
  MemoryResponse,
} from "@xenoblade/contracts";

/** Timeout for Worker generation calls (AI inference can be slow). */
const GENERATION_TIMEOUT_MS = 60_000;
/** Timeout for short Worker control-plane calls. */
const CONTROL_TIMEOUT_MS = 15_000;

/**
 * Send a generation request to the Platform Worker and return the result.
 * Throws after structured logging on network, HTTP, or malformed-response
 * errors.
 */
export async function generate(
  req: GenerationRequest,
  workerUrl: string,
  token: string,
): Promise<GenerationResult> {
  const result = await postJson(
    `${workerUrl}/internal/v1/generations`,
    req,
    token,
    GENERATION_TIMEOUT_MS,
  );
  return assertGenerationResult(result);
}

/** Clear conversation context for a user/container on the Worker. */
export async function clearContext(
  req: ContextClearRequest,
  workerUrl: string,
  token: string,
): Promise<ContextClearResult> {
  return postJson(
    `${workerUrl}/internal/v1/context/clear`,
    req,
    token,
    CONTROL_TIMEOUT_MS,
  ) as Promise<ContextClearResult>;
}

/** Perform a user-memory operation on the Worker. */
export async function memoryOp(
  req: MemoryRequest,
  workerUrl: string,
  token: string,
): Promise<MemoryResponse> {
  return postJson(
    `${workerUrl}/internal/v1/memory`,
    req,
    token,
    CONTROL_TIMEOUT_MS,
  ) as Promise<MemoryResponse>;
}

/**
 * POST a JSON body to the Worker with Bearer auth and a timeout. Throws after
 * structured logging on any network, non-2xx, or JSON-parse failure.
 */
async function postJson(
  url: string,
  body: unknown,
  token: string,
  timeoutMs: number,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "worker_network_error",
        url,
        error: String(error),
      }),
    );
    throw new Error(`Worker request failed: ${url}`);
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    console.log(
      JSON.stringify({
        event: "worker_http_error",
        url,
        status: response.status,
        body: errorBody.slice(0, 200),
      }),
    );
    throw new Error(`Worker HTTP ${response.status} for ${url}`);
  }

  try {
    return await response.json();
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "worker_json_error",
        url,
        error: String(error),
      }),
    );
    throw new Error(`Worker returned invalid JSON for ${url}`);
  }
}

/** Validate the Worker generation response shape before handing it back. */
function assertGenerationResult(value: unknown): GenerationResult {
  // Boundary check: the Worker is authoritative for the union shape once the
  // discriminator parses; narrow with `in` so no member shape is fabricated.
  if (value !== null && typeof value === "object" && "status" in value) {
    if (typeof value.status === "string") {
      return value as GenerationResult;
    }
  }
  console.log(JSON.stringify({ event: "worker_malformed_generation_result" }));
  throw new Error("Worker returned a malformed generation result");
}
