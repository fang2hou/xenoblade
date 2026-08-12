# ADR-006: Smart URL Reader Pipeline

- **Status**: Accepted
- **Date**: 2026-08-12

## Context

The `read_url` tool fetches web page content for the AI model to reference during investigation tasks. Web pages vary dramatically in size: a news article may be 3,000 characters; a documentation page or legal document may exceed 50,000 characters.

Sending raw page content directly to the generation model has two problems:

1. **Context window pollution.** A single 30,000-character page consumes ~15,000 tokens — a large fraction of the model's context window. Multi-source investigations (3–5 pages) can exhaust the window entirely, crowding out conversation history and user memory.

2. **Cost.** The generation model is the most expensive per token. Paying generation-model rates for boilerplate HTML, navigation menus, cookie banners, and irrelevant sections is wasteful.

## Decision

`read_url` is a two-stage pipeline that uses the **summarization model** (see [ADR-004](004-two-tier-model.md)) to compress content before it reaches the generation model:

```text
Stage 1: Fetch
  Cloudflare Browser Rendering → innerText
  Block image/font/media/stylesheet requests for speed
  Strip script/style/nav/header/footer/aside tags
  Truncate to a safe maximum (e.g. 50,000 chars) before summarization

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
- Browser Rendering is already a Cloudflare binding — no external API dependency for fetching.
- Cache API can cache compressed results, avoiding re-summarization on repeated reads of the same URL.

**Negative:**

- Browser Rendering is slower than a lightweight reader API (2–4 seconds per page including network idle wait).
- Summarization adds 1–3 seconds latency per `read_url` call.
- One additional failure mode (summarization timeout/error) to handle.
- Browser sessions must be carefully closed in `finally` blocks to prevent resource leaks.

**Neutral:**

- The threshold and max tokens are configurable via environment variables.
- Browser Rendering handles JavaScript-rendered content natively (no need for a separate reader API).
