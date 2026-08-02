# syntax=docker/dockerfile:1

# Jinn container image. InteractiveClaudeEngine always spawns `claude` with
# --dangerously-skip-permissions, which disables the approval gate for everything
# the process can reach; here that is only the paths deliberately mounted in.

FROM node:24-bookworm-slim AS builder

# g++/make/python3 compile better-sqlite3 and node-pty. No git: pnpm-lock.yaml has
# zero git specifiers and the install below is --frozen-lockfile.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates g++ make python3 \
  && rm -rf /var/lib/apt/lists/*

# pnpm version comes from the root package.json "packageManager" field.
RUN corepack enable
WORKDIR /src

# Manifests first so dependency installation caches independently of source edits.
# Both scripts/ trees come along: each declares a postinstall that pnpm runs during
# install, so the files must exist on disk beforehand.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json .npmrc ./
COPY scripts/ ./scripts/
COPY packages/jinn/package.json ./packages/jinn/
COPY packages/jinn/scripts/ ./packages/jinn/scripts/
COPY packages/web/package.json ./packages/web/
RUN pnpm install --frozen-lockfile

COPY . .

# The ROOT build, not `pnpm --filter jinn build`: the root script also runs
# sync-web-dist.mjs, which puts the dashboard where the gateway serves it from.
# Filtering to the jinn package yields a gateway with no UI.
RUN pnpm build


FROM node:24-bookworm-slim AS runtime

# procps/lsof: the gateway inspects its own processes and port ownership.
# git: agents work inside mounted repositories.
# curl: not optional — the session context (sessions/context.ts) instructs every
# agent to reach the gateway with it, for connector sends and for pushing a file
# into the chat. Without it those turns die on "curl: command not found".
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git lsof procps \
  && rm -rf /var/lib/apt/lists/*

# The engine spawns this binary; it is not a jinn dependency, so it is pinned here.
# Engine drift is a realised failure mode: 2.1.170 implied the Bypass Permissions
# consent through global onboarding and 2.1.220 does not.
ARG CLAUDE_CODE_VERSION=2.1.220
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# Without this the pin is defeatable: the CLI is installed root-owned but runs as
# `node`, so the updater either warns every turn or relocates itself onto the
# writable volume, where the drift then survives rebuilds. Unprefixed on purpose —
# buildEngineChildEnv strips every CLAUDE_CODE_* key before spawning the engine.
ENV DISABLE_AUTOUPDATER=1

# The whole tree, node_modules included: pnpm's layout is a symlink farm into
# node_modules/.pnpm that only resolves at its original paths. root:node rather
# than node:node — the runtime only reads, and an agent running without the
# permission gate should not be able to rewrite the gateway serving it.
COPY --from=builder --chown=root:node /src /opt/jinn

# A shell wrapper rather than a symlink into dist/bin/jinn.js: that file's shebang
# is rewritten at publish time, so depending on it would couple us to packaging.
RUN printf '#!/bin/sh\nexec node /opt/jinn/packages/jinn/dist/bin/jinn.js "$@"\n' > /usr/local/bin/jinn \
  && chmod 0755 /usr/local/bin/jinn

COPY docker-entrypoint.sh /usr/local/bin/jinn-entrypoint
RUN chmod 0755 /usr/local/bin/jinn-entrypoint

# Create the mount points before the volumes land on them: Docker seeds a fresh
# named volume from the ownership of the directory underneath, so without these the
# volume is root-owned and `node` cannot write its own config.
RUN mkdir -p /home/node/.jinn /home/node/.claude /work \
  && chown -R node:node /home/node /work

USER node
ENV HOME=/home/node
WORKDIR /home/node

# Keep Claude Code's config inside the volume. It otherwise writes ~/.claude.json,
# which sits in the container layer and is discarded by every rebuild along with
# the user's MCP servers, project trust and onboarding state.
ENV CLAUDE_CONFIG_DIR=/home/node/.claude

# Publish to the host's loopback only. The dashboard authenticates with a shared
# gateway token, so a routable interface would put agent control on the network.
EXPOSE 7777

ENTRYPOINT ["/usr/local/bin/jinn-entrypoint"]
