#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ORIGINAL_HOME="$HOME"
HELPER="${JINN_SANDBOX_HELPER:-$ORIGINAL_HOME/.jinn/skills/jinn-sandbox/scripts/jinn-sandbox.sh}"
PORT="${JINN_VERIFY_PORT:-8060}"
TMP_BASE="${JINN_VERIFY_TMP_ROOT:-/tmp}"
MIN_FREE_BYTES="${JINN_VERIFY_MIN_FREE_BYTES:-2147483648}"
MIN_FREE_INODES="${JINN_VERIFY_MIN_FREE_INODES:-10000}"
POLICY="$REPO/e2e/workflow-layout/harness-policy.mjs"
RUN_AUTHORS=0

# Keep the helper, gateway, seed scripts, and Playwright on one Node ABI. On
# developer machines a global `node` can be newer than the Node beside pnpm,
# while the repo's native better-sqlite3 binding was built by that pnpm
# toolchain. An explicit override remains available for CI.
PNPM_BIN="$(command -v pnpm || true)"
if [[ -z "$PNPM_BIN" ]]; then echo "pnpm is required" >&2; exit 2; fi
NODE_BIN="${JINN_VERIFY_NODE_BIN:-$(dirname "$PNPM_BIN")/node}"
if [[ ! -x "$NODE_BIN" ]]; then echo "Node beside pnpm not found: $NODE_BIN" >&2; exit 2; fi
NODE_DIR="$(dirname "$NODE_BIN")"
export PATH="$NODE_DIR:$PATH"

if [[ "${1:-}" == "--with-authors" ]]; then RUN_AUTHORS=1; shift; fi
if [[ $# -ne 0 ]]; then echo "Usage: $0 [--with-authors]" >&2; exit 2; fi
if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 8060 )); then echo "JINN_VERIFY_PORT must be an integer at or above 8060" >&2; exit 2; fi
if [[ ! "$MIN_FREE_BYTES" =~ ^[0-9]+$ || ! "$MIN_FREE_INODES" =~ ^[0-9]+$ ]]; then echo "disk preflight limits must be non-negative integers" >&2; exit 2; fi
if [[ ! -x "$HELPER" ]]; then echo "Sandbox helper not found: $HELPER" >&2; exit 2; fi
if [[ "$RUN_AUTHORS" -eq 1 && "${JINN_IMPLEMENTATION_GREEN:-}" != "1" ]]; then
  echo "Author probes require JINN_IMPLEMENTATION_GREEN=1 after focused implementation gates pass" >&2
  exit 2
fi
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then echo "Candidate port $PORT is already in use" >&2; exit 2; fi

# Fail before allocating the run root when either byte or inode headroom is
# insufficient. Both thresholds are overrideable for constrained CI hosts.
node "$POLICY" preflight "$TMP_BASE" "$MIN_FREE_BYTES" "$MIN_FREE_INODES"

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-workflow-layout"
VERIFY_ROOT="$(mktemp -d "$TMP_BASE/jinn-workflow-layout.XXXXXX")"
HOST_HOME="$VERIFY_ROOT/host"
# The daemon lifecycle intentionally sanitizes inherited CODEX_HOME. Put the
# disposable auth/config at its HOME-based fallback as well, so detached child
# sessions never fall through to an unauthenticated throwaway path.
CODEX_BASE="$HOST_HOME/.codex"
SANDBOX_HOME="$HOST_HOME/.jinn-workflow-layout-verification"
ARTIFACTS="$SANDBOX_HOME/sandbox-artifacts/$RUN_ID"
BASE_URL="http://127.0.0.1:$PORT"
SOURCE_AUTH="${JINN_VERIFY_CODEX_AUTH:-${CODEX_HOME:-$ORIGINAL_HOME/.codex}/auth.json}"
STARTED=0
EXPECTED_CHECKS=111
if [[ "$RUN_AUTHORS" -eq 1 ]]; then EXPECTED_CHECKS=151; fi

# Refuse any target that is not the exact loopback candidate and dedicated
# sandbox home beneath this newly-created verification root.
if ! node "$POLICY" assert-target "$VERIFY_ROOT" "$SANDBOX_HOME" "$BASE_URL" >/dev/null; then
  echo "Refusing non-sandbox workflow-layout verification target" >&2
  exit 2
fi

cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$STARTED" -eq 1 ]]; then
    env HOME="$HOST_HOME" CODEX_HOME="$CODEX_BASE" JINN_REPO="$REPO" \
      "$HELPER" stop workflow-layout-verification >/dev/null 2>&1 || true
    for _ in {1..20}; do
      if ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then break; fi
      sleep 0.25
    done
    if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
      echo "Incomplete verification: candidate listener leak remains on port $PORT" >&2
      status=3
    fi
  fi
  if [[ -d "$ARTIFACTS" ]]; then
    if ! node "$POLICY" finalize "$ARTIFACTS" >/dev/null; then status=3; fi
    if ! node "$POLICY" require-complete "$ARTIFACTS" "$EXPECTED_CHECKS" >/dev/null; then status=3; fi
  elif [[ "$STARTED" -eq 1 ]]; then
    echo "Incomplete verification: artifact root is missing" >&2
    status=3
  fi
  local cleanup_targets=()
  for target in \
    "$CODEX_BASE" \
    "$SANDBOX_HOME/tmp" \
    "$SANDBOX_HOME/cache" \
    "$SANDBOX_HOME/gateway.json" \
    "$SANDBOX_HOME/secrets/mcp-session-capability.key"; do
    if [[ -e "$target" || -L "$target" ]]; then cleanup_targets+=("$target"); fi
  done
  if (( ${#cleanup_targets[@]} > 0 )); then
    node "$POLICY" cleanup-run "$VERIFY_ROOT" "${cleanup_targets[@]}" || status=3
  fi
  echo "Scrubbed only current-run Codex homes, sandbox caches, gateway token, and MCP capability key."
  echo "Retained verification root: $VERIFY_ROOT"
  echo "Retained sandbox home: $SANDBOX_HOME"
  echo "Artifacts: $ARTIFACTS"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

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
PLAYWRIGHT_ARGS=(--config playwright.workflow-layout.config.ts)
if [[ -n "${JINN_VERIFY_GREP:-}" ]]; then
  PLAYWRIGHT_ARGS+=(--grep "$JINN_VERIFY_GREP")
fi
pnpm exec playwright test "${PLAYWRIGHT_ARGS[@]}"
