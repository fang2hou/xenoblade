# ADR-006: Smart URL Reader Pipeline

- **Status**: Accepted
- **Date**: 2026-08-12

## Context

The `read_url` tool fetches web pages for the model. Pages vary from ~3,000 to 50,000+ characters. Sending raw content to the generation model pollutes its context window (a 30k-character page ≈ 15k tokens) and pays generation-model rates for navigation, boilerplate, and cookie banners.

## Decision

`read_url` is a two-stage pipeline that compresses content before the generation model sees it:

1. **Fetch + strip**: fetch the URL (SSRF-gated), strip script/style/nav/header/footer/aside, decode entities, collapse whitespace; keep at most 8,000 characters.
2. **Compress**: content over 2,000 characters is summarized by the **summarization model** (see [ADR-004](004-two-tier-model.md)) — extract key facts, numbers, dates, names; output ≤ 512 tokens. Below the threshold, content passes through raw. On summarizer failure, fall back to the truncated raw text — the tool stays available at the cost of tokens.

_Recorded drift:_ the original decision fetched via Cloudflare Browser Rendering. The implementation moved to direct `fetch` + HTML stripping (faster, simpler); the `BROWSER` binding remains provisioned but unused, and JavaScript-rendered pages are currently unsupported.

## Alternatives Considered

### Raw content straight to the generation model

- Pros: no extra call, no summarizer risk.
- Cons: context-window pollution; premium tokens spent on boilerplate.
- Why not chosen: the original problem being solved.

### Cloudflare Browser Rendering for the fetch stage

- Pros: executes JavaScript; managed Chrome without self-hosting.
- Cons: 2–4s per page; heavier failure surface; direct fetch covers most pages faster.
- Why not chosen: replaced by direct fetch (see recorded drift) — revisit if JS-rendered content becomes a primary target.

### Dedicated reader API (e.g. hosted extraction service)

- Pros: high-quality extraction without model calls.
- Cons: new external dependency, per-call cost, another key to manage.
- Why not chosen: the summarization role already exists (ADR-004) and is effectively free by comparison.

## Consequences

**Positive:** generation sees ≤ 512-token summaries for long pages — token use drops 1–2 orders of magnitude on web-heavy tasks; no external reader dependency; graceful degradation on every failure.

**Negative:** summarization adds 1–3s per long read; a poor summary starves the generation model; JS-rendered pages unreadable today.

**Neutral:** threshold (2,000 chars) and cap (8,000 chars) are code constants in `apps/platform-worker/src/tools/read-url.ts`.

## Review Triggers

- JavaScript-rendered pages dominate `read_url` targets (Browser Rendering back on the table).
- Summarizer quality regresses on the pages users actually read.
- Thresholds prove mis-sized against observed traffic.
