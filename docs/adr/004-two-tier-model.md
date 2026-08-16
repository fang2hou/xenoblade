# ADR-004: Two-Tier Model Architecture

- **Status**: Accepted
- **Date**: 2026-08-12

## Context

A single model cannot efficiently serve all tasks in a Discord AI bot:

1. **Generation (conversation, reasoning)** wants a large, high-quality model; its context window should hold conversation, memory, and compressed tool results — not raw web pages.
2. **Summarization (web page extraction)** is mechanical extraction over 5,000–50,000-character pages; a small, fast model does it at a fraction of the cost.
3. **Transcription (audio)** requires a specialized speech-to-text model, not a general LLM.

One model for everything means either feeding raw pages to an expensive model or skipping extraction entirely.

## Decision

Define model roles, each independently configured and routed through OpenRouter via the AI SDK standard interface:

```ts
type ModelRole = "generation" | "summarization" | "transcription" | "vision";
```

| Role            | Purpose                                     | Config key      |
| --------------- | ------------------------------------------- | --------------- |
| `generation`    | Conversation, reasoning, tool orchestration | `generation`    |
| `summarization` | Web page compression, key fact extraction   | `summarization` |
| `transcription` | Audio-to-text                               | `transcription` |
| `vision`        | Image description for text-only models      | `vision`        |

Each role is an ordered **model chain** (`MODEL_CONFIG` Worker var; defaults in `packages/ai`) with provider fallbacks, so the primary can fail over without code changes. `selectModel(role)` picks the head of the chain.

_Evolution note:_ the original decision defined three roles; `vision` was added when fallback models without native image input entered the generation chain (the `vision_describe` tool delegates to it). The transcription role is configured but not yet wired — no voice handling ships today.

## Alternatives Considered

### One model for all roles

- Pros: single configuration, no role routing.
- Cons: generation-model prices paid for boilerplate extraction; context window pollution; wrong tool for audio.
- Why not chosen: order-of-magnitude token waste on web-heavy tasks.

### Per-call ad-hoc model choice (no roles/chains)

- Pros: maximum flexibility per request.
- Cons: configuration scattered across call sites; no fallback story; swapping providers means code changes.
- Why not chosen: roles + chains make swaps and failover configuration, not code.

## Consequences

**Positive:** the generation model sees compressed summaries (≤ 512 tokens), not raw pages; extraction runs near-free; each role upgrades/swaps independently; the AI SDK abstraction keeps direct-provider connections open as a future option.

**Negative:** two model calls per `read_url` invocation (latency); a weak summarizer starves the generation model; several model configurations to maintain.

**Neutral:** the summarization prompt is tuned for extraction (preserve numbers, dates, names, quotes; drop navigation/ads); on summarizer failure `read_url` falls back to truncating raw text — tool availability survives at the cost of token efficiency.

## Review Triggers

- A single model family serves all roles cheaply (large-context, low-cost models erase the economic split).
- OpenRouter pricing or provider availability breaks a chain's economics.
- Voice ships and the transcription role gains real constraints (streaming, formats), forcing re-evaluation.
