# ADR-007: Brave Search and Answer Integration

- **Status**: Accepted (the citation-rendering clause is amended: the inline `[n]` + Sources-footer pipeline was replaced by inline masked links with a durable source index — see below)
- **Date**: 2026-08-12

## Context

The bot needs web search for current events, documentation lookups, and factual questions. The previous design used a keyword-heuristic prefetch that guessed whether a query "looks like a search" and injected results into the prompt — the model had no agency over when or what to search, and the heuristic dead code accumulated.

## Decision

Expose Brave as first-class model tools the model calls autonomously:

- **`web_search`** — Brave Search API (`/res/v1/web/search`): structured results (title, URL, description) for research-style queries. Results feed the citation pipeline. _(Amended 2026-08-17: replies cite inline masked links with short labels (来源/原文) instead of `[n]` markers plus a rendered Sources footer — Discord's preview-card spam destroyed readability. A runtime sanitizer masks any bare URL as a guarantee layer, and every generation's extracted sources persist in `interaction_sources` (24h window) and are re-injected into later generations of the same container, so "where is the source" follow-ups stay answerable with no footer at all.)_
- **`web_answer`** — Brave Answer API (`/res/v1/chat/completions`): a synthesized, source-cited natural-language answer for factual questions.

Both tools are always present; with a missing key or a failed request they return a structured error so the model degrades gracefully — no tool failure is fatal. Two separate keys (`BRAVE_SEARCH_API_KEY`, `BRAVE_ANSWER_API_KEY`) are Worker secrets, each independently optional. The old keyword-prefetch pipeline and its dead code were deleted.

## Alternatives Considered

### Keyword-heuristic prefetch (previous design)

- Pros: no model round-trip for "obvious" searches.
- Cons: no model agency; heuristics rot; results arrive whether or not they help.
- Why not chosen: replaced — search decisions belong to the model.

### Single API only (search without answer, or vice versa)

- Pros: one key, one code path.
- Cons: factual questions get link lists; research questions get unsupported synthesis.
- Why not chosen: the two APIs cover complementary query shapes.

### Multi-provider search abstraction

- Pros: provider diversity from day one.
- Cons: premature — normalized interfaces before a second proven need.
- Why not chosen: wait for the second use case; the tool result shape is already normalized for it.

## Consequences

**Positive:** the model decides when and what to search; citations are structured and consistent; no external search dependency beyond Brave.

**Negative:** two Brave keys to manage; Brave rate limits/pricing to watch; a Brave outage removes search entirely (no engine diversity).

**Neutral:** additional backends can join later by emitting the same normalized result shape.

## Review Triggers

- A Brave outage or pricing change materially degrades the bot.
- Search diversity becomes a requirement (add a backend behind the normalized interface).
- The Answer API's quality diverges from the Search API's (re-split responsibilities).
