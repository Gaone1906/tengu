# Decision log

Newest decisions at the bottom. Each records what we chose, the reasoning, and what we rejected.

---

## D1 — Fork Jinn, not OpenClaw

**Chosen:** fork `hristo2612/jinn`. Our fork is named **Tengu** — see the README's naming note.

Both are MIT TypeScript pnpm monorepos with a local gateway daemon and a web dashboard, but they're
built for different jobs.

| | Jinn (301★) | OpenClaw (385k★) |
|---|---|---|
| Built for | An agent **work org** | A **personal assistant** on messaging channels |
| Multi-agent | Employees, departments, ranks, delegation | Isolated **personas routed by channel**; peers, no hierarchy |
| Todo ledger | ✅ `WorkItem` tree (`parentId`/`rootId`/`depth`≤3) | ❌ none |
| Claude limits data | ✅ **per session** | ✅ account-level only |
| Limits UI | ❌ account-level page only | ✅ per-window bars with reset times |
| Threshold enforcement | ❌ | ❌ **display-only** |

**Reasoning:** the governor is unbuilt in both, so requirements 3–5 are net-new either way. The
choice comes down to what's free underneath. Jinn gives the work model — todo hierarchy, assignees,
departments, delegation — which *is* requirements 1, 2, 7, and half of 6. OpenClaw has no todo ledger
at all, and its channel-routed persona model actively resists one. Jinn also writes limits **per
session**, which is what "context remaining per agent" needs; OpenClaw's is account-level.

**Rejected:** OpenClaw (wrong shape, and forking a 385k-star project moving that fast is its own tax);
`claw-orchestrator` (542★, has an Autoloop planner/coder/reviewer pattern worth reading, but no todo
ledger and no usage tracking).

**Steal anyway:** OpenClaw's Control UI per-window usage bars are the design to copy for the GUI.

---

## D2 — Continuous, not concurrent

Single agent working the backlog without stopping. See [00-context.md](00-context.md#execution-model).
Removes worktree isolation, concurrency control, and fleet UI from scope.

---

## D3 — Model mix: Opus planner → Sonnet executor → Opus reviewer

**This is the highest-leverage decision in the design, and it needs no fork.**

On a subscription the per-token ratio is the wrong number. Opus 5 is $5/$25 per Mtok vs Sonnet 5's
$3/$15 — only ~1.67×, so on the API the swap looks marginal. But we're metered against buckets, and
**on Max plans Opus draws from its own separate 5-hour and weekly buckets**, sized far smaller.
Published estimates for Max 5x: ~**15–35 hours of Opus** vs ~**140–280 hours of Sonnet** per week
(~9× more headroom). Claude's Settings → Usage confirms the split by showing separate reset timers
for Opus and for everything else.

So: an all-Opus continuous loop is capped by the Opus weekly bucket and exhausts it in **2–4 days**.
No governor tuning moves that wall.

| Role | ~Share of tokens | Model | Bucket |
|---|---|---|---|
| Planner (once per task) | ~5% | Opus 5 | Opus (scarce) |
| Executor (code/test loop) | ~85% | Sonnet 5 | General (~9× larger) |
| Reviewer (per gate) | ~10% | Opus 5 | Opus (scarce) |

Moves ~85% of volume off the scarce bucket. Sonnet 5 supports this — it reaches near-Opus quality on
coding and agentic work specifically, which is the executor's job.

**The thing that spoils it:** reviewer frequency. If Opus reviews *every* sub-task and sub-tasks are
small, review climbs from ~10% toward 30% and we're back on the Opus bucket. **Gate review at the
parent todo, not per sub-task.**

**Second lever:** `effort` moves cost more than model choice within a tier. Executor at `medium`,
planner/reviewer at `high`. Sweep before committing.

**Implementation:** pure Jinn config — employees bound to engines/models, workflows with per-phase
model selection. Do it first, before any fork work.

---

## D4 — Resume the same session, don't spawn a fresh one

*(from the efficiency discussion — see [04-efficiency.md](04-efficiency.md))*

Jinn's cron mints a **fresh** session per fire. For a usage-limit resume that's the wrong shape: every
resume pays a full cold rebuild (re-read the plan, re-orient in the repo, cold prompt cache). At ~4–5
halts a day that's a large fraction of total spend.

`claude-interactive.ts` already passes `--resume` when resuming, so the machinery exists. Prefer
resuming the halted session; fall back to fresh-session-plus-handoff only when the session is
genuinely unrecoverable.

---

## D5 — Separate context pressure from usage pressure

*(from the efficiency discussion)*

These are different events with different correct responses, and the original plan conflated them:

- **Context at 80%** → `/compact` **in place**. Cheap, keeps the session, keeps the cache warm.
  Handoff file is a safety net, not the mechanism.
- **Usage at 80%** → halt + handoff + wait for reset. Expensive and unavoidable.

Only the second should ever end a session.

---

## D6 — Departments are labels, not agents

*(see [05-org-structure.md](05-org-structure.md))*

Starting roster is **4 employees**: `planner` (Opus, executive), `engineer` (Sonnet, employee),
`reviewer` (Opus, manager), `security` (system, executive, zero tokens). One executor handles backend,
frontend, and database work in a single warm session.

**Reasoning:** in a continuous single-threaded model, every employee switch is a session switch and
therefore a cold start (~20–30% of spend). One-agent-per-department pays that tax on every handoff for
no benefit. Departments already exist as a **column on `work_items`** — the planner tags sub-tasks,
the stand-up groups by the column, and the departmental report works with one executor.

Promote a department to its own employee only when the context it needs genuinely differs (different
repo/stack/credentials), not merely when the subject matter differs. The ledger doesn't change when
you do.

**Rejected:** a QA/tester employee (testing is inside the engineer's loop); a coordinator/dispatcher
(assignment is a `SELECT`, not an LLM call); one agent per department up front.

**Add early:** a `scribe` on Haiku/Sonnet-`low` for stand-up narration — it's a fixed recurring
background cost and must not sit on the work's engine.

---

## D7 — Sequential default, bounded fan-out (amends D2)

*(see [06-concurrency.md](06-concurrency.md))*

Re-examined 1 agent × 10 tasks vs 10 agents × 1 task. **Not token-equivalent**: ten agents duplicate
orientation (~9×O, roughly 25–50% overhead for related tasks in one repo), plus merge coordination and
a burst of simultaneous Opus review gates.

**The throughput intuition inverts.** The 5-hour limit caps *usage* in a rolling window, so work
available per window is fixed by the cap, not by concurrency. Parallelism doesn't raise the ceiling —
it reaches it in ~45 minutes and then idles ~4h15m, delivering *less* total work because of the
duplication overhead. For sustained operation the weekly cap binds, and higher tokens-per-task means
lower weekly output. Parallelism buys **latency, not throughput**.

Context-window pressure genuinely does drop with single-task agents — but compaction is the cheap,
already-solved problem; trading it for duplicated orientation and merge cost is a bad exchange.

**Amendment to D2:** sequential remains the default for sustained backlog work. Allow bounded fan-out
— **cap 2–3** — for genuinely independent contexts (separate repos/services), freely for read-only
investigation, and deliberately for deadline bursts with headroom. Fan-out must be **governor-aware**:
only when 5-hour and 7-day usage are both well under threshold.

Executor fan-out is cheaper than it looks (Sonnet draws from the ~9× bucket), but the review burst
still lands on Opus.

**Measure, don't argue:** compare cost-per-completed-todo for a sequential batch vs a fanned-out one
once the loop runs. Raise the cap if duplication is smaller than estimated.

---

## D8 — Fan-out is planner-annotated, budget-gated, and fails closed

*(see [07-fanout-policy.md](07-fanout-policy.md))*

**The executor never decides.** Current models over-delegate by default, so "let the agent judge"
optimises for the behaviour we're bounding. Instead: **a planning-time annotation validated by a
runtime budget gate**, both must pass, uncertainty resolves to sequential.

- **Gate 1 (planning):** `planner` sets `parallelSafe` (**defaults false**) and `parallelGroup`,
  justified in the todo body — requires a distinct `workspacePath` or read-only work, no shared files,
  no ordering dependency. Judged once, by the most capable model, with full decomposition context.
- **Gate 2 (runtime):** `shared/fanout-policy.ts` — pure arithmetic, no model call. Weekly **pace
  ratio** (`sevenDay.used% ÷ weekElapsedFraction`) is the primary brake; plus ≥90 min window runway,
  projected 5h spend < 60%, and **≥20 completed todos of cost history** before fan-out is ever
  permitted.

Degree ladder: `<15%/<30%` → 3, `<30%/<50%` → 2, else 1. Hard cap 3. Runtime can only **downgrade**.

Every threshold sits well below the 80% halt line — fan-out happens when comfortably ahead of budget,
never to catch up. Circuit breakers disable it for the window (member halted mid-flight) or the week
(pace > 1.0, merge conflict), and it auto-disables if measured cost-per-todo is worse than sequential
over 10 samples.

**Consequence:** the first week runs sequential by construction (no cost history), so the policy turns
on with measured numbers rather than the estimates in D7.

**Rejected:** executor decides per task (no cross-task context, adds an LLM call per unit of work);
dispatcher agent decides (reintroduces the coordinator rejected in D6); reviewer decides at gates
(too late — work already done).

---

## D9 — Pacing controller: spend the window, protect the week (amends D8)

*(see [08-pacing-controller.md](08-pacing-controller.md))*

**Correction:** unused 5-hour capacity is **destroyed at reset, not saved**. At 50% used with an hour
left, going slow isn't conservative — it wastes ~40% of the window. D8's absolute thresholds ("fan out
only below 30% usage") get this backwards in the endgame.

**But** a week holds ~33 five-hour windows and the weekly cap is far below 33× the 5-hour cap, so
maximising every window is exactly what the weekly cap punishes — burn every window and the week ends
in 2–3 days.

**Resolution:** derive a per-window target from the weekly budget and pace to hit it.
`fairShare = weeklyRemaining / windowsLeft`; `paceRatio = spentThisWindow / (fairShare × windowElapsed)`.
Accelerate below 0.8 (only when `windowElapsed > 0.6`), hold 0.8–1.2, throttle above 1.2.

**Second correction: `effort` is the primary throttle, not concurrency.** Effort burns budget smoothly
with zero duplication, zero merge risk, zero mid-flight-halt risk, and is reversible next task.
Ladder: accelerate `effort medium→high→xhigh` *then* `fanout 1→2→3`; throttle in reverse. **No fan-out
past 85% window elapsed** — insufficient runway, and mid-flight halts are the worst case.

Modes: `even` / `balanced` (default) / `eager`. The stated preference ("idle beats trickling") is
`eager` — front-loads hard, then idles Thursday–Sunday. Start on `balanced`; switch after a week of
real data.

**Rejected: a polling agent.** It's arithmetic, not judgment; ~48 cold-start sessions/day would spend
the budget it exists to protect; 30-minute resolution is far too coarse for the endgame; and the
statusline recorder already emits free, token-free telemetry on every assistant message. Evaluate
`shared/pacing-controller.ts` on each telemetry write plus a 60s idle tick. **It's a thermostat, not
an employee.**

---

## D10 — Locked to `balanced` mode; overnight is the primary workload

Confirmed: pacing mode is **`balanced`**, not `eager`. `eager` stays available in config but is not
the default. Revisit only after a week of real telemetry.

**Overnight continuous execution is the main use case** — the value is time saved while asleep, not
latency. That has two consequences worth holding onto:

1. **Latency is worthless overnight**, so there is no reason to accelerate beyond fair-share. The
   controller's only job between midnight and morning is to avoid *wasting* window capacity, not to
   finish sooner. `balanced` is exactly right for this shape.
2. **Overnight running is what makes the weekly cap bind.** ~8h/night × 7 nights is a lot of windows,
   before any daytime use. Expect the controller to throttle and expect idle stretches late in the
   week — that's the design working, not a failure. The stand-up should make it visible so it never
   looks like a stall.

**Pull forward before the first unattended overnight run:** the step 8 deny-list extension
(git-/data-destructive patterns) and restore points. Unattended is exactly when nobody is watching an
agent do something irreversible, and the deny-list extension is a few hours against an existing,
already-enforced function.

---

## D11 — Two profiles; per-service employees in work; a council that plans across them

*(see [09-work-profile-and-council.md](09-work-profile-and-council.md))*

**Profiles cost nothing.** `shared/home.ts` honours `JINN_HOME` and `JINN_INSTANCE`, and `src/instances/`
(create/start/directory/access) is a first-class upstream feature. `JINN_INSTANCE=personal` → `~/.personal`,
`=work` → `~/.work`. Separate employees, skills, cron, ledger, DB, port.

**The work profile overturns D6 — legitimately.** D6 named the exception: promote a department to its own
employee when the context genuinely differs. Separate services are separate repos with separate domain
models, so there is no shared orientation to duplicate. Same test, opposite answer. Cross-service work is
also the cleanest fan-out available (distinct repos, no merge conflicts) — though the weekly budget still
governs the degree.

**Council replaces `planner` in the work profile**: intake (interactive Opus) → impact triage via a service
registry (Opus) → **parallel read-only consultation** by each affected service against its own knowledge
base (Sonnet) → synthesis into a dependency graph, todo tree, and a generated **Jinn workflow** (Opus) →
**mandatory human approval** → governed execution. Opus on the reasoning phases, Sonnet on the widest one.

**Blocker found:** `--disallowedTools AskUserQuestion,ExitPlanMode` means agents cannot ask clarifying
questions. Resolution: don't fork the arg builder — the council asks in **chat** and idles for a reply.
Requires `interactive: true` on the council employee and excluding interactive sessions from Stop-hook
continuation, or it answers its own questions.

**Knowledge bases are Jinn skills** (no knowledge subsystem exists — confirmed). `SERVICE.md` per repo,
bootstrapped once, appended to after each completed todo or it rots.

**Unresolved and important:** two instances share one Claude account and therefore one set of limits, but
each would run its own governor believing it owns the whole budget. **The pacing controller must read
account-level state shared across instances** before both run concurrently.

---

## D12 — Sub-sub-task checkpoints; verify-before-act idempotency

*(see [10-checkpointing.md](10-checkpointing.md))*

**Reframe:** the governor halts several times a day, so **interruption is the primary control flow, not
an error path.** Checkpointing is the execution model.

- **One sub-task per session** (clean boundary, review gate); **sub-sub-tasks** (depth 3, ~10–20 min)
  are the atomic checkpoint. Size so losing one to a hard cut is cheap.
- **A checkpoint is a pair:** git commit (`JIN-42.3: <what>`) **and** ledger status, written together,
  **commit first**. Status-without-commit is the only unrecoverable ordering.
- **Idempotency = verify-before-act.** Every sub-sub-task carries a machine-checkable `verify` command.
  Run it first; if it passes, mark done and skip. Decomposition rule: *no machine-checkable
  done-criterion means it isn't decomposed enough.* `verify` commands route through
  `evaluateCommandPolicy` — they're model-generated shell.
- **Reconcile on resume** (extend `work-items/reconcile.ts`): run `verify` on each not-done unit;
  passing means the crash landed between work and status. Zero model tokens. Order: reconcile → ledger
  → handoff → work; **ledger authoritative, handoff narrative**.
- **Soft ceiling** (~75%) — don't start a unit that would cross the hard 80%. A clean stop at 78% beats
  a hard cut at 80%.
- **WIP rescue** — hard cut commits on-disk edits to `refs/jinn/wip/<sessionId>`.

**Consequence:** the D5 handoff shrinks to in-flight state only, since the ledger records what was done.

**Tension accepted:** upstream's one-root-per-outcome doctrine says procedural steps stay in the parent
body, not as todos. Sub-sub-tasks push against that — justified because they need durable, queryable
status, which body text can't give. Fallback if `depth ≤ 3` blocks it: a structured `verify`-per-item
checklist inside the sub-task body (weaker — no transitions, not countable in the stand-up).

**Correction to D11's open question:** root/task/sub-task/sub-sub-task is 0/1/2/3, which *fits*
`depth ≤ 3` if depth is 0-indexed. Verify in `work-items/relations.ts` before assuming a migration.

---

## D13 — Local web app, not a desktop wrapper; the real gap is daemon supervision

*(see [12-deployment-and-ux.md](12-deployment-and-ux.md))*

**"Web app vs desktop app" is already decided by forking Jinn** — it's a local Node gateway + a
browser-rendered dashboard, no native binary anywhere upstream (confirmed: no `electron/`, `tauri/`,
`desktop/` directory in the repo). Local-first, not hosted — nothing runs anywhere but the user's
machine unless deliberately pointed elsewhere.

**The real gap, verified:** upstream has **no daemon supervisor at all** — no `service` block in the
Homebrew formula, no systemd/launchd anywhere. Docker's `restart: unless-stopped` only survives
container crashes, not a host going to sleep, and binds to `127.0.0.1` only by design. The pairing
mechanism (`pairing-challenge.ts`) is a **local filesystem proof**, not remote-device auth — the whole
posture assumes one operator on one machine watching a tab they opened. Same supervised-autonomy root
cause as D11, showing up at the infrastructure layer.

Concretely: closing a laptop lid suspends the `node-pty` sessions mid-unit — below any layer the
governor can recover from.

**Chosen:** OS-level service supervision (`launchd`/systemd, restart-on-failure) — required regardless
of anything else. Plus `caffeinate`/`systemd-inhibit`, **gated on pacing-controller state**, for
idle-sleep while the lid stays open. **Correction (see [14-lid-close-mode.md](14-lid-close-mode.md)):
this does not cover the lid-closed case at all** — closing the lid fires a signal straight to the
kernel's power controller that `caffeinate` never sees. Lid-closed operation needs macOS clamshell mode
(a dummy display adapter, ~$10–15) — a separate, additional mechanism, not a consequence of gating
`caffeinate` correctly. A dedicated always-on host is the durable long-term answer but a config
decision, not new code — don't build it speculatively.

**Rejected: an Electron/Tauri desktop wrapper.** Doesn't address the actual gap (the daemon still has
to run somewhere), and it's the single most against-the-grain addition available — a permanently
divergent parallel codebase with its own packaging/signing/auto-update, nothing mergeable upstream.

**Deferred, not rejected:** a menu-bar status glancer — a small poller against the existing telemetry
API showing state and firing OS notifications on halt/resume/council-input. Real value, genuinely
cheap, but additive polish that can land any time after the core loop works.

---

## D14 — No desktop app; daemon runs always-on via OS service, starts on boot

*(closes the open questions in [12-deployment-and-ux.md](12-deployment-and-ux.md) and [13-costs.md](13-costs.md))*

**Confirmed: same deployment shape as upstream Jinn** — local Node gateway + browser dashboard, no
native wrapper. The desktop-app option was priced (~155 on the 100-scale for a real one, dominated by
code-signing/notarization + native-module rebuilds + a recurring $99/yr Apple Developer cost) and
explicitly declined — it doesn't address the actual gap (the daemon still has to run somewhere) and is
the single most against-the-grain, permanently-diverging addition available.

**Chosen instead:** step 13's OS-level service supervision, with the boot-start requirement now locked
in rather than left as "if needed":

- `launchd` `.plist` (macOS) / systemd user unit (Linux) with **`RunAtLoad`/`WantedBy=default.target`**
  (start on login/boot) **and** `KeepAlive`/`Restart=on-failure` (survive crashes).
- `caffeinate`/`systemd-inhibit`, gated on pacing-controller state — covers **idle sleep with the lid
  open** only. **Lid-closed operation on macOS is a separate mechanism** (clamshell mode via a dummy
  display adapter, not `caffeinate`) — see [14-lid-close-mode.md](14-lid-close-mode.md), added after
  this decision to correct an earlier wrong assumption that gating `caffeinate` was sufficient.
- `tengu service install/start/stop/status` CLI subcommands wrapping the above.

**Not decided yet, deliberately deferred:** whether this runs on the daily laptop or a rented always-on
box ([13-costs.md](13-costs.md) has real 2026 pricing — $40–48/mo personal, $96–126/mo work profile,
if that's ever wanted). Step 13's boot-start config is identical either way — a laptop just needs to
actually be on for "on boot" to mean anything.

---

## D15 — Privileged host commands (`pmset disablesleep`) stay local-native, never behind the web gateway

*(see [14-lid-close-mode.md](14-lid-close-mode.md))*

Proposed: a "Close Laptop Mode" toggle in the web dashboard, running `sudo pmset -a disablesleep 1/0`
with user consent/auth. Directly solves a real footgun (D14/[14](14-lid-close-mode.md) flagged that
`disablesleep` persists until manually cleared — easy to forget on a daily-driver laptop). **The idea
is right; the location is wrong.**

**Why not the web app, concretely:** a browser tab has no path to macOS's native privilege-auth dialog;
the gateway daemon runs as a normal user with no TTY inside an HTTP handler. Making a **web-reachable**
button actually flip `disablesleep` requires one of three things, all worse than the problem: a
passwordless `sudoers` rule (a standing elevated capability behind an HTTP endpoint — "authenticate
each time" stops being true after setup); a signed privileged helper (`SMAppService`) — the same
code-signing/notarization cost (~3–5 days, $99/yr) D14 already declined for the desktop-app question;
or running the gateway daemon itself elevated — actively dangerous given it already spawns
`--dangerously-skip-permissions` Claude sessions gated only by a regex deny-list
([11](11-deviation-assessment.md)'s "speed bump, not a sandbox").

**Chosen:** a local, native toggle outside the gateway entirely —
`osascript -e 'do shell script "pmset -a disablesleep 1" with administrator privileges'`, which triggers
macOS's real native password/Touch ID dialog. No signing needed for a script run locally by its own
author (notarization is a distribution requirement). Ship as two tiny scripts/Shortcuts now (zero new
code), fold into the deferred menu-bar glancer (D13) later as two menu items.

**General principle this sets:** privileged host-level actions (power management, disk operations,
anything needing elevation) stay **local-native, never routed through the web gateway** — the gateway's
threat model already includes semi-autonomous AI-driven shell execution, and every privileged action
added to that surface multiplies exactly the risk the security officer (step 10) exists to bound.

---

## D16 — UI extends Jinn's existing screens; no standalone TelemetryBar (corrects step 2)

*(see [15-ui-ux.md](15-ui-ux.md))*

**Verified against actual source, not route names.** Jinn has a real, deliberate design system —
"Ledger Dark/Light," two hand-tuned palettes (warm charcoal `#14130F` / warm paper `#F4F1E8`, amber
accent `#E0A33C`/`#926516`), Hanken Grotesk + IBM Plex Mono, a 56px icon-only nav rail with floating
pills instead of fixed headers, and an explicit rule: *"Active item = soft fill, NEVER accent."* No
persistent top bar anywhere, by design.

**Correction:** step 2's `TelemetryBar.tsx` "mounted in the shared layout" doesn't fit this shell —
there is no persistent bar anywhere in the app to mount it in. Building one would be the most visible
way to make Tengu feel bolted-on rather than native.

**Chosen instead — extend existing screens rather than add new chrome:**
- Governor/telemetry → a status dot on the Limits **rail icon** (ambient, zero new chrome) + extend
  the **existing Limits page** (already has status-dot cards, threshold-colored bars, reset countdowns)
  with per-session cards and a pacing/fan-out state strip, rather than a parallel dashboard.
- Council phase progress → **no new UI** — step 12 already generates a Jinn workflow from the council's
  output, and Workflow's existing Runs lens (`run-inspector.tsx`, a 20KB step inspector) renders
  multi-phase execution for free once the council's phases are workflow steps.
- Sub-sub-task checkpoints → deeper nodes in the todo board's existing `card-tree.tsx` subtree
  expansion, plus one new verify-status glyph reusing the existing status-dot visual language.
- Security incidents → a filtered lens on the existing `/logs` Activity page, not a new page.
- Stand-up → the one genuinely new **route**, following Cron's existing grouped-list pattern
  (employee-groups → project-groups; job-rows → department-rows).
- Profile switcher → **possibly zero new UI** — the rail already has a `WorkspaceSwitcher`; whether it
  supports separate `JINN_INSTANCE`s or just views within one is unverified and must be checked before
  building a parallel one.

**Net effect:** the honest new-UI surface is small — per-session Limits cards, a pacing/fan-out strip,
the Stand-up route, one new glyph, one new filter lens, and possibly nothing for profiles. Most of "how
Tengu looks" is "how Jinn already looks," which is the right outcome given D1/D11's whole thesis of
reusing what's legitimately reusable.

**Gap noted, not yet resolved:** no charting library exists anywhere in the app — every stat today is a
hand-rolled progress bar. A real trend line (cost-per-todo, weekly pace) needs either a hand-rolled SVG
sparkline (matches the codebase's evident preference for small custom primitives) or a new dependency.
Decide once the data shape is known.

---

## D17 — Closing the remaining open pointers

*(see [16-features.md](16-features.md) for the user-facing summary this resolves into)*

Design phase closed. Remaining open items from D8–D16 and their topic docs, resolved:

- **Cross-instance budget coordination** ([D11](01-decisions.md#d11--two-profiles-per-service-employees-in-work-a-council-that-plans-across-them)):
  personal and work profiles share one governor state file if ever run concurrently, so neither spends
  against a budget it doesn't actually have alone. Default assumption remains one active profile at a
  time.
- **Contract changes between services** ([09](09-work-profile-and-council.md)): a service needing
  something from another opens a task in the *providing* service, rather than cross-service write
  access. Matches real team ownership; avoids the coupling a shared-write model would create.
- **Stale service knowledge base** ([09](09-work-profile-and-council.md)): "I don't know, let me check"
  is an explicit valid council/service response — it opens an investigation task rather than guessing
  from outdated docs.
- **Non-mechanically-checkable `verify`** ([10-checkpointing.md](10-checkpointing.md)): falls back to a
  weaker criterion (file exists / contains expected content) and is flagged lower-confidence at the
  review gate, rather than forcing a pass/fail that doesn't fit the work.
- **Per-checkpoint commit granularity** ([10-checkpointing.md](10-checkpointing.md)): kept as-is —
  recoverability outweighs a tidy log. Squashing at the review gate is a per-project option, not
  required.
- **Where it runs day to day** ([12-deployment-and-ux.md](12-deployment-and-ux.md)): the laptop, by
  default, using D14/D15's boot-start service + lid-close toggle. Moving to a rented always-on box
  later ([13-costs.md](13-costs.md)) is a config change, not a rebuild — nothing in the design assumes
  one or the other.
- **Remote/phone access**: not built for v1 — the local dashboard is enough to start. A secure tunnel
  (Tailscale) is a five-minute add whenever it's actually wanted; not worth designing around
  speculatively.
- **Charting** ([15-ui-ux.md](15-ui-ux.md)): hand-rolled, matching the app's existing preference for
  small custom primitives over a new dependency — the actual need (two trend lines) doesn't justify one.

**Deliberately left for build-time, not resolved here** — these need the real codebase or running
telemetry to answer, and guessing further would just be more speculation stacked on speculation:
whether `depth` is 0-indexed (decides if the sub-sub-task level needs a schema change), whether the
existing `WorkspaceSwitcher` already does what profile-switching needs, and the real Opus/Sonnet token
split and reviewer share once genuine work is flowing. None of these block starting the build — they're
the first things the system will tell us, not open design questions.

---

## D18 — DaisyUI: port palettes into Jinn's own theme system, don't install the plugin

*(see [17-daisyui.md](17-daisyui.md))*

**Real, concrete collision, not a vague worry:** DaisyUI switches themes via `data-theme` on `<html>`
with built-in theme names including `"light"`/`"dark"` — the exact attribute, element, *and* two of the
exact names Jinn's own `ThemeProvider` already uses for Ledger Dark/Light. Installing both means two
unrelated CSS-variable systems firing on the same selector, with load order silently deciding the
winner.

**Chosen:** take the actual ask (good-looking color themes) without the conflicting mechanism — port
specific daisyUI palettes into Jinn's own token structure (`--bg`/`--accent`/etc.), added as new
`data-theme` values through Jinn's *existing* switcher, extended from a two-way toggle into a small
registry. Same pattern D16 already established: extend what's there, don't import a parallel system.

**Deliberately not done here:** typing out specific hex values for named themes without verifying them
first. The mechanism is decided; porting 2–3 real palettes with checked values is bounded follow-up
work, not something to guess at in a decisions doc.
