# Council/specialist redesign — D20–D25

Supersedes the planner/engineer/reviewer/scribe roster (D6's "one executor") and the personal/work
instance split (D11) with a different shape: the user manages **Profiles** and **Projects**; a
**council** of Opus-tier generalists takes it from there, breaking a project into **phases** and
delegating to **specialists** — Sonnet-tier employees who each own exactly one repo, hold a persistent
RAG-retrieved knowledge base of it, and work continuously and unattended, same as the existing engine,
just per-repo instead of one shared executor.

Two things verified against source before any of this was trusted into a plan:

1. **Every session's `cwd` is hardcoded to `JINN_HOME`** — 8 real call sites (`gateway/api.ts:7398`,
   `gateway/pty-ws.ts:108`, `sessions/manager.ts:559`, `sessions/compaction.ts:69,96`,
   `sessions/rate-limit-handler.ts:242,350`, `sessions/handoff.ts:198`). "A specialist owns a repo" is
   inert until every one is parametrized — the single must-land-first change here.
2. **A structured, schema-constrained inter-agent handoff mechanism already exists** —
   `workflows/output.ts`'s `workflow_submit_output` (MCP tool, validated against a per-node
   `output.fields` contract in `workflows/model.ts`) plus `create_workflow`/`update_workflow`/
   `start_workflow_run` (employee-callable). The council authoring its own execution pipeline needs no
   new backend plumbing. The one real gap: `workflowOutputFieldSchema.type`/`FIELD_TYPES` only allow
   `'string'|'number'|'boolean'|'string[]'` — needs a bounded `'json'` type for nested handoff fields.

## D20 — "Profile" is renamed away from D11's instance-level meaning

D11 used "profile" for `JINN_INSTANCE=personal|work` — a separate home/DB/port. The new Profile is a
user-defined grouping *inside one running instance*. Shipping both as "Profile" guarantees confusion.
**Chosen:** rename D11's concept to **instance** everywhere in these docs (it already is one, in code).
**Reasoning:** the code already calls it `JINN_INSTANCE`; only the docs' prose called it "profile."

## D21 — Phase is a label on tasks, not a new tree depth

The work-item tree is capped at depth ≤3 (root/task/sub-task/sub-sub-task). A literal 5th level blows
that cap for no benefit. **Chosen:** `phase` is a column on `work_items`, exactly parallel to
`department` (D6's "labels, not agents" applied again) — per-project vocabulary (a `work_item_phases`
registry scoped by `rootId`), transitions logged (`work_item_events`, new `phase_changed` kind), not
gated. **Revisit if:** a project genuinely needs cross-cutting phase logic the tree can't express.

## D22 — Profile is a namespace inside one instance, not a separate `JINN_INSTANCE`

**Chosen:** modeled exactly like the existing `workspacePath` overlay (`work_items/store.ts:150-152`,
additive `work_item_workspace` table, depth-0-only) — a `profiles` registry + `work_item_profile`
overlay table, not a schema change to `work_items` itself. **Reasoning:** the user explicitly wants
many profiles (work/personal/side-project/hobby/...), and N separate running instances (N ports, N DBs)
fights the stated goal of abstraction. **Revisit if:** cross-profile confidentiality turns out to need
real process isolation, not just a namespace.

## D23 — Generalist↔specialist relationship is not `reportsTo`

**Chosen:** it's per-task and per-project, shown through work-item assignment and handoff documents
(D25), not a static org-chart edge. **Reasoning:** `reportsTo`'s own doc comment already flags it as
unsuited to anything beyond one fixed dotted line; the real relationship changes per delegation.

## D24 — No new "specialist handoff" workflow node type; no in-graph iteration loop

**Rejected:** a dedicated node type for specialist-to-specialist handoff. **Reasoning:** `employee` +
`output.fields` + `workflow_submit_output` already is the handoff mechanism (finding 2 above); a
parallel node type duplicates `runner.ts`'s dispatch/output-validation state machine for zero behavioral
gain. **Rejected:** expressing "iterate until the plan stabilizes" as a graph cycle. **Reasoning:**
`workflows/validation.ts` rejects cycles outright, by design. Bounded iteration is the generalist
re-running fresh, acyclic consultation rounds from an outer interactive session, capped at a small round
limit (reuse the shape of `store.ts`'s existing `DEFAULT_MAX_ROUNDS`, not its literal values) — not
something expressed inside one workflow graph.

## D25 — The Opus-bucket telemetry gap gets fixed now, not deferred

D3's economics (Opus stays to planner+reviewer, ~85% of volume on Sonnet) were enforced by having
exactly one Opus employee on each side. `GovernorTelemetry` has no per-model-bucket dimension — one
unified 5h/7d %, even though Opus and Sonnet draw from genuinely separate Max-plan buckets per D3. A
council with more than a couple of Opus generalists can run comfortably under an aggregate 80%
threshold — mostly cheap Sonnet-specialist headroom — while the Opus bucket silently starves
underneath it, invisible until it halts everything with no warning. **Chosen:** (a) hard-cap generalist
count in config, default 3–5; (b) extend `shared/governor.ts`/`session-telemetry.ts` to track the Opus
bucket separately from the general bucket.

---

## Data model

| Entity | File(s) | Shape |
|---|---|---|
| Profile | new `work-items/profile-rows.ts` + `profiles.ts`, DDL in `migrate.ts` | Registry table + additive overlay, mirrors `workspace-rows.ts`/`departments.ts` exactly |
| Phase | new `work-items/phases.ts`, `phase TEXT` column in `migrate.ts` | Per-project registry (`rootId`-scoped), `phase` column parallel to `department` |
| `Employee.repo` | `shared/types.ts`, parsed in `gateway/org.ts` | The specialist's one owned repo (absolute/`~`-relative). Absent = generalist. |
| `Employee.color` | `shared/types.ts` + `web/src/lib/settings.ts`'s `EmployeeOverride` | Round-table/avatar identity; new `web/src/lib/color-pool.ts` deterministic fallback, mirrors `emoji-pool.ts` |
| `resolveSessionCwd()` | new `shared/session-cwd.ts` | `(employee?) => employee?.repo ?? JINN_HOME` — the function every hardcoded call site switches to |
| Handoff documents | new `council/handoff-schemas.ts` | `scope-request`, `scope-verification`, `plan-hld-lld`, `task-assignment`, `completion-report` — strict-validated shapes, carried by `output.fields` (in-workflow) or a new `"handoff-document"` `ChatBlockType` (pre-workflow chat intake) |
| Specialist KB metadata | `~/.{instance}/kb/<employeeName>/manifest.json` | Filesystem-resident, not in the SQL ledger — `{employeeName, repo, lastIndexedAt, lastIndexedGitSha, fileCount, chunkCount, embeddingModel}` |

Once `Employee.repo` + `resolveSessionCwd` land, `gateway/hook-endpoint.ts` already reads the live
process `cwd` for workspace confinement (M5's security work) — specialists get confined to their own
repo automatically, no new confinement code.

## RAG subsystem (`packages/jinn/src/knowledge-base/`) — fully greenfield, confirmed zero prior art

Precedent for the retrieval discipline: `mcp/knowledge-tools.ts`'s `search_knowledge` is index-only,
≤20 snippet hits, "never inlined" by its own docstring — same budget shape applies to repo content.

- `chunking.ts` — walk a repo respecting `.gitignore`, ~800–1200 token chunks with slight overlap,
  line/heuristic-based, not full AST.
- `embeddings.ts` — local ONNX embedding model via `@xenova/transformers`, default
  `Xenova/bge-small-en-v1.5` (384-dim). Chosen over Voyage AI (hosted, per-call, network-dependent —
  breaks the standing "no hosted dependency by default" principle). State plainly at wizard time: first
  specialist creation downloads a ~130MB model once, then fully offline.
- `store.ts` — `sqlite-vec` loaded as a `better-sqlite3` extension, one `vec0` table per specialist.
  Chosen over LanceDB (second storage engine) and `sqlite-vss` (unmaintained).
- `manifest.ts`, `index.ts` (`runLearningPhase` full index, `runIncrementalUpdate` diffs against
  `lastIndexedGitSha` via `git diff --name-status`), `retrieval.ts` (`retrieveForTask`, the only read
  path into a KB), `teaching.ts` (reuses the existing `interactive: true` session flow as-is, stores the
  transcript as `source: 'teaching'` chunks blended with `source: 'code'`).
- `mcp/repo-knowledge-tools.ts` — `search_repo_knowledge`/`read_repo_chunk`, resolving `employee.repo`
  from the calling session's own identity so a specialist can only search its own KB.
- Context injection: not inlined at session start. One pointer line in `sessions/context.ts`'s stable
  ESSENTIAL tier; retrieved chunks arrive per-turn, never in the cached-prefix tier.

## The council protocol — "Plan with the council"

1. Chat target — extend `chat-employee-picker.tsx`'s department grouping with a `generalists` bucket.
2. Intake — interactive Opus generalist in chat, reusing the existing `interactive: true` +
   Stop-hook-exclusion mechanism.
3. Triage — enumerating specialists is a query (`list_employees` filtered by `department=specialists`),
   not a model call. Judging relevance is a model call at `effort: medium`.
4. Draft scope → author a workflow via `create_workflow`, one `employee` node per affected specialist
   declaring a `scope-verification`-shaped `output` contract, drawn as parallel branches off the
   trigger, not a chain.
5. Consultation → merge (`wait-all`) → synthesis `employee` node (`effort: high`) reconciling into
   `plan-hld-lld` — HLD (what changes, cross-repo contracts) + LLD (files, functions — not code-level) +
   a task/sub-task/commit breakdown per repo.
6. Bounded iteration outside the graph — the generalist, as an ordinary session, starts a fresh acyclic
   round when synthesis surfaces corrections, capped at a small round limit.
7. One mandatory human approval gate — the existing `approval` node, `operatorOnly: true`.
8. Execution — `task-assignment` handoffs, each a normal `WorkItem` with `verifyCommand` (existing
   checkpointing, unchanged). `parallelSafe: true` set automatically whenever two dispatched specialists
   have different `employee.repo`.

## Frontend

- Round-table dashboard — `web/src/routes/roundtable/page.tsx`, replaces `routes/standup/` (deleted).
- Org tab — extends the existing React Flow canvas at `routes/workflow/editor/`: `'json'` field-type
  editor, an "authored by `<generalist>`" badge, a `"handoff-document"` chat block renderer.
- Specialist carousel — `web/src/routes/specialists/page.tsx`.
- Specialist creation wizard — `web/src/routes/specialists/new.tsx` (name/repo/model/effort → learning
  phase → teaching phase). Last piece to land; the integration point across every other piece.
- Cleanup: delete `routes/standup/page.tsx`, `work-items/standup.ts`, `gateway/standup-api.ts`, their
  nav entries; delete the "Context remaining" block in `routes/limits/page.tsx`'s `SessionCard`.
- `config/org/{planning,engineering,review,reporting}/*.yaml` retire, replaced by
  `config/org/generalists/*.yaml` and `config/org/specialists/*.yaml`.

## Efficiency optimizations — where they land (top tier adopted, bottom tier explicitly deferred)

| Optimization | Landing point |
|---|---|
| Prompt caching | `sessions/context.ts` tier ordering; Claude Code CLI already caches automatically |
| Complexity-based routing | Triage at `effort: medium`, synthesis at `effort: high` (`resolveEffort()`) |
| RAG not stuffing | `knowledge-base/retrieval.ts` as the sole KB read path |
| Structured handoffs | `workflow_submit_output`/`output.fields` + `"handoff-document"` block type |
| Pipeline not barrier concurrency | Parallel-branch workflow authoring (protocol step 4) |
| Cheap triage before delegation | Protocol step 3 |
| Right-sized context per role | Retrieval scoping + existing `context.ts` tiering |
| Cheap redundant verification | Existing `VerifyPolicy`/`DEFAULT_MAX_ROUNDS`, applied to specialist sub-tasks |
| Dedup before fan-out | Persona instruction in generalist synthesis, not new code |
| Escalate-on-failure | Existing `retry_workflow_node` + independent per-retry `model`/`effort` bindings |
| Context compaction between handoffs | The handoff-document schema itself is the compaction |
| Structured tracing | Extend `work_item_events` with an originating `handoffDocumentId` |

Deferred (bottom tier, not built this pass): fine-tuning/prompt-distillation, speculative parallel
execution, knowledge-bank incremental re-indexing beyond the diff-based approach above, result
memoization/caching keyed on task signature.
