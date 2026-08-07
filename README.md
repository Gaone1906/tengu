# Tengu — working notes

A fork of [hristo2612/jinn](https://github.com/hristo2612/jinn), named for the mountain guardian of
Japanese folklore — famously skilled, watches from places humans don't go. **Tengu** is an autonomous,
usage-governed AI agent org running on a Claude Max 5x ($100) subscription.

Publishing name (not yet published): npm `tengu-cli`, binary `tengu`, GitHub `tengu-cli` — matching
Jinn's own `jinn-cli` convention. Confirmed available on both npm and GitHub as of 2026-08-07.

**Status:** design complete, no code yet. Nothing installed (`~/.jinn` does not exist).
[03-implementation-plan.md](docs/03-implementation-plan.md) is consolidated and ready to execute;
twelve decisions (D1–D12) are recorded with reasoning in [01-decisions.md](docs/01-decisions.md).

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
| **[03-implementation-plan.md](docs/03-implementation-plan.md)** | **The consolidated build plan — 13 steps, files, effort, verification. Start here to build.** |
| [04-efficiency.md](docs/04-efficiency.md) | Ongoing discussion: making continuous execution affordable |
| [05-org-structure.md](docs/05-org-structure.md) | Recommended roster, responsibilities, and when to add more |
| [06-concurrency.md](docs/06-concurrency.md) | Sequential vs parallel — why throughput doesn't scale with agents |
| [07-fanout-policy.md](docs/07-fanout-policy.md) | How the system decides to parallelise — two gates, fails closed |
| [08-pacing-controller.md](docs/08-pacing-controller.md) | Spend the window, protect the week — effort before concurrency |
| [09-work-profile-and-council.md](docs/09-work-profile-and-council.md) | Personal vs work profiles; per-service agents; the council flow |
| [10-checkpointing.md](docs/10-checkpointing.md) | Sub-sub-task checkpoints, verify-before-act idempotency, graceful stops |
| [11-deviation-assessment.md](docs/11-deviation-assessment.md) | How far this is from stock Jinn, and where the fork risk concentrates |
| [12-deployment-and-ux.md](docs/12-deployment-and-ux.md) | Web app vs desktop app — why it's already decided, and what keeps the daemon alive |
| [13-costs.md](docs/13-costs.md) | Desktop-wrapper effort as a multiplier, and real 2026 hosting prices across 5 providers |
| [14-lid-close-mode.md](docs/14-lid-close-mode.md) | **Correction:** `caffeinate` does not survive lid-close. What actually does, on macOS |
| [15-ui-ux.md](docs/15-ui-ux.md) | Jinn's actual design system (verified) and how Tengu extends its existing screens |

## Naming note

Throughout these docs, **"Jinn"** refers to the upstream project (`hristo2612/jinn`) and its actual
behavior, commands, and environment variables (`jinn setup`, `JINN_HOME`, `~/.jinn`, etc.) — those
stay literal since they describe real upstream code. **"Tengu"** refers to our fork as a product.
Where a doc says "the fork" or "our fork" generically, that's Tengu.

## Quick orientation

- **The scarce resource is the Opus weekly bucket**, not dollars. Jinn is MIT and free; it drives the
  real `claude` binary interactively so it bills against the normal Max pool, not the separate
  non-interactive credit.
- **The sensor already exists.** Jinn pipes Claude Code's statusline JSON — 5-hour and 7-day usage
  percentages, reset timestamps, context-window usage — to `~/.jinn/tmp/engine-limits/claude/<sessionId>.json`.
  Verified against the installed binary. Nothing surfaces it to the UI and nothing enforces a threshold.
- **The biggest win needs no fork at all**: Opus planner → Sonnet executor → Opus reviewer — step 0,
  about an hour of config, and it moves the economics more than everything else combined.
- **Interruption is the normal case**, not an error path. The governor halts several times a day, so
  sub-sub-task checkpoints (commit + ledger status, `verify`-before-act) are the execution model.
- **Two profiles**: personal (one executor, departments as labels) and work (one agent per service,
  plus a council that plans across them). `JINN_INSTANCE` makes this free.
