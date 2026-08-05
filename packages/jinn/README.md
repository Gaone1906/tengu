# 🧞 Jinn

> Run your AI agents as a company. Jinn is a bus, not a brain.

[![npm version](https://img.shields.io/npm/v/jinn-cli.svg)](https://www.npmjs.com/package/jinn-cli)
[![license: MIT](https://img.shields.io/npm/l/jinn-cli.svg)](https://github.com/hristo2612/jinn)
[![node](https://img.shields.io/node/v/jinn-cli.svg)](https://github.com/hristo2612/jinn)

<p align="center">
  <img src="https://raw.githubusercontent.com/hristo2612/jinn/main/assets/jinn-showcase.gif" alt="Jinn web dashboard" width="800" />
</p>

Jinn turns installed agent CLIs into a persistent AI company: named employees, a Todo ledger, reusable Workflows, and one chat and dashboard. It delegates to the official CLIs instead of replacing them.

## Engines

Mix the six shipped engines. Jinn hides unavailable binaries and lets each employee or session choose one:

- **claude** - Anthropic Claude Code
- **codex** - OpenAI Codex CLI
- **grok** - xAI Grok CLI
- **antigravity** - Antigravity CLI (`agy`)
- **pi** - Pi coding agent
- **hermes** - NousResearch Hermes over ACP

## Quickstart

> **Prerequisites:** Node.js **22 or newer** (the repository pins **24.13.0** in `.nvmrc`), and at least one agent CLI installed **and signed in**.

```bash
# 1. Install Jinn
npm install -g jinn-cli

# 2. Install + sign in to at least one engine (example: Claude Code)
npm install -g @anthropic-ai/claude-code
claude            # run once, use /login, then quit

# 3. Set up ~/.jinn (probes your engines, writes config, seeds your company)
jinn setup

# 4. Start the gateway - opens the dashboard for you
jinn start
```

Or install via Homebrew:

```bash
brew tap hristo2612/jinn https://github.com/hristo2612/jinn
brew install jinn
jinn setup && jinn start
```

Then open [http://localhost:7777](http://localhost:7777).

## Company building blocks

- **Employees** are YAML roles with personas, departments, ranks, reporting lines, and engine defaults.
- **Todos** preserve assignment, priority, status, sub-tasks, labels, comments, links, attachments, approvals, and reviewer-owned completion across sessions.
- **Workflows** combine sequential, conditional, parallel, and switch paths, per-node engines and models, native approvals, schema-validated completion, evidence, and durable run history.
- **Jinn MCP** gives capable engines typed tools for org, sessions, delegation, Todos, Workflows, Triggers, approvals, Notes, cron, connectors, attachments, and managed files.
- **Chat** keeps the receipts. Delegations, callbacks, Todo changes, and Workflow operations render as structured activity beside the conversation.
- **Skills, Notes, Cron, and connectors** provide reusable playbooks, durable knowledge, scheduled work, and external communication.

## How it runs

One local gateway dispatches work, persists company state, and serves the dashboard. Claude runs through its interactive CLI inside a PTY, so eligible turns use your subscription. Hermes is provider-metered; see the [Hermes engine guide](https://github.com/hristo2612/jinn/blob/main/docs/engines-hermes.md).

## Documentation

Read the [full README](https://github.com/hristo2612/jinn), [changelog](https://github.com/hristo2612/jinn/blob/main/CHANGELOG.md), and [contributing guide](https://github.com/hristo2612/jinn/blob/main/.github/CONTRIBUTING.md).

## License

[MIT](https://github.com/hristo2612/jinn/blob/main/LICENSE)
