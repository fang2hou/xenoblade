# ADR-007: Multi-Backend Search

- **Status**: Accepted
- **Date**: 2026-08-12

## Context

The current implementation uses a single search path: keyword heuristics trigger a Brave Answers API call, falling back to Jina Search. This is a prefetch mechanism — the model never calls search as a tool; instead, the pipeline guesses whether a query "looks like a search" and injects results into the prompt.

This has two problems:

1. **No model agency.** The model cannot decide when to search, what to search for, or which engine to use. The keyword heuristic ("查一下", "latest", year numbers) is crude and produces false positives and false negatives.

2. **Single backend.** Different search engines excel at different query types. Brave provides strong general-web results with synthesized answers. Jina returns content-rich results (search + full text in one call). Exa (formerly Metaphor) excels at semantic, academic, and deep-research queries. Relying on one backend limits search quality across query types.

## Decision

Expose `web_search` as a first-class AI SDK tool that the model can call autonomously, supporting three configurable backends:

```ts
web_search(query: string, opts?: {
  engine?: "brave" | "jina" | "exa";
  count?: number;
}) → { results: Array<{ title, url, description, content? }> }
```

**Backend selection:**
- Default: Brave (best for general queries, includes synthesized answers).
- Fallback: Jina (content-rich results, search + page content in one step).
- Explicit: Exa (semantic search, academic papers, deep research).
- The model can specify `engine` explicitly when the query type warrants it (e.g., Exa for academic topics).

**Result normalization:** All backends return results in a common structured format. No backend-specific fields leak to the model.

**Error handling:** If the primary backend fails (timeout, rate limit, API error), the tool falls back to the next configured backend. If all backends fail, the tool returns a structured error, and the model can answer without search results or try a different approach.

## Consequences

**Positive:**
- The model decides when and what to search — no keyword heuristics.
- Three backends provide coverage across general, content-rich, and semantic/academic query types.
- No single-provider dependency; one backend's outage doesn't break search.
- Results are structured and normalized, making them easy to cite.

**Negative:**
- Three API keys to manage (Brave, Jina, Exa).
- Backend-specific rate limits and pricing models to monitor.
- Result normalization loses some backend-specific features (e.g., Exa's similarity scores).

**Neutral:**
- The old keyword-based prefetch code is deleted entirely. Search becomes a tool call, not a pipeline stage.
- Additional backends can be added by implementing the normalized result interface.
