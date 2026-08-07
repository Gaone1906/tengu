# Pacing controller — spend the window, protect the week

Amends [07-fanout-policy.md](07-fanout-policy.md). The absolute thresholds there ("fan out only below
30% usage") are wrong in one important regime, and the correction matters.

---

## The insight: unused 5-hour capacity is destroyed, not saved

The 5-hour limit is a **bucket that starts on your first prompt and zeroes at reset** — fire at 10:00,
resets at 15:00 regardless of what you did in between. So capacity you don't use doesn't roll over.
It evaporates.

That means at 50% used with **1 hour left**, going slow isn't conservative — it's **destroying ~40% of
the window**. The old rule ("usage is at 50%, so no fan-out") gets this exactly backwards.

But the opposite extreme is also wrong, and this is the part that keeps it conservative:

## The tension: you cannot fill every window

A week holds ~33 back-to-back 5-hour windows. The weekly cap is far less than 33 × the 5-hour cap —
weekly limits exist precisely to stop 24/7 saturation. So **maximising every window is the behaviour
the weekly cap punishes**: burn every window to 100% and you exhaust the week in 2–3 days, then idle
for four.

Two true things that pull opposite ways:

| Horizon | Property | Implication |
|---|---|---|
| 5-hour window | Use-it-or-lose-it | Under-spending wastes capacity |
| 7-day window | Hard weekly ceiling | Over-spending ends the week early |

**The resolution: derive a per-window target from the weekly budget, then pace to hit that target
exactly — neither under nor over.**

---

## The control signal

Everything below is computable from telemetry we already collect for free.

```
windowElapsed   = 1 - (fiveHour.resets_at - now) / 5h
weekElapsed     = 1 - (sevenDay.resets_at - now) / 7d

weeklyRemaining = 100 - sevenDay.used_percentage        // % of weekly cap
windowsLeft     = hoursUntilWeeklyReset / 5

fairShare       = weeklyRemaining / windowsLeft          // weekly-% this window may spend
spentThisWindow = sevenDay.used%(now) - sevenDay.used%(at window start)

paceRatio       = spentThisWindow / (fairShare * windowElapsed)
```

`paceRatio` is the single number that drives everything:

- **< 0.8** — under-spending. Capacity will be wasted at reset. **Accelerate.**
- **0.8 – 1.2** — on pace. Hold.
- **> 1.2** — over-spending against a sustainable weekly rate. **Throttle.**

Urgency scales with `windowElapsed`: being under pace at 20% elapsed is fine (plenty of time to catch
up); being under pace at 85% elapsed means the capacity is about to be destroyed. So the accelerate
trigger is `paceRatio < 0.8 AND windowElapsed > 0.6`.

---

## Effort is the primary throttle, not concurrency

This is the other correction. Concurrency was the wrong first lever:

| Lever | Burns budget | Duplication | Merge risk | Mid-flight halt risk | Reversible |
|---|---|---|---|---|---|
| **`effort`** | Yes, smoothly | None | None | None | Instantly |
| **Fan-out** | Yes, in steps | ~9×O | Yes | Yes | Only between tasks |

Raising executor effort `medium → high → xhigh` consumes budget **productively and with zero waste
risk** — better output on the same task, no orientation duplication, no branches to reconcile,
reversible on the next task. Fan-out buys throughput but pays duplication and risks the worst case
(N orientations paid, then halted before anything completes).

So the ladder is **effort first, fan-out second**:

```
accelerate:  effort medium → high → xhigh    then    fanout 1 → 2 → 3
throttle:    fanout 3 → 2 → 1                then    effort xhigh → high → medium → low
```

Symmetric: unwind concurrency before cutting effort, because concurrency carries the risk.

### Endgame refinement

Late in a window (`windowElapsed > 0.85`), **do not fan out at all** — there isn't runway for N tasks
to finish, and mid-flight halts are the worst outcome. Raise effort instead, and prefer short queued
tasks (median duration under the remaining window). Effort has no completion risk: a higher-effort
task that gets halted is handed off exactly like any other.

---

## Modes

The weekly anchor is a policy choice. Your stated preference — *"idle is a smaller loss than
trickling"* — is `eager`:

| Mode | Behaviour | Result |
|---|---|---|
| `even` | Strict fair-share every window | Steady all week, never idle, never bursts |
| `balanced` *(default)* | Fair-share ±20%, accelerate when under-pace late in window | Mostly steady, uses what would be wasted |
| `eager` | Ignore weekly pacing until 7-day > 70%, then hard-throttle | Front-loads hard, idles later in the week |

`eager` does what you asked for, and the cost is explicit: you finish Monday–Wednesday at full tilt
and Thursday–Sunday mostly idle. `balanced` captures most of the wasted-capacity win without that.
Start on `balanced`, switch to `eager` after a week of real data if idle time still looks like the
bigger loss.

**Hard floor in every mode:** the 80% halt line, and the fan-out gates from
[07-fanout-policy.md](07-fanout-policy.md) (planner `parallelSafe`, ≥90 min runway, ≥20 samples of
history) still apply. Acceleration can raise the *degree*; it can never bypass a gate.

---

## No polling agent — this is the one thing that would hurt

**Recommendation: don't build it.** A dedicated agent polling every 30 minutes is self-defeating here:

1. **It's arithmetic, not judgment.** Every input is a number we already have. There is nothing for a
   model to reason about.
2. **It spends the budget it's protecting.** ~48 sessions/day, each a cold start, each burning tokens
   from the very bucket it exists to conserve.
3. **30 minutes is far too coarse.** The endgame decision needs minute resolution — by the time a
   30-minute poll notices you're under pace with 40 minutes left, half the remaining capacity is gone.
4. **We already have a free, faster signal.** The statusline recorder fires on **every assistant
   message** and runs locally at zero token cost. That's near-real-time telemetry for free.

**Instead:** evaluate `shared/pacing-controller.ts` on every telemetry write (free, event-driven, via
the existing `live-events` channel), plus a 60-second timer tick to cover idle periods when no
assistant messages are flowing. Pure code, zero tokens, minute-resolution.

The pacing controller is a thermostat, not an employee.

---

## Config

```yaml
governor:
  pacing:
    mode: balanced              # even | balanced | eager
    accelerateBelowPace: 0.8
    throttleAbovePace: 1.2
    accelerateAfterWindowElapsed: 0.6
    noFanoutAfterWindowElapsed: 0.85
    effortLadder: [low, medium, high, xhigh]
    eagerModeWeeklyBrake: 70    # eager only: hard throttle above this 7-day %
```

---

## Surfacing it

The telemetry bar should show the pacing state and *why*, in plain language:

- `Accelerating — 38% of window budget unused, 52 min to reset · effort xhigh`
- `On pace · effort medium · sequential`
- `Throttling — 1.4× weekly budget rate · effort low`
- `Sequential — 12 min runway, too short to fan out`

That line is what makes the governor legible: you can see at a glance whether it's protecting you or
whether it's leaving capacity on the table.

---

## Open questions

- **`spentThisWindow` needs window-start bookkeeping.** We must persist `sevenDay.used%` at each
  window boundary to compute the delta. Small addition to the telemetry store — do it in step 1.
- Does the 7-day window truly reset as a bucket, or slide continuously? The fair-share maths assumes
  bucket. If it slides, `windowsLeft` needs a different derivation. **Verify once we have a week of
  telemetry.**
- Does raising effort actually consume budget proportionally, or does it saturate? If `xhigh` only
  costs ~20% more than `high` on typical tasks, effort alone may not absorb a large endgame surplus
  and fan-out has to do more of the work. **Measure early** — it decides how much the ladder can lean
  on its first rung.
