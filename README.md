<div align="center">

# Xenoblade

An LLM-powered Discord assistant for community operators, split between a self-hosted discord.js runtime and a Cloudflare Worker.

[Usage](#-usage) | [Features](#-features) | [Development](#-development)

[![CI](https://img.shields.io/github/actions/workflow/status/fang2hou/xenoblade/ci.yml?branch=main&label=CI&style=flat-square)](https://github.com/fang2hou/xenoblade/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=flat-square)](./LICENSE)

</div>

Xenoblade brings conversation-aware, citation-backed, and budget-bounded AI assistance to Discord servers while keeping credentials isolated across two tiers: the Discord bot token stays on the self-hosted runtime host, and AI provider keys stay in the Cloudflare Worker. It targets single-operator communities rather than multi-tenant hosting, other chat platforms, or token streaming.

## 🚀 Usage

Once the Worker and Discord Runtime are deployed, interact with Xenoblade directly in Discord:

| Action                                                  | Effect                                                                                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `@bot <message>` or watched-role mention in a channel   | Starts a public thread on your message and answers there; the bot keeps following the thread so no further `@` mention is needed   |
| `@bot` (bare mention)                                   | Answers your most recent prior message in the channel                                                                              |
| Chat in a followed thread                               | Answered automatically when relevant; say "stop following" to pause following, or `@bot` to resume                                 |
| Reply to a bot message                                  | Continues the conversation in place in your language                                                                               |
| Click a question or confirmation card                   | Answers clarifying questions (`ask_user`) or confirms proposed guild memory, bot soul, or owner-only server administration changes |
| "try again" or "try again, shorter"                     | Redoes the previous reply as a new message without editing the original                                                            |
| `/status`, `/usage`, `/language`                        | Checks gateway status, shows 24h token usage (ephemeral), or switches UI notice language (`zh` or `en`)                            |
| `/context truncate` or `/context restore`               | Hides earlier channel messages from context with an undoable stack                                                                 |
| `/persona`, `/preference`, `/memory`, `/learn`, `/help` | Manages per-user memories, opt-in auto-learning, and command help                                                                  |
| DM: `/chat on` + message                                | Enables opt-in private chat in a DM-isolated scope; `/chat off` clears the DM context                                              |

## ✨ Features

### `1` Credential-Isolated Two-Tier Architecture

The self-hosted `discord.js` runtime owns the Discord Gateway, REST API, and interactions, and communicates with the Cloudflare Worker over outbound HTTPS with a bearer token. The Worker owns AI generation, tools, MCP clients, and D1 persistence, and never calls back to the runtime host.

### `2` Conversation, Threads, and Guild History

Mentions in text channels open auto-followed discussion threads gated by a deterministic filter and a semantic relevance check, while a rolling 90-day D1 FTS5 index lets the assistant search public allowlisted guild channels. Replies automatically follow the conversation language and fall back to a `reply.md` attachment when long outputs would flood a channel.

### `3` Web Search, Page Reading, Vision, and MCP

First-party tools provide Brave web search and answers, SSRF-gated web page summarization, image understanding, and read-only remote MCP servers with per-server and per-tool allowlists. Model routing supports Charm Hyper and OpenRouter with per-role fallback chains and model output token clamping.

### `4` Scoped Memory, Bot Soul, and Opt-In DMs

Each user has isolated personal memory that can be managed via slash commands or explicit chat requests, while shared server memory and the server bot persona (`soul`) require button confirmation before taking effect. DMs act as a configuration console by default, and opt-in DM chat stays isolated from guild context and logs.

### `5` Owner-Approved Server Administration

When explicitly configured for a single guild and owner inside a private channel or thread, the assistant can inspect live Discord server state through Runtime-proxied read-only calls and prepare frozen change plans. Every write plan is hashed, stored in D1, and executed verbatim only after the owner clicks Approve on the confirmation card.

## 🛠️ Development

Requires [mise](https://mise.jdx.dev/) on macOS or Linux. Runtime and CLI tool versions are pinned in `mise.toml`.

```bash
mise install
pnpm install --frozen-lockfile
cp .dev.vars.example apps/platform-worker/.dev.vars
pnpm --filter @xenoblade/platform-worker db:migrate:local
pnpm --filter @xenoblade/platform-worker types
mise run dev
```

`mise run dev` starts the Platform Worker locally on `http://localhost:8787`. Run `pnpm dev:runtime` in a separate terminal with a Discord bot token to start the Discord Runtime, and run `mise run` to list all tasks (`check`, `test`, `build`, `deploy`).

See [DEVELOPMENT.md](./DEVELOPMENT.md) for the full local setup, validation, and deployment workflow, and [ARCHITECTURE.md](./ARCHITECTURE.md) for system invariants and ADRs.

<details>
<summary>Environment variables and external services</summary>

### Platform Worker (`apps/platform-worker/.dev.vars` or `wrangler secret put`)

| Variable                      | Required | Purpose                                                                 |
| ----------------------------- | -------- | ----------------------------------------------------------------------- |
| `INTERNAL_API_TOKEN`          | Yes      | Shared bearer token authenticating Runtime calls to `/internal/v1/*`    |
| `HYPER_API_KEY`               | One of   | Routes DeepSeek calls through Charm Hyper (with `OPENROUTER_API_KEY`)   |
| `OPENROUTER_API_KEY`          | One of   | Routes model chains through OpenRouter (and cross-provider fallback)    |
| `BRAVE_SEARCH_API_KEY`        | No       | Enables the `web_search` tool                                           |
| `BRAVE_ANSWER_API_KEY`        | No       | Enables the `web_answer` tool                                           |
| `GITHUB_MCP_TOKEN`            | No       | Authenticates the optional GitHub MCP server                            |
| `ARTIFICIAL_ANALYSIS_API_KEY` | No       | Authenticates the optional Artificial Analysis MCP server               |
| `ADMIN_GUILD_ID`              | No       | Target guild ID for owner-approved server administration (paired below) |
| `ADMIN_OWNER_USER_ID`         | No       | Owner Discord user ID for server administration (paired above)          |

### Discord Runtime (shell environment or host `.env`)

| Variable                 | Required | Purpose                                                            |
| ------------------------ | -------- | ------------------------------------------------------------------ |
| `DISCORD_BOT_TOKEN`      | Yes      | Bot token for the single Discord Gateway session                   |
| `DISCORD_APPLICATION_ID` | Yes      | Discord application ID used to register global slash commands      |
| `WORKER_URL`             | Yes      | Base URL of the Platform Worker (`http://localhost:8787` locally)  |
| `INTERNAL_API_TOKEN`     | Yes      | Shared bearer token matching the Platform Worker                   |
| `MENTION_ROLE_IDS`       | No       | Comma-separated role IDs whose mentions also trigger the assistant |
| `HEALTH_PORT`            | No       | Localhost health server port (defaults to `8397`)                  |
| `ADMIN_GUILD_ID`         | No       | Must match the Worker value to enable server administration        |
| `ADMIN_OWNER_USER_ID`    | No       | Must match the Worker value to enable server administration        |

### External services

- Required: Discord application, Cloudflare (Workers and D1), Charm Hyper and/or OpenRouter, and a self-hosted Docker host with a container registry for the runtime.
- Optional: Brave Search/Answer APIs and remote MCP servers (Context7, GitHub, Artificial Analysis).

</details>

## 📄 License

[MIT](./LICENSE)
