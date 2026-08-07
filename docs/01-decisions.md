# Decision log

Newest decisions at the bottom. Each records what we chose, the reasoning, and what we rejected.

---

## D1 — Fork Jinn, not OpenClaw

**Chosen:** fork `hristo2612/jinn`.

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
