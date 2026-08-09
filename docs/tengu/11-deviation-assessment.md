# How far are we from stock Jinn?

Two axes matter, and they're different questions:

- **Distance** — how much new code? (Answer: moderate, and less than expected.)
- **Direction** — does it go *with* Jinn's grain or *against* it? (Answer: mostly with, but the
  against-the-grain part is concentrated and permanent.)

A lot of code going with the grain is easy. A little code going against it is what generates merge
pain forever.

---

## What Jinn already gives us — more than expected

| Requirement | Status in stock Jinn |
|---|---|
| Employees, departments, ranks, reporting lines, personas | ✅ Complete |
| Per-employee engine + model | ✅ Complete |
| Todo tree with status, assignee, approvals, comments, transitions | ✅ Complete |
| Departments as a queryable dimension | ✅ `department` column + registry |
| Pipelines (sequential / conditional / parallel / switch, per-phase model, gates) | ✅ `src/workflows/`, bound to todos |
| Cron that mints work items | ✅ Complete |
| **Instances** (personal / work) | ✅ `JINN_INSTANCE` + `src/instances/` — first class |
| Knowledge bases | ✅ Skills |
| Chat command centre + activity receipts | ✅ Complete |
| Web dashboard incl. a limits page | ✅ Complete |
| **Per-session usage + context telemetry** | ✅ **Already collected, free, per session** |
| Destructive-command blocking | ✅ Deny-list + `PreToolUse` → 451 |
| Per-employee spend caps with a proven enforcement seam | ✅ `budgets.ts` |
| Session resume | ✅ `--resume` supported |

**Roughly 70% of what we want is assembling or extending things that already exist.** The single
biggest surprise: the telemetry sensor — the thing the entire governor depends on — is already built
and running. We're surfacing and acting on data Jinn already writes to disk.

---

## The real deviation is one assumption, not a feature list

Every genuinely hard part of the plan traces back to the same thing:

> **Jinn assumes a human is nearby. We want it to run unattended for a week.**

Jinn is built for *supervised* autonomy — an AI org you watch. We want *unsupervised* autonomy. That's
a posture difference, not a capability gap, and it surfaces in exactly four places:

| # | Upstream behaviour | Why it exists | What we need |
|---|---|---|---|
| 1 | `waiting` state clears **only on a user message** (`rate-limit-waiting-resume.ts`) | A human notices the limit and resumes | Programmatic resume at window reset |
| 2 | `--disallowedTools AskUserQuestion,ExitPlanMode` | Agents must never block on a human | The council **must** ask clarifying questions |
| 3 | One-root-per-outcome: procedural steps stay in the parent body, not as todos | A human tolerates losing 20 min of work | Sub-sub-task checkpoints with durable status |
| 4 | Instances are fully independent | Separate orgs, separate concerns | Shared account-level budget across instances |

Note that **1, 2 and 4 are not oversights** — they're deliberate design choices that make sense for
Jinn's intended use. We're inverting them. That's legitimate in a fork, but it means these four spots
will conflict with upstream approximately forever.

Item 3 is the same assumption in a different costume: if someone is watching, losing a unit of work is
an annoyance; if nobody is watching for eight hours, it's the difference between progress and a
treadmill.

---

## Effort split by kind

Of ~20–32 working days:

| Kind | Steps | Days | Merge risk |
|---|---|---|---|
| **Config only** — works today | 0, instances | ~1 hr | None |
| **Additive** — new files, minimal upstream edits | 1, 2, 3, 11, most of 10 | ~8–10 | Low; several are upstreamable |
| **Seam edits** — touch dispatch/hook paths | 4, 7, 8, 9 | ~6–8 | Medium |
| **Against the grain** — invert an assumption | 5, 6, council, cross-instance | ~9–12 | **High, permanent** |

So: **~40% additive, ~30% seam, ~30% fighting the design.** The last third is where the fork actually
becomes a fork rather than a patch set.

Mitigation, already in the plan: keep the governor, pacing controller, and fan-out policy in their own
modules with minimal call-site edits. The four inversion points can't be isolated that way — they are
edits to upstream behaviour by definition.

---

## Is Jinn still the right base?

**Yes.** The counterfactual is building the ledger, org model, workflow engine, instance system,
skills, hook relay, chat surface, and dashboard from scratch — months of work, all of it to arrive at
what Jinn hands you on day one. Fighting four assumptions is far cheaper than rebuilding thirteen
subsystems.

But the honest framing matters: **you are not configuring Jinn, you are forking Jinn to invert one of
its assumptions.** Budget for that — including that upstream may never accept the interesting parts
back, and that a future upstream release could make these four spots harder rather than easier.

### What the GUI actually costs

Requirements 6 and 7 (dashboard + stand-up) are the most "extra" sounding, so worth pricing honestly:
GUI-only work is step 2 (1–2 days) and step 11 (2–3 days) — **~3–5 days of 20–32, so roughly 15–20%.**
Steps 1 and 3 look like GUI work but aren't: the governor needs the telemetry aggregation and the
fan-out policy needs the progress history regardless.

So the dashboard is not the tail wagging the dog. It's about a fifth of the build, and it's also the
only way you'll know whether any of the rest is working.

---

## Where the risk actually concentrates

Not evenly across the four inversions:

1. **Auto-resume (step 6)** — highest. It's the linchpin of unattended operation, it fights an
   explicitly tested upstream behaviour, and if it silently fails the whole system just stops
   overnight and you find out in the morning. Regression test it first, not last.
2. **Cross-instance budget** — highest *consequence*. Two governors, one account, each believing it
   owns the whole budget. Get it wrong and you double-spend the weekly cap without either instance
   noticing.
3. **Council interactivity** — medium. The chat workaround avoids forking the arg builder, but if the
   continuous loop ever auto-continues an interactive session, the council answers its own questions
   and builds on invented requirements. Quiet and expensive.
4. **Checkpoint doctrine** — lowest. A depth-cap check away from being a non-issue, with a workable
   fallback.

---

## One-line answer

**About 70% assembly, 30% new — but the 30% is concentrated in four places where Jinn deliberately
assumes someone is watching, and we need it to run alone.** That's the deviation. Not the features:
the posture.
