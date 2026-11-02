#!/bin/bash
# Runs the secret-santa workflow through a short-lived swamp serve on its own
# port, then tears it down. ~/.bashrc points SWAMP_SERVE_URL at the
# apt-inventory daemon on 9090, so this repo never relies on that variable.
#
#   ./run-via-serve.sh                                   # dry run, everyone
#   ./run-via-serve.sh --input testRecipient=Aaron --input dryRun=false
#   ./run-via-serve.sh --input dryRun=false              # the real thing
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=9098
SERVER="ws://127.0.0.1:${PORT}"

cd "$REPO_DIR"
unset SWAMP_SERVE_URL
swamp serve --repo-dir "$REPO_DIR" --port "$PORT" --host 127.0.0.1 --no-schedule --no-telemetry \
  >/tmp/secret-santa-serve.log 2>&1 &
SERVE_PID=$!
trap 'kill "$SERVE_PID" 2>/dev/null || true' EXIT

# Wait for the server to actually be listening rather than a fixed sleep.
for _ in $(seq 1 20); do
  if curl -s -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

swamp workflow run secret-santa --server "$SERVER" "$@"
