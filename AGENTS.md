# AGENTS.md

Guidance for AI agents working in this repository. Read this before making changes.

Xenoblade is an LLM-powered Discord assistant for community operators: a self-hosted discord.js runtime owns the Discord connection, a Cloudflare Worker owns AI generation, tools, and data.

## Commands

```bash
mise install                 # set up the toolchain
mise run dev                 # start the Platform Worker dev server (wrangler dev)
mise run test                # test suite (runs check first)
mise run test -- {{filter}}  # run a single test file or case, e.g. mise run test -- staged-status
mise run lint                # lint only
mise run format              # format check only — write with pnpm format
mise run typecheck           # type checking only
mise run build               # build discord-runtime (pnpm -r build)
pnpm --filter @xenoblade/platform-worker types  # regenerate worker-configuration.d.ts
mise run check               # full validation (lint + format + typecheck) — run before every commit
```

Use pnpm, never npm or yarn. The Discord Runtime has no mise task: run `pnpm dev:runtime` (needs a real Discord bot token).

## Engineering Standards

This project follows the shared engineering guidelines:

> <https://github.com/fang2hou/ai-coding-guidelines> — start from its [PORTAL.md](https://github.com/fang2hou/ai-coding-guidelines/blob/main/PORTAL.md).

Read the portal's reading recipes for your task type before starting.
Repository documentation always takes precedence over remembered summaries.

Project-specific overrides:

- Server-side Vercel AI SDK (`ai` + `@openrouter/ai-sdk-provider`) without Next.js — justified: the SDK's tool-calling loop and provider abstraction are heavily exercised (model chains with provider fallbacks, tool loops, MCP); nothing else from the Vercel stack is used or wanted.
- Raw fetch-handler Cloudflare Worker instead of a framework (Hono et al.) — pre-existing working service; introducing a framework is a decision change, not a refactor (see [ARCHITECTURE.md](./ARCHITECTURE.md)).

## Layout

- `apps/platform-worker/` — Cloudflare Worker: `/internal/v1/*` routes, generation pipeline, tools, D1 access
- `apps/discord-runtime/` — self-hosted discord.js gateway: triggers, staged status, reply controls, DM control plane
- `packages/contracts/` — wire types for every Runtime↔Worker call, shared verbatim by both apps
- `packages/ai/` — model chains per role (OpenRouter), system prompt composition, generation limits
- `packages/db/` — legacy D1 helpers from the pre-split worker; unreferenced, do not add code here
- `docs/adr/` — architecture decision records
- `scripts/` — local deploy script and legacy registrars
- `deploy/` — docker-compose definition used on the gateway host

## Boundaries

Always:

- Run `mise run check` before every commit
- Keep each change minimal and scoped to the request
- Route all Runtime↔Worker communication through `packages/contracts`

Never:

- Force push shared branches or rewrite shared history casually
- Commit secrets, tokens, or DM/user content — DM-scope logs carry no content previews
- Edit generated files by hand (`worker-configuration.d.ts` — regenerate with `wrangler types`)
- Run two runtime instances against the same bot token (single Gateway session per token)

Ask first:

- New dependencies
- Changes to invariants in [ARCHITECTURE.md](./ARCHITECTURE.md) or any ADR — supersede the record explicitly, never violate silently
- Deleting or reshaping wire-contract types in `packages/contracts`
- Anything touching applied D1 migration history

## Confirmed Language Policy

| Item                      | Value                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| Conversation              | Follows the user                                                                                |
| Code / comments / commits | English                                                                                         |
| Chat replies              | Always follow the conversation language automatically                                           |
| UI notices                | Staged status, command replies, DM control plane: the user's `/language` setting (`zh` default) |
| Tone                      | Concise, casual                                                                                 |

Do not infer UI language from conversation language.

## Project Conventions

- Structured logging only: `console.log(JSON.stringify({ event, ... }))` — one line per event.
- Early returns; no hidden second behavior behind boolean flags.
- All outbound fetches of user-supplied URLs go through the SSRF gate (`isUrlSafe`).
- Only the triggering user's `user_memory` is injected into a generation — never another user's.
- DM context lives under `discord:@me:<channelId>` keys that cannot collide with guild keys; keep it that way.
- Staged status placeholder is capped at 4 edits per generation (ADR-003 amendment) — do not raise casually.
- TypeScript strict + `noUncheckedIndexedAccess`; guard every indexed access.
- Budget guardrails: 1024 tokens reserved per generation, 200k tokens / 24h rolling window.

Depth: [DEVELOPMENT.md](./DEVELOPMENT.md) for workflow and toolchain, [CONTRIBUTING.md](./CONTRIBUTING.md) for PR rules, [ARCHITECTURE.md](./ARCHITECTURE.md) for invariants.
