# Development

How development is performed in this repository, for both humans and AI agents.
User-facing setup lives in the README; this document is for people changing the code.

## Setup

All tools are managed by mise.

```bash
mise install
```

| Tool       | Purpose                                  | Managed via                 |
| ---------- | ---------------------------------------- | --------------------------- |
| node       | Runtime (24)                             | `mise.toml`                 |
| pnpm       | Package manager (11.21.0)                | `mise.toml`, `package.json` |
| prek       | Git hooks (hygiene, checks, commit lint) | `mise.toml`                 |
| cocogitto  | Conventional Commits validation          | `mise.toml`                 |
| oxlint     | Linter                                   | `package.json`              |
| oxfmt      | Formatter (code **and** markdown)        | `package.json`              |
| typescript | Type checking                            | `package.json`              |
| vitest     | Test runner                              | `package.json`              |
| wrangler   | Workers dev/deploy, D1, types            | `apps/platform-worker`      |

Do not substitute tools without explicit approval (see the guideline repository's toolchain standards).

**First Worker run** — secrets and local D1:

```bash
cp .dev.vars.example apps/platform-worker/.dev.vars   # INTERNAL_API_TOKEN, OPENROUTER_API_KEY (+ optional Brave keys)
pnpm --filter @xenoblade/platform-worker db:migrate:local
pnpm --filter @xenoblade/platform-worker types
```

**First Runtime run** — needs a real Discord bot:

```bash
export DISCORD_BOT_TOKEN=... DISCORD_APPLICATION_ID=... \
       WORKER_URL=http://localhost:8787 INTERNAL_API_TOKEN=...
# optional: MENTION_ROLE_IDS=<id,id> HEALTH_PORT=8397
pnpm dev:runtime
```

The runtime registers global slash commands (`/status`, `/clear-context`, `/usage`) automatically on startup and connects to the Discord Gateway on login.

## Commands

```bash
mise run dev                # start the dev server (wrangler dev, :8787)
mise run check              # full validation — what CI runs
mise run test               # test suite (runs check first)
mise run test -- {{filter}} # run a single test file or case, e.g. mise run test -- staged-status
```

`mise run` lists every task. Notes: `mise run format` checks formatting (write with `pnpm format`); `mise run build` bundles discord-runtime via `pnpm -r build`; the runtime dev server is `pnpm dev:runtime` (no mise task).

## Workflow

1. Branch from `main`
2. Implement the smallest coherent change
3. `mise run check` must pass (the pre-commit hook enforces it)
4. Commit with Conventional Commits (validated by Cocogitto via the prek `commit-msg` hook)
5. Open a PR following [CONTRIBUTING.md](./CONTRIBUTING.md); squash-merge keeps history linear

## Layout

- `apps/platform-worker/` — Cloudflare Worker: routes, generation pipeline, tools, D1 access
- `apps/discord-runtime/` — self-hosted discord.js gateway: triggers, staged status, reply controls, DM control plane
- `packages/contracts/` — wire types shared by both apps
- `packages/ai/` — model chains, OpenRouter provider, system prompt composition
- `packages/db/` — legacy D1 helpers; unreferenced, do not add code here
- `docs/adr/` — architecture decision records
- `scripts/`, `deploy/` — local deploy tooling; docker-compose for the gateway host

## Coding Standards

Follow the guideline repository's coding standards. Project-specific rules:

- TypeScript strict, ESM only, `verbatimModuleSyntax`, `noUncheckedIndexedAccess` — guard every indexed access.
- Code, comments, and identifiers in English, always; only intentional UI literals may be Chinese (see [AGENTS.md](./AGENTS.md)).
- The Worker is a raw fetch handler on purpose — do not introduce a framework (see [ARCHITECTURE.md](./ARCHITECTURE.md)).
- Structured JSON logging only; early returns; no hidden second behavior behind boolean flags.
- All outbound fetches of user-supplied URLs go through the SSRF gate (`isUrlSafe`).
- Keep configuration files comment-free; rationale belongs in the PR or docs.
- Server-side Vercel AI SDK without Next.js is a recorded, justified divergence (see AGENTS.md overrides).

## Testing

- Unit tests: `mise run test` — one vitest run covers the whole workspace (platform-worker route tests against a local D1 harness, discord-runtime behavior tests, `packages/ai` chain tests).
- Single test: `mise run test -- {{filter}}` (file or case name).
- No E2E suite; runtime liveness is covered by the `/health` endpoint and CI deploy checks.
- Prioritize meaningful behavior over coverage numbers.

## Debugging

- Worker logs: `wrangler dev` streams them; every event is one JSON line (`event`, ids, timings, errors — content previews only on the guild path, never DM).
- Runtime health: `curl localhost:8397/health` (bound to localhost only).
- Worker health: `curl -H "Authorization: Bearer $INTERNAL_API_TOKEN" $WORKER_URL/internal/v1/health`.
- Common failure: missing/blank env vars fail fast at startup on both tiers (check `.dev.vars` placement — wrangler reads it from `apps/platform-worker/`).
- Generated Worker types live in `worker-configuration.d.ts` — regenerate with `wrangler types`; never edit by hand.

## Validation

`mise run check` is the entry point for the project's main validation.
It runs the same checks locally that CI runs (`ci.yml`: `mise run check` + `mise run test`, plus commit-message validation via cocogitto) — do not maintain separate logic.

## Deployment

Production deploys run in CI (`deploy.yml`) after `ci.yml` passes on `main`. Order matters:

1. **D1 remote migration first** — CI applies `wrangler d1 migrations apply xenoblade --remote` before the Worker deploy; locally, run `pnpm --filter @xenoblade/platform-worker db:migrate` first.
2. **Worker secrets** (once, via `wrangler secret put`): `INTERNAL_API_TOKEN`, `OPENROUTER_API_KEY`; optional: `BRAVE_SEARCH_API_KEY`, `BRAVE_ANSWER_API_KEY`, `GITHUB_MCP_TOKEN`, `ARTIFICIAL_ANALYSIS_API_KEY`. Discord credentials do **not** belong on the Worker.
3. **Worker deploy** — `wrangler deploy` with `CLOUDFLARE_API_TOKEN`, then health verification (`/internal/v1/health` must return `status: "ok"`).
4. **Runtime deploy** — build `linux/arm64` image, push to the self-hosted registry, SSH: `docker compose pull && down && up -d` (SIGTERM closes the Gateway socket gracefully first — Discord allows only one Gateway session per token), then `/health` poll on `:8397`.
5. **Host `.env`** (runtime container): `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, `WORKER_URL`, `INTERNAL_API_TOKEN`.
6. **Slash commands & gateway** — automatic at runtime startup.

Local deploy from a dev machine: `mise run deploy` (= `scripts/deploy.sh [all|gateway|worker]`), configured via `.env.deploy` (see `.env.deploy.example`). `compatibility_date` is bounded by the workderd cap of the pinned wrangler (currently `2026-08-12`) — bump it deliberately alongside lockfile upgrades.
