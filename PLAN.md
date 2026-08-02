# ICI-666 — `jinn-simplify`, the ultra workflow

Base: `main` @ `492cbc18dcc7fc883f8bcae1dcc4bac1bccf46dc`
Branch: `build/ICI-666-simplify-workflow`

## What the operator asked for

A second build-style pipeline, deliberately expensive, running on Claude models (Opus 5
and Fable 5). It is armed by enabling it and runs hourly while enabled — the on/off switch
is "do I have spare tokens this week". Each run picks **one** area of the Jinn project to
improve, writes **hard, mechanically checkable constraints before touching any code** so
the result is a *simplification* rather than another layer, and runs PLAN → IMPLEMENT →
VERIFY like `jinn-build`. It asks for **no approval**. When a run succeeds it opens a
**pull request** with a detailed summary and leaves its Todo in `in_review`.

## Where the deliverable lives — read this before reviewing the diff

A Workflow in Jinn is **company state, not repository code**. `jinn-build` itself does not
exist anywhere under `packages/**`; it lives in the Workflow store and is authored through
`create_workflow` / `update_workflow`. `jinn-simplify` is authored the same way.

So the acceptance criteria below are checked against the **live definition**
(`get_workflow { workflowId: "jinn-simplify" }`), not against a file. The branch diff is
intentionally `PLAN.md` only — that file is already tracked on `main` and is this
pipeline's existing convention.

Explicitly rejected: committing the definition as JSON under `packages/**` plus an
installer script. It would be a second source of truth for something the store already
owns, it would ship a definition full of one operator's local paths to strangers, and
inventing a new repo convention for a single file is exactly the over-engineering this
workflow is being built to fight.

## The graph

Trigger `schedule`, cron `0 * * * *`, timezone `Europe/Sofia`. Created **disabled**.

```
trigger ─ survey ─ worth-doing? ─(no)─ nothing-found (end)
                        │
                       (yes)
                        │
                    constrain
                        │
                   implement-1 ─ verify-1 ─ verdict-1 ─(ship)──┐
                        ┌──────────(rework)──────┘             │
                   implement-2 ─ verify-2 ─ verdict-2 ─(ship)──┤
                                               (rework)        │
                                                  │        shippable
                                              handback         │
                                                  │         deliver
                                            stopped (end)      │
                                                          delivered (end)
```

No approval node anywhere. Mirrors `jinn-build` minus the variant gate and the merge gate.

### Node roles, employees and models

| Node | Employee | Engine / model / effort | Job |
| --- | --- | --- | --- |
| `survey` | `jinn-dev` | claude / **opus** / high | Pick exactly ONE target. Create the Todo. |
| `constrain` | `jinn-verifier` | claude / **fable** / high | Turn it into a budget the implementer cannot argue with. |
| `implement-1` | `jinn-dev` | claude / **opus** / high | Build inside the budget. |
| `verify-1` | `jinn-verifier` | claude / **fable** / high | Independent review plus the budget check. |
| `implement-2` | `jinn-dev` | claude / **opus** / high | Fix round-1 Blockers and Majors only. |
| `verify-2` | `jinn-verifier` | claude / **fable** / high | Scope-locked final check. |
| `deliver` | `jinn-dev` | claude / **opus** / high | Push, open the PR, move the Todo to `in_review`. |
| `handback` | `jinn-verifier` | claude / **fable** / low | Honest failure note, Todo → `escalated`. |

Alternating Opus and Fable across the propose/check pairs is deliberate: the model that
writes the budget is not the model that spends it, and the model that writes the code is
not the model that judges it.

### The Todo

A schedule-triggered run has no Todo of its own, so `survey` creates one
(`create_work_item`, label `simplify`) and emits `todoId`. Every later node addresses that
Todo, which also makes the Todo ledger this workflow's memory.

### Not repeating itself, and not piling up

`survey` reads the existing `simplify` Todos first and must:

- pick an area no open or recently closed `simplify` Todo already covers;
- emit `worth: no` and end the run cleanly when it cannot find one worth the money — an
  hourly job that always finds something will manufacture work;
- emit `worth: no` when two or more `simplify` Todos are already `executing`, capping
  concurrency at two overlapping runs on one checkout.

### What `survey` is looking for

The operator named three flavours, and `survey` picks exactly one target from them:

1. **Over-engineering to delete** — abstractions with one caller, configuration nobody
   sets, indirection that costs more to read than it saves.
2. **Blended concerns** — enumerate the core pieces (Todos, Workflows, Triggers, Sessions,
   Employees, Engines, Connectors, Cron, Knowledge, gateway HTTP, web UI) and find two that
   share code, storage, or vocabulary where they should be separate. The operator's own
   example is Todos versus Workflows.
3. **Something that does not work** — a dead path, a silently swallowed failure, prose the
   code has already falsified.

### The constraints — the actual point of the workflow

`constrain` emits the budget as data, and every field is something a shell command can
settle. Defaults it must justify departing from:

- `netLineDelta` ≤ 0 — a simplification removes at least as much as it adds.
- `maxFilesTouched` — a small integer, stated.
- `maxNewFiles` — 0, unless splitting an oversized file is the whole task.
- `maxFileLines` — no file may end the change longer than this, and no touched file may
  grow at all.
- `noNewDependencies` — `package.json` and the lockfile untouched.
- `noNewConfigOptions`, `noNewPublicExports` — no new surface for a case nobody has.
- `noSingleCallerAbstraction` — no helper, interface, or option introduced with fewer than
  two real callers.
- Behaviour preserved: `pnpm typecheck`, `pnpm test`, `pnpm build` green, and no test
  deleted unless the thing it tested was deleted.

`constrain` also emits `budgetCommand`: a literal shell command printing the measured
numbers, so `verify-1` settles the budget by running it rather than by having an opinion.

### Delivery

`deliver` pushes the branch to `origin` and runs `gh pr create` with a summary stating the
area, why it was over-engineered, the budget, and the measured result against that budget.
It then sets the Todo to `in_review`. It does not merge, and there is no approval gate
anywhere in the graph — that is what the operator asked for. The PR is public; that is the
operator's explicit instruction, recorded here so it is a decision rather than a surprise.

Every phase inherits `jinn-build`'s production-safety block verbatim (never port 7777,
never `~/.jinn`, never a gateway without a throwaway `JINN_HOME` and a non-prod port, never
kill a process it did not start, isolated `AGENT_BROWSER_PROFILE`) and its worktree
discipline, with paths `~/Projects/.worktrees/jinn-simplify-<todoId>` and branch
`simplify/<todoId>-<slug>` so concurrent runs cannot collide.

## Acceptance criteria

1. `get_workflow { workflowId: "jinn-simplify" }` returns a definition whose only trigger
   node is `kind: "schedule"` with `cron: "0 * * * *"`, and whose `enabled` is `false`.
2. The definition contains **zero** nodes of type `approval`.
3. Every `employee` node sets `engine: claude`, and the set of models across those nodes is
   exactly `{opus, fable}` — both present, nothing else.
4. The definition contains employee nodes for the phases `survey`, `constrain`,
   `implement-1`, `verify-1`, `implement-2`, `verify-2`, `deliver` and `handback`, wired so
   that a `rework` verdict in round 1 reaches `implement-2`, a `rework` verdict in round 2
   reaches `handback` and never a third implementation round, and a `ship` verdict in
   either round reaches `deliver`.
5. `survey`'s declared output includes `todoId` and `worth`, and a condition node routes
   `worth != yes` to an `end` node without reaching `constrain`. The `survey` prompt
   instructs it to create the Todo with the `simplify` label and to skip areas already
   covered by existing `simplify` Todos.
6. `constrain`'s declared output includes `netLineDelta`, `maxFilesTouched`, `maxNewFiles`,
   `maxFileLines`, `budgetCommand` and `acceptance`, and `implement-1`, `implement-2`,
   `verify-1` and `verify-2` each interpolate the constraint fields into their prompts.
7. `verify-1`'s prompt requires it to run `budgetCommand`, quote the real output, and
   return `rework` when the measured result exceeds the budget — a budget breach is a
   Blocker, not a note.
8. `deliver`'s prompt pushes the branch, opens a PR with `gh pr create`, and sets the Todo
   to `in_review`; `handback`'s sets it to `escalated`. Neither ever sets `done`.
9. Every employee node's prompt contains the production-safety block: no port 7777, no
   `~/.jinn`, no gateway without a throwaway `JINN_HOME` and a non-production port, and no
   killing a process it did not start.
10. The definition saves with zero validation issues, and the run history for
    `jinn-simplify` is empty — it must not have been enabled or fired during this ticket.

## Verification

Criteria 1–9 are read directly off `get_workflow { workflowId: "jinn-simplify" }`; each is
a property of the returned JSON, so the check is mechanical rather than a matter of taste.
Criterion 10 is `list_workflow_runs { workflowId: "jinn-simplify" }` returning nothing.

No repo tests are added, because no repo code changes. `pnpm typecheck`, `pnpm test` and
`pnpm build` are still run on the branch to prove the `PLAN.md`-only diff broke nothing.

## Out of scope

- Enabling the workflow. It ships disabled; arming it is the operator's call and is the
  "I have free tokens" switch.
- Running it end to end. Its first real run spends Claude money and opens a PR; a live
  rehearsal is not something this ticket buys.
- Any change under `packages/**`. No gateway, schema, or web change is needed — schedule
  triggers, the `opus`/`fable` aliases, and Todo creation from a phase session all exist.
- Changing `jinn-build`. The two pipelines stay separate.
- Retiring or editing any other workflow.

## Risks worth stating

- **Hourly and expensive by design.** The guards are that it ships disabled, that `survey`
  can decline a run, and that it refuses a third concurrent run. There is no spend cap in
  the graph itself; if the operator wants one, that is a follow-up.
- **It opens public PRs without asking.** Explicitly requested. Worth re-reading once the
  first PR appears.
- **Concurrent runs share one checkout.** Per-Todo worktrees and the concurrency check hold
  this to two, but `main` moving underneath a long run is still possible; the PR surfaces
  the conflict rather than hiding it.
