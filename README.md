# Jinn

Lightweight AI gateway daemon orchestrating Claude Code and Codex.

<p align="center">
  <img src="assets/jinn-showcase.gif" alt="Jinn Web Dashboard" width="800" />
</p>

## What is Jinn?

Jinn is an open-source AI gateway that wraps the Claude Code CLI and Codex SDK
behind a unified daemon process. It routes tasks to AI engines, manages
connectors like Slack, and schedules background work via cron. Jinn is a bus,
not a brain.

## Features

- Claude Code and Codex engine support
- Slack integration (with more connectors coming)
- Cron job scheduling
- Self-organizing AI workforce (org system)
- Web dashboard
- Hot-reload configuration
- Self-modification capabilities

## Quick Start

```bash
npm install -g jinn-cli
jinn setup
jinn start
```

Then open [http://localhost:7777](http://localhost:7777).

## Architecture

```
                          +----------------+
                          |   jinn CLI     |
                          +-------+--------+
                                  |
                          +-------v--------+
                          |    Gateway     |
                          |    Daemon      |
                          +--+--+--+--+---+
                             |  |  |  |
              +--------------+  |  |  +--------------+
              |                 |  |                  |
      +-------v-------+ +------v------+  +-----------v---+
      |    Engines     | | Connectors  |  |    Web UI     |
      | Claude | Codex | |   Slack     |  | localhost:7777|
      +----------------+ +-------------+  +---------------+
              |                 |
      +-------v-------+ +------v------+
      |     Cron      | |    Org      |
      |   Scheduler   | |   System    |
      +---------------+ +-------------+
```

The CLI sends commands to the gateway daemon. The daemon dispatches work to AI
engines (Claude Code, Codex), manages connector integrations, runs scheduled
cron jobs, and serves the web dashboard.

## Configuration

Jinn reads its configuration from `~/.jinn/config.yaml`. An example:

```yaml
gateway:
  port: 7777

engines:
  claude:
    enabled: true
  codex:
    enabled: false

connectors:
  slack:
    enabled: true
    app_token: xapp-...
    bot_token: xoxb-...

cron:
  jobs:
    - name: daily-review
      schedule: "0 9 * * *"
      task: "Review open PRs"

org:
  agents:
    - name: reviewer
      role: code-review
```

## Project Structure

```
jinn/
  packages/
    jimmy/          # Core gateway daemon + CLI
    web/            # Web dashboard (frontend)
  turbo.json        # Turborepo build configuration
  pnpm-workspace.yaml
  tsconfig.base.json
```

## Development

```bash
git clone https://github.com/hristo2612/jinn.git
cd jinn
pnpm install
pnpm build
pnpm dev
```

### Available Scripts

| Command          | Description                     |
| ---------------- | ------------------------------- |
| `pnpm build`     | Build all packages              |
| `pnpm dev`       | Start development mode          |
| `pnpm typecheck` | Run TypeScript type checking    |
| `pnpm lint`      | Lint all packages               |
| `pnpm clean`     | Clean build artifacts           |

## Acknowledgments

The web dashboard UI is built on components from [ClawPort UI](https://github.com/JohnRiceML/clawport-ui) by John Rice, adapted for Jinn's architecture. ClawPort provides the foundation for the theme system, shadcn components, org map, kanban board, cost dashboard, and activity console.

## License

[MIT](LICENSE)

## Contributing

See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for guidelines on setting up
your development environment and submitting pull requests.
