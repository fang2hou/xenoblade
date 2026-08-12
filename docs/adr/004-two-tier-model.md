# ADR-004: Two-Tier Model Architecture

- **Status**: Accepted
- **Date**: 2026-08-12

## Context

A single model cannot efficiently serve all tasks in a Discord AI bot:

1. **Generation (conversation, reasoning).** Requires a high-quality model with strong reasoning, creativity, and instruction-following. These models are expensive per token. Their context window should be reserved for conversation, user memory, and compressed tool results — not raw web page HTML.

2. **Summarization (web page extraction).** When a tool fetches a web page, the raw content can be 5,000–50,000 characters. Sending this to the generation model wastes tokens on navigation, boilerplate, and irrelevant sections. A small, fast model can extract key facts, data points, and arguments at a fraction of the cost.

3. **Transcription (audio).** Voice messages require a specialized speech-to-text model, not a general-purpose LLM.

Using the generation model for all three roles means either (a) sending raw web pages to an expensive model, or (b) skipping content extraction entirely. Both are suboptimal.

## Decision

Define three model roles, each independently configurable and routed through OpenRouter via the AI SDK standard interface:

```ts
type ModelRole = "generation" | "summarization" | "transcription";
```

| Role            | Purpose                                          | Characteristics                | Config key            |
| --------------- | ------------------------------------------------ | ------------------------------ | --------------------- |
| `generation`    | Main conversation, reasoning, tool orchestration | Large, high-quality, expensive | `GENERATION_MODEL`    |
| `summarization` | Web page compression, key fact extraction        | Small, fast, cheap             | `SUMMARIZATION_MODEL` |
| `transcription` | Audio-to-text                                    | Specialized STT                | `TRANSCRIPTION_MODEL` |

All three go through OpenRouter using the AI SDK provider abstraction. Each is configured via a separate Wrangler var and can be swapped independently without affecting the others.

The `packages/ai` module exposes:

```ts
function selectModel(role: ModelRole): LanguageModel;
```

## Consequences

**Positive:**

- The generation model's context window sees only compressed summaries (≤ 512 tokens), not raw pages. Token consumption drops by an order of magnitude for web-heavy tasks.
- The summarization model handles mechanical extraction at near-zero cost per call.
- Each role can be upgraded, downgraded, or switched to a different provider without touching the others.
- The AI SDK abstraction preserves the option to switch from OpenRouter to direct provider connections in the future.

**Negative:**

- Two model calls per `read_url` invocation (fetch + summarize), adding latency.
- The summarization model's output quality affects what the generation model "sees" — a poor summarizer can drop critical details.
- Three model configurations to maintain instead of one.

**Neutral:**

- The summarization model's prompt is tuned for extraction, not creativity: "Preserve specific numbers, dates, names, and quotes. Remove navigation, ads, boilerplate. Output structured markdown."
- If the summarization model fails, `read_url` falls back to truncating raw text to a safe length, preserving tool availability at the cost of token efficiency.
