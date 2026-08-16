# Development

How development is performed in this repository, for both humans and AI agents.

## Toolchain

Runtime tools are managed by mise; run `mise install` after checkout, then `pnpm install`.
Node packages (linter, formatter, TypeScript, test runner, wrangler) come from the workspace `package.json` files and lockfile — do not install global equivalents.

| Tool        | Version (pinned via)                  | Purpose                                             |
| ----------- | ------------------------------------- | --------------------------------------------------- |
| node        | `mise.toml`                           | JS runtime                                          |
| pnpm        | `mise.toml`, `packageManager` 11.21.0 | Workspace package manager                           |
| prek        | `mise.toml`                           | Git hooks (hygiene, commit lint, pre-push tests)    |
| cocogitto   | `mise.toml`                           | Conventional Commits validation (`cog verify`)      |
| oxlint      | `package.json` ^1.78.0                | Linter                                              |
| oxfmt       | `package.json` ^0.63.0                | Formatter (code **and** markdown)                   |
| typescript  | `package.json` ^7.0.2                 | Type checking (`tsc -b --noEmit`)                   |
| vitest      | `package.json` ^4.1.10                | Unit test runner (whole workspace)                  |
| wrangler    | `apps/platform-worker` 4.119.0        | Cloudflare Workers dev/deploy, D1 migrations, types |
| esbuild/tsx | `apps/discord-runtime`                | Runtime bundling and local dev runner               |

Do not substitute tools without explicit approval (see the guideline repository's toolchain standards).

## Common Tasks

`mise run` is the canonical entry point for every workflow:

```bash
mise run dev      # start the Worker dev server (wrangler dev)
mise run lint     # oxlint across the monorepo
mise run format   # oxfmt write
mise run format:check # oxfmt --check
mise run typecheck    # tsc -b --noEmit
mise run test     # vitest run (all unit tests)
mise run check    # full validation — the same checks CI runs
mise run build    # bundle discord-runtime (esbuild → dist/)
mise run deploy   # scripts/deploy.sh (local deploy)
```

The tasks wrap the root `package.json` scripts (`pnpm dev`, `pnpm lint`, `pnpm format`, `pnpm format:check`, `pnpm test`, `pnpm deploy`) plus `pnpm exec tsc -b --noEmit` and `pnpm --filter @xenoblade/discord-runtime build` — use either surface, but CI and docs treat `mise run` as canonical.

## Development Workflow

1. Branch from `main`.
2. Implement the smallest coherent change.
3. `mise run check` must pass (hooks enforce hygiene on commit and `pnpm test` on push).
4. Commit with Conventional Commits (validated by cocogitto via the prek `commit-msg` hook).
5. Open a PR following [CONTRIBUTING.md](./CONTRIBUTING.md); rebase-merge keeps history linear.

## Coding Standards

Follow the guideline repository's coding standards. Project-specific rules:

- TypeScript strict, ESM only; `verbatimModuleSyntax`, no unused locals/params.
- Code, comments, and identifiers in English — always (see the README [Language Policy](./README.md#language-policy); only intentional UI literals may be Chinese).
- The Worker is a raw fetch handler on purpose — no framework (see [ARCHITECTURE.md](./ARCHITECTURE.md)). Do not introduce Hono/Express without superseding the recorded decision.
- Structured logging only: `console.log(JSON.stringify({ event, ... }))`.
- Early returns; no hidden second behavior behind boolean flags.
- All outbound fetches of user-supplied URLs go through the SSRF gate (`isUrlSafe`).
- Keep configuration files comment-free; rationale belongs in the PR or docs.

## Monorepo Layout

| Path                        | Responsibility                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `apps/platform-worker/`     | Cloudflare Worker: `/internal/v1/*` routes, generation pipeline, tools, D1 access (`src/db.ts`)                       |
| `apps/discord-runtime/`     | Self-hosted discord.js gateway: trigger policy, queues, staged status, reply controls, DM control plane               |
| `packages/contracts/`       | Wire types for every Runtime↔Worker call — shared verbatim by both apps                                               |
| `packages/ai/`              | Model chains per role (OpenRouter via `@openrouter/ai-sdk-provider`), system prompt composition, generation limits    |
| `packages/db/`              | Legacy D1 helpers from the pre-split worker — **unreferenced**; the live D1 layer is `apps/platform-worker/src/db.ts` |
| `scripts/`                  | Local deploy script and legacy registrars                                                                             |
| `deploy/docker-compose.yml` | Runtime container definition used on the gateway host                                                                 |
| `docs/adr/`                 | Architecture decision records (indexed in [ARCHITECTURE.md](./ARCHITECTURE.md))                                       |

## Testing Workflow

- Unit tests: `mise run test` (root `pnpm test`) — one vitest run covers the whole workspace; no per-package invocation needed.
- Platform Worker route tests (`apps/platform-worker/test/routes.test.ts`) exercise the real fetch handler: bearer auth, route dispatch, error codes — against a local D1 harness (`test/helpers/d1.ts`).
- Discord Runtime tests cover staged status milestones, reply affordances, citation rendering, usage formatting, and slash-command registration.
- `packages/ai` tests cover model-chain parsing and selection.
- Prioritize meaningful behavior over coverage numbers; there is no E2E suite — runtime liveness is covered by the `/health` endpoint and CI deploy checks.

## Local Development

**Worker** (`pnpm dev` / `mise run dev` — wrangler dev on :8787):

```bash
cp .dev.vars.example apps/platform-worker/.dev.vars   # INTERNAL_API_TOKEN, OPENROUTER_API_KEY (+ optional Brave keys)
pnpm --filter @xenoblade/platform-worker db:migrate:local
pnpm --filter @xenoblade/platform-worker types
pnpm dev
```

**Runtime** (`pnpm dev:runtime` — tsx, needs a real Discord bot):

```bash
export DISCORD_BOT_TOKEN=... DISCORD_APPLICATION_ID=... \
       WORKER_URL=http://localhost:8787 INTERNAL_API_TOKEN=...
# optional: MENTION_ROLE_IDS=<id,id> HEALTH_PORT=8397
pnpm dev:runtime
```

The runtime registers global slash commands (`/status`, `/clear-context`, `/usage`) automatically on startup and connects to the Discord Gateway on login — no manual registration or connect step.

## Validation Workflow

`mise run check` is the entry point for the project's main validation.
It runs the same checks locally that CI runs (`ci.yml` `check` job: `prek run --all-files` → `wrangler types` → lint → test) — do not maintain separate logic.

## Deployment

Production deploys run in CI (`deploy.yml`) after `ci.yml` passes on `main`. Order matters:

1. **D1 remote migration first** — `pnpm --filter @xenoblade/platform-worker db:migrate` (`wrangler d1 migrations apply xenoblade --remote`). Never deploy Worker code that expects schema the remote D1 does not have.
2. **Worker secrets** (once, via `wrangler secret put`): `INTERNAL_API_TOKEN`, `OPENROUTER_API_KEY`; optional: `BRAVE_SEARCH_API_KEY`, `BRAVE_ANSWER_API_KEY`, `GITHUB_MCP_TOKEN`, `ARTIFICIAL_ANALYSIS_API_KEY`. Discord credentials do **not** belong on the Worker.
3. **Worker deploy** — CI runs `wrangler deploy` with `CLOUDFLARE_API_TOKEN`, then verifies `GET /internal/v1/health` returns `status: "ok"`.
4. **Runtime deploy** — CI builds the `linux/arm64` image, pushes it to the self-hosted registry, then SSHes to the host: `docker compose pull && down && up -d` (SIGTERM closes the Gateway socket gracefully first — Discord allows only one Gateway session per token), followed by a `/health` poll on `:8397`.
5. **Host `.env`** (runtime container): `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, `WORKER_URL`, `INTERNAL_API_TOKEN`.
6. **Slash commands & gateway** — both automatic at runtime startup; nothing to register manually.

Local deploy from a dev machine: `pnpm deploy` (= `scripts/deploy.sh [all|gateway|worker]`), configured via `.env.deploy` (see `.env.deploy.example`).

## Known Constraints & Justified Divergences

- **Vercel AI SDK without Next.js** — the project uses `ai` + `@openrouter/ai-sdk-provider` server-side only. Justified: the SDK's tool-calling loop and provider abstraction are heavily exercised (model chains with provider fallbacks, `generateText` tool loops, MCP integration); no part of Next.js is needed or wanted on a Worker. This is the recorded justification per the guideline's scope note for the SDK.
- **Raw fetch-handler Worker, no framework** — pre-existing working service; adding a framework is a decision change, not a refactor (see ARCHITECTURE.md).
- **`compatibility_date` is bounded** by the workderd cap of the pinned wrangler/miniflare (currently `2026-08-12`, accepted by `wrangler 4.119.0`); bump it deliberately alongside lockfile upgrades.
- **Single Gateway session per bot token** — never run two runtime instances against the same token; deployments sequence stop-before-start for this reason.
- **`packages/db` is dead weight** — left over from the pre-split worker; nothing imports it. Do not add new code there.
