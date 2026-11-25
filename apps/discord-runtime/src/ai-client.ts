import type {
  ChannelAllowedRequest,
  ChannelAllowedResponse,
  ContextClearRequest,
  ContextClearResult,
  ContextRestoreRequest,
  ContextRestoreResult,
  ContextTruncateRequest,
  ContextTruncateResult,
  GenerationRequest,
  GenerationResult,
  GuildMemoryApplyRequest,
  GuildMemoryApplyResponse,
  MessageIngestRequest,
  MessageIngestResponse,
  MemoryRequest,
  MemoryResponse,
  SoulApplyRequest,
  SoulApplyResponse,
  ThreadSessionRequest,
  ThreadSessionResponse,
  ThreadShouldReplyRequest,
  ThreadShouldReplyResponse,
  UsageSummaryResponse,
  SettingsRequest,
  SettingsResponse,
} from "@xenoblade/contracts";

/**
 * Timeout for Worker generation calls. The Worker tries each model of the
 * chain in turn, each bounded by its own attempt timeout, while the staged
 * status keeps escalating up to 90s — the client must outlast the whole
 * chain, not a single attempt. The Worker caps that chain at 135s, so its
 * structured answer arrives before this fires.
 */
export const GENERATION_TIMEOUT_MS = 150_000;
/** Timeout for short Worker control-plane calls. */
const CONTROL_TIMEOUT_MS = 15_000;
/** Timeout for one history ingest request; a slow Worker must not hold back the buffer for long. Shutdown waits at least this long for a flush in flight. */
export const INGEST_TIMEOUT_MS = 10_000;

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

/** Push an undo-able context truncation on the Worker (ADR-014). */
export function truncateContext(
  req: ContextTruncateRequest,
  workerUrl: string,
  token: string,
): Promise<ContextTruncateResult> {
  return postJson<ContextTruncateResult>(
    `${workerUrl}/internal/v1/context/truncate`,
    req,
    token,
    CONTROL_TIMEOUT_MS,
  );
}

/** Pop the newest undoable truncation on the Worker (ADR-014). */
export function restoreContext(
  req: ContextRestoreRequest,
  workerUrl: string,
  token: string,
): Promise<ContextRestoreResult> {
  return postJson<ContextRestoreResult>(
    `${workerUrl}/internal/v1/context/restore`,
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

/** Apply button-confirmed guild memory proposals on the Worker. */
export function applyGuildMemoryProposals(
  req: GuildMemoryApplyRequest,
  workerUrl: string,
  token: string,
): Promise<GuildMemoryApplyResponse> {
  return postJson<GuildMemoryApplyResponse>(
    `${workerUrl}/internal/v1/memory/guild/apply`,
    req,
    token,
    CONTROL_TIMEOUT_MS,
  );
}

/** Apply a button-confirmed soul proposal on the Worker. */
export function applySoulProposal(
  req: SoulApplyRequest,
  workerUrl: string,
  token: string,
): Promise<SoulApplyResponse> {
  return postJson<SoulApplyResponse>(
    `${workerUrl}/internal/v1/soul/apply`,
    req,
    token,
    CONTROL_TIMEOUT_MS,
  );
}

/** Read or change a thread's session on the Worker (ADR-003 amendment). */
export function threadSessionOp(
  req: ThreadSessionRequest,
  workerUrl: string,
  token: string,
): Promise<ThreadSessionResponse> {
  return postJson<ThreadSessionResponse>(
    `${workerUrl}/internal/v1/threads/state`,
    req,
    token,
    CONTROL_TIMEOUT_MS,
  );
}

/** Timeout for the lightweight Layer 2 thread-relevance gate; kept short so it never delays a turn for long. */
const THREAD_GATE_TIMEOUT_MS = 6_000;

/** Ask the Worker's generation gate whether the bot answers in a channel at all. */
export function checkChannelAllowed(
  req: ChannelAllowedRequest,
  workerUrl: string,
  token: string,
): Promise<ChannelAllowedResponse> {
  return postJson<ChannelAllowedResponse>(
    `${workerUrl}/internal/v1/threads/allowed`,
    req,
    token,
    CONTROL_TIMEOUT_MS,
  );
}

/** Ask the Worker's Layer 2 semantic gate whether an ambiguous followed-thread message is for the bot. */
export function shouldReplyInThread(
  req: ThreadShouldReplyRequest,
  workerUrl: string,
  token: string,
): Promise<ThreadShouldReplyResponse> {
  return postJson<ThreadShouldReplyResponse>(
    `${workerUrl}/internal/v1/threads/should-reply`,
    req,
    token,
    THREAD_GATE_TIMEOUT_MS,
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
 * Send one batch of guild message changes to the Worker's history index.
 * Best-effort by design: the caller decides what happens to a batch this
 * call could not deliver.
 */
export function ingestMessages(
  req: MessageIngestRequest,
  workerUrl: string,
  token: string,
): Promise<MessageIngestResponse> {
  return postJson<MessageIngestResponse>(
    `${workerUrl}/internal/v1/messages/ingest`,
    req,
    token,
    INGEST_TIMEOUT_MS,
  );
}

/** Read or update per-user opt-in settings on the Worker. */
export function settingsOp(
  req: SettingsRequest,
  workerUrl: string,
  token: string,
): Promise<SettingsResponse> {
  return postJson<SettingsResponse>(
    `${workerUrl}/internal/v1/settings`,
    req,
    token,
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
    // Status and route only. An error body can echo a request body, and an
    // ingest request carries message text.
    console.log(JSON.stringify({ event: "worker_http_error", url, status: response.status }));
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
