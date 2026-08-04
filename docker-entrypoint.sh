#!/bin/sh
# Container entrypoint: first-time setup, container-only config, then the gateway.
# docker-configure.mjs exits non-zero if it cannot resolve a bind address; `set -e` turns
# that into a stopped container rather than an unreachable gateway.
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

# Prepare this instance, then become the gateway. Inside the function, not at the top of
# the file: `docker compose run --rm jinn jinn status` shares the live service's volumes,
# and these steps rewrite state the running gateway owns (gateway.json, gateway.pid,
# .claude.json).
start_gateway() {
  if [ ! -f "$JINN_CONFIG" ]; then
    # `jinn setup` prompts only on a TTY, so under Docker it writes defaults.
    # Re-running is safe, but gating on config.yaml keeps boot logs quiet.
    echo "jinn-entrypoint: no config at $JINN_CONFIG, running first-time setup"
    jinn setup
  fi

  node /opt/jinn/scripts/docker-configure.mjs

  # Exported rather than written into config.yaml: "bind every interface" is true of this
  # container, not of the home directory on a volume that outlives it. Reaches the
  # gateway's process tree, PTY children included, but not a later `docker exec`.
  if [ -s "$JINN_HOME/container-bind-host" ]; then
    JINN_HOST=$(cat "$JINN_HOME/container-bind-host")
    export JINN_HOST
  fi

  echo "jinn-entrypoint: starting gateway"
  # Foreground, not --daemon: the daemon detaches and the container would exit.
  # exec so the gateway receives SIGTERM directly on `docker stop`.
  exec jinn start "$@"
}

# A command passed to `docker run` / `docker compose run` must REPLACE the gateway,
# not be appended to it: `jinn start jinn pair` would boot a second gateway against
# the same volume, rewriting gateway.json under the live one. A leading flag is
# still meant for the gateway, so `docker run … --take-port` keeps working.
case "${1:-}" in
  "") start_gateway ;;
  -*)
    # A whitelist, because `jinn start` has three options and only --take-port is safe
    # in a container — and a blacklist defaults a future option to being forwarded.
    # Patterns cover commander's attached-value form (`-p8080`), which a bare `-p` missed.
    for arg in "$@"; do
      case "$arg" in
        --take-port) ;;
        -i*|--instance|--instance=*)
          # Program-level (bin/jinn.ts), and JINN_HOME above already came from
          # JINN_INSTANCE — so this would boot on a home the entrypoint never prepared.
          echo "jinn-entrypoint: -i/--instance cannot be forwarded to \`jinn start\` — it is a program-level flag that must precede the subcommand. Select the instance with -e JINN_INSTANCE=<name> (or -e JINN_HOME=<path>) so setup and the gateway agree." >&2
          exit 64
          ;;
        -p*|--port|--port=*)
          # Moves the gateway but not the published mapping: a refused connection under
          # a boot log that reads "listening on 0.0.0.0:<port>".
          echo "jinn-entrypoint: -p/--port cannot be forwarded to \`jinn start\` — it would move the gateway without moving the published port mapping, leaving the dashboard unreachable. Set the port with -e JINN_PORT=<port>, which the compose mapping and every \`jinn\` subcommand in the container read." >&2
          exit 64
          ;;
        --daemon)
          # Detaches, so PID 1 returns and the container stops — a restart loop whose
          # log says "Gateway started in background."
          echo "jinn-entrypoint: --daemon cannot be forwarded to \`jinn start\` — the gateway must stay in the foreground or the container exits as soon as it detaches. It already runs in the background as a container (\`docker compose up -d\`)." >&2
          exit 64
          ;;
        *)
          echo "jinn-entrypoint: refusing to forward \`$arg\` to \`jinn start\` — only --take-port is safe to pass to the containerised gateway. Pass a full command instead (\`docker compose run --rm jinn jinn <command>\`)." >&2
          exit 64
          ;;
      esac
    done
    start_gateway "$@"
    ;;
  *) exec "$@" ;;
esac
