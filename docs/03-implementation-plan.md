# Implementation plan — Tengu (a Jinn fork)

Consolidated build plan. Supersedes the earlier draft; incorporates decisions **D1–D12** from
[01-decisions.md](01-decisions.md). Design rationale lives in the topic docs — this file is what you
execute.

---

## Goal

An autonomous, usage-governed agent org on a Claude Max 5x subscription: decompose work, hammer at it
continuously and unattended, govern its own usage, checkpoint so nothing is redone, hand off and
resume cleanly, and make all of it legible in a dashboard.

### Requirements

| # | Requirement | Steps |
|---|---|---|
| 1 | Decompose into task → sub-task → sub-sub-task | 0, 12 |
| 2 | Work the backlog continuously | 8 |
| 3 | Track usage; stop at 80% | 1, 4 |
| 4 | On halt: log work, resume automatically next window | 5, 6 |
| 5 | Compact context at 80%, carry a handoff | 7 |
| 6 | GUI: context/usage per agent, work complete overall and per agent | 2, 3 |
| 7 | Stand-up per project × department | 11 |
| 8 | Security officer — no wiped work, no destructive commands | 10 |
| 9 | Two profiles (personal / work), per-service agents, council flow | 12 |
| 10 | Idempotent checkpoints — an interrupted session redoes almost nothing | 5 |

### Environment

Claude Max 5x. Claude Code **2.1.185** (`/opt/homebrew/Caskroom/claude-code/2.1.185/claude`), Node
**v25.9.0**. Nothing installed yet — no `~/.jinn`, `jinn` not on PATH.

---

## The five decisions that shape everything

Full reasoning in [01-decisions.md](01-decisions.md); the load-bearing ones:

**Fork Jinn, not OpenClaw** (D1). Jinn has the work model — todo tree, employees, departments,
delegation, per-session limits data. OpenClaw has a better usage UI and no ledger at all. The governor
is unbuilt in both.

**Model mix is worth more than the governor** (D3). Opus draws from its own small weekly bucket
(~15–35h vs ~140–280h for Sonnet on Max 5x). An all-Opus loop dies in 2–4 days. Opus planner → **Sonnet
executor** → Opus reviewer moves ~85% of volume off the scarce bucket. **Config only, no fork — do it
first.**

**Sequential by default, bounded fan-out** (D2→D7). The 5-hour limit caps *usage per window*, so
parallelism doesn't raise the ceiling — it reaches it sooner and then idles, while paying ~25–50%
duplicated orientation. Fan-out buys latency, not throughput. Cap 2–3, only for genuinely independent
contexts.

**Spend the window, protect the week** (D9). Unused 5-hour capacity is *destroyed* at reset, but you
can't fill every window without ending the week early. Pace to a fair share derived from the weekly
budget. **`effort` is the primary throttle, fan-out second** — effort burns budget with no duplication,
no merge risk, no mid-flight-halt risk.

**Interruption is the normal case** (D12). The governor halts several times a day, so checkpointing is
the execution model, not recovery tooling.

---

## What already exists upstream

Condensed from [02-findings.md](02-findings.md) — all `/contents/`-API verified.

| Need | Already there |
|---|---|
| Usage sensor | `shared/claude-settings.ts` writes `rate_limits` + `context_window` per session to `~/.jinn/tmp/engine-limits/claude/<sessionId>.json`, **free** (statusline runs locally) |
| Limits collection | `shared/engine-limits.ts` — OAuth API, statusline snapshot fallback, 30-min staleness |
| Enforcement seam | `gateway/budgets.ts` blocks in `runWebSession` before the engine runs, across all dispatch paths |
| Command gate | `shared/command-policy.ts` + `PreToolUse`→HTTP 451 in `gateway/hook-endpoint.ts` |
| Todo tree | `work-items/` — `parentId`/`rootId`/`depth≤3`, status, assignee, comments, transitions, **`reconcile.ts`** |
| Departments | `work-items/departments.ts` — user-defined slugs, `department` column on work items |
| Profiles | `shared/home.ts` (`JINN_HOME`/`JINN_INSTANCE`) + `src/instances/` — **first-class, zero code** |
| Pipelines | `src/workflows/` + `gateway/workflow-todo-binding.ts` — sequential/conditional/parallel/switch, per-phase model, approval gates |
| Knowledge bases | **Skills** (`gateway/skills.ts`) — there is no knowledge subsystem |
| Frontend | `packages/web/src/routes/` incl. an existing `limits/` page to extend |

**Three upstream behaviours that must change:**

1. `gateway/rate-limit-waiting-resume.ts` — the `waiting` state clears **only on a user message**. Unattended resume silently never fires without a fix. (Step 6)
2. `buildInteractiveArgs()` passes `--disallowedTools AskUserQuestion,ExitPlanMode` — agents cannot ask clarifying questions. (Step 12)
3. `buildPtyEnv()` sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000`, which may push auto-compact past a 200k ceiling. **Verify empirically.** (Step 7)

---

## Architecture

```
                    ┌──────────── governor (deterministic) ────────────┐
                    │  usage 80% → halt    context 80% → compact       │
                    │  soft ceiling 75% → stop at a unit boundary      │
                    │  pacing controller → effort ladder, then fan-out │
                    └──────────────────────┬───────────────────────────┘
                                           │ gates every dispatch
  project (root)                           ▼
   └── task              ┌─────────── session ───────────┐
       └── sub-task ─────┤  one sub-task per session     │
           └── sub-sub-task  │  many units; each = commit + status
                             └────────────────────────────┘
```

**Personal profile** (`JINN_INSTANCE=personal`): `planner` · `engineer` · `reviewer` · `security` ·
`scribe`. Departments are labels on work items, one executor covers all of them (D6).

**Work profile** (`JINN_INSTANCE=work`): `council` (replaces `planner`) · one **senior Sonnet employee
per service** · `reviewer` · `security` · `scribe`. Per-service agents are justified here because the
contexts genuinely differ — separate repos, separate domains (D11).

---

## Build steps

Steps 1–3 deliver the GUI standalone. Steps 4–8 are the governed loop. 9–12 are the rest.

### 0. Config & model mix — *no fork, ~1 hour*

Employees in `~/.{instance}/employees/`:

| Employee | Rank | Model | Effort | Role |
|---|---|---|---|---|
| `planner` | executive | Opus 5 | `high` | Decompose into department-tagged, `verify`-carrying units |
| `engineer` | employee | **Sonnet 5** | `medium` | The code/test loop, all departments |
| `reviewer` | manager | Opus 5 | `high` | Approve/reject at **parent-todo gates only** |
| `security` | executive | — (`system: true`) | — | Policy + restore points; zero tokens |
| `scribe` | employee | Haiku / Sonnet `low` | `low` | Stand-up narration (add with step 11) |

Reporting: `planner → reviewer → engineer`; `security` outside the chain.

Personas carry the efficiency instructions from [04-efficiency.md](04-efficiency.md): `engineer` gets
scope discipline, **no verification scaffolding** (current models self-verify; telling them to verify
causes redundant work), a subagent cap, conciseness, and ledger-before-filesystem on resume.
`reviewer` gets report-everything-filter-downstream — conservative review instructions are followed
literally and depress recall.

Confirm YAML field names against `packages/jinn/template/`.

### 1. Per-session telemetry — *0.5–1 day*

New `shared/session-telemetry.ts`. Scan `CLAUDE_LIMITS_DIR`, parse each `<sessionId>.json`, join to
the session registry and employee identity. Emit per session: `contextUsedPct`, `fiveHourUsedPct`,
`fiveHourResetsAt`, `sevenDayUsedPct`, `sevenDayResetsAt`, `costUsd`, `capturedAt`, `stale`.

Account rollup takes the **max** across snapshots (the freshest-file heuristic in `engine-limits.ts`
under-reports with concurrent sessions). Reuse its parsing and 30-min staleness rule.

**Also persist `sevenDay.used%` at each 5-hour window boundary** — step 9's fair-share maths needs the
per-window delta.

### 2. Live GUI surface — *1–2 days*

**Corrected per [D16](01-decisions.md#d16--ui-extends-jinns-existing-screens-no-standalone-telemetrybar-corrects-step-2)/[15-ui-ux.md](15-ui-ux.md)** — verified against actual source rather than assumed. Jinn's
nav has no persistent top bar anywhere (56px icon rail + floating pills, deliberately); a standalone
`TelemetryBar` mounted in a shared layout doesn't fit and would be the most visible way to make this
feel bolted-on.

`session.telemetry` event in `packages/gateway-events/src/index.ts`, broadcast on the existing
live-events channel, debounced ~1s. New `web/src/hooks/use-session-telemetry.ts` (model on
`routes/limits/use-engine-limits.ts`). Extend `routes/limits/page.tsx` — it already has exactly the
right visual vocabulary (status-dot cards, threshold-colored progress bars at 90%, reset countdowns):
add a per-session card section (model, context remaining %, current todo) alongside the existing
per-engine cards, plus a pacing/fan-out state strip at the top. Ambient awareness from any screen via a
small status dot on the Limits rail icon itself — green/amber/red, same language Cron already uses —
rather than new chrome. Green <60 / amber 60–80 / red ≥80.

### 3. Progress rollups — *0.5–1 day*

New `work-items/progress.ts` — `computeRootProgress(rootId)` (completed vs total descendants over the
`parentId`/`rootId` tree, terminal states from `transitions.ts`) and `computeEmployeeProgress()`. Ship
on the same event as step 1.

### 4. Governor — *1–2 days*

Grow `shared/usageAwareness.ts` (currently warn-only, fixed 6-hour heuristic, no thresholds). Add
`GovernorConfig` under a `governor:` section in config, and
`evaluateGovernor(telemetry, config) → { action: "run" | "handoff" | "halt", reason, resumeAt }`.
Track **both** windows — the 7-day cap is the harder stop.

Enforce at the **same call site as `isBudgetExhausted()`** in `runWebSession`, which already covers
web, API, delegation and workflow paths. A `halt` blocks the spawn with a clear assistant message.

### 5. Checkpointing & idempotency — *2–3 days*

[10-checkpointing.md](10-checkpointing.md). **Do this before step 6** — the handoff depends on it.

- **One sub-task per session; sub-sub-tasks (depth 3, ~10–20 min) are the atomic checkpoint.** Size so
  losing one to a hard cut is cheap.
- **A checkpoint is a pair, commit first:** git commit `JIN-42.3: <what>` **then** ledger status.
  Status-without-commit is the only unrecoverable ordering.
- **`verify` field on every sub-sub-task** — a machine-checkable command. Execution: run `verify` →
  pass means mark done and skip → else do work → commit → re-`verify` → mark done. Planner rule: *no
  machine-checkable done-criterion means it isn't decomposed enough.* Route `verify` through
  `evaluateCommandPolicy` — it's model-generated shell.
- **Reconcile on resume** (extend `work-items/reconcile.ts`): `verify` each not-done unit; passing
  means the crash landed between work and status. Zero model tokens. Order: **reconcile → ledger →
  handoff → work.** Ledger authoritative, handoff narrative.
- **WIP rescue:** hard cut commits on-disk edits to `refs/jinn/wip/<sessionId>`, recorded in the
  handoff.

**Check first:** is `depth` 0-indexed in `work-items/relations.ts`? Root/task/sub-task/sub-sub-task is
0/1/2/3 and fits `depth ≤ 3` if so. Fallback if blocked: a `verify`-per-item checklist inside the
sub-task body (weaker — no transitions, not countable in the stand-up).

### 6. Halt, handoff, auto-resume — *2–3 days* · **highest risk**

New `sessions/handoff.ts`. On `action: "handoff"`:

1. Write `~/.{instance}/handoffs/<employee>-<todoId>.md` — **in-flight state only** (interrupted unit,
   what was tried, WIP ref, surprises). The ledger already records what was done, so this is small.
2. Run `/compact` — compresses history, knowledge survives.
3. Halt.
4. **Resume the same session** at reset via `--resume` (D4). A fresh session pays full re-orientation;
   resuming an *uncompacted* one re-sends a huge history. Compact-then-resume gets both.

Schedule from `five_hour.resets_at + 60s`. Jinn's cron is expression-based, so add a one-shot `runAt`
kind across `cron/{validation,jobs,scheduler}.ts` — **confirm the existing job schema first.**

⚠️ **`gateway/rate-limit-waiting-resume.ts` clears `waiting` only on a user message.** The governor's
resume must clear it programmatically or unattended restart silently never happens. Regression test
required.

### 7. Context compaction — *1–2 days*

**Context pressure ≠ usage pressure** (D5). Context at 80% → `/compact` **in place**, keep the session,
stay warm. Only a usage halt ends a session.

First **verify empirically** what `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000` does on a 200k model — if
it defers compaction past the ceiling, sessions hit a wall instead of compacting, which must be fixed
regardless. `SessionStart` fires again with `source: "compact"` — use it to re-inject the handoff.

### 8. Continuous loop — *~1 day*

On `Stop`: if the governor says `run` and there's an open todo, dispatch the next unit instead of
idling. Implement in the hook relay path (`gateway/hook-registry.ts` / `hook-endpoint.ts`).

**Assignment is a query, not a model call** — next open sub-task by priority. No dispatcher employee.

**Exclude `interactive: true` employees** (the council) from continuation, or it answers its own
clarifying questions.

### 9. Pacing controller & fan-out — *2–3 days*

New `shared/pacing-controller.ts` and `shared/fanout-policy.ts`. Evaluated on every (free) telemetry
write plus a 60s idle tick — **not a polling agent**: it's arithmetic, and ~48 cold-start sessions/day
would spend the budget it exists to protect.

**Pacing** ([08](08-pacing-controller.md)):
```
fairShare = weeklyRemaining / windowsLeftInWeek
paceRatio = spentThisWindow / (fairShare × windowElapsed)
  < 0.8 and windowElapsed > 0.6  → accelerate
  0.8 – 1.2                      → hold
  > 1.2                          → throttle
```
Ladder: accelerate `effort medium→high→xhigh` **then** `fanout 1→2→3`; throttle in reverse. **Soft
ceiling ~75%** — don't start a unit that would cross 80%. **No fan-out past 85% window elapsed.**
Modes `even` / **`balanced` (default)** / `eager`.

**Fan-out** ([07](07-fanout-policy.md)) — two gates, uncertainty resolves to sequential:
- *Planning time:* `planner`/`council` sets `parallelSafe` (**defaults false**) and `parallelGroup`,
  justified in the todo body — distinct `workspacePath` or read-only, no shared files, no ordering
  dependency. New fields on `work-items/store.ts`.
- *Runtime:* `allowFanout(telemetry, history, config) → 1|2|3`. Requires ≥90 min runway, projected 5h
  spend <60%, and **≥20 completed todos of cost history** — so the first week is sequential by
  construction and the policy turns on with measured numbers.

Runtime can only **downgrade**. Circuit breakers: member halted mid-flight → off for the window; pace
>1.0 or merge conflict → off for the week; worse cost-per-todo over 10 samples → auto-disable and flag.

Surface mode **and reason**: *"Sequential — weekly pace 1.3× budget"*.

### 10. Security officer — *1.5–2.5 days*

Hardening, not greenfield. `evaluateCommandPolicy` + the `PreToolUse`→451 path already exist. Four gaps:

1. **Bash-only** — extend `hook-endpoint.ts` dispatch to `Write`/`Edit`/`NotebookEdit`.
2. **No git/data-destructive patterns** — add `git reset --hard`, `checkout -- .`, `clean -fd(x)`,
   `push --force` (allow `--force-with-lease`), `branch -D`, `stash drop/clear`, `DROP TABLE`,
   `TRUNCATE`, `DELETE FROM` without `WHERE`, single-`>` truncation of tracked files. **These are the
   realistic ways an agent destroys work** — far likelier than `mkfs`.
3. **No workspace confinement** — canonical-path resolution; reject escapes from the employee's `cwd`.
4. **Refusal without recovery** — new `security/restore-points.ts`: before the first mutating call,
   write `refs/jinn/<sessionId>`. Turns "wiped out" into "restorable."

Make it a `system: true` executive employee so blocks become attributed activity receipts visible in
the stand-up. **Note:** `autoApproveSafetyPrompts` dismisses Claude's own dialogs, so this policy is
the only gate — it must evaluate before auto-approval.

**Pull items 2 and 4 forward before the first unattended overnight run.** Hours of work against an
already-enforced function.

### 11. Stand-up — *2–3 days*

New `work-items/standup.ts` + `web/src/routes/standup/page.tsx`.

**Projects need identity** — add `workspacePath` to root items (root = project, matching
one-root-per-outcome). Per (project × department): reuse `computeRootProgress` filtered by the
`department` column, plus the raw event log from `transitions.ts`/`comments.ts`/approvals.

**Narrate the issues** — "what we hit, how we solved it" is prose, so summarize with `scribe` (Haiku /
Sonnet `low`), **cached by (project, department, latest-event-timestamp)**. Never on Opus: a fixed
recurring background job must not compete with the work.

Cron produces a scheduled snapshot plus on-demand refresh. Security blocks and circuit-breaker trips
appear inline as incidents.

### 13. Process supervision — *~1 day*

Full reasoning in [12-deployment-and-ux.md](12-deployment-and-ux.md). Mechanical, no Jinn-internal
code — the gap is that **upstream has no daemon supervisor at all** (confirmed: no `service` block in
the Homebrew formula, no systemd/launchd files anywhere in the repo; Docker's `restart: unless-stopped`
only survives container crashes, not a laptop going to sleep).

- `launchd` `.plist` (macOS, `RunAtLoad: true`) / systemd user unit (Linux, `WantedBy=default.target`
  + `systemctl --user enable`), **starts on boot/login and restarts on failure** (D14 — locked, not
  optional). Required regardless of everything else — closing the laptop lid suspends the `node-pty`
  child processes mid-unit, below any layer the governor can recover from.
- `caffeinate` / `systemd-inhibit` wrapper, **gated on pacing-controller state** — assert only while
  there's queued work, or it defeats the controller's own decision to idle overnight for weekly-budget
  reasons. Small addition to `shared/pacing-controller.ts`, not a new module. **Covers idle-sleep with
  the lid open only — does not prevent lid-close sleep on macOS at all** (`caffeinate` never sees the
  lid-close signal; corrected in [14-lid-close-mode.md](14-lid-close-mode.md) after an earlier wrong
  assumption here).
- **If this runs on a laptop with the lid actually closed:** macOS clamshell mode via a dummy display
  adapter (~$10–15) is the real mechanism — see [14-lid-close-mode.md](14-lid-close-mode.md) for setup,
  the Bluetooth-unpairing gotcha, and the `pmset disablesleep` footgun if layered on top. Verify with an
  actual overnight run before trusting it — reported behavior varies by macOS version. Not needed at
  all if running on a rented always-on box instead ([13-costs.md](13-costs.md)).
- `tengu service install/start/stop/status` CLI subcommands.

**Explicitly not building:** an Electron/Tauri wrapper. It doesn't address the actual gap (the daemon
still has to be running somewhere) and it's the single most against-the-grain thing we could add to the
fork — permanently divergent, nothing to merge back. The web dashboard already is the app; a pinned
browser tab plus real OS notifications on halt/resume/council-input covers what people actually want
from "an app." A menu-bar status glancer (~50-line poller against the existing telemetry API) is real
value and cheap, but deferred — additive polish, not core.

**Open before building:** does this run on the daily laptop, or a dedicated always-on box? Changes
whether the sleep-prevention piece matters at all.

### 12. Work profile & council — *4–6 days*

[09-work-profile-and-council.md](09-work-profile-and-council.md).

**Profiles are free** — `JINN_INSTANCE=personal` / `=work`. Separate employees, skills, cron, ledger,
DB, port.

**Roster:** `council` (executive, Opus, `interactive: true`) replaces `planner`; one senior Sonnet
employee per service (`onboarding`, `kyc`, `mobile-backend`, `app`, `address-service`), each with
`cwd` = its repo and a Jinn **skill** as knowledge base.

**Council flow:** intake (interactive Opus, asks in chat) → impact triage against a service registry
(Opus) → **parallel read-only consultation** by each affected service (Sonnet) → synthesis into a
dependency graph, todo tree with `verify` leaves, and a generated **Jinn workflow** (Opus) →
**mandatory human approval** → governed execution.

Phase 4 is the value: matching contract *requests* against *provisions* across services, and flagging
unmatched ones — what nobody is providing but someone needs.

**Knowledge bases:** `SERVICE.md` per repo (purpose, owns, contracts, integration points, invariants,
gotchas) as a Jinn skill. One-time bootstrap per service — a council consulting empty knowledge bases
produces confident nonsense. Each completed todo appends what was learned, or they rot in a month.

⚠️ **Cross-instance governor.** Both profiles share one Claude account and one set of limits, but each
instance's governor sees only its own sessions. Two instances each pacing to "fair share" spend double.
**Shared account-level state outside either home is required before running both concurrently.**

---

## Files

**New:** `shared/{session-telemetry,pacing-controller,fanout-policy}.ts`,
`work-items/{progress,standup}.ts`, `sessions/handoff.ts`, `security/restore-points.ts`,
`web/src/hooks/use-session-telemetry.ts`, `web/src/components/TelemetryBar.tsx`,
`web/src/routes/standup/page.tsx`

**Modified:** `shared/{usageAwareness,engine-limits,command-policy,config}.ts`,
`gateway/{hook-endpoint,hook-registry,budgets,rate-limit-waiting-resume}.ts`,
`engines/claude-interactive.ts` (`buildPtyEnv`; `autoApproveSafetyPrompts` ordering),
`work-items/{store,relations,departments,reconcile}.ts`, `cron/{validation,jobs,scheduler}.ts`,
`packages/gateway-events/src/index.ts`, `web/src/routes/{limits/page,providers}.tsx`

---

## Effort

| Step | Est. |
|---|---|
| 0. Config & model mix | **~1 hour** |
| Learning the codebase | 1–2 days |
| 1–3. Telemetry, GUI, rollups | 2–4 days |
| 4. Governor | 1–2 days |
| 5. Checkpointing | 2–3 days |
| 6. Halt/handoff/resume | 2–3 days |
| 7. Compaction | 1–2 days |
| 8. Continuous loop | ~1 day |
| 9. Pacing & fan-out | 2–3 days |
| 10. Security officer | 1.5–2.5 days |
| 11. Stand-up | 2–3 days |
| 12. Work profile & council | 4–6 days |

**~4–5 weeks for the personal profile; ~6–7 including work profile and council.** Steps 6 and 12 carry
most of the risk.

**Three stopping points that stand alone:**
- **~1 hour** — step 0. Moves the economics more than everything else combined; no fork.
- **~3–4 days** — steps 1–3. The full GUI, zero governor code, and it tells you whether the telemetry
  is trustworthy before you build enforcement on it.
- **~2 weeks** — through step 8. A working governed continuous loop.

---

## Verification

1. `pnpm install && pnpm setup && pnpm dev` — gateway + Vite on `localhost:5173`.
2. **Sensor first, before writing code:** start one session, confirm
   `~/.jinn/tmp/engine-limits/claude/<sessionId>.json` appears and `five_hour.used_percentage` updates
   per assistant message. Everything downstream rests on this.
3. **Depth:** confirm `depth` indexing in `work-items/relations.ts` before designing the tree.
4. **Telemetry/GUI:** two concurrent employees — both rows appear, account rollup shows max not
   freshest.
5. **Governor:** unit-test at 79/80/81%. Force it by setting `fiveHourStopPct: 5` — don't wait for a
   real 80%.
6. **Checkpointing:** interrupt mid-sub-task; confirm completed units are not redone, `verify`
   short-circuits them, reconcile marks the crash-window unit done, and WIP ref restores.
7. **Handoff/resume:** with the low threshold, confirm handoff written, work item records the path,
   one-shot job scheduled at `resets_at + 60s`, and the session **resumes rather than respawning**.
   Stub `resets_at` ~2 minutes out. **Regression test: `waiting` clears without user input.**
8. **Compaction:** run to 80% context; confirm compact-in-place, session survives, and
   `SessionStart(source: "compact")` re-injects the handoff.
9. **Pacing:** unit-test `paceRatio` across window/week positions; confirm the effort ladder moves
   before fan-out and that no fan-out occurs past 85% window elapsed.
10. **Security:** test destructive forms (`git reset --hard`, `clean -fdx`, `DROP TABLE`,
    `> tracked-file`) **and safe near-misses that must pass** (`reset --soft`, `--force-with-lease`,
    `DELETE ... WHERE`). Confirm a blocked `Write` returns 451 and lands as an attributed receipt, and
    `refs/jinn/<sessionId>` restores. **Also confirm known bypasses fail** — base64-obfuscated `rm`,
    write-then-execute — and document what gets through.
11. **Stand-up:** two projects × two departments, mixed statuses; counts match the tree, narrative
    reflects real comments, cache doesn't re-summarize, and the snapshot's `model` is the cheap engine.
12. **Council:** a two-service project — confirm it asks clarifying questions in chat and **does not
    auto-continue**, triage explains inclusions, consultations run in parallel, synthesis flags an
    unmatched contract, and nothing executes before approval.
13. **End-to-end:** one root, 5 sub-tasks, threshold at 5%, fully unattended — work → clean stop →
    handoff → resume → completion, GUI never stale, nothing redone.

---

## Risks

- **The command gate is a speed bump, not a sandbox.** A regex deny-list inside a session launched with
  `--dangerously-skip-permissions` cannot deliver "never" — `$(echo cm0K | base64 -d) -rf .`, a
  different binary, or write-then-execute all walk past it. Step 10 raises the floor; the ceiling is
  OS-level (Docker with only the project mounted, or a restricted user). Say this out loud before
  trusting it overnight.
- **Fork maintenance.** Jinn is beta, ~301 stars, effectively one maintainer, actively pushed. Steps
  1–3 and 11 are additive and upstreamable; 4–9 touch the dispatch seam and will conflict. Keep the
  governor in its own modules with minimal call-site edits.
- **Cross-instance budget double-spend** (step 12) — two governors, one account.
- **Stale telemetry presented as live.** Statusline only updates on assistant messages, so an idle
  session's snapshot goes stale. Show the 30-min staleness rule in the GUI.
- **Overnight running is what makes the weekly cap bind.** ~8h/night × 7 before any daytime use. Expect
  throttling and idle stretches late in the week — that's the design working. The stand-up must show
  *why*, or a quiet Friday looks like a failure.
- **Knowledge-base rot** (step 12). Without the append-after-each-todo habit, council routing degrades
  silently — it confidently routes around a service that actually changed.
