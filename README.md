# Xenoblade

A natural Discord bot powered by LLMs — running entirely on Cloudflare Workers with D1, Durable Objects, and OpenRouter.

## Features

- **Natural conversation** — replies in-channel (no forced thread creation), always reads conversation context, matches the user's language
- **Vision** — sees images in messages and Discord message links
- **Voice** — transcribes audio messages via `openai/gpt-transcribe`
- **Web search** — Brave Search tool for real-time information
- **Per-user context** — isolated conversation state with `/clear-context`
- **Bare @mention fallback** — send a message, then `@bot` alone to trigger it
- **Retry with backoff** — generation retries up to 3 times on transient failures

## Architecture

```
Discord Gateway ──► Worker (/webhooks/discord)
                       │
                       ├── @xenoblade/ai    model selection + prompt construction
                       ├── @xenoblade/db    D1: budget, dedup, user context state
                       ├── context          history fetching + container isolation
                       ├── prompt           cache-friendly message building
                       ├── tools            Brave Search
                       ├── transcribe       voice → text (gpt-transcribe)
                       └── discord-links    message link unfurling (text + images)
```

## Quick Start

### Prerequisites

- Node.js 24+, pnpm 11+
- Cloudflare account with Wrangler authenticated
- Discord application with bot token, public key, and application ID
- OpenRouter API key
- Brave Search API key (optional, for web search)

### Setup

```bash
pnpm install

# Configure secrets
cp .dev.vars.example apps/bot-worker/.dev.vars
# Fill in your Discord, OpenRouter, and gateway tokens

# Apply D1 migrations locally
pnpm --filter @xenoblade/bot-worker db:migrate:local

# Generate Worker types
pnpm generate-types

# Start dev server
pnpm dev
```

### Deploy

```bash
# Remote D1 migration
pnpm --filter @xenoblade/bot-worker db:migrate

# Set secrets
echo "YOUR_DISCORD_TOKEN" | pnpm --filter @xenoblade/bot-worker exec wrangler secret put DISCORD_BOT_TOKEN
echo "YOUR_OPENROUTER_KEY" | pnpm --filter @xenoblade/bot-worker exec wrangler secret put OPENROUTER_API_KEY
echo "YOUR_BRAVE_KEY" | pnpm --filter @xenoblade/bot-worker exec wrangler secret put BRAVE_SEARCH_API_KEY
# ... repeat for DISCORD_PUBLIC_KEY, DISCORD_APPLICATION_ID, GATEWAY_CONTROL_TOKEN, GATEWAY_STATUS_TOKEN

# Deploy
pnpm --filter @xenoblade/bot-worker exec wrangler deploy

# Register slash commands
DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... node scripts/register-status-command.mjs

# Connect the Discord Gateway
curl -X POST -H "Authorization: Bearer $GATEWAY_CONTROL_TOKEN" \
  https://your-worker.workers.dev/gateway/connect
```

## Configuration

Secrets are injected via `wrangler secret put` (remote) or `.dev.vars` (local):

| Secret                   | Required | Description                               |
| ------------------------ | -------- | ----------------------------------------- |
| `DISCORD_BOT_TOKEN`      | Yes      | Discord bot token                         |
| `DISCORD_PUBLIC_KEY`     | Yes      | Discord application public key            |
| `DISCORD_APPLICATION_ID` | Yes      | Discord application ID                    |
| `OPENROUTER_API_KEY`     | Yes      | OpenRouter API key                        |
| `GATEWAY_CONTROL_TOKEN`  | Yes      | Auth token for gateway connect/disconnect |
| `GATEWAY_STATUS_TOKEN`   | Yes      | Auth token for gateway status             |
| `BRAVE_SEARCH_API_KEY`   | No       | Brave Search API key (enables web search) |

Model and provider are configured in `wrangler.jsonc`:

```jsonc
"vars": {
  "AI_PROVIDER": "openrouter",
  "AI_MODEL": "openai/gpt-5.6-luna"
}
```

## Usage

| Action              | Description                                                          |
| ------------------- | ------------------------------------------------------------------- |
| `@bot <message>`    | Mention with text — full conversation context included              |
| `@bot` (bare)       | Read and respond to your most recent prior message                  |
| Reply to bot        | Continue a conversation thread                                       |
| `/status`           | Check gateway status                                                |
| `/clear-context`    | Clear your conversation context in the current channel              |
| Voice message + `@bot` | Transcribe via gpt-transcribe, then respond                       |
| Image + `@bot`      | Bot sees and describes the image                                    |

The bot always replies in the user's language and switches when asked.

## Development

```bash
pnpm test                                         # unit tests
pnpm --filter @xenoblade/bot-worker test:worker   # worker integration tests
pnpm typecheck                                    # TypeScript check
pnpm lint                                         # oxlint
pnpm format                                       # oxfmt
```

## Tech Stack

- **Runtime**: Cloudflare Workers (with `nodejs_compat`)
- **AI**: OpenRouter → GPT-5.6 Luna (chat) + GPT Transcribe (voice)
- **Database**: Cloudflare D1 (SQLite)
- **State**: Durable Objects (Chat state + Discord Gateway)
- **Language**: TypeScript (strict, ESM)
- **Tooling**: pnpm, oxlint, oxfmt, Vitest
