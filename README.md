# Xenoblade

An LLM-powered Discord assistant for community operators: a self-hosted discord.js runtime owns the Discord connection, a Cloudflare Worker owns AI generation, tools, and data.

[![CI](https://github.com/fang2hou/xenoblade/actions/workflows/ci.yml/badge.svg)](https://github.com/fang2hou/xenoblade/actions/workflows/ci.yml)

## Why

- Discord communities want an AI assistant that is conversation-aware, citation-backed, and budget-bounded — and privacy-safe in DMs by default.
- Xenoblade splits that into two tiers so credentials never cross: the Discord token lives only on the runtime host, AI keys only in the Worker (see [ARCHITECTURE.md](./ARCHITECTURE.md)).

Scope boundaries — intentionally **not** done:

- Discord only; no cross-platform messaging abstraction.
- No token streaming: single-shot replies with bounded staged status (ADR-003).
- No self-hosted model inference; all models via OpenRouter.
- Voice is not wired yet — the topology supports it (ADR-002), but no audio handling ships.
- Single-operator deployment, not a multi-tenant service.

Current status: **actively developed** — conversation, search, vision, memory, and opt-in DM chat are live.

## Use it

```bash
mise install
mise run dev
```

- `mise run` lists all tasks (lint, format, typecheck, test, check, build, dev, deploy). Every task delegates to a `pnpm` script; see [DEVELOPMENT.md](./DEVELOPMENT.md#common-tasks).
- First Worker run needs secrets (`INTERNAL_API_TOKEN`, `OPENROUTER_API_KEY`) and a local D1 migration; the runtime needs a real Discord bot token — see [DEVELOPMENT.md](./DEVELOPMENT.md#local-development).

Everyday usage in Discord:

| Action                                          | Effect                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| `@bot <message>` / reply / watched-role mention | Conversation-aware reply in your language                                  |
| `@bot` (bare)                                   | Responds to your most recent prior message                                 |
| 🔁 / 🗑️ on a bot reply                          | Regenerate / delete — triggering user only                                 |
| `/status` `/clear-context` `/usage`             | Runtime status, context reset, 24h token summary (ephemeral)               |
| DM: `/persona` `/preference` `/memory` `/learn` | Per-user configuration console, no AI generation                           |
| DM: `/chat on` + text                           | Opt-in private chat in a DM-isolated scope (ADR-011); `/chat off` wipes it |

## What to read next

| Goal                  | Read                                 |
| --------------------- | ------------------------------------ |
| Understand the system | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Develop and validate  | [DEVELOPMENT.md](./DEVELOPMENT.md)   |
| Contribute a change   | [CONTRIBUTING.md](./CONTRIBUTING.md) |

## Language Policy

| Item                 | Value                                                                      |
| -------------------- | -------------------------------------------------------------------------- |
| Primary UI language  | Bot conversation replies match each user's language                        |
| Additional languages | None fixed — follows the user                                              |
| Tone / formality     | Concise, casual                                                            |
| Fixed UI literals    | Chinese (Simplified) DM control-plane notices; `/usage` labels are English |

Code identifiers, comments, and commit messages are always English.
Do not infer UI language from conversation language.

## Environment Requirements

- Runtime versions: managed by mise (see `mise.toml`) — node, pnpm, prek, cocogitto.
- Required environment variables: Worker secrets `INTERNAL_API_TOKEN`, `OPENROUTER_API_KEY` (optional: Brave, MCP, Artificial Analysis keys); Runtime env `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, `WORKER_URL`, `INTERNAL_API_TOKEN` — full lists in [DEVELOPMENT.md](./DEVELOPMENT.md#local-development).
- External services: Discord application, Cloudflare (Workers, D1), OpenRouter, a self-hosted Docker host with its own registry for the runtime; optional: Brave APIs, MCP servers (context7, GitHub), Artificial Analysis.
