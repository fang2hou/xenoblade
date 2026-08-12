# ADR-007: Brave Search and Answer Integration

- **Status**: Accepted
- **Date**: 2026-08-12

## Context

The bot needs web search capability for investigation tasks: answering questions about current events, looking up documentation, and finding specific information online.

The previous design used a keyword-heuristic prefetch mechanism that guessed whether a query "looks like a search" and injected results into the prompt. This was not a tool — the model had no agency over when or what to search.

## Decision

Expose Brave search as a first-class AI SDK tool that the model can call autonomously. Brave provides two complementary APIs, both configured:

**Brave Search API** (`api.search.brave.com/res/v1/web/search`):

- Returns structured web search results (title, URL, description).
- Used for general queries: "latest Rust release notes", "Cloudflare Workers CPU limits".

**Brave Answer API** (`api.search.brave.com/res/v1/chat/completions`):

- Returns a synthesized natural-language answer with source citations.
- Used for factual questions: "what is the capital of Brazil", "when did Discord add threads".

The tool automatically selects the appropriate API based on query type, or the model can specify explicitly:

```ts
web_search(query: string, opts?: {
  mode?: "search" | "answer";
  count?: number;
}) → { results: Array<{ title, url, description }>, answer?: string }
```

**Default behavior:** factual-looking questions (what/when/who/is/are) use the Answer API first, falling back to Search API. Complex or research-oriented queries use Search API directly.

**Result normalization:** Both APIs return results in a common structured format. The synthesized answer (if available) is included alongside the result list.

**Error handling:** If the primary API fails (timeout, rate limit), the tool falls back to the other API. If both fail, the tool returns a structured error, and the model can answer without search results.

**Credentials:** Two separate API keys (`BRAVE_SEARCH_API_KEY`, `BRAVE_ANSWER_API_KEY`), stored as Worker secrets.

## Consequences

**Positive:**

- The model decides when and what to search — no keyword heuristics.
- Two complementary Brave APIs cover both factual answers and general web search.
- No external reader/search service dependency beyond Brave.
- Results are structured and easy to cite.

**Negative:**

- Two Brave API keys to manage (search + answer subscriptions).
- Brave-specific rate limits and pricing to monitor.
- No search engine diversity — Brave outage means no search capability.

**Neutral:**

- The old keyword-based prefetch code and `tools.ts` dead code are deleted entirely. Search becomes a tool call, not a pipeline stage.
- Additional search backends can be added later by implementing the normalized result interface.
