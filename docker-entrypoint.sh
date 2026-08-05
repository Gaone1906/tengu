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
# the file: one-off containers share the live service's volumes, and these steps rewrite
# state the running gateway owns (gateway.json, gateway.pid, .claude.json).
start_gateway() {
  # Keep one inode for the lifetime of the gateway and let the host kernel arbitrate
  # every container that mounts this home. This shell retains the open fd while it
  # supervises the gateway, so the lock is released automatically when either exits.
  # Acquire before setup/docker-configure: both mutate records owned by a live gateway.
  JINN_GATEWAY_LOCK="$JINN_HOME/gateway.lock"
  exec 9>>"$JINN_GATEWAY_LOCK"
  chmod 0600 "$JINN_GATEWAY_LOCK"
  if ! flock -n 9; then
    echo "jinn-entrypoint: another gateway already holds the shared-volume lock at $JINN_GATEWAY_LOCK. Use \`docker compose exec jinn ...\` for live inspection or \`docker compose restart jinn\` to restart it." >&2
    exit 75
  fi

  # Runtime-only dispatch proof that this process descends from the entrypoint's private
  # default service command. The CLI consumes it before the handler runs; authority to
  # mutate the shared service records comes from the kernel lock above, not this marker.
  _JINN_CONTAINER_SERVICE_START=1
  export _JINN_CONTAINER_SERVICE_START

  if [ ! -f "$JINN_CONFIG" ]; then
    # `jinn setup` prompts only on a TTY, so under Docker it writes defaults.
    # Re-running is safe, but gating on config.yaml keeps boot logs quiet.
    echo "jinn-entrypoint: no config at $JINN_CONFIG, running first-time setup"
    jinn setup
  fi

  # Container-only consent: docker-configure records Claude's bypass-permissions
  # acknowledgement in the dedicated /home/node/.claude volume. Host startup does not.
  node /opt/jinn/scripts/docker-configure.mjs

  # Exported rather than written into config.yaml: "bind every interface" is true of this
  # container, not of the home directory on a volume that outlives it. Reaches the
  # gateway's process tree, PTY children included, but not a later `docker exec`.
  if [ -s "$JINN_HOME/container-bind-host" ]; then
    JINN_HOST=$(cat "$JINN_HOME/container-bind-host")
    export JINN_HOST
  fi

  echo "jinn-entrypoint: starting gateway"
  # Foreground, not --daemon: the daemon detaches and the container would exit. Keep
  # this shell alive as the sole lock owner, close its lock fd in the gateway process,
  # forward stop signals, and leave as soon as the gateway does. Closing fd 9 in the
  # child prevents a surviving session descendant from pinning the lock after a crash.
  jinn start "$@" 9>&- &
  gateway_pid=$!
  trap 'kill -TERM "$gateway_pid" 2>/dev/null || true' TERM
  trap 'kill -INT "$gateway_pid" 2>/dev/null || true' INT
  trap 'kill -HUP "$gateway_pid" 2>/dev/null || true' HUP

  set +e
  wait "$gateway_pid"
  gateway_status=$?
  while kill -0 "$gateway_pid" 2>/dev/null; do
    wait "$gateway_pid"
    gateway_status=$?
  done
  set -e
  trap - TERM INT HUP
  exit "$gateway_status"
}

# A command passed to `docker run` / `docker compose run` must REPLACE the gateway,
# not be appended to it: `jinn start jinn pair` would boot a second gateway against
# the same volume, rewriting gateway.json under the live one. A leading flag is
# still meant for the gateway, but none is safe against the shared container home.
case "${1:-}" in
  __jinn_service_start__)
    if [ "$#" -ne 1 ]; then
      echo "jinn-entrypoint: the private service-start marker does not accept arguments." >&2
      exit 64
    fi
    shift
    start_gateway
    ;;
  "")
    echo "jinn-entrypoint: missing the private service-start marker; use the image or Compose default command." >&2
    exit 64
    ;;
  -*)
    # A blacklist with explicit remediation for today's options; the fallback refuses
    # future options too. Patterns cover commander's attached-value form (`-p8080`),
    # which a bare `-p` missed.
    for arg in "$@"; do
      case "$arg" in
        --take-port)
          echo "jinn-entrypoint: --take-port is disabled because one-off commands use the shared container home and Claude volume. Stop the container, or run the other instance in its own container with dedicated volumes and a published port." >&2
          exit 64
          ;;
        -i*|--instance|--instance=*)
          # Program-level (bin/jinn.ts), and JINN_HOME above already came from
          # JINN_INSTANCE — so this would boot on a home the entrypoint never prepared.
          echo "jinn-entrypoint: secondary Jinn instances are not supported in this container. Run each instance in its own container with dedicated jinn-home and jinn-claude volumes and a separately published port." >&2
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
          echo "jinn-entrypoint: refusing to forward \`$arg\` to the containerised gateway. Pass a full command instead (\`docker compose run --rm jinn jinn <command>\`)." >&2
          exit 64
          ;;
      esac
    done
    exit 64
    ;;
  jinn)
    case "${2:-}" in
      setup|start|restart)
        echo "jinn-entrypoint: refusing one-off \`jinn ${2}\` against the shared service volumes. Use \`docker compose up -d\` for service startup and \`docker compose restart jinn\` for restart." >&2
        exit 64
        ;;
    esac
    exec "$@"
    ;;
  *) exec "$@" ;;
esac
