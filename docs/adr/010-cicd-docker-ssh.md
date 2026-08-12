# ADR-010: CI/CD with Docker Registry and SSH

- **Status**: Accepted
- **Date**: 2026-08-12

## Context

The hybrid deployment topology (see [ADR-002](002-hybrid-deployment.md)) requires deploying two artifacts:

1. **Discord Runtime** — a Docker container image that must reach the self-hosted host.
2. **Platform Worker** — a Cloudflare Worker deployed via Wrangler.

The self-hosted host runs its own Docker Registry. This eliminates the need for a third-party registry (Docker Hub, GHCR, ECR) and keeps image distribution on-network: the host pushes to and pulls from its own registry with no external dependency.

Both local development machines and GitHub Actions CI need to deploy. The deployment mechanism must be identical in both contexts to avoid environment-specific failures.

A critical operational constraint: Discord allows only **one active Gateway session per bot token**. Two simultaneous Gateway connections with the same token will invalidate each other. Deployment must handle this — the old process must stop before the new one starts.

## Decision

### Docker image distribution

The self-hosted host runs a Docker Registry. The deployment flow:

1. Build `linux/arm64` image (both the development machine and CI runner are ARM64; the host is ARM64).
2. Push to the host's registry.
3. SSH into the host, `docker compose pull` (pulls from localhost registry — fast, no external network), `docker compose up -d`.

### Single deploy script

A single `scripts/deploy.sh` handles both local and CI deployment. It accepts a target argument (`all`, `worker`, `gateway`) and reads configuration from environment variables or `.env.deploy`.

### GitHub Actions workflow

CI triggers on push to `main`. The workflow:
1. Run tests (typecheck, lint, unit, E2E with mock LLM).
2. Build and push Docker image to the registry (using QEMU for ARM64 cross-compilation if the runner is x86).
3. Deploy Worker via `wrangler deploy`.
4. SSH into the host to pull and restart the container.

SSH authentication uses a private key stored as a GitHub secret. Registry authentication uses credentials stored as GitHub secrets.

### Gateway session management

Deployment order during cutover:

1. The deploy script sends `SIGTERM` to the running container (via `docker compose down`).
2. The container's `SIGTERM` handler closes the Discord Gateway WebSocket gracefully.
3. After confirming the old process has stopped, `docker compose up -d` starts the new container.
4. The new container connects to Discord Gateway with the same bot token.

This sequencing prevents dual-session invalidation.

### Health check

After deployment, the script polls the Runtime's `/health` endpoint (over SSH tunnel or direct localhost check) to confirm the new container is ready and the Gateway connection is established.

## Consequences

**Positive:**
- Identical deployment path for local and CI — no environment drift.
- Self-hosted registry keeps images on-network; pulls are fast and dependency-free.
- SSH-based deployment requires no agent, daemon, or orchestration platform on the host.
- Single script with clear targets (`worker`, `gateway`, `all`) is easy to operate.
- Graceful Gateway handoff prevents session invalidation.

**Negative:**
- SSH key management: the private key must be securely stored in GitHub secrets and rotated if compromised.
- QEMU-based ARM64 cross-compilation on x86 CI runners is slower than native builds. (If GitHub Actions ARM64 runners are available, they should be preferred.)
- No automatic rollback: if the new container fails health checks, manual intervention is required to restart the previous image.

**Neutral:**
- `.env.deploy` (gitignored) holds host address, SSH user, registry URL, and image name. A `.env.deploy.example` template is committed.
- The docker-compose file lives in the repository (`deploy/docker-compose.yml`) and is used on the host via a git checkout or direct copy.
