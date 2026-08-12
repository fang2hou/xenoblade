# ADR-003: Single-Shot Generation Protocol

- **Status**: Accepted
- **Date**: 2026-08-12

## Context

The initial design considered streaming AI output to Discord via progressive message editing — a "typewriter effect" where the bot creates a placeholder message and updates it as tokens arrive.

This approach has three problems on the current architecture:

1. **CPU cost.** Cloudflare Workers bill per CPU millisecond. Token streaming requires parsing each chunk, accumulating text, rate-limiting edits, and making repeated Discord REST `PATCH` calls. None of this produces user-visible value — it only creates the illusion of real-time typing. The model's network latency (waiting for tokens) is free, but the per-chunk processing and REST I/O are billed.

2. **Discord REST rate limits.** Message edits are subject to Discord's rate limiting. Frequent edits risk hitting `429` responses, which require backoff handling and can delay the final message. A single generation with 50 edits is 50 REST calls; a burst of concurrent generations across channels multiplies this.

3. **Typing indicator sufficiency.** Discord's typing indicator (`POST /channels/{id}/typing`) already communicates "the bot is working." It persists for ~10 seconds per call and is the standard UX pattern used by most Discord bots. Users do not expect character-by-character streaming in a chat client.

## Decision

Adopt a single-shot response protocol:

1. On valid trigger, the Runtime sends **one** typing indicator.
2. The Runtime calls the Worker, which runs the full generation pipeline (model + tools) and returns one complete `GenerationResult` JSON.
3. The Runtime posts the final message **once**. If the result exceeds Discord's 2000-character limit, it is sliced into sequential messages — but no editing loop occurs.
4. No token deltas are transmitted between the Worker and Runtime.
5. No placeholder messages are created.
6. No periodic typing renewal.

## Consequences

**Positive:**
- Minimal Worker CPU per generation: one `generateText` call, one JSON response.
- Minimal Discord REST calls per generation: one typing + one message send.
- No rate-limit risk from edit bursts.
- Simple protocol: a single request/response cycle with structured error handling.
- The Worker can use `generateText` (not `streamText`), which is simpler and supports tool loops natively.

**Negative:**
- No streaming UX. Users wait for the complete response with only a typing indicator.
- Long generations (multi-step research) may take 10-30 seconds with no incremental feedback. The typing indicator expires after ~10 seconds and is not renewed.

**Neutral:**
- Future versions could add a single mid-generation "still working" typing refresh if latency exceeds a threshold, without adopting full streaming.
