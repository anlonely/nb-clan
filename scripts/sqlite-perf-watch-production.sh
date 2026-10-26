#!/usr/bin/env sh
set -eu

HOST="${1:?Usage: sqlite-perf-watch-production.sh user@host}"
SAMPLES="${SAMPLES:-40}"
INTERVAL="${INTERVAL:-15}"
APP_DIR="${APP_DIR:?Set APP_DIR to the explicit absolute deployment directory}"
CONTAINER="${CONTAINER:-nb-clan-member-system}"

case "$HOST" in -*|*[!a-zA-Z0-9_.@:-]*) echo 'Invalid host' >&2; exit 2;; esac
case "$APP_DIR" in /*) ;; *) echo 'APP_DIR must be absolute' >&2; exit 2;; esac
case "$APP_DIR" in *[!a-zA-Z0-9_./-]*) echo 'Invalid APP_DIR' >&2; exit 2;; esac
case "$CONTAINER" in *[!a-zA-Z0-9_.-]*) echo 'Invalid CONTAINER' >&2; exit 2;; esac
case "$SAMPLES:$INTERVAL" in *[!0-9:]*) echo 'SAMPLES and INTERVAL must be numeric' >&2; exit 2;; esac

ssh "$HOST" "SAMPLES='$SAMPLES' INTERVAL='$INTERVAL' APP_DIR='$APP_DIR' CONTAINER='$CONTAINER' sh -s" <<'REMOTE'
set -eu

sample=1
while [ "$sample" -le "$SAMPLES" ]; do
  echo "===== sample $sample/$SAMPLES $(date '+%F %T %Z') ====="
  uptime || true
  free -h || true
  df -h / || true
  if command -v iostat >/dev/null 2>&1; then
    iostat -xz 1 1 || true
  fi
  docker stats --no-stream "$CONTAINER" || true
  curl -fsS http://127.0.0.1:8787/api/readyz || true
  echo
  if [ -d "$APP_DIR/data" ]; then
    ls -lh "$APP_DIR"/data/nb-clan.sqlite* "$APP_DIR"/data/store.json 2>/dev/null || true
  fi
  sample=$((sample + 1))
  if [ "$sample" -le "$SAMPLES" ]; then
    sleep "$INTERVAL"
  fi
done
REMOTE

