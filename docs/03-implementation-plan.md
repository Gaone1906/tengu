# Jinn fork: autonomous usage-governed agent org

## Context

Goal: run Claude Code agents autonomously against a Jinn todo ledger — decomposing large tasks into sub-tasks, hammering away continuously, with **no user input** — while never blowing through a Claude Max 5x ($100) plan. Specifically:

1. Decompose large tasks into tasks/sub-tasks
2. Continuously work the backlog
3. Stop **all** agent execution at 80% usage limit
4. On halt: every agent logs current work to a handoff file; resume automatically when the next 5-hour window opens
5. Compact context at 80% and carry a handoff forward so nothing is lost
6. A Jinn GUI panel showing, **constantly**: context remaining per agent, usage limit remaining, overall work % complete, and work complete per agent
7. A **stand-up** view: the main dashboard lists projects; within each, every department (backend, frontend, database…) reports done / remaining, the issues it hit, and how they were resolved
8. A **security officer** that guarantees existing work is never wiped out and agents never run destructive commands

### Cost answer (settled)

Jinn is MIT/free and adds **no dollar cost** for Claude. `packages/jinn/src/engines/claude-interactive.ts` spawns the real `claude` binary through `node-pty` deliberately **without** `-p` (source comment: "no -p → cc_entrypoint=cli"). Non-interactive usage (`claude -p`, Agent SDK) bills against a separate $100/mo credit on Max 5x; by staying interactive, Jinn draws from the normal Max pool. So there is no surprise invoice — but agents consume the **same 5-hour and 7-day limits** used for interactive work, with `--dangerously-skip-permissions` and `AskUserQuestion`/`ExitPlanMode` disabled. Continuous operation will exhaust the weekly cap quickly. That is exactly why the governor below is the core of this work, not a nice-to-have.

Adding Codex/Grok/Hermes employees *does* bill per token — those are covered by Jinn's existing monthly `budgets`.

### Model mix: Opus planner → Sonnet executor → Opus reviewer

This is the highest-leverage decision in the whole design, and it is worth more than the governor.

**Why, on a subscription, the per-token price ratio is the wrong number.** Opus 5 is $5/$25 per Mtok against Sonnet 5's $3/$15 — only ~1.67×, so on the API the swap looks marginal. But you are not billed per token; you are metered against buckets, and on Max plans **Opus draws from its own separate 5-hour and weekly buckets**, sized far smaller than the general/Sonnet pool. Published estimates for Max 5x put it around **15–35 hours of Opus versus 140–280 hours of Sonnet per week** — call it ~9× more Sonnet headroom. Claude's own Settings → Usage reflects this by showing separate reset timers for Opus and for everything else.

The consequence: **an all-Opus continuous loop is capped by the Opus weekly bucket, and will exhaust it in roughly two to four days of sustained work.** That is the wall you would hit, and no amount of 80%-governor tuning moves it.

**What the proposed split does.** For a plan → code → test → review loop, the recursive executor is where nearly all the tokens go:

| Role | Share of tokens | Model | Bucket |
|---|---|---|---|
| Planner (once per task) | ~5% | Opus 5 | Opus (scarce) |
| Executor (code/test loop) | ~85% | Sonnet 5 | General (~9× larger) |
| Reviewer (per gate) | ~10% | Opus 5 | Opus (scarce) |

That moves ~85% of the volume off the scarce bucket, leaving roughly **10–15% of the work on Opus**. Practically it turns "two to four days" into "the Opus bucket is no longer the binding constraint" — the general/Sonnet pool becomes the limit, and it is far larger. Your instinct is right, and Sonnet 5 supports it: it reaches near-Opus quality on coding and agentic work specifically, which is exactly the executor's job.

**The one thing that can spoil it: reviewer frequency.** Reviewer share is the variable you control least well. If Opus reviews every sub-task and sub-tasks are small, review volume balloons from ~10% toward 30% and you are back on the Opus bucket. Gate review at the **parent todo**, not per sub-task, and make the review gate explicit in the workflow rather than implicit per-transition.

**Second lever, cheaper than the model swap: `effort`.** Within a tier, effort moves cost more than model choice does. Sonnet 5 at `medium` is roughly Sonnet 4.6 at `high`. Run the executor at `medium`, reserve `high`/`xhigh` for the planner and reviewer, and sweep before committing — Jinn already supports per-phase engine *and* model selection in workflows, so this is configuration, not code.

**Where this lands in the build:** it is a Jinn config decision (employees bound to engines/models, workflows with per-phase model selection), not new code. It should be set up **first**, before any of the seven steps — it is the change that actually makes continuous execution survivable, and it needs no fork at all.

### Verified locally (2026-08-07)

The premise is confirmed against the installed binary, not just docs. `claude --version` → **2.1.185**, `/opt/homebrew/Caskroom/claude-code/2.1.185/claude`. A `strings` scan of that binary finds every field the governor needs:

| Field | Occurrences |
|---|---|
| `seven_day` | 79 |
| `five_hour` | 41 |
| `resets_at` | 18 |
| `used_percentage` | 11 |
| `remaining_percentage` | 4 |
| `context_window_size` | 3 |
| `exceeds_200k_tokens` | 2 |

So the statusline JSON on this machine really does carry 5-hour and 7-day usage percentages with reset timestamps, and Jinn's `buildSessionSettings()` already pipes exactly those fields to `~/.jinn/tmp/engine-limits/claude/<sessionId>.json`. Nothing in steps 1–4 depends on an unproven assumption.

Still unverified (needs Jinn installed, deliberately deferred to verification step 2): that the snapshot file appears and refreshes per assistant message in practice. Node v25.9.0 is present, so the Node 22+ prerequisite is met. `~/.jinn` does not exist and `jinn` is not on PATH — nothing installed yet.

### Execution model: continuous, not concurrent

One agent working a backlog without stopping — **not** many agents in parallel. This simplifies the build materially:

- Account rollup is the single active session; the max-across-sessions concern in step 1 becomes hygiene rather than correctness.
- No git worktree isolation, no concurrent-write conflicts, no per-agent contention.
- Handoff choreography halts and resumes **one** session, not a fleet.
- The GUI's per-agent table is one live row plus history, not a fleet view.

It also changes which limit binds. A single agent hammering continuously saturates each 5-hour window and then idles until reset — so the 5-hour governor fires **often** and is the routine control path, while the 7-day cap is what ends the week. Both need handling; the 5-hour one needs to be boring and reliable because it will run several times a day.

### Fork choice: Jinn, not OpenClaw

Both are MIT TypeScript pnpm monorepos with a local gateway daemon and a web dashboard. They are built for different jobs.

| | **Jinn** (301★) | **OpenClaw** (385k★) |
|---|---|---|
| Built for | An agent **work org** | A **personal assistant** on messaging channels |
| Multi-agent | Employees with departments, ranks, reporting lines, delegation | Isolated **personas routed by channel**; peers, no hierarchy; agent-to-agent messaging **off by default** |
| Todo ledger | ✅ `WorkItem` tree — `parentId`/`rootId`/`depth`≤3, assignee, status, approvals | ❌ none |
| Claude limits data | ✅ **per session** (`rate_limits` + `context_window` written per `sessionId`) | ✅ account-level only |
| Limits **UI** | ❌ account-level page only | ✅ Control UI per-window bars (5h, weekly, model-scoped) with reset times |
| Threshold **enforcement** | ❌ | ❌ **display-only** — no thresholds, no pause, no auto-resume |
| Cron | ✅ mints a work item before spawning | ✅ exists |

The decisive point: **the governor is unbuilt in both.** OpenClaw's usage tracking is explicitly informational — it surfaces quota and does not throttle or stop anything. So requirements 3, 4 and 5 are net-new work either way, and the choice comes down to what each gives you *for free* underneath.

Jinn gives the work model — the todo hierarchy, assignees, and delegation that requirements 1, 2 and the per-agent progress half of 6 are made of. OpenClaw gives a usage-bar UI, which is roughly a third of requirement 6 and the easiest third to write. Building a work ledger and org hierarchy into OpenClaw is far more work than building a telemetry panel into Jinn — and OpenClaw's channel-routed persona model actively resists it, since agents are isolated by design with separate session stores and no shared ledger.

Jinn also already writes limits **per session**, which OpenClaw's account-level view does not. The requirement is "context remaining **per agent**" — that needs the per-session snapshot Jinn is already producing.

Caveats, stated plainly: Jinn is beta, 301 stars, effectively one maintainer — real bus-factor risk, and you own the fork. OpenClaw's ecosystem is vastly larger, but forking a 385k-star project moving at that pace is its own tax. Also worth knowing: [`claw-orchestrator`](https://github.com/Enderfga/claw-orchestrator) (542★) has an "Autoloop" three-agent Planner/Coder/Reviewer autonomous loop and a run UI, closest to requirement 2 — but no todo ledger and no usage tracking, so it is not a better base, just a good reference for the loop design.

**Steal from OpenClaw:** its Control UI per-window usage bars are the design to copy for step 2 rather than invent.

### What already exists (reuse — do not rebuild)

The sensor is **already built and running**. This is the single most important finding:

- `packages/jinn/src/shared/claude-settings.ts` — `buildSessionSettings()` injects a `statusLine` recorder into the per-session Claude settings file. It reads Claude's statusline JSON on stdin and atomically writes (mode `0o600`) to `<CLAUDE_LIMITS_DIR>/<sessionId>.json`, keeping `captured_at`, `jinn_session_id`, `model`, `version`, `rate_limits`, `context_window`, `cost`.
- On disk: `~/.jinn/tmp/engine-limits/claude/<sessionId>.json`. Contains `rate_limits.five_hour.{used_percentage,resets_at}`, `rate_limits.seven_day.{...}`, and `context_window.{used_percentage,context_window_size,...}`.
- **Every field the GUI needs is already on disk, per session, refreshed on every assistant message.** Nothing is surfaced to the UI and nothing enforces a threshold.
- `packages/jinn/src/shared/engine-limits.ts` — `collectEngineLimits()` and `claudeSnapshotFile()`; prefers a live OAuth usage API, falls back to the statusline snapshot, marks snapshots stale after 30 min. Currently account-level: picks only the most-recently-modified snapshot.
- `packages/web/src/routes/limits/{page.tsx,use-engine-limits.ts}` — an existing account-level limits page to extend rather than duplicate.
- `packages/jinn/src/gateway/budgets.ts` — `isBudgetExhausted()`, enforced in `runWebSession` **before the engine runs**, across web/API/delegation/workflow paths (per PLA-54). This is the enforcement seam the governor should copy exactly.
- `packages/jinn/src/work-items/{store,relations,transitions,live-events}.ts` — todo tree: `id`, `parentId`, `rootId`, `depth` (≤3), `status`, `approvalState`, `assignee`. No completion-percentage aggregation exists.
- `packages/jinn/src/cron/{jobs,runner,scheduler,validation}.ts` — each fire starts a **fresh** session, mints the work item *before* spawning, dedupes on `fireIso`.
- `packages/gateway-events/src/index.ts` — shared event types between gateway and web.
- `packages/jinn/src/shared/usageAwareness.ts` — `ClaudeUsageState { lastRateLimitAt?, lastResetsAt? }`, `isLikelyNearClaudeUsageLimit()`. **Warn-only**, fixed 6-hour heuristic, no percentage thresholds, no enforcement. This is the module to grow into the governor.

### What is missing

| Requirement | Status |
|---|---|
| Sub-task decomposition | Ledger supports it; decomposition is prompt-driven |
| Continuous work | Cron re-fires but always fresh; no repeat-until-done loop |
| Stop at 80% | Data exists, **no threshold enforcement** |
| Handoff + auto-resume | `rate-limit-waiting-resume.ts` enters `waiting` and, per its own test, **requires a user message to clear** — directly contradicts unattended operation |
| Context compaction at 80% | `buildPtyEnv()` sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000`; on a 200k model this likely pushes auto-compact past the ceiling. **Verify empirically before changing.** |
| GUI telemetry | Nothing renders per-session limits or progress |

## Approach

Fork `hristo2612/jinn`, implement in-tree in nine steps, after a config-only step 0. Steps 1–3 deliver the GUI on their own and are worth landing first.

### 0. Org and model configuration (no fork required)

Four employees in `~/.jinn/employees/`, per [05-org-structure.md](05-org-structure.md):

| Employee | Rank | Engine / model | Effort | Responsibility |
|---|---|---|---|---|
| `planner` | executive | Claude / Opus 5 | `high` | Decompose project roots into independently assignable, department-tagged sub-tasks in the ledger |
| `engineer` | employee | Claude / **Sonnet 5** | `medium` | The recursive code/test loop, across all departments |
| `reviewer` | manager | Claude / Opus 5 | `high` | Approve/reject at **parent-todo gates only** |
| `security` | executive | — (`system: true`) | — | Command policy, path confinement, restore points; zero tokens |

Reporting line `planner → reviewer → engineer`; `security` sits outside the delegation chain.

**Departments are labels on `work_items`, not agents** — one executor covers backend, frontend, and
database in a single warm session. Promote a department to its own employee only when the context it
needs genuinely differs (different repo/stack/credentials).

Personas carry the efficiency instructions from [04-efficiency.md](04-efficiency.md): `engineer` gets
scope discipline, **no** verification scaffolding, a subagent cap, and ledger-before-filesystem on
resume; `reviewer` gets report-everything-filter-downstream.

Add a `scribe` (Haiku / Sonnet `low`) when step 9 ships — stand-up narration is a fixed recurring
cost and must not sit on the work's engine.

Confirm the YAML field names against `packages/jinn/template/` before writing these.

### 1. Per-session telemetry aggregation (backend)

New `packages/jinn/src/shared/session-telemetry.ts`:
- `readAllSessionTelemetry()` — scan `CLAUDE_LIMITS_DIR`, parse every `<sessionId>.json`, join to live sessions from the session registry (`~/.jinn/sessions/registry.db`) and to employee identity.
- Return per session: `sessionId`, `employee`, `model`, `contextUsedPct`, `contextRemainingPct`, `fiveHourUsedPct`, `fiveHourResetsAt`, `sevenDayUsedPct`, `sevenDayResetsAt`, `costUsd`, `capturedAt`, `stale`.
- Account-level rollup takes the **max** `used_percentage` across snapshots (limits are account-wide; the freshest-file heuristic in `engine-limits.ts` under-reports when several agents run concurrently).

Reuse `claudeSnapshotFile()`'s parsing and the 30-min staleness rule from `engine-limits.ts` — extract the shared bits rather than copying.

### 2. Live GUI surface (frontend)

- Emit a `session.telemetry` event via `packages/gateway-events/src/index.ts`; broadcast on the existing live-events channel used by `work-items/live-events.ts`. Debounce to ~1s.
- New `packages/web/src/hooks/use-session-telemetry.ts`, modelled on `routes/limits/use-engine-limits.ts`.
- New `packages/web/src/components/TelemetryBar.tsx` — a persistent bar mounted in the shared layout (`routes/providers.tsx` / `client-providers.tsx`), showing:
  - **Account:** 5-hour and 7-day usage bars with a marked 80% governor line and reset countdowns
  - **Per agent:** one row each — employee name, model, context remaining %, current todo
  - **Progress:** overall completion % and per-employee completion (from step 3)
- Colour thresholds: green <60%, amber 60–80%, red ≥80% (governor engaged).
- Extend `routes/limits/page.tsx` with the per-session breakdown rather than creating a competing page.

### 3. Work-item progress rollups

New `packages/jinn/src/work-items/progress.ts`:
- `computeRootProgress(rootId)` — completed vs total descendants over the `parentId`/`rootId` tree in `store.ts`, using terminal states from `transitions.ts`.
- `computeEmployeeProgress()` — per-assignee completed/total/in-flight.
- Expose on the same event as step 1 so one event feeds the whole bar.

### 4. The governor (enforcement)

Grow `packages/jinn/src/shared/usageAwareness.ts` — keep `ClaudeUsageState`, add:
- `GovernorConfig { fiveHourStopPct: 80, sevenDayStopPct: 80, contextCompactPct: 80 }` in `~/.jinn/config.yaml` under a new `governor:` section, defaults as shown.
- `evaluateGovernor(telemetry, config): { action: "run" | "handoff" | "halt", reason, resumeAt }`.
- Track **both** windows. The 7-day cap is the one that ends the week — treat it as the harder stop.

Enforce it at the **same seam as budgets**: `packages/jinn/src/gateway/budgets.ts`'s call site in `runWebSession`, which already covers web, API, delegation, and workflow paths. Add the governor check beside `isBudgetExhausted()` so no dispatch path bypasses it. A `halt` blocks spawning with a clear assistant message, exactly as an over-budget employee does today.

### 5. Handoff + auto-resume

- New `packages/jinn/src/sessions/handoff.ts`. On `action: "handoff"` (crossing 80% while sessions are live), send each running session a final turn instructing it to write `~/.jinn/handoffs/<employee>-<todoId>.md`: what was done, what remains, current file/line state, next concrete step. Then let it stop and block further spawns.
- Write the handoff path onto the work item (`work-items/comments.ts`) so it is visible in the GUI and survives restarts.
- **Resume:** read `five_hour.resets_at` (epoch seconds) from the latest telemetry, schedule a one-shot job at `resets_at + 60s`. Jinn's cron is expression-based (`~/.jinn/cron/jobs.json`), so add a one-shot `runAt` job kind across `cron/{validation,jobs,scheduler}.ts` — **confirm the existing job schema first**, it may already accommodate this.
- The resume prompt must load the handoff file and the open todo tree. Cron already mints the work item before spawning, so the fresh session starts attached to the right todo.
- **Critical:** `gateway/rate-limit-waiting-resume.ts` clears `waiting` only on a user message. The governor-initiated resume must clear that state programmatically or unattended restart silently fails. Cover this with a test.

### 6. Context compaction at 80%

- First **verify empirically** what `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000` does on a 200k-context model in `buildPtyEnv()` (`claude-interactive.ts`). If it defers compaction past the ceiling, sessions hit a wall instead of compacting — that must be fixed regardless.
- When `context_window.used_percentage ≥ 80`, have the governor inject a turn telling the agent to write its handoff file and then run `/compact`. Claude Code's `PreCompact` hook already relays through `HOOK_RELAY_SCRIPT`, so Jinn can record the compaction in the activity feed.
- `SessionStart` (already wired in `buildSessionSettings()`) fires again after compaction with `source: "compact"` — use it to re-inject the handoff file, so post-compaction context still knows what was done and what remains.

### 7. Continuous loop + fan-out policy

The repeat-until-done behaviour: on `Stop`, if the governor says `run` and the employee has an open todo, dispatch the next sub-task instead of idling. Implement in the existing `Stop` hook relay path (`gateway/hook-registry.ts` / `hook-endpoint.ts`), guarded by the governor so the loop can never outrun the budget.

**Assignment is a query, not a model call** — next open sub-task by priority. No dispatcher employee.

**Fan-out** (full policy in [07-fanout-policy.md](07-fanout-policy.md)) — two gates, both must pass, uncertainty resolves to sequential:

1. **Planning-time annotation.** `planner` writes `parallelSafe` (defaults **false**) and `parallelGroup` onto sub-tasks, justified in the todo body. Requires distinct `workspacePath` or read-only work, no shared files, no ordering dependency. New fields on `work-items/store.ts`.
2. **Runtime budget gate.** New `shared/fanout-policy.ts` → `allowFanout(telemetry, history, config): 1|2|3`. Pure arithmetic, no model call, evaluated beside the governor. Weekly **pace ratio** (`sevenDay.used% ÷ weekElapsedFraction`) is the primary brake; also requires ≥90 min of window runway, projected 5h spend under 60%, and ≥20 completed todos of cost history before fan-out is ever permitted.

Runtime can only ever **downgrade** to sequential — never exceed the planner's group. Hard cap 3.

**Circuit breakers:** a member halted mid-flight disables fan-out for the window; pace ratio > 1.0 or any merge conflict disables it for the week; fan-out costing more per todo than sequential over 10 samples auto-disables and flags in the stand-up.

**Pacing controller** (step 7c, [08-pacing-controller.md](08-pacing-controller.md)) — new `shared/pacing-controller.ts`. Unused 5-hour capacity is destroyed at reset, so under-spending is a real loss; but the weekly cap means you can't fill every window. Derive a per-window target from the weekly budget (`fairShare = weeklyRemaining / windowsLeft`), compute `paceRatio`, and steer: accelerate below 0.8 when `windowElapsed > 0.6`, throttle above 1.2. **`effort` is the primary lever, fan-out second** — effort burns budget smoothly with no duplication, no merge risk, and no mid-flight-halt risk. No fan-out at all past 85% window elapsed. Evaluated on every (free) telemetry write plus a 60s tick — **not** a polling agent. Requires persisting `sevenDay.used%` at window boundaries (add to step 1).

Surface the current mode **and its reason** in the telemetry bar — "Sequential: weekly pace 1.3× budget" is what tells you the governor is working rather than the system just being slow.

### 8. Security officer

**Already built (verified in source) — this is a hardening job, not a greenfield one:**

- `shared/command-policy.ts` — `evaluateCommandPolicy(command): {action: "allow"|"block", reason?}`. Deny-list covers recursive home/root removal, `sudo` destructive removal, disk-destructive commands (`mkfs`, `dd`, `diskutil erase`), plus an exfiltration rule that fires when a `SECRET_PATH` pattern (SSH keys, `.env`, Jinn secrets) co-occurs with an `EXFIL` pattern (`curl`, `wget`, `nc`, `scp`, `rsync`, `python http.server`).
- `gateway/hook-endpoint.ts` — on `PreToolUse` with `tool_name === "Bash"`, calls the policy and returns **HTTP 451** with the reason, rejecting the call *before* it reaches the hook registry.

**Four gaps between that and "existing work is never wiped out":**

1. **Bash-only.** The check is gated on `tool_name === "Bash"`. `Write`, `Edit`, and `NotebookEdit` can overwrite a file with no policy evaluation at all. Extend the dispatch in `hook-endpoint.ts` to a per-tool evaluator.
2. **No git- or data-destructive patterns.** Add `git reset --hard`, `git checkout -- .`, `git clean -fd(x)`, `git push --force` (allow `--force-with-lease`), `git branch -D`, `git stash drop/clear`, `DROP TABLE`, `TRUNCATE`, `DELETE FROM` without a `WHERE`, and single-`>` truncation onto a tracked file. These are the realistic ways an agent destroys work — far more likely than `mkfs`.
3. **No workspace confinement.** Nothing resolves a write path and checks it stays inside the employee's `cwd`. Add canonical-path resolution and reject escapes (`..`, symlinks, absolute paths outside the mount) — same discipline the text-editor tool guidance prescribes.
4. **Refusal without recovery.** New `security/restore-points.ts`: before a session's first mutating tool call, write a git ref `refs/jinn/<sessionId>` (or `git stash create` on a dirty tree) capturing the pre-session state. Cheap, non-invasive, and turns "wiped out" into "restorable" — which is the requirement actually asked for. Surface the restore point in the GUI next to the session.

**Make it an actual officer, not a function.** `Employee` already has `system?: boolean` and `rank: "executive" | ...`, so define a `security` system employee at executive rank in `~/.jinn/employees/`. Every block becomes an activity receipt and a work-item comment attributed to it, so refusals appear in the org's audit trail and in the stand-up rather than vanishing into a 451. This is what makes the officer legible to you.

**One interaction to get right:** `claude-interactive.ts` sets `autoApproveSafetyPrompts` (default on) and answers Claude's own permission dialogs via `answerPermissionPrompt()`. That means the policy is the *only* gate. The officer's evaluation must therefore run before auto-approval for any tool class it governs — do not rely on Claude's dialog as a second line of defence, because Jinn is configured to dismiss it.

### 9. Stand-up

**What exists:** `work-items/departments.ts` models departments as user-defined slugs with lazy registration (`resolveDepartmentPrefix`), a `department` column on `work_items`, and `listDepartmentsWithCounts(db)` returning `{slug, prefix, createdAt, todoCount}`. `Employee` carries `department` and `rank`. `cron/run-summary.ts` already generates run summaries. So department → work-item association and per-department counts are done.

**The gap: there is no project entity.** Projects are just `cwd` paths on engine execution. Two options; recommend the first:

- **Root work item = project** (matches Jinn's documented one-root-per-outcome doctrine). Add a `workspacePath` field to root items so a project has an identity and a location. Minimal schema change, no new concept.
- A separate `projects` table — cleaner conceptually, more migration surface, and duplicates what roots already express.

**Build `work-items/standup.ts`:**

- For each (project root × department), reuse `computeRootProgress` from step 3 to get done / in-flight / remaining, filtered by the `department` column.
- Pull the raw event log for the window: `transitions.ts` (status changes), `comments.ts` (discussion), and approval/rejection records.
- **Narrate the issues.** "We had these issues, we solved it like this" is prose, not a field — it has to be summarized from the raw log by a model. Run it as a cheap engine call (Haiku, or Sonnet at `low` effort) over each department's window, and **cache the result keyed by (project, department, latest-event-timestamp)** so unchanged history is never re-summarized.
- **Never run stand-up summarization on Opus.** It is a background reporting job on a fixed cadence; putting it on the scarce bucket would quietly compete with the work itself. This is the model-mix discipline from step 0 applied to your own tooling.

**Surfacing it:** a Jinn cron job produces a stored stand-up snapshot on a schedule, plus an on-demand refresh button. New route `packages/web/src/routes/standup/page.tsx` — projects as cards, departments as rows within each, every row showing a progress bar, done/left counts, blocked items, and the narrative paragraph. Security-officer blocks from step 8 appear inline as incidents, which is where they become genuinely useful: an agent that tried something destructive shows up in the morning report attributed to a department.

## Files

**New:** `shared/session-telemetry.ts`, `shared/fanout-policy.ts`, `shared/pacing-controller.ts`, `work-items/progress.ts`, `work-items/standup.ts`, `sessions/handoff.ts`, `security/restore-points.ts`, `web/src/hooks/use-session-telemetry.ts`, `web/src/components/TelemetryBar.tsx`, `web/src/routes/standup/page.tsx`

**Modified:** `shared/usageAwareness.ts`, `shared/engine-limits.ts`, `shared/command-policy.ts` (extend deny-list; add per-tool + path evaluators), `shared/config.ts`, `gateway/hook-endpoint.ts` (dispatch beyond Bash), `gateway/budgets.ts` (call site), `gateway/rate-limit-waiting-resume.ts`, `gateway/hook-registry.ts`, `engines/claude-interactive.ts` (`buildPtyEnv`; `autoApproveSafetyPrompts` ordering), `work-items/{store,departments}.ts` (`workspacePath` on roots; `parallelSafe`/`parallelGroup` on sub-tasks), `cron/{validation,jobs,scheduler}.ts`, `packages/gateway-events/src/index.ts`, `web/src/routes/limits/page.tsx`, `web/src/routes/providers.tsx`

## Effort

Assuming comfort with TypeScript and React, and no major upstream churn mid-build.

| Step | Estimate | Notes |
|---|---|---|
| 0. Model mix (Opus/Sonnet/Opus) | **~1 hour** | Config only, no fork. Do this first — biggest win per unit effort |
| Learning the codebase | 1–2 days | Beta monorepo, vitest + Playwright, unfamiliar seams |
| 1. Telemetry aggregation | 0.5–1 day | ~200 LOC; parsing already exists in `engine-limits.ts` |
| 2. Live GUI surface | 1–2 days | Event type + hook + component + layout wiring |
| 3. Progress rollups | 0.5–1 day | Tree walk over `work-items/store.ts` |
| 4. Governor + enforcement | 1–2 days | Config schema, evaluator, `budgets.ts` call-site, tests |
| 5. Handoff + auto-resume | **2–3 days** | Hardest. Turn injection, one-shot cron kind, clearing `waiting` |
| 6. Context compaction at 80% | 1–2 days | Includes empirically verifying `CLAUDE_CODE_AUTO_COMPACT_WINDOW` |
| 7. Continuous loop on Stop | ~1 day | Hook relay path, guarded by the governor |
| 7b. Fan-out policy | 1–1.5 days | Planner fields + `fanout-policy.ts` arithmetic + circuit breakers |
| 7c. Pacing controller | 1–1.5 days | Fair-share maths, effort ladder, window-boundary bookkeeping |
| 8. Security officer | 1.5–2.5 days | Deny-list extension is hours; per-tool + path evaluators and restore points are the bulk |
| 9. Stand-up | 2–3 days | `workspacePath` migration, aggregation, cached narration, new route |

**Total: roughly 14–23 working days — call it 4 weeks solo**, with steps 5 and 9 carrying most of the risk.

Two natural stopping points, both of which stand alone:

- **~1 hour** — step 0 alone. Changes the economics more than anything else on this list, requires no fork, and is worth doing even if you never build the rest.
- **~3–4 days** (steps 1–3, after the learning ramp) — the full GUI: per-agent context remaining, account usage bars, overall and per-employee completion. That is requirement 6 delivered, with zero governor code, and it tells you whether the telemetry is trustworthy before you build enforcement on top of it.

Steps 4–9 are where you commit to owning a fork. Within those, **step 8's deny-list extension is worth pulling forward** — adding the git- and data-destructive patterns to `command-policy.ts` is a few hours against an existing, already-enforced function, and it closes the most realistic way an unattended agent destroys a day's work. Do that before the first overnight run, whatever else slips.

## Verification

1. `pnpm install && pnpm setup && pnpm dev` — gateway + Vite on `localhost:5173`.
2. **Sensor:** start one Claude session; confirm `~/.jinn/tmp/engine-limits/claude/<sessionId>.json` appears and `rate_limits.five_hour.used_percentage` updates per assistant message. This validates the premise before any code is written — **do this first**.
3. **Telemetry/GUI:** run two employees concurrently; both rows appear, account rollup shows the max not the freshest.
4. **Governor:** unit-test `evaluateGovernor` at 79/80/81%. Then force it by setting `fiveHourStopPct: 5` in config and confirm spawns are blocked and the bar turns red — do not wait for a real 80%.
5. **Handoff/resume:** with the low threshold still set, confirm handoff files are written, the work item records the path, a one-shot job is scheduled at `resets_at + 60s`, and the resumed session reads the handoff. Temporarily stub `resets_at` to ~2 minutes out to test without waiting 5 hours.
6. **Compaction:** run a long session to 80% context; confirm handoff-then-compact and that `SessionStart(source: "compact")` re-injects it.
7. `pnpm test` (vitest) plus a new regression test that the `waiting` state clears without user input.
8. **Security officer:** unit-test the extended deny-list against both the destructive forms (`git reset --hard`, `git clean -fdx`, `rm -rf` inside the mount, `DROP TABLE`, `> tracked-file`) and the safe near-misses that must still pass (`git reset --soft`, `git push --force-with-lease`, `DELETE FROM t WHERE id=1`). Then confirm end-to-end that a blocked `Write` returns 451 and lands as an activity receipt attributed to the `security` employee. Verify a restore point exists (`git show refs/jinn/<sessionId>`) and actually restores. **Also confirm the bypasses fail as expected** — try a base64-obfuscated `rm` and a write-then-execute script, and record which ones get through, so the deny-list's real coverage is documented rather than assumed.
9. **Stand-up:** two projects × two departments with mixed statuses, some blocked items and some resolved comments. Confirm counts match the underlying tree, the narrative reflects actual comment history rather than hallucinating, the cache doesn't re-summarize unchanged windows, and summarization runs on the configured cheap engine — check the snapshot's `model` field, don't assume.
10. End-to-end: one root todo with 5 sub-tasks, threshold at 5%, fully unattended — expect work → halt → handoff → resume → completion, with the GUI never going stale.

## Risks

- **Fork maintenance.** Jinn is beta with active development (last push Aug 5, 2026). Steps 1–3 are additive and upstreamable; step 4 touches the dispatch seam and will conflict. Keep the governor in its own modules with minimal call-site edits, and consider a PR upstream.
- **The command gate is a speed bump, not a sandbox.** Correcting an earlier assumption: Jinn is not ungated — `shared/command-policy.ts` + the `PreToolUse` check in `gateway/hook-endpoint.ts` already block a class of destructive commands (see step 8). But it is a **regex deny-list running inside a session launched with `--dangerously-skip-permissions`**, and a deny-list cannot deliver "never." `$(echo cm0K | base64 -d) -rf .`, a different binary, or a script written to disk and then executed all walk straight past it. Treat step 8 as raising the floor; the ceiling is OS-level — the Docker path with only the project mounted, or a restricted user account. Say this out loud before trusting it overnight.
- **Statusline-only telemetry updates on assistant messages**, so an idle session's snapshot goes stale. The 30-min staleness rule must be shown in the GUI rather than presenting stale numbers as live.
- 80% of the 7-day window can arrive mid-task and halt everything for days. Worth a distinct GUI treatment from the 5-hour halt.
