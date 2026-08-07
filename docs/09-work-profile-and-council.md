# Work profile & the council

Two profiles — **personal** and **work** — with different org shapes, and a council flow that turns a
project request into an execution pipeline across multiple services.

---

## Profiles are Jinn instances — no code required

`shared/home.ts` resolves the Jinn home in this order:

```
if (process.env.JINN_HOME) return path.resolve(process.env.JINN_HOME);
// else JINN_INSTANCE (default "jinn") → ~/.{instance}
```

And there's a whole `src/instances/` module — `create.ts`, `start.ts`, `directory.ts`, `access.ts`
(each with tests). **Multi-instance is a first-class upstream feature.**

So:

| Profile | Instance | Home | Org shape |
|---|---|---|---|
| Personal | `JINN_INSTANCE=personal` | `~/.personal` | One `engineer`, departments as labels ([D6](01-decisions.md#d6--departments-are-labels-not-agents)) |
| Work | `JINN_INSTANCE=work` | `~/.work` | One employee **per service** + council |

Fully separate employees, skills, cron jobs, ledger, DB, and config. Different gateway ports so both
can run at once (`lifecycle-port.ts` handles port ownership).

**Open question:** does the usage governor need to be *shared* across instances? Both draw from the
same Claude account and therefore the same 5-hour and 7-day buckets. If both run simultaneously, each
instance's governor sees only its own sessions but the *limits are global*. Two instances each pacing
to "fair share" would together spend double. **The pacing controller must read account-level limits
and coordinate across instances** — probably a shared state file outside either home. Flag this before
running both concurrently.

---

## Why the work profile overturns D6 — legitimately

[D6](01-decisions.md#d6--departments-are-labels-not-agents) said departments are labels, not agents,
because per-department agents duplicate orientation when they share a repo. It named the exception:

> Promote a department to its own employee only when the context it needs genuinely differs
> (different repo/stack/credentials), not merely when the subject matter differs.

**The work profile is that exception.** `onboarding`, `kyc`, `mobile-backend`, `app`,
`address-service` are separate repos with separate domain models and separate integration contracts.
There is no shared orientation to duplicate — each agent's context is genuinely its own. Same test,
opposite answer.

It also makes cross-service work the **highest-quality fan-out available**: distinct repos, no shared
files, no merge conflicts. The [D7](01-decisions.md#d7--sequential-default-bounded-fan-out-amends-d2)
gates and the pacing controller still govern the *degree* — the weekly budget doesn't care that the
parallelism is clean.

---

## Service employees

One per service. Each carries:

| | |
|---|---|
| `department` | the service slug (`kyc`, `onboarding`, …) |
| `cwd` | that service's repo |
| **skill** | its knowledge base — see below |
| `engine` / `model` | Sonnet 5 for both consultation and execution |
| `rank` | `senior` (they answer to the council, they own their service) |

### The knowledge base

Jinn's primitive for this is **skills** (`gateway/skills.ts`, `shared/skill-commands.ts`, stored under
`~/.work/skills/`) — described upstream as "customized best-practices context with progressive
disclosure," which is exactly the shape. There is no separate knowledge-base subsystem.

Per service, a `SERVICE.md` in the repo plus a Jinn skill pointing at it:

- **Purpose** — what this service is for, in two sentences
- **Owns** — data, endpoints, queues, jobs it is the source of truth for
- **Public contracts** — APIs/events it exposes, with stability guarantees
- **Integration points** — who calls us, who we call, what we assume of them
- **Invariants** — things that must stay true
- **Gotchas** — the non-obvious, the load-bearing hacks, the things that bit someone

**Bootstrapping:** one-time "write your SERVICE.md" task per service. Expensive once, amortised
forever. Do it before the first council run — a council consulting empty knowledge bases produces
confident nonsense.

**Keeping it current — this is the part that usually rots.** After each completed todo, the service
employee appends what it learned to its own knowledge base. Cheap, and it's the same ledger-as-memory
pattern from [04-efficiency.md](04-efficiency.md#8-the-ledger-is-the-memory--dont-re-explore). Without
this the knowledge base is stale within a month and the council's routing decisions quietly degrade.

### The service registry

Separate from the knowledge bases: a small index the council reads to *route* — service name, one-line
purpose, what it owns, who it integrates with. Cheap to load all of it; the full knowledge bases are
only read by the services themselves in phase 3.

---

## The blocker: agents can't ask clarifying questions

`buildInteractiveArgs()` passes **`--disallowedTools AskUserQuestion,ExitPlanMode`**. Jinn is built
for unattended operation, so the tool that asks the human is deliberately removed. The council is the
opposite — it's interactive by design.

**Don't fork the arg builder.** The council doesn't need the tool: it **writes its questions as a chat
message** and the session goes idle awaiting a reply. Jinn's chat is already the command centre, and
sessions accept messages while `idle`. Zero code, and it uses the surface you'd want to answer in
anyway.

**One required change:** the continuous loop (step 7) must not auto-continue a session that's waiting
on a human. Add `interactive: true` to the council employee and exclude those sessions from Stop-hook
continuation. Small, and worth getting right — otherwise the council answers its own questions and
proceeds on invented requirements.

---

## Council flow

| Phase | Who | Model | Mode | Output |
|---|---|---|---|---|
| 1. **Intake** | `council` | Opus `high` | Interactive, loops | Scoped brief |
| 2. **Impact triage** | `council` | Opus `high` | Reads service registry | Affected service list |
| 3. **Consultation** | each affected service | Sonnet `medium` | **Parallel, read-only** | Per-service breakdown |
| 4. **Synthesis** | `council` | Opus `high` | Reconciles | Dependency graph + pipeline |
| 5. **Approval** | you | — | Chat | Go / revise |
| 6. **Execution** | service employees | Sonnet `medium` | Governed loop | Work |

**Phase 1 — Intake.** You post the project. The council asks clarifying questions until the brief is
unambiguous: what outcome, what's in and out of scope, constraints, deadline, what "done" looks like.
It should be willing to ask two or three rounds rather than guess — this is the cheapest place in the
whole system to remove ambiguity.

**Phase 2 — Impact triage.** From the brief plus the service registry, decide which services are
touched. Routing only — it reads one-line summaries, not full knowledge bases. Cheap, and it bounds
phase 3's cost. Ask the council to state *why* each service is or isn't included, so a wrong call is
visible before you pay for it.

**Phase 3 — Consultation.** Each affected service employee, in parallel, reads its own knowledge base
and repo and answers a fixed template:

- What changes are needed on our end
- **What already exists** that covers part of this
- What's genuinely new
- What we need **from** other services (contract requests)
- What we must **provide** to other services
- Risks, migrations, backfills
- A breakdown into task → sub-task → sub-sub-task (depth ≤ 3, matching the ledger's cap)

This is read-only fan-out across genuinely distinct contexts — the case
[D7](01-decisions.md#d7--sequential-default-bounded-fan-out-amends-d2) allows freely. Sonnet is right
here: the service is reading its own docs and reporting, not doing novel reasoning.

**Phase 4 — Synthesis.** The council reconciles N breakdowns into one plan. This is the genuinely hard
reasoning and the reason the council is Opus:

- Match contract *requests* against contract *provisions* — if `kyc` needs a field `onboarding`
  doesn't yet emit, that's an ordering constraint and a missing task
- Flag unmatched requests (someone needs something nobody is providing) — the most valuable output of
  the whole flow
- Dedupe overlapping work
- Build the dependency graph and topologically sort it into phases
- Write the todo tree into the ledger with `department`, `parallelSafe`, `parallelGroup` per
  [D8](01-decisions.md#d8--fan-out-is-planner-annotated-budget-gated-and-fails-closed)

The pipeline is emitted as a **Jinn workflow** — `src/workflows/` already supports sequential,
conditional, parallel and switch paths with per-phase engine/model selection and approval gates, and
`gateway/workflow-todo-binding.ts` binds workflow nodes to todos. The council doesn't need a new
execution engine; it generates a workflow.

**Phase 5 — Approval, mandatory.** Given what phase 6 costs, never auto-start. You see the graph, the
task count, the estimated budget, and the unmatched contracts before anything runs.

**Phase 6 — Execution.** The normal governed loop, per service, following the workflow's ordering.
Cross-service ordering from the workflow; within a service, the sequential loop.

---

## Where the council replaces the planner

In the work profile the **council subsumes the `planner` role** — phases 1–4 *are* decomposition, done
with more context and a human in the loop. Keep `planner` in the personal profile; in work, the roster
is:

```
council (executive, Opus, interactive)
   └── reviewer (manager, Opus)
          └── onboarding | kyc | mobile-backend | app | address-service   (senior, Sonnet)

security (executive, system)
scribe   (Haiku/Sonnet-low, stand-up narration)
```

Stand-up grouping works unchanged — `department` is already a column on `work_items`, and here it's
genuinely per-service.

---

## Cost shape

The council is Opus-heavy but **rare** — once per project, not per task. Phases 1, 2 and 4 are Opus;
phase 3 (the widest phase) is Sonnet. That keeps the scarce bucket on the reasoning and the abundant
bucket on the reading.

Still worth gating: a council run across five services is a real chunk of budget. Run it through the
same pacing controller, and make its *estimated* cost part of the phase-5 approval screen. A council
run that would consume 30% of the weekly bucket is a decision you should make deliberately.

---

## Open questions

- **Cross-instance governor coordination** (above) — the most important one. Two instances, one
  account, two independent governors that each think they have the whole budget.
- Do the service employees need write access to each other's repos for contract changes, or does each
  contract change become a task in the *providing* service? (Latter is cleaner and matches ownership;
  confirm it doesn't deadlock on tight coupling.)
- How does the council handle a service whose knowledge base is stale? It should be able to say "my
  docs don't cover this, I need to investigate first" and emit an investigation task rather than
  guessing.
- Does `depth ≤ 3` on work items accommodate task → sub-task → sub-sub-task **under a project root**?
  That's four levels. Check `work-items/relations.ts` — this may need the cap raised, or the project
  root modelled as something other than a work item.
