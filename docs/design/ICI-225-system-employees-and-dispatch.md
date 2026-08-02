# ICI-225 — System employees, Todo dispatch, shipped workflows

Brainstorm round. No product code. Base SHA `23df25ed`.

---

## 1. Audit — what the Todo asks for vs what exists

The Todo was written 2026-07-13. The Todos v2 program merged 2026-07-24 and delivered most of
the Todos half. Every "shipped" row below cites a path that resolves at the base SHA.

| Asked for | State | Evidence |
| --- | --- | --- |
| Linear-type experience, a board | Shipped | `packages/web/src/routes/todos/board/` |
| Comments on a Todo | Shipped | `packages/jinn/src/work-items/comments.ts` |
| Comments with attachments, images included | Shipped | `packages/jinn/src/work-items/attachments.ts` |
| Sub-issues | Shipped | `packages/jinn/src/work-items/store.ts` (`parent_id` / `root_id`) |
| Relations between Todos | Shipped | `packages/jinn/src/work-items/relations.ts` |
| Labels, priority | Shipped | `packages/jinn/src/work-items/labels.ts` |
| Hide employee-created noise, see only my own | Shipped | `packages/web/src/routes/todos/board/` — My requests = `createdBy=operator` + `rootsOnly` |
| System employees that cannot be deleted or altered | **Missing** | `scanOrg()` in `packages/jinn/src/gateway/org.ts:44` treats every YAML alike; the constructed `Employee` has no system or protected field |
| Todo Dispatcher + a Dispatch button | **Missing** | no dispatch affordance on any Todo surface; `delegate_task` exists but is agent-invoked, not a Todo action |
| Request-update button | **Missing** | — |
| Shipped system workflows, disableable | **Missing** | `packages/jinn/template/` ships `org/`, `skills/`, `knowledge/`, `docs/`, `migrations/` — no `workflows/` |

**So the unbuilt request is three things:** system employees, Todo dispatch (plus request
update), and shipped system workflows.

### Primitives dispatch should sit on top of, not beside

- `delegate_task` / `spawn_session` already create a child session bound to an employee with a
  chosen engine, model, and effort. Dispatch does not need a new session mechanism.
- The workflow runner (`packages/jinn/src/workflows/runner.ts`) already executes multi-node
  procedures with typed step outputs and approval gates. The `jinn-build` pipeline this very
  round is running on is the proof.
- Workflow definitions persist as rows in `workflow_definitions`
  (`packages/jinn/src/workflows/repository-migrations.ts:22`), not as files. Shipping a system
  workflow therefore means seeding the database, not copying a template file.

### Two facts that constrain every variant

1. **There is no DELETE route for employees.** `api.ts` exposes `GET` and `PATCH` on
   `/api/org/employees/:name` and nothing else. Employees are removed by deleting the YAML file
   on disk. Any "cannot be deleted" guarantee enforced at the API layer therefore guards the
   PATCH path only — `rm` still works.
2. **Workflows live in SQLite, employees live in YAML.** These have different upgrade stories.
   A file already written to `~/.jinn/org` is never revisited by an upgrade; a DB row can be
   re-seeded by version. That asymmetry is the main thing separating the variants below.

---

## 2. The three decisions that need the operator

**a. How strong is "cannot be deleted or altered"?**
Options run from *structurally impossible* (the employee is code, there is no file to delete)
to *refused by the API* (a flag the write paths check) to *convention* (shipped, editable, we
just do not encourage it). Recommendation: structurally impossible for the entry, editable for
the runtime knobs the Todo itself asks to be changeable (engine, model, effort).

**b. Does Dispatch pick an employee or a workflow, and who decides?**
The Todo describes an employee picker, but the operator also asks how the dispatcher handles
"a workflow right now for building stuff efficiently". Both are valid targets for the same
button. Recommendation: one button, and the routing choice belongs to the Dispatcher, with a
label match as a strong prior rather than a hard rule.

**c. Does the Dispatcher own the Todo's lifecycle afterwards, or hand off and forget?**
Request-update only has somewhere to land if the Dispatcher session is durable. Recommendation:
the Dispatcher keeps a session per Todo, so Request-update is a follow-up message into a thread
that already knows the history.

---

## 3. Variants

Three different bets on where a system employee *lives*. Each states its persistence model,
what the operator clicks, upgrade behaviour, and one named failure mode.

### Variant A — System employees are code

**Persistence.** A built-in registry compiled into the shipped bundle. `scanOrg()` starts from
the built-ins and merges `~/.jinn/org/*.yaml` on top. Nothing is written to disk at init, so
there is no file to delete and no copy to go stale. A user YAML of the same name may override
the runtime knobs the Todo asks for (engine, model, effort, notify) and nothing else; the entry
itself cannot be removed.

**What the operator clicks.** A **Dispatch** button on the Todo. It spawns a Todo Dispatcher
session bound to that Todo. The Dispatcher reads the Todo, the roster, and the enabled workflow
list, then returns one constrained result: `assign <employee>`, `start-workflow <id>`,
`hire <proposal>`, `ask` (escalate to the COO), or `hold`. The gateway performs that effect
deterministically — the model chooses, the gateway acts, so a rambling answer cannot half-start
something. **Request update** sends a follow-up into the same Dispatcher session, which looks up
the child session, posts a Todo comment, and wakes a stalled worker if it finds one.

**Upgrade.** Free and automatic. Every install runs the current Dispatcher the moment it
updates, because the definition ships with the code.

**Routing question.** The Dispatcher decides. A `build` label with an enabled `jinn-build`
workflow is a strong prior toward `start-workflow`, not a rule; genuine ambiguity returns `ask`
rather than guessing.

**Named failure mode.** *Un-debuggable in the field.* When the shipped Dispatcher misroutes,
there is no file to open and no prompt to tweak — the fix is a Jinn release. The mitigation
(an override YAML for the knobs) helps with model and effort but not with judgement.

---

### Variant B — System employees are seeded, protected files

**Persistence.** `packages/jinn/template/org/system/*.yaml`, copied into `~/.jinn/org/system/`
at init, each carrying `system: true`. `scanOrg()` reads the flag; the PATCH route refuses to
edit a system employee and the UI renders it locked.

**What the operator clicks.** Identical surface to A — Dispatch and Request update behave the
same, because the Dispatcher is still a real employee with a real session. The difference is
that its persona is a file on disk the operator can read, diff, and, if they choose, unlock.

**Upgrade.** The weak point. Once a file is written it is never revisited, so a Dispatcher
improved in v2 does not reach an install created under v1. Re-seeding on upgrade would silently
overwrite a persona the operator deliberately edited, and *not* re-seeding leaves the fleet
running divergent Dispatchers.

**Routing question.** Same as A, and better in one respect: routing preferences live in editable
persona prose, so an operator can teach their Dispatcher "always use jinn-build for `build`"
without a release. That editability is also exactly how installs drift apart.

**Named failure mode.** *Silent divergence.* The `system: true` flag guards the PATCH route, but
there is no DELETE route to guard — `rm ~/.jinn/org/system/todo-dispatcher.yaml` still removes
it, and an edited copy sticks around forever. Within two releases, support answers stop matching
what a given install actually runs.

---

### Variant C — No new employee kind; Dispatch is a shipped system workflow

The minimal option, stated honestly as such.

**Persistence.** Nothing new. System workflows are seeded `workflow_definitions` rows carrying a
`system` origin and a version, re-seeded on upgrade unless the operator has forked them. They are
disabled with the existing `disable_workflow`. No changes to `scanOrg()`, no new employee
concept, no new protection semantics.

**What the operator clicks.** **Dispatch** starts a `todo-dispatch` workflow run on the Todo.
Node 1 is a deterministic routing check (label to workflow map); node 2 is an LLM step that
picks an employee when no workflow matches; node 3 performs the delegation. The run appears on
the Todo like any other workflow run, with the approval gates already built.

**Upgrade.** The cleanest of the three, because workflow definitions are already versioned rows
and the runner already handles blueprint versions.

**Routing question.** Answered most explicitly of the three, and deterministically: a label to
workflow map is consulted first, employee assignment is the fallback branch. Adding a route
means editing the blueprint rather than persuading a model.

**Named failure mode.** *There is no colleague.* The Todo asks for "a new session with a default
System employee whose name might be Todo Dispatcher" and for Request-update to "send a follow-up
message to the Todo Dispatcher employee session". A workflow run is not a durable conversational
thread, so Request-update has nowhere natural to land — it becomes "start a second run", which
loses the history that made the feature worth having.

---

## 4. Recommendation

**Variant A.** It is the only one that makes "cannot be deleted" true rather than merely
enforced, and the only one where an upgrade actually reaches an existing install. It keeps the
Dispatcher a visible colleague with a durable session, which is what makes Request-update
coherent. Its failure mode — not tweakable in the field — is the one we can most cheaply soften,
by allowing a same-name YAML to override engine, model, and effort, which the Todo asks for
anyway. C's determinism is worth stealing: ship A's Dispatcher with C's label-to-workflow map as
its first-pass prior, so the common case never depends on model judgement.

### Slice plan if A is picked

Thin vertical slices in the shape Todos v2 used, each independently mergeable.

1. **Built-in registry.** `scanOrg()` merges compiled-in system employees under user YAML; a
   `system` marker on `Employee`; PATCH refuses non-knob fields; the org UI renders the lock.
   One shipped employee: Todo Dispatcher. No Todo surface changes.
2. **Dispatch, employees only.** Button on the Todo, Dispatcher session with the constrained
   output contract, gateway performs `assign` / `hire` / `ask` / `hold`. Workflow routing not
   yet wired.
3. **Workflow routing.** Add `start-workflow` to the contract plus the label-to-workflow prior;
   ship the first system workflow blueprint through the same seeding path.
4. **Request update.** Follow-up into the existing Dispatcher session; comment, status update,
   stalled-worker wake.

---

## 5. Out of scope this round

Implementation of any of the above. Changes to the existing Todos UI, which shipped. Schema or
migration work. Re-designing the board, task page, or filters.
