#!/usr/bin/env bash
#
# Deploy Xenoblade to self-hosted host + Cloudflare.
#
# Usage:
#   ./scripts/deploy.sh             # deploy everything (default)
#   ./scripts/deploy.sh runtime     # deploy Discord Runtime only
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
: "${RUNTIME_HOST:?Set RUNTIME_HOST in .env.deploy}"
: "${RUNTIME_USER:?Set RUNTIME_USER in .env.deploy}"
: "${REGISTRY_URL:?Set REGISTRY_URL in .env.deploy}"

# Optional defaults
RUNTIME_SSH_PORT="${RUNTIME_SSH_PORT:-22}"
RUNTIME_DEPLOY_PATH="${RUNTIME_DEPLOY_PATH:-/opt/xenoblade}"
IMAGE_NAME="${IMAGE_NAME:-xenoblade/discord-runtime}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
HEALTH_CHECK_URL="${HEALTH_CHECK_URL:-http://localhost:3000/health}"
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
  if [[ -n "${REGISTRY_USER:-}" && -n "${REGISTRY_PASS:-}" ]]; then
    log "Logging in to registry: ${REGISTRY_URL}"
    echo "${REGISTRY_PASS}" | docker login "${REGISTRY_URL}" \
      -u "${REGISTRY_USER}" --password-stdin
  fi
}

# ---------------------------------------------------------------------------
# Discord Runtime (self-hosted host)
# ---------------------------------------------------------------------------
deploy_runtime() {
  registry_login

  log "Building linux/arm64 image: ${REGISTRY_URL}/${IMAGE_NAME}:${IMAGE_TAG}"

  cd "$PROJECT_ROOT"

  # Build and push in one step.
  # Requires: docker buildx, qemu-user-static (for x86 hosts).
  docker buildx build \
    --platform linux/arm64 \
    --tag "${REGISTRY_URL}/${IMAGE_NAME}:${IMAGE_TAG}" \
    --push \
    apps/discord-runtime/

  log "Deploying to ${RUNTIME_USER}@${RUNTIME_HOST}:${RUNTIME_DEPLOY_PATH}"

  # Pull new image and restart.
  # docker compose down sends SIGTERM; the container's handler closes the
  # Discord Gateway gracefully before docker compose up starts the new one.
  ssh -p "$RUNTIME_SSH_PORT" "${RUNTIME_USER}@${RUNTIME_HOST}" \
    "cd '${RUNTIME_DEPLOY_PATH}' \
     && docker compose pull \
     && docker compose down \
     && docker compose up -d"

  log "Waiting for health check..."
  local i
  for i in $(seq 1 "$HEALTH_CHECK_RETRIES"); do
    if ssh -p "$RUNTIME_SSH_PORT" "${RUNTIME_USER}@${RUNTIME_HOST}" \
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
  runtime) deploy_runtime ;;
  worker)  deploy_worker ;;
  all)
    deploy_runtime
    deploy_worker
    ;;
  *)
    err "Usage: $0 [all|runtime|worker]"
    ;;
esac

log "Done."
