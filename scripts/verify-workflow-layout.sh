#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ORIGINAL_HOME="$HOME"
HELPER="${JINN_SANDBOX_HELPER:-$ORIGINAL_HOME/.jinn/skills/jinn-sandbox/scripts/jinn-sandbox.sh}"
PORT="${JINN_VERIFY_PORT:-7800}"
RUN_AUTHORS=0

if [[ "${1:-}" == "--with-authors" ]]; then RUN_AUTHORS=1; shift; fi
if [[ $# -ne 0 ]]; then echo "Usage: $0 [--with-authors]" >&2; exit 2; fi
if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 7800 )); then echo "JINN_VERIFY_PORT must be an integer at or above 7800" >&2; exit 2; fi
if [[ ! -x "$HELPER" ]]; then echo "Sandbox helper not found: $HELPER" >&2; exit 2; fi
if [[ "$RUN_AUTHORS" -eq 1 && "${JINN_IMPLEMENTATION_GREEN:-}" != "1" ]]; then
  echo "Author probes require JINN_IMPLEMENTATION_GREEN=1 after focused implementation gates pass" >&2
  exit 2
fi
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then echo "Candidate port $PORT is already in use" >&2; exit 2; fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-workflow-layout"
VERIFY_ROOT="$(mktemp -d /tmp/jinn-workflow-layout.XXXXXX)"
HOST_HOME="$VERIFY_ROOT/host"
CODEX_BASE="$VERIFY_ROOT/codex-base"
SANDBOX_HOME="$HOST_HOME/.jinn-workflow-layout-verification"
ARTIFACTS="$SANDBOX_HOME/sandbox-artifacts/$RUN_ID"
BASE_URL="http://127.0.0.1:$PORT"
SOURCE_AUTH="${JINN_VERIFY_CODEX_AUTH:-${CODEX_HOME:-$ORIGINAL_HOME/.codex}/auth.json}"
STARTED=0

cleanup() {
  if [[ "$STARTED" -eq 1 ]]; then
    env HOME="$HOST_HOME" CODEX_HOME="$CODEX_BASE" JINN_REPO="$REPO" \
      "$HELPER" stop workflow-layout-verification >/dev/null 2>&1 || true
  fi
  rm -rf "$CODEX_BASE"
  find "$SANDBOX_HOME/tmp/codex-homes" \( -name auth.json -o -name config.toml \) -delete 2>/dev/null || true
  rm -f "$SANDBOX_HOME/gateway.json" "$SANDBOX_HOME/secrets/mcp-session-capability.key"
  find "$VERIFY_ROOT" -name auth.json -delete 2>/dev/null || true
  echo "Scrubbed retained Codex auth links/overlay config, gateway token, and MCP capability key."
  echo "Retained verification root: $VERIFY_ROOT"
  echo "Retained sandbox home: $SANDBOX_HOME"
  echo "Artifacts: $ARTIFACTS"
}
trap cleanup EXIT

mkdir -p "$HOST_HOME" "$CODEX_BASE"
node "$REPO/e2e/workflow-layout/bootstrap-sandbox.mjs" \
  --phase codex-home --target "$CODEX_BASE" --source-auth "$SOURCE_AUTH"

env HOME="$HOST_HOME" CODEX_HOME="$CODEX_BASE" JINN_REPO="$REPO" \
  "$HELPER" create workflow-layout-verification --port "$PORT" --build --seed

mkdir -p "$ARTIFACTS"
node "$REPO/e2e/workflow-layout/bootstrap-sandbox.mjs" \
  --phase jinn-home --home "$SANDBOX_HOME" --port "$PORT" --artifacts "$ARTIFACTS"

STARTED=1
env HOME="$HOST_HOME" CODEX_HOME="$CODEX_BASE" JINN_REPO="$REPO" \
  "$HELPER" start workflow-layout-verification

export JINN_VERIFY_HOME="$SANDBOX_HOME"
export JINN_VERIFY_BASE_URL="$BASE_URL"
export JINN_VERIFY_ARTIFACTS="$ARTIFACTS"

node "$REPO/e2e/workflow-layout/seed-fixtures.mjs"
if [[ "$RUN_AUTHORS" -eq 1 ]]; then
  export JINN_VERIFY_RUN_AUTHORS=1
  HOME="$HOST_HOME" CODEX_HOME="$CODEX_BASE" \
    node "$REPO/e2e/workflow-layout/author-canonical.mjs"
fi

cd "$REPO"
node --test e2e/workflow-layout/*.test.mjs
pnpm exec playwright test --config playwright.workflow-layout.config.ts
