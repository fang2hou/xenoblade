#!/usr/bin/env bash
#
# Deploy Xenoblade to self-hosted host + Cloudflare.
#
# Usage:
#   ./scripts/deploy.sh             # deploy everything (default)
#   ./scripts/deploy.sh gateway     # deploy Discord Gateway only
#   ./scripts/deploy.sh worker      # deploy Platform Worker only
#   ./scripts/deploy.sh all         # deploy everything
#
# Configuration:
#   Copy .env.deploy.example to .env.deploy and fill in values.
#   Or export the variables directly.
#
set -euo pipefail

set -o allexport
source .env.deploy 2>/dev/null || true
set +o allexport

TARGET="${1:-all}"

# Required variables
: "${GATEWAY_HOST:?Set GATEWAY_HOST in .env.deploy}"
: "${GATEWAY_USER:?Set GATEWAY_USER in .env.deploy}"
: "${DOCKER_REGISTRY_URL:?Set DOCKER_REGISTRY_URL in .env.deploy}"

# Optional defaults
GATEWAY_SSH_PORT="${GATEWAY_SSH_PORT:-22}"
GATEWAY_DEPLOY_PATH="${GATEWAY_DEPLOY_PATH:-/opt/xenoblade}"
IMAGE_NAME="${IMAGE_NAME:-xenoblade/discord-runtime}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
HEALTH_CHECK_URL="${HEALTH_CHECK_URL:-http://localhost:8397/health}"
HEALTH_CHECK_RETRIES="${HEALTH_CHECK_RETRIES:-15}"
HEALTH_CHECK_INTERVAL="${HEALTH_CHECK_INTERVAL:-2}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

log() { echo "==> $*" >&2; }
err() { echo "ERROR: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Registry login (if credentials are provided)
# ---------------------------------------------------------------------------
registry_login() {
  if [[ -n "${DOCKER_REGISTRY_USER:-}" && -n "${DOCKER_REGISTRY_PASS:-}" ]]; then
    log "Logging in to registry: ${DOCKER_REGISTRY_URL}"
    echo "${DOCKER_REGISTRY_PASS}" | docker login "${DOCKER_REGISTRY_URL}" \
      -u "${DOCKER_REGISTRY_USER}" --password-stdin
  fi
}

# ---------------------------------------------------------------------------
# Discord Runtime (self-hosted host)
# ---------------------------------------------------------------------------
deploy_gateway() {
  registry_login

  log "Building linux/arm64 image: ${DOCKER_REGISTRY_URL}/${IMAGE_NAME}:${IMAGE_TAG}"

  cd "$PROJECT_ROOT"

  # Bundle discord-runtime with esbuild before Docker build.
  log "Bundling discord-runtime..."
  pnpm --filter @xenoblade/discord-runtime build

  # Build and push Docker image (pre-built dist/ already in context).
  # Requires: docker buildx, qemu-user-static (for x86 hosts).
  docker buildx build \
    --platform linux/arm64 \
    --tag "${DOCKER_REGISTRY_URL}/${IMAGE_NAME}:${IMAGE_TAG}" \
    --push \
    apps/discord-runtime/

  log "Deploying to ${GATEWAY_USER}@${GATEWAY_HOST}:${GATEWAY_DEPLOY_PATH}"

  # Pull new image and restart.
  # docker compose down sends SIGTERM; the container's handler closes the
  # Discord Gateway gracefully before docker compose up starts the new one.
  ssh -p "$GATEWAY_SSH_PORT" "${GATEWAY_USER}@${GATEWAY_HOST}" \
    "cd '${GATEWAY_DEPLOY_PATH}' \
     && docker compose pull \
     && docker compose down \
     && docker compose up -d"

  log "Waiting for health check..."
  local i
  for i in $(seq 1 "$HEALTH_CHECK_RETRIES"); do
    if ssh -p "$GATEWAY_SSH_PORT" "${GATEWAY_USER}@${GATEWAY_HOST}" \
         "curl -sf '${HEALTH_CHECK_URL}'" >/dev/null 2>&1; then
      log "Runtime is healthy."
      return 0
    fi
    sleep "$HEALTH_CHECK_INTERVAL"
  done

  err "Runtime failed health check after ${HEALTH_CHECK_RETRIES} attempts."
}

# ---------------------------------------------------------------------------
# Platform Worker (Cloudflare)
# ---------------------------------------------------------------------------
deploy_worker() {
  log "Deploying Platform Worker via Wrangler"

  cd "$PROJECT_ROOT/apps/platform-worker"
  pnpm exec wrangler deploy
  cd "$PROJECT_ROOT"

  log "Worker deployed."
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
case "$TARGET" in
  gateway) deploy_gateway ;;
  worker)  deploy_worker ;;
  all)
    deploy_gateway
    deploy_worker
    ;;
  *)
    err "Usage: $0 [all|gateway|worker]"
    ;;
esac

log "Done."
