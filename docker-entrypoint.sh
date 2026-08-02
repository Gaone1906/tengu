#!/bin/sh
# Container entrypoint: first-time setup, container-only config, then the daemon.
# docker-configure.mjs exits non-zero if it cannot determine a bind address, and
# `set -e` turns that into a stopped container rather than a gateway listening
# where the published port cannot reach it.
set -eu

# Mirrors resolveJinnHome() in packages/jinn/src/shared/home.ts. Resolved to an
# absolute path so the shell and the two Node consumers agree.
JINN_HOME="${JINN_HOME:-$HOME/.${JINN_INSTANCE:-jinn}}"
case "$JINN_HOME" in
  /*) ;;
  *) JINN_HOME="$PWD/$JINN_HOME" ;;
esac
export JINN_HOME
JINN_CONFIG="$JINN_HOME/config.yaml"

# `jinn setup` prompts only on a TTY, so under Docker it writes defaults. Re-running
# is safe, but gating on config.yaml keeps boot logs quiet.
if [ ! -f "$JINN_CONFIG" ]; then
  echo "jinn-entrypoint: no config at $JINN_CONFIG, running first-time setup"
  jinn setup
fi

node /opt/jinn/scripts/docker-configure.mjs

# A command passed to `docker run` / `docker compose run` must REPLACE the gateway,
# not be appended to it: `jinn start jinn pair` would boot a second gateway against
# the same volume, rewriting gateway.json under the live one. A leading flag is still
# meant for the gateway, so `docker run … --port 9000` keeps working.
#
# Foreground, not --daemon: the daemon detaches and the container would exit.
# exec so the gateway receives SIGTERM directly on `docker stop`.
case "${1:-}" in
  "") echo "jinn-entrypoint: starting gateway"; exec jinn start ;;
  -*) echo "jinn-entrypoint: starting gateway"; exec jinn start "$@" ;;
  *)  exec "$@" ;;
esac
