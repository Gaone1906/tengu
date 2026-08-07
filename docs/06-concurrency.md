# Concurrency — 1 agent × 10 tasks vs 10 agents × 1 task

Re-examining [D2](01-decisions.md#d2--continuous-not-concurrent). The question: for 10 tasks, is one
agent doing them sequentially equivalent in tokens to ten agents doing one each — trading faster
completion for faster budget burn?

**Short answer: no, not equivalent — and the throughput intuition inverts once you look at how the
5-hour window actually works.** But there's a real case for bounded parallelism, and it's narrower
than "10 agents."

---

## 1. Token usage is not the same

Two forces pull in opposite directions.

**Against parallel — duplicated orientation.** Every agent starts cold: reads `CLAUDE.md`, the
ledger, repo structure, greps for relevant files, builds a mental model. Call it **O**. Ten agents
pay 10×O. One agent pays O once and amortizes it across all ten tasks.

**For parallel — context growth.** The sequential agent carries tasks 1–9's history while doing task
10, and re-sends it as input on every turn. Parallel agents each stay small.

**Prompt caching decides it, and it favors sequential.** The sequential agent's accumulated history
is a *stable prefix*, so it caches — reads cost ~0.1× base input. During continuous work turns are
frequent enough to stay inside the TTL. Meanwhile each fresh parallel agent pays a **cache write**
(1.25×) on its orientation and finishes before earning many reads back.

Illustrative sizing (assumptions stated, not measured):

| | Orientation | Task work | Total |
|---|---|---|---|
| 1 agent × 10 tasks | 1 × ~20k | 10 × ~50k | ~520k + cached-history overhead + ~2 compactions |
| 10 agents × 1 task | 10 × ~20k | 10 × ~50k | ~700k |

≈ **9×O of pure duplication — roughly 25–50% overhead** for related tasks in one repo.

**The governing principle: duplication cost scales with how much context the tasks share.**

- Same repo, related tasks → parallel is materially worse.
- Genuinely separate repos/services → O isn't duplicated (each agent needed its own orientation
  anyway) → roughly parity.

Two costs the naive comparison also misses: **merge coordination** (10 agents on one repo needs
worktree isolation and then someone reconciles 10 branches — plus rework when they conflict
semantically), and **review burst** (10 near-simultaneous completions → 10 Opus gates at once, on the
scarce bucket).

---

## 2. The throughput intuition inverts

> "We run out of tokens faster, but at least the work gets done faster in a particular 5-hour window."

This is the part to correct. The 5-hour limit is a **rolling window that caps usage**, and it starts
on your first prompt — fire at 10:00 and it resets at 15:00 regardless of how you spend it.

So the amount of work available in a window is **fixed by the cap, not by concurrency.** Parallelism
doesn't raise the ceiling; it reaches it sooner:

- **10 agents:** burn the window's allowance in ~45 minutes, then idle ~4h15m.
- **1 agent:** pace across the full 5 hours, working the whole time.

Same ceiling. And because parallel carries ~25–50% duplication overhead, it delivers **less** work
before hitting it. Per window, sequential wins.

For **sustained** operation — the actual goal, "continuously hammer away" — the binding constraint is
the **weekly** cap. Total work per week ≈ weekly cap ÷ tokens-per-task. Parallelism raises
tokens-per-task, so it *lowers* total weekly output. Strictly worse for sustained throughput.

**What parallelism actually buys is latency, not throughput.** If you need a specific batch of 10
finished as soon as possible and you have headroom to spend, parallel finishes in ~1 task-duration
instead of ~10. That's real and sometimes worth paying for. It just isn't what a continuous backlog
run optimizes for.

---

## 3. The context claim is right on mechanism, wrong on conclusion

> "Context management becomes almost unnecessary — each agent does such a small subset it fits."

Correct that a single-task agent rarely approaches 80% context. Two caveats:

- It becomes *less frequently triggered*, not unnecessary. One wide refactor or deep investigation
  still blows 200k on its own.
- More importantly: **compaction is the cheap, already-solved problem.** Claude Code does it natively;
  our step 6 just triggers it at a sensible threshold. Trading it away to acquire duplicated
  orientation, merge coordination, and review bursts is a bad exchange — you're spending expensive
  unsolved problems to avoid a cheap solved one.

---

## 4. One place the argument genuinely lands

Executor work is **Sonnet**, drawing from the general bucket with ~9× the headroom of Opus. So
parallelism *on the executor tier* is far less costly than the raw token numbers suggest — you're
burning the abundant resource, not the scarce one.

That materially weakens the objection for executor fan-out specifically. What it does **not** fix:

- The review burst still lands on **Opus**, the scarce bucket, all at once.
- The overall weekly cap still counts everything.
- Merge coordination is unaffected by which model did the work.

---

## 5. Revised position (amends D2)

Sequential stays the **default** for sustained backlog work. Add **bounded** fan-out where it
genuinely pays:

| Condition | Mode |
|---|---|
| Related tasks, one repo, sustained run | **Sequential** — the default |
| Genuinely independent contexts (separate repos/services) | Fan out, **cap 2–3**, one worktree each |
| Read-only investigation / research fan-out | Fan out freely — no merge cost, cheap model, keeps executor context clean |
| Deadline burst with budget headroom | Fan out deliberately, accepting the overhead as the price of latency |

Cap fan-out at **2–3, not 10**. Beyond that, duplication and merge cost grow faster than the latency
benefit, and the review burst starts distorting the Opus budget.

**Gate it on the governor.** Fan-out multiplies burn rate, so concurrency must be a governor-aware
decision: allow it only when 5-hour and 7-day usage are both well under threshold. Refusing to fan
out at 60% usage is the difference between finishing the week and idling through Thursday.

**This is measurable, and we should measure it rather than argue it.** Once the loop runs, compare
cost-per-completed-todo (from step 3's rollups) for a sequential batch against a fanned-out batch of
similar work. If duplication turns out smaller than estimated here, raise the cap.
