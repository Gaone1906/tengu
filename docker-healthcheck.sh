#!/bin/sh
# Docker HEALTHCHECK: is the gateway actually serving, or merely alive? A turn wedged on
# a consent dialog no PTY can answer keeps the process running, so nothing exit-based
# notices. /api/status is auth-exempt, so this needs no token.
#
# NOTE: `restart:` policies react to exits, not health — an unhealthy container is
# reported, not restarted.
set -eu

# Mirrors resolveJinnHome() in shared/home.ts, absolutization included: a probe that
# disagrees about the home finds no gateway.json and reports a healthy container sick.
JINN_HOME="${JINN_HOME:-$HOME/.${JINN_INSTANCE:-jinn}}"
case "$JINN_HOME" in
  /*) ;;
  *) JINN_HOME="$PWD/$JINN_HOME" ;;
esac

# The URL the gateway recorded for itself at boot — writeGatewayInfo() derives it from
# the address it actually bound, so wildcard and IPv6 handling lives there rather than
# in a second implementation here. gateway.json is written with JSON.stringify(…, 2), so
# the key sits alone on its line; the fallback covers the window before it exists.
url=""
if [ -f "$JINN_HOME/gateway.json" ]; then
  url=$(sed -n 's/^[[:space:]]*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$JINN_HOME/gateway.json" | head -n 1)
fi
[ -n "$url" ] || url="http://127.0.0.1:${JINN_PORT:-7777}"

exec curl -fsS -m 5 -o /dev/null "$url/api/status"
