# Xenoblade

> A natural-language Discord bot split across two tiers: a self-hosted discord.js runtime that owns the Discord connection, and a Cloudflare Worker that owns AI generation, tools, and data.

## Overview

- **What it does**: an LLM-powered Discord assistant. Mentions, role mentions, replies, and slash commands trigger conversation-aware answers with web search, page reading, vision, and per-user memory — budget-bounded and citation-backed.
- **Who uses it**: Discord communities operated by the project maintainer (single-operator deployment today).
- **Current status**: actively developed. Core conversation, search, vision, memory, and DM opt-in chat are live; voice is not yet wired (see [Features](#features)).

## Purpose

- **Problem**: give a Discord server a genuinely useful AI assistant — context-aware, cost-bounded, and privacy-safe in DMs — without leaking credentials or private content across tiers.
- **Scope boundaries**: Discord only (no cross-platform abstraction); no token streaming; no self-hosted model inference (all models via OpenRouter); voice support is enabled by the topology but not yet implemented.

## Features

- **Natural conversation** — `@bot <message>`, watched-role mentions, replies to the bot, and bare `@bot` (falls back to your most recent message); replies in-channel with conversation context, always matching the user's language.
- **Reaction controls** — 🔁 regenerate and 🗑️ delete on the bot's replies; only the triggering user can act (ADR-003 protocol, durable regenerate claim).
- **Structured citations** — inline `[n]` markers with a canonical numbered **Sources** footer built from actual search results.
- **Staged status** — long generations escalate a status placeholder at coarse milestones (hard cap: 4 edits per generation, ADR-003 amendment).
- **Slash commands** — `/status` (runtime status), `/clear-context` (reset your context in the channel), `/usage` (ephemeral 24h per-user and per-server token/tool summary).
- **DM opt-in chat** — private conversations with the bot behind an explicit per-user opt-in (`/chat on`), stored in a DM-isolated context scope that can never collide with guild data (ADR-011); off by default, `/chat off` also wipes the DM context.
- **DM control plane** — DMs are primarily a configuration console: `/persona`, `/preference`, `/memory`, `/learn`, `/help` manage your per-user settings without any AI generation.
- **Per-user memory** — persona, preferences, and facts (`user_memory`) are injected only into the triggering user's prompts; auto-memory extraction is consent-gated: opt-in plus pending/confirm review, never from DMs (ADR-012; extraction pipeline not yet implemented — the consent contract is).
- **Web search** — `web_search` (Brave Search) and `web_answer` (Brave Answer) as first-class model tools with graceful degradation.
- **Page reading** — `read_url` fetches a page, strips boilerplate, and compresses long content through the summarization model before it reaches the generation model.
- **Vision** — image attachments are seen natively by vision-capable models; a `vision_describe` tool gives text-only fallback models the same ability.
- **MCP** — remote MCP servers over Streamable HTTP (context7 always; GitHub MCP when a token is configured), read-only scope (ADR-008).
- **Voice** — not yet wired: the runtime topology supports it (ADR-002) and a transcription model role (`openai/gpt-transcribe`) is configured, but no voice/audio handling ships today.
- **Budget guardrails** — rolling 24h token budget per user, message dedup, and per-container serialization of generations.

## Architecture

Two tiers, one direction of trust:

```
Discord ←→ Discord Runtime (self-hosted, discord.js, Docker)
                 │ outbound HTTPS + bearer token only
                 ▼
            Platform Worker (Cloudflare)
                 ├─ AI generation (OpenRouter, model chains per role)
                 ├─ Tools: web_search / web_answer / read_url / vision / MCP
                 ├─ D1: config, budget, dedup, memory, telemetry
                 └─ /internal/v1/* — the only exposed surface
```

The Runtime owns the Discord token and never accepts inbound traffic; the Worker owns AI keys and never calls back. Invariants and decision records: [ARCHITECTURE.md](./ARCHITECTURE.md). Day-to-day workflow: [DEVELOPMENT.md](./DEVELOPMENT.md). Contributions: [CONTRIBUTING.md](./CONTRIBUTING.md).

## Setup

Requires [mise](https://mise.jdx.dev/), a Cloudflare account with Wrangler authenticated, a Discord application (bot token + application ID), and an OpenRouter API key. Brave keys are optional (search tools degrade gracefully without them).

```bash
mise install                 # node, pnpm, prek, cocogitto
pnpm install

# Worker secrets for local dev (wrangler reads apps/platform-worker/.dev.vars)
cp .dev.vars.example apps/platform-worker/.dev.vars
#   fill: INTERNAL_API_TOKEN, OPENROUTER_API_KEY
#   optional: BRAVE_SEARCH_API_KEY, BRAVE_ANSWER_API_KEY

pnpm --filter @xenoblade/platform-worker db:migrate:local   # local D1 schema
pnpm --filter @xenoblade/platform-worker types              # generate Worker types
pnpm dev                                                   # wrangler dev (Worker)
```

To run the Discord Runtime locally as well (needs a real Discord bot token):

```bash
export DISCORD_BOT_TOKEN=... DISCORD_APPLICATION_ID=... \
       WORKER_URL=http://localhost:8787 INTERNAL_API_TOKEN=...
pnpm dev:runtime
```

Deployment (CI-driven, D1 migration first) is documented in [DEVELOPMENT.md](./DEVELOPMENT.md#deployment).

## Usage

| Action                                             | Effect                                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------- |
| `@bot <message>`                                   | Reply with full conversation context                                       |
| `@bot` (bare)                                      | Respond to your most recent prior message in the channel                   |
| Mention a watched role                             | Same as a direct mention (roles set via `MENTION_ROLE_IDS` on the runtime) |
| Reply to a bot message                             | Continue that conversation                                                 |
| React 🔁 / 🗑️ on a reply                           | Regenerate / delete (triggering user only)                                 |
| `/status`                                          | Runtime status                                                             |
| `/clear-context`                                   | Clear your conversation context in the current channel                     |
| `/usage`                                           | Ephemeral 24h usage and token summary (you + this server)                  |
| DM: `/chat on` then text                           | Private opted-in conversation in a DM-isolated scope (ADR-011)             |
| DM: `/persona`, `/preference`, `/memory`, `/learn` | Per-user configuration console (no AI generation)                          |

The bot always replies in the user's language and switches when asked.

## Language Policy

| Item                      | Value                                                             |
| ------------------------- | ----------------------------------------------------------------- |
| Bot conversation replies  | Match the user's language (enforced in the system prompt)         |
| Primary UI literals       | Chinese (Simplified) — DM control-plane replies and error notices |
| Additional UI languages   | English — `/usage` summary labels                                 |
| Code / comments / commits | Always English                                                    |

Do not infer UI language from conversation language; do not switch UI literals because a conversation switched.

## Environment Requirements

- **Runtimes**: managed by mise (see `mise.toml`); Node and pnpm versions come from `mise.toml` + `package.json` `packageManager`.
- **Worker secrets** (`wrangler secret put`, required unless noted): `INTERNAL_API_TOKEN`, `OPENROUTER_API_KEY`; optional: `BRAVE_SEARCH_API_KEY`, `BRAVE_ANSWER_API_KEY`, `GITHUB_MCP_TOKEN`, `ARTIFICIAL_ANALYSIS_API_KEY`.
- **Runtime environment** (host `.env`): `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, `WORKER_URL`, `INTERNAL_API_TOKEN`; optional: `MENTION_ROLE_IDS`, `HEALTH_PORT` (default 8397).
- **External services**: Discord (application + bot), Cloudflare (Workers, D1), OpenRouter, Brave APIs (optional), a self-hosted Docker host with its own registry for the runtime, MCP servers (context7; GitHub MCP optional), Artificial Analysis (optional).
- **Model routing**: `MODEL_CONFIG` Worker var — JSON of model chains per role (`generation`, `summarization`, `transcription`, `vision`); defaults live in `packages/ai`.
