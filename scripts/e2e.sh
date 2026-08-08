#!/usr/bin/env bash
# Xenoblade gateway connect smoke check.
# Run after deploying the Worker and setting GATEWAY_CONTROL_TOKEN /
# GATEWAY_STATUS_TOKEN (Checkpoints A & D).
#
# Required env:
#   BOT_URL                 workers.dev URL (or custom domain), no trailing slash
#   GATEWAY_CONTROL_TOKEN   authorizes POST /gateway/connect
#   GATEWAY_STATUS_TOKEN    authorizes GET /gateway/status
#
# This script only gates on connection state. A real MESSAGE_CREATE canary must
# be sent from Discord by a human — it cannot be substituted by a status field.
set -euo pipefail

: "${BOT_URL:?BOT_URL is required}"
: "${GATEWAY_CONTROL_TOKEN:?GATEWAY_CONTROL_TOKEN is required}"
: "${GATEWAY_STATUS_TOKEN:?GATEWAY_STATUS_TOKEN is required}"

echo "Connecting gateway..."
curl -fsS -X POST \
  -H "Authorization: Bearer ${GATEWAY_CONTROL_TOKEN}" \
  "${BOT_URL}/gateway/connect" >/dev/null

echo "Polling /gateway/status until connected..."
deadline=$(( $(date +%s) + 60 ))
while [ "$(date +%s)" -lt "${deadline}" ]; do
  body="$(curl -fsS \
    -H "x-gateway-status-token: ${GATEWAY_STATUS_TOKEN}" \
    "${BOT_URL}/gateway/status" 2>/dev/null)" || {
    sleep 2
    continue
  }
  ready="$(printf '%s' "${body}" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(s);
        process.stdout.write(j.status === "connected" && j.sessionId ? "1" : "");
      } catch {
        /* keep polling */
      }
    });
  ')"
  if [ "${ready}" = "1" ]; then
    echo "Gateway connected (status=connected, sessionId present)"
    exit 0
  fi
  sleep 2
done

echo "Gateway did not reach connected state within 60s" >&2
exit 1
