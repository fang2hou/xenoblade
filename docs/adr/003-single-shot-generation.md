# ADR-003: Single-Shot Generation Protocol

- **Status**: Accepted (amended 2026-08-16 — see [Amendment](#amendment-2026-08-16))
- **Date**: 2026-08-12

## Context

The initial design considered streaming AI output to Discord via progressive message editing — a placeholder message updated as tokens arrive. Three problems:

1. **CPU cost.** Workers bill per CPU millisecond; per-chunk parsing, edit throttling, and repeated Discord REST `PATCH` calls produce no user-visible value.
2. **Discord REST rate limits.** A generation with 50 edits is 50 REST calls; edit bursts risk `429` backoffs across concurrent channels.
3. **Typing indicator sufficiency.** Discord's typing indicator is the standard "working" UX; users do not expect character streaming in a chat client.

## Decision

Adopt a single-shot response protocol:

1. On valid trigger, the Runtime sends **one** typing indicator.
2. The Runtime calls the Worker, which runs the full generation pipeline (model + tools) and returns one complete `GenerationResult` JSON.
3. The Runtime posts the final message **once**; results over Discord's 2000-character limit are sliced into sequential messages — no editing loop.
4. No token deltas are transmitted between the Worker and Runtime.
5. No placeholder messages. _(Superseded within bounds by the 2026-08-16 amendment.)_
6. No periodic typing renewal. _(Superseded by the amendment's accepted drift.)_

## Alternatives Considered

### Token streaming with progressive edits

- Pros: perceived real-time UX.
- Cons: per-chunk CPU billing, Discord rate-limit exposure, complex edit/backoff machinery for cosmetic value.
- Why not chosen: cost and fragility with no functional gain.

### Zero-feedback wait (single typing indicator only, never renewed)

- Pros: absolute minimum REST surface.
- Cons: the indicator expires after ~10s; long generations look hung.
- Why not chosen: the amendment's bounded feedback (typing renewal + staged placeholder) covers this without streaming.

## Consequences

**Positive:** minimal Worker CPU per generation (one `generateText` call, one JSON response); minimal Discord REST per generation (one typing + one send, plus bounded placeholder edits); no rate-limit risk from edit bursts; simple request/response protocol with structured errors.

**Negative:** no streaming UX; long generations (10–30s, multi-step research) need the staged-status mechanism to communicate progress.

**Neutral:** the Worker uses `generateText` (tool loops natively supported) rather than `streamText`.

## Amendment (2026-08-16)

This amendment records accepted drift and authorizes one bounded addition. The original decision otherwise remains binding.

### Accepted drift: typing renewal

Commit `6068f97` ("feat: keep typing indicator alive during generation") made the Runtime refresh the typing indicator every 8 seconds for the duration of a generation, superseding Decision point 6. Recorded as accepted practice.

### New authorization: staged status messages

Long generations may maintain a staged status placeholder under hard constraints:

1. A single placeholder may be posted when a generation is still running after ~8 seconds.
2. The placeholder is edited **only** at coarse elapsed-time milestones (8s / 20s / 40s / 90s) to escalate the status text.
3. Hard cap: **4 edits per generation in total** (escalations plus final replacement). Escalations stop at 3 edits so the final replacement always fits; the placeholder is never edited otherwise.
4. **No token deltas**, **no per-chunk streaming**: the Worker protocol and single-request/single-response contract are unchanged — staging is Runtime-side timing only.
5. The result (or failure reply) replaces the placeholder by editing it; continuation chunks beyond 2000 characters post as new messages. Silent rejections delete the placeholder; a stale placeholder must never remain.
6. Edits respect Discord rate limits (single retry with backoff on `429`).

Decision point 5 is superseded by this amendment within the bounds above.

## Review Triggers

- Discord ships a first-party streaming/edit affordance for bot messages.
- Generation latency routinely exceeds the 90s milestone (staging ladder insufficient).
- Model or pipeline changes make generation fast enough that staging never triggers (simplify back to typing-only).
