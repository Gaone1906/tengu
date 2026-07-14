#!/bin/sh
set -eu

if [ ! -f /workspace/scripts/upgrade-lab/run.mjs ]; then
  echo "The Jinn repository must be mounted read-only at /workspace." >&2
  exit 2
fi

exec node /workspace/scripts/upgrade-lab/run.mjs "$@"
