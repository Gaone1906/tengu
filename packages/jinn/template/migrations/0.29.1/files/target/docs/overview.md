# {{portalName}} Overview

{{portalName}} is a lightweight AI gateway daemon that wraps professional AI CLI tools as "engines." It is published as `jinn-cli`.

## Core Principle

**{{portalName}} is a bus, not a brain.** All AI intelligence comes from the engines natively. {{portalName}} adds no custom agentic loop and focuses on routing, scheduling, and connectivity. The canonical engines are claude, codex, antigravity, grok, pi, hermes.

The company operating model is in [company-doctrine.md](company-doctrine.md). The public blocks are Employees, Todos, Workflows, Chats, Notes, and Experiments.

## What {{portalName}} Does

- **Gateway**: Single Node.js process that accepts messages from multiple sources and routes them to AI engines
- **Connectors**: Modular input/output adapters (Slack, web UI, future: Discord, iMessage)
- **Cron**: Scheduled AI jobs with hot-reloadable configuration
- **Organization**: Employee personas with departments, ranks, Todos, and inter-agent sessions
- **Skills**: Markdown instruction sets that engines read and follow natively
- **Self-modification**: {{portalName}} can edit its own config, skills, cron jobs, and org structure at runtime

## How It Differs from Custom Agentic Frameworks

Traditional approaches build custom tool-calling loops, manage context windows, and implement retry logic. {{portalName}} leaves those behaviors to the selected engine and connects it to company state and external systems.

## Directory Structure

```
~/.jinn/
  config.yaml          # Gateway configuration
  sessions/
    registry.db        # SQLite session registry
  docs/                # These reference docs
  skills/              # Skill directories with SKILL.md files
  cron/
    jobs.json          # Cron job definitions
    runs/              # Run logs (JSONL)
  org/
    <department>/
      department.yaml  # Department config
      <name>.yaml      # Employee persona
  logs/                # Application logs
```
