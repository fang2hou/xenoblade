# ADR-010: CI/CD with Docker Registry and SSH

- **Status**: Accepted
- **Date**: 2026-08-12 (updated 2026-08-16 to record the split-CI workflow reality; amended 2026-08-17 — see [Amendment](#amendment-2026-08-17))

## Context

The hybrid topology (see [ADR-002](002-hybrid-deployment.md)) produces two artifacts: the **Discord Runtime** Docker image that must reach a self-hosted ARM64 host, and the **Platform Worker** deployed to Cloudflare. The host runs its own Docker Registry — no third-party registry (Docker Hub, GHCR, ECR), image distribution stays on-network.

Local dev machines and CI must deploy through an identical mechanism to avoid environment drift.

A hard operational constraint: Discord allows **one active Gateway session per bot token** — the old process must stop before the new one starts, or the sessions invalidate each other.

## Decision

### Split CI workflows

- **`ci.yml` (check)** runs on every pull request and push to `main`: `prek run --all-files` (hook parity: hygiene, private-key detection), `wrangler types`, `pnpm lint`, `pnpm test`. No deploy permissions.
- **`deploy.yml` (deploy)** runs after check on `main` pushes (or manual dispatch with a `worker`/`runtime`/`all` target):
  - **deploy-worker**: `wrangler deploy` with `CLOUDFLARE_API_TOKEN`, then health verification — `GET /internal/v1/health` must return `status: "ok"`.
  - **deploy-runtime**: bundle with esbuild, build the `linux/arm64` image (QEMU on x86 runners), push to the self-hosted registry (`latest` + commit SHA tags, registry cache), then SSH to the host: `docker compose pull && down && up -d`, followed by a `/health` poll on `:8397`.

### Gateway session handoff

`docker compose down` sends SIGTERM; the container's handler closes the Gateway WebSocket gracefully; only after the old process stops does `up -d` start the new container, which reconnects with the same token. No dual-session window.

### Local parity

`scripts/deploy.sh [all|gateway|worker]` performs the same steps from a dev machine, configured via `.env.deploy` (see `.env.deploy.example`); `deploy/docker-compose.yml` is version-controlled here and lives on the host at `$GATEWAY_DEPLOY_PATH`.

## Alternatives Considered

### Third-party container registry

- Pros: managed availability, GitHub-native auth.
- Cons: external dependency and egress for every host pull; credentials spread further.
- Why not chosen: the host already runs a registry; keeping images on-network is simpler and faster.

### Agent/daemon-based deploys on the host

- Pros: push deploys without SSH; richer orchestration.
- Cons: an inbound-exposed agent contradicts the closed-inbound topology (ADR-002).
- Why not chosen: SSH needs no agent and no open ports beyond SSH itself.

### Single monolithic workflow (check + deploy in one file)

- Pros: one file, one dependency graph.
- Cons: check reruns coupled to deploy triggers; PR-only checks and main-only deploys fight over one `on:` block.
- Why not chosen: split files give each concern its own trigger and review surface.

## Consequences

**Positive:** identical deployment path locally and in CI; on-network image pulls; no agent on the host; graceful Gateway handoff prevents session invalidation; check runs on PRs with zero deploy permissions.

**Negative:** SSH key and registry credentials live in GitHub secrets and need rotation discipline; QEMU cross-builds are slower than native ARM64; no automatic rollback — a failed health check needs manual intervention.

**Neutral:** deploy targets are selectable (`worker`, `runtime`, `all`) for partial rollouts; the runtime's health endpoint binds to localhost only.

## Amendment (2026-08-17)

The runtime bundle step now uses rolldown instead of esbuild (branch `feat/rolldown-bundler`). Same contract otherwise: one self-contained ESM file, node platform, sourcemap, `createRequire` banner. The pipeline shape (local `scripts/deploy.sh` and `deploy-runtime` job both call the package build script) is unchanged.

## Review Triggers

- GitHub Actions offers native ARM64 runners (drop QEMU cross-compilation).
- The registry host migrates or the second host appears (revisit distribution + secrets).
- Failed deploys become frequent enough to justify automated rollback.
