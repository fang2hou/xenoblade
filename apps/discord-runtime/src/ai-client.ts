import type {
  ContextClearRequest,
  ContextClearResult,
  GenerationRequest,
  GenerationResult,
  MemoryRequest,
  MemoryResponse,
  UsageSummaryResponse,
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
export function clearContext(
  req: ContextClearRequest,
  workerUrl: string,
  token: string,
): Promise<ContextClearResult> {
  return postJson<ContextClearResult>(
    `${workerUrl}/internal/v1/context/clear`,
    req,
    token,
    CONTROL_TIMEOUT_MS,
  );
}

/** Perform a user-memory operation on the Worker. */
export function memoryOp(
  req: MemoryRequest,
  workerUrl: string,
  token: string,
): Promise<MemoryResponse> {
  return postJson<MemoryResponse>(
    `${workerUrl}/internal/v1/memory`,
    req,
    token,
    CONTROL_TIMEOUT_MS,
  );
}

/** Fetch the rolling-window usage summary for a user and their guild. */
export function fetchUsage(
  params: { userId: string; scopeId: string },
  workerUrl: string,
  token: string,
): Promise<UsageSummaryResponse> {
  const query = `userId=${encodeURIComponent(params.userId)}&scopeId=${encodeURIComponent(params.scopeId)}`;
  return requestJson<UsageSummaryResponse>(
    `${workerUrl}/internal/v1/usage?${query}`,
    { method: "GET", headers: { Authorization: `Bearer ${token}` } },
    CONTROL_TIMEOUT_MS,
  );
}

/**
 * POST a JSON body to the Worker with Bearer auth and a timeout. Throws after
 * structured logging on any network, non-2xx, or JSON-parse failure.
 */
function postJson<T = unknown>(
  url: string,
  body: unknown,
  token: string,
  timeoutMs: number,
): Promise<T> {
  return requestJson<T>(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
}

/**
 * Perform a JSON request against the Worker with a timeout. Throws after
 * structured logging on any network, non-2xx, or JSON-parse failure.
 */
async function requestJson<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "worker_network_error",
        url,
        error: String(error),
      }),
    );
    throw new Error(`Worker request failed: ${url}`, { cause: error });
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
    const json: unknown = await response.json();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON boundary: caller validates via type guard
    return json as T;
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "worker_json_error",
        url,
        error: String(error),
      }),
    );
    throw new Error(`Worker returned invalid JSON for ${url}`, { cause: error });
  }
}

/** Type guard: does this value look like a GenerationResult? */
function isGenerationResult(value: unknown): value is GenerationResult {
  return (
    value !== null &&
    typeof value === "object" &&
    "status" in value &&
    typeof value.status === "string"
  );
}

/** Validate the Worker generation response shape before handing it back. */
function assertGenerationResult(value: unknown): GenerationResult {
  if (isGenerationResult(value)) {
    return value;
  }
  console.log(JSON.stringify({ event: "worker_malformed_generation_result" }));
  throw new Error("Worker returned a malformed generation result");
}
