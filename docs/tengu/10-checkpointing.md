# Checkpointing & idempotency

The governor halts at 80%, context compacts at 80%, cron resumes. **Interruption isn't an error path —
it's the primary control flow**, happening several times a day. So checkpointing isn't recovery
tooling; it's the execution model.

---

## Hierarchy and session mapping

```
project (root)          depth 0
└── task                depth 1
    └── sub-task        depth 2   ← one per session
        └── sub-sub-task depth 3  ← atomic unit; several per session; the checkpoint
```

| Level | Granularity | Boundary meaning |
|---|---|---|
| **sub-task** | One session's scope | Clean session boundary; review gate |
| **sub-sub-task** | 10–20 min of work | **Checkpoint** — durable, resumable, idempotent |

Sizing matters: a hard cut mid-sub-sub-task loses at most that unit's work. **Size sub-sub-tasks so
losing one is cheap.** If a sub-sub-task takes an hour, the checkpoint isn't doing its job.

> **Depth check:** the cap is `depth ≤ 3`. With root at 0, this hierarchy is exactly 0/1/2/3 — it
> fits, assuming 0-indexing. My earlier note in [09](09-work-profile-and-council.md) that this needed
> four levels was wrong if root counts as 0. **Verify in `work-items/relations.ts` before designing
> around it** — it's the difference between "no change needed" and "schema migration."

---

## The checkpoint is a *pair*, and both halves must land

Marking a todo done is not enough — the work has to be durable too. A checkpoint is:

1. **Ledger status** — sub-sub-task transitions to done (`work-items/transitions.ts`, persisted by
   `store.ts`). The ledger is already the checkpoint store; no new mechanism.
2. **Git commit** — the actual work, committed with the todo id in the message: `JIN-42.3: <what>`.

Neither alone survives a crash usefully. Status without a commit means the ledger claims work that
isn't durable; a commit without status means the work is redone. **Write them together, commit first**
— an uncommitted-but-marked-done is the only unrecoverable ordering.

Committing per sub-sub-task also buys things we already wanted: the reviewer sees a coherent commit
series at the sub-task gate, a bad unit is a `git revert` rather than a manual unpick, and it lines up
with the security officer's restore points, which are already git refs.

---

## Idempotency: verify-before-act

Making arbitrary code work inherently idempotent isn't realistic. Making it **check whether it's
already done** is.

**Every sub-sub-task must carry a machine-checkable done-criterion.** A `verify` field — a command
that exits 0, or a concretely checkable statement:

```
JIN-42.3  Add `residency_status` to the address payload
  verify: rg -q 'residency_status' src/schemas/address.ts && pnpm test -- address.schema
```

Execution becomes: **run `verify` first → if it passes, mark done and move on → otherwise do the work
→ commit → re-run `verify` → mark done.**

That makes re-running any sub-sub-task safe, which is what idempotency actually needs here. It also
gives a useful decomposition rule:

> **A sub-sub-task without a machine-checkable done-criterion isn't decomposed enough.**

That belongs in the planner's and the council's personas. It's a quality forcing function as much as a
recovery mechanism — vague units are exactly the ones that get half-done and redone.

---

## Reconciliation on resume

There's still a window between "work committed" and "status written." On resume, before doing anything
else, run a reconciliation pass over the current sub-task:

```
for each sub-sub-task not marked done:
    run verify
    if verify passes  -> mark done          (crashed after work, before status)
    else              -> this is where we restart
```

Cheap (shell commands, no model tokens for the passing ones), and it closes the window without
distributed-transaction machinery. Jinn already has `work-items/reconcile.ts`, so reconciliation is an
existing concept to extend rather than invent.

**Resume order:** reconcile → read ledger → read handoff → resume work. Ledger before handoff, always
— the ledger is authoritative, the handoff is narrative.

---

## Prefer a graceful stop to a hard cut

The governor's 80% is a *hard* line. Add a **soft ceiling** below it:

```
softCeiling = hardCeiling - estimatedCostOfOneSubSubTask   (e.g. ~75%)

at a sub-sub-task boundary:
    if projectedUsageAfterNextUnit > hardCeiling  -> stop cleanly now
```

Stopping cleanly at 78% is worth more than being cut off at 80%, because the hard cut discards
in-flight work and forces a redo. The soft ceiling converts most halts into clean boundaries — which
means most resumes cost nothing beyond reading the ledger.

This is the same shape as the pacing controller's endgame logic
([08](08-pacing-controller.md)): don't start what you can't finish.

---

## Rescue uncommitted work at a hard halt

When the hard cut does land mid-unit, don't lose the edits:

1. Commit whatever is on disk to a scratch ref — `refs/jinn/wip/<sessionId>` (or `git stash create`)
2. Record the ref in the handoff
3. On resume, restore it, then run `verify` to decide whether it's finishable or should be discarded

This closes the "work exists on disk but nothing knows about it" hole, and it composes with the
security officer's restore points rather than competing with them.

---

## The handoff gets much lighter

Because the ledger now checkpoints at sub-sub-task granularity, the handoff file no longer has to
describe what was done — **the ledger already knows.** It carries only in-flight state:

- Which sub-sub-task was interrupted
- What was attempted and what was learned (the part no `verify` can capture)
- The WIP ref, if any
- Anything surprising that should change the approach

Smaller handoff → cheaper to write, cheaper to re-inject after compaction, less to go stale. This
strengthens [D5](01-decisions.md#d5--separate-context-pressure-from-usage-pressure): the handoff is a
narrative supplement to an authoritative ledger, not a state dump.

---

## Tension with upstream doctrine — worth noting

Jinn's `2026-07-27-todo-hierarchy-clarity` plan states a **one-root-per-outcome** doctrine: *"only
independently assignable/reviewable deliverables become children"*, and procedural steps *"remain in
the parent body, comments, or activity"* rather than becoming todos.

Sub-sub-tasks as checkpoints push against that — they are closer to procedural steps than to
independently reviewable deliverables. **The justification for diverging: they need durable, queryable
status, which body text can't provide.** That's a real requirement, not a stylistic preference, and
it's our fork.

**Fallback if depth 3 turns out to be blocked:** model sub-sub-tasks as a structured checklist inside
the sub-task body, with `verify` per item and checkbox state. Cheaper, no schema change — but weaker:
no per-item transitions, no assignee, harder to query, and the stand-up can't count them. Prefer
first-class; keep this in reserve.

---

## What this changes elsewhere

| Doc | Change |
|---|---|
| [03 plan](03-implementation-plan.md) | New step 11; step 5's handoff shrinks to in-flight state only |
| [05 org](05-org-structure.md) | `planner`/`council` personas must require a `verify` per sub-sub-task |
| [08 pacing](08-pacing-controller.md) | Add the soft ceiling; halt at unit boundaries |
| [09 council](09-work-profile-and-council.md) | Phase 3 breakdowns must include `verify` at the leaf |

---

## Open questions

- **Is `depth` 0-indexed?** Decides whether this fits or needs a migration. Check first.
- What's the right `verify` for work that isn't mechanically checkable — a docs change, a refactor with
  no behaviour change? Options: a weaker criterion (file exists, contains string), or accept that some
  units are marked done on the agent's assertion and flag those as lower-confidence in review.
- Should `verify` run in the security officer's policy path? It's a shell command generated by a model,
  so it's exactly the class of thing the deny-list exists for. **Yes — route it through
  `evaluateCommandPolicy` like any other command.**
- Per-sub-sub-task commits could produce a noisy history. Squash at the sub-task gate after review, or
  keep the granularity for bisectability? Leaning keep — the noise is worth the recoverability, and the
  reviewer sees the series anyway.
