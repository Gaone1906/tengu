# Org structure

## The constraint that decides everything

**Every employee switch is a session switch, and every session switch is a cold start.**

We established in [04-efficiency.md](04-efficiency.md#2-cold-starts--the-most-under-appreciated-cost)
that cold starts plausibly cost 20–30% of spend. In a **continuous, single-threaded** model, handing
work from a `backend` agent to a `frontend` agent isn't free coordination — it ends one session and
starts another, paying full re-orientation.

So the usual instinct (one agent per department: backend, frontend, database, QA, DevOps…) is
actively expensive here. It's the right shape for a *concurrent* org, which we explicitly aren't
building.

**The resolution: departments are labels on work items, not a fleet of agents.**

`work_items` already has a `department` column and `departments.ts` registers slugs lazily. The
planner tags each sub-task with a department. The stand-up groups by that column. All of this works
with **one** executor doing backend, frontend, and database work in a single warm session.

You get the departmental stand-up you want without paying a cold start per department. And when a
department genuinely earns its own agent, you promote it — the ledger doesn't change.

## Recommended starting roster — 4 employees

| Employee | Rank | Engine / model | Effort | Fires | ~Token share |
|---|---|---|---|---|---|
| `planner` | executive | Claude / Opus 5 | `high` | Once per project or epic | ~5% |
| `engineer` | employee | Claude / **Sonnet 5** | `medium` | Continuously | **~85%** |
| `reviewer` | manager | Claude / Opus 5 | `high` | At parent-todo gates only | ~10% |
| `security` | executive | — (`system: true`) | — | On every tool call | **0%** |

Three of the four burn tokens; one of them burns almost all of it. That asymmetry is the design
working correctly.

### Reporting lines

```
planner (executive)  — owns the roadmap
   └── reviewer (manager)  — owns the quality gate
          └── engineer (employee)  — executes

security (executive, system)  — cross-cutting, outside the delegation chain
```

### Responsibilities

**`planner`** — Opus 5, `high`. Takes a project root and decomposes it into independently assignable,
independently reviewable sub-tasks, each tagged with a `department`. Follows Jinn's one-root-per-outcome
doctrine: procedural steps go in the parent body, not into child todos. Writes the plan **into the
ledger**, not into prose. Runs rarely — once per project or epic, plus on re-planning after a
rejected gate.

*Why Opus:* decomposition quality determines everything downstream. A bad plan is paid for in
executor tokens for days. This is the right place to spend the scarce bucket.

**`engineer`** — Sonnet 5, `medium`. The executor. Picks up the next open sub-task, implements it,
writes and runs tests, iterates until green, marks it done with a comment describing what happened
and any issues hit. Handles **all** departments. This is the recursive code/test loop, and it's where
~85% of tokens go.

*Why Sonnet:* near-Opus quality on coding and agentic work specifically, drawing from the ~9× larger
bucket. This single substitution is what makes continuous execution survivable.

**`reviewer`** — Opus 5, `high`. Reviews at **parent-todo gates only** — never per sub-task. Approves
or rejects with specific reasons; a rejection returns the parent to the engineer with comments. Also
the natural owner of the THOROUGH approval level for irreversible actions.

*Why gates only:* this is the number that decides whether the model mix holds. Per-sub-task review
pushes Opus share from ~10% toward 30% and we're back on the scarce bucket. Gate placement is a
budget decision, not a process preference.

**`security`** — `system: true`, no engine, no tokens. Not an LLM worker in v1: it's
`evaluateCommandPolicy` + path confinement + restore points, given an org identity so that blocks are
**attributed** and surface in the stand-up as incidents rather than vanishing into an HTTP 451.
Executive rank so it outranks everyone in the approval chain.

*Why system:* a security agent that has to think costs tokens on every tool call and adds latency to
the inner loop. Deterministic policy is both cheaper and more reliable here. Revisit only if we want
judgment calls on ambiguous commands.

## Assignment is code, not an agent

Do **not** add a dispatcher/coordinator employee. Picking "the next open sub-task by priority" is a
database query. Making it an LLM call means an Opus-or-Sonnet turn between every unit of work —
enormous cost for a `SELECT ... ORDER BY priority LIMIT 1`.

Assignment belongs in the Stop-hook continuation path (step 7 of the plan), guarded by the governor.

## When to add more — and the test to apply

The test for splitting an employee out: **does the context it needs differ enough that splitting
saves more than the handoff costs?** If a `frontend` agent would re-read most of what the `engineer`
already had loaded, splitting is a net loss.

| Add | When | Model |
|---|---|---|
| `scribe` | As soon as the stand-up ships — it runs narration on cron | **Haiku / Sonnet `low`** |
| `researcher` | Read-heavy, non-mutating investigation is polluting the executor's context | Sonnet `low` |
| `frontend` / `db` | The stack, repo, tooling, or credentials genuinely differ — not merely the subject matter | Sonnet 5 `medium` |
| second `engineer` | Only if we ever revisit the continuous-not-concurrent decision | Sonnet 5 |

`scribe` is the one I'd add early and deliberately. Stand-up narration is a **fixed recurring
background cost**; leaving it on the default engine means the reporting layer quietly competes with
the work. Put it on the cheapest model that writes readable prose.

### Don't add these

- **QA / tester** — testing is inside the engineer's loop by definition (it's the "recursive loop for
  coding and testing"). A separate QA agent doubles cold starts for work already being done.
- **Coordinator / dispatcher / PM** — see above; it's a query.
- **Integrator / merger** — only meaningful with concurrency.
- **One agent per department, up front** — the whole point of the label approach.

## Personas carry the efficiency instructions

The `persona` field feeds `--append-system-prompt`, which makes it the delivery mechanism for
everything in [04-efficiency.md](04-efficiency.md). Per role:

**`engineer`** — scope discipline (deliver what was asked, don't widen); **no** verification
scaffolding (Opus/Sonnet 5 self-verify; telling them to verify causes redundant work); conciseness
and deliverable-length instructions; a hard cap on subagent delegation; and **read the ledger first,
the filesystem second** on resume.

**`reviewer`** — report *every* finding with confidence and severity, filter downstream. Conservative
instructions ("only high-severity", "don't nitpick") are followed literally by current models and
depress measured recall even as real bug-finding improves. This is a known trap; write the persona
against it.

**`planner`** — decompose into independently assignable and reviewable units; tag departments; depth
≤ 3; procedural steps stay in the parent body.

**`scribe`** — summarize the event window into "what shipped / what's blocked / issues hit and how
they were resolved". Never invent resolution detail that isn't in the comments.

## Open questions

- Does the `Employee` YAML schema use `manager:` or `reportsTo:` for the reporting line? Confirm
  against `packages/jinn/template/` before writing configs.
- Is `rank` load-bearing for approval authority, or purely cosmetic in the org chart? If cosmetic,
  the reviewer's gate authority needs to come from the approval config instead.
- Should `planner` and `reviewer` be the **same** Opus employee wearing two hats? It would halve
  Opus-side cold starts. Argues against: mixing decomposition and review context in one session, and
  a reviewer that wrote the plan is a compromised reviewer. Worth testing once the loop runs.
