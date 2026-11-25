<div align="center">

# Xenoblade

An LLM-powered Discord assistant for community operators: a self-hosted discord.js runtime owns the Discord connection, a Cloudflare Worker owns AI generation, tools, and data.

[![CI](https://github.com/fang2hou/xenoblade/actions/workflows/ci.yml/badge.svg)](https://github.com/fang2hou/xenoblade/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

</div>

## Why

Discord communities want an AI assistant that is conversation-aware, citation-backed, and budget-bounded — and privacy-safe in DMs by default. Xenoblade splits that into two tiers so credentials never cross: the Discord token lives only on the runtime host, AI keys only in the Worker.

- In scope: natural conversation with search, page reading, vision, and per-user memory; opt-in DM chat; per-user/guild usage accounting; deployment for a single operator's servers.
- Out of scope: other chat platforms; token streaming; self-hosted model inference; multi-tenant hosting. Voice is topology-enabled but not wired yet.
- Status: actively developed — conversation, search, vision, memory, and opt-in DM chat are live.

## Use it

**As a human** — requires [mise](https://mise.jdx.dev/):

```bash
mise install
mise run dev
```

`mise run` lists every task. Other main workflows: `mise run check` (full validation), `mise run test`, `mise run deploy`. The Discord Runtime side needs a real bot token — see [DEVELOPMENT.md](./DEVELOPMENT.md#setup).

Once running, in Discord:

| Action                                                    | Effect                                                                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `@bot <message>` / watched-role mention in a text channel | Starts a public thread on your message and answers there; the bot keeps following the thread, so nobody has to `@` it again |
| `@bot` (bare)                                             | Responds to your most recent prior message                                                                                  |
| Chat in a followed thread                                 | Answered without an `@`; say "先到这" / "stop following" to pause it, `@bot` to resume                                      |
| A question card with buttons                              | Click an option (or just reply) — the card is removed and the bot continues from your answer                                |
| "重新回答" / "再说简单点" / "try again, shorter"          | Redoes the last reply as a new message                                                                                      |
| Reply to a bot message                                    | Conversation-aware reply in place, in your language                                                                         |
| `/status` `/clear-context` `/usage`                       | Runtime status, context reset, 24h token summary (ephemeral)                                                                |
| DM: `/persona` `/preference` `/memory` `/learn`           | Per-user configuration console, no AI generation                                                                            |
| DM: `/chat on` + text                                     | Opt-in private chat in a DM-isolated scope; `/chat off` wipes it                                                            |

**With an AI coding agent** — paste this into the agent to hand it the repository:

```text
Work in this repository. Read AGENTS.md at the repository root first and follow it.
```

## What to read next

| Goal                  | Read                                 |
| --------------------- | ------------------------------------ |
| Understand the system | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Develop and validate  | [DEVELOPMENT.md](./DEVELOPMENT.md)   |
| Contribute a change   | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| Give it to an agent   | [AGENTS.md](./AGENTS.md)             |

## Environment Requirements

- Runtime versions: managed by mise (see `mise.toml`) — node 24, pnpm, prek, cocogitto.
- Required environment variables: Worker secrets `INTERNAL_API_TOKEN`, `OPENROUTER_API_KEY` (optional: Brave, MCP, Artificial Analysis keys); Runtime env `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, `WORKER_URL`, `INTERNAL_API_TOKEN` — full lists in [DEVELOPMENT.md](./DEVELOPMENT.md#setup).
- External services: Discord application, Cloudflare (Workers, D1), OpenRouter, a self-hosted Docker host with its own registry for the runtime; optional: Brave APIs, MCP servers (context7, GitHub, Artificial Analysis).

## License

MIT — see [LICENSE](./LICENSE).
