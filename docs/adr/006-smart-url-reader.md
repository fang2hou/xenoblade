# ADR-006: Smart URL Reader Pipeline

- **Status**: Accepted
- **Date**: 2026-08-12

## Context

The `read_url` tool fetches web page content for the AI model to reference during investigation tasks. Web pages vary dramatically in size: a news article may be 3,000 characters; a documentation page or legal document may exceed 50,000 characters.

Sending raw page content directly to the generation model has two problems:

1. **Context window pollution.** A single 30,000-character page consumes ~15,000 tokens — a large fraction of the model's context window. Multi-source investigations (3–5 pages) can exhaust the window entirely, crowding out conversation history and user memory.

2. **Cost.** The generation model is the most expensive per token. Paying generation-model rates for boilerplate HTML, navigation menus, cookie banners, and ad scripts is wasteful.

A naive truncation (first 2,000 characters) loses critical information that may appear later in the page — conclusions, data tables, code examples.

## Decision

`read_url` is a two-stage pipeline that uses the **summarization model** (see [ADR-004](004-two-tier-model.md)) to compress content before it reaches the generation model:

```text
Stage 1: Fetch
  Primary: Jina Reader (r.jina.ai) → plain text
  Fallback: Cloudflare Browser Rendering → innerText

Stage 2: Compress (only if content > READ_URL_CONTENT_THRESHOLD)
  Call: SUMMARIZATION_MODEL (small, fast, cheap)
  Prompt: "Extract key facts, data points, and arguments.
           Preserve specific numbers, dates, names, quotes.
           Remove navigation, ads, boilerplate.
           Output structured markdown."
  Max output: SUMMARIZATION_MAX_TOKENS (default 512)

Stage 3: Return to generation model
  { content: compressed_summary_or_raw_text,
    sourceUrl, originalLength, compressed: boolean }
```

If the content is below the threshold (default 2,000 characters), it is returned raw without summarization — small pages don't warrant the extra model call.

If the summarization model fails or times out, the tool falls back to truncating raw text to a safe length. The investigation continues; it just costs more tokens.

## Consequences

**Positive:**
- Generation model sees only compressed summaries (≤ 512 tokens), not raw pages. Token consumption drops by 1–2 orders of magnitude for web-heavy tasks.
- Summarization model handles extraction at minimal cost (small model, single call).
- The generation model's context window is preserved for reasoning and multi-step investigation.
- Structured summaries are easier for the generation model to cite accurately than raw HTML.
- Cache API can cache compressed results, avoiding re-summarization on repeated reads of the same URL.

**Negative:**
- Two model calls per `read_url` (fetch + summarize), adding 1–3 seconds latency.
- Summarization quality determines what the generation model "knows" — critical details dropped by the summarizer are invisible.
- One additional failure mode (summarization timeout/error) to handle.

**Neutral:**
- The threshold and max tokens are configurable via environment variables, allowing tuning per deployment.
- Jina Reader remains the primary fetch mechanism; Browser Rendering is fallback for JavaScript-rendered content.
