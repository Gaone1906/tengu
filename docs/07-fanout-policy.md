# Fan-out policy — when to parallelise, decided conservatively

**Design principle: the executor never decides.** Current models delegate readily — Opus 5 reaches for
subagents far more than 4.8 did — so "let the agent judge whether to fan out" optimises for exactly
the behaviour we're trying to bound. Instead:

> **Fan-out is a planning-time annotation, validated by a runtime budget gate.**
> Two independent gates, both must pass, and *anything uncertain resolves to sequential.*

Nobody makes a judgment call in the hot loop. The runtime decision is arithmetic.

---

## Gate 1 — Work shape (decided once, at planning time)

The `planner` already sees the whole decomposition, runs on Opus at `high`, and fires once per
project. That's the right place — and the only place — to judge independence.

It writes two fields onto sub-tasks:

| Field | Meaning |
|---|---|
| `parallelSafe: boolean` | **Defaults to `false`.** Must be affirmatively justified. |
| `parallelGroup: string \| null` | Group id; members may run concurrently with each other |

To set `parallelSafe: true`, the planner must satisfy **all** of these, and record which in the todo
body so the call is auditable:

1. **Distinct workspace** — different `workspacePath` (different repo/service), *or* the task is
   **read-only investigation** with no file mutations.
2. **No shared files** — the tasks don't touch the same paths.
3. **No ordering dependency** — neither blocks the other.
4. **Independently reviewable** — already Jinn's one-root-per-outcome doctrine.

If the planner is unsure about any of them, it leaves `parallelSafe: false`. Persona wording:

> Mark sub-tasks `parallelSafe` only when you can name the distinct workspace each one operates in,
> or when the task only reads. If two sub-tasks might touch the same file, they are not parallel-safe.
> When uncertain, leave it false — sequential execution is always correct, and a wrong `true` costs
> real budget.

**Why this is the conservative choice:** the judgment is made once by the most capable model with
full context, not repeatedly by an executor mid-task with partial context. It costs nothing at
runtime, it's auditable after the fact, and it fails closed.

---

## Gate 2 — Budget (evaluated at runtime, deterministic, non-overridable)

`shared/fanout-policy.ts`, evaluated in the Stop-hook continuation path (plan step 7) right beside
the governor. Pure arithmetic over the telemetry we already collect — no model call.

```
allowFanout(telemetry, history, config) -> degree: 1 | 2 | 3

  // Any single failure returns 1 (sequential).

  if !config.fanout.enabled                              -> 1
  if fanoutAlreadyInFlight                               -> 1
  if history.completedSamples < 20                       -> 1   // no cost data yet
  if circuitBreaker.trippedThisWindow                    -> 1
  if circuitBreaker.trippedThisWeek                      -> 1

  // Weekly pacing — the hard gate.
  paceRatio = sevenDay.used_percentage / weekElapsedFraction
  if paceRatio > 1.0                                     -> 1   // already ahead of budget
  if sevenDay.used_percentage > 50                       -> 1

  // Current window must have room to actually finish the work.
  minutesLeft = (fiveHour.resets_at - now) / 60
  estMinutes  = history.medianTaskMinutes * 1.5          // pad the estimate
  if minutesLeft < max(90, estMinutes)                   -> 1

  // Projected spend must stay well under the halt threshold.
  projected = fiveHour.used_percentage + (degree * history.medianTaskPctOfWindow)
  if projected > 60                                      -> 1   // vs the 80% halt line

  // Degree ladder — earn concurrency by having headroom.
  if fiveHour.used < 15 && sevenDay.used < 30            -> 3
  if fiveHour.used < 30 && sevenDay.used < 50            -> 2
  otherwise                                              -> 1
```

Three parts of this deserve calling out.

**Weekly pacing is the primary brake.** `paceRatio` compares 7-day consumption against how far
through the week we are. On day 3 of 7 at 60% used, `paceRatio ≈ 1.4` — ahead of budget, so no
fan-out regardless of how empty the current 5-hour window looks. This is what directly serves "I'd
rather work goes slow than burn my limits": it protects the *week*, not just the hour.

**The window-time check prevents the worst case.** Fanning out with 20 minutes left means paying N
orientations and getting halted before anything completes — strictly worse than sequential on every
axis. Require enough runway to finish, using the ledger's own median task duration, padded 1.5×.

**No fan-out until we have cost data.** Below 20 completed todos, `degree` is always 1. The first
week runs sequential by construction, which both matches the conservative posture and means the
policy turns on with real numbers rather than my estimates.

**The runtime can only ever downgrade.** It never fans out beyond the planner's `parallelGroup`, and
it can always drop to sequential. Gates compose one way.

---

## Circuit breakers

| Trigger | Effect |
|---|---|
| A fan-out member is halted mid-flight by the governor | Disable fan-out for the rest of the **5-hour window** |
| `paceRatio > 1.0` at any evaluation | Disable fan-out for the rest of the **week** |
| Any merge conflict between fan-out members | Disable fan-out for the rest of the **week**; flag in stand-up |
| Fan-out cost-per-todo worse than sequential over 10 samples | Auto-disable, flag in stand-up for a human call |

That last one closes the loop from [06-concurrency.md](06-concurrency.md): the 25–50% duplication
overhead is an *estimate*. The system measures the real number and switches itself off if the
estimate was optimistic. We never have to argue about it again.

---

## Config

```yaml
governor:
  fiveHourStopPct: 80
  sevenDayStopPct: 80
  contextCompactPct: 80
  fanout:
    enabled: true
    maxDegree: 3                    # hard cap, validated
    fiveHourMaxPct: 30              # no fan-out above this
    sevenDayMaxPct: 50              # no fan-out above this
    pacingRatioMax: 1.0             # weekly burn vs week elapsed
    projectedCeilingPct: 60         # projected 5h spend must stay under
    minWindowMinutesRemaining: 90
    requireHistorySamples: 20
```

Every threshold sits **well below** the 80% halt line. Fan-out is something the system does when it
is comfortably ahead of budget, never something it does to catch up.

---

## Why not let the agent decide?

Considered and rejected:

- **Executor decides per task** — needs full cross-task context it doesn't have, adds an LLM call
  before every unit of work, and leans on exactly the over-delegation tendency we're bounding.
- **A "dispatcher" agent decides** — reintroduces the coordinator we rejected in
  [D6](01-decisions.md#d6--departments-are-labels-not-agents); it's a `SELECT` plus arithmetic.
- **Reviewer decides at gates** — too late; the work is already done.

Planning-time annotation + runtime arithmetic gives a decision that is cheap, deterministic,
auditable, and fails closed. The only model judgment involved is one the planner is already making
when it decomposes the work.

---

## Surfacing it

The GUI's telemetry bar should show current fan-out state, degree, and — when sequential — **the
reason**. "Sequential: weekly pace 1.3× budget" is the line that tells you the governor is working
for you rather than the system merely being slow. Circuit-breaker trips appear in the stand-up as
incidents, next to security blocks.
