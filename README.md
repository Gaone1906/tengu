# jinn — working notes

Planning workspace for a fork of [hristo2612/jinn](https://github.com/hristo2612/jinn): an autonomous,
usage-governed AI agent org running on a Claude Max 5x ($100) subscription.

**Status:** design discussion. No code yet. Nothing installed (`~/.jinn` does not exist).

## Goal

One agent working a todo backlog continuously and unattended — decomposing tasks into sub-tasks,
hammering away, governing its own usage against the plan's limits, handing off cleanly when it runs
out of budget, and resuming on its own when the window reopens. Plus a dashboard that makes all of
that legible, a stand-up view per project/department, and a security officer that keeps it from
destroying work.

## Docs

| File | What's in it |
|---|---|
| [00-context.md](docs/00-context.md) | The eight requirements, and the constraints they run into |
| [01-decisions.md](docs/01-decisions.md) | Decision log — what we chose, why, and what we rejected |
| [02-findings.md](docs/02-findings.md) | Verified findings about the upstream codebase (with file paths) |
| [03-implementation-plan.md](docs/03-implementation-plan.md) | The full build plan — nine steps, files, effort, verification |
| [04-efficiency.md](docs/04-efficiency.md) | Ongoing discussion: making continuous execution affordable |

## Quick orientation

- **The scarce resource is the Opus weekly bucket**, not dollars. Jinn is MIT and free; it drives the
  real `claude` binary interactively so it bills against the normal Max pool, not the separate
  non-interactive credit.
- **The sensor already exists.** Jinn pipes Claude Code's statusline JSON — 5-hour and 7-day usage
  percentages, reset timestamps, context-window usage — to `~/.jinn/tmp/engine-limits/claude/<sessionId>.json`.
  Verified against the installed binary. Nothing surfaces it to the UI and nothing enforces a threshold.
- **The biggest win needs no fork at all**: Opus planner → Sonnet executor → Opus reviewer (see 01-decisions).
