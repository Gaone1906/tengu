# Jinn Chat Workflow Todo KISS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Todo and Workflow operations feel native in chat while making Workflow runs first-class durable records that report exactly once to their invoking session without creating, owning, linking, or mutating Todos or synthetic Workflow sessions.

**Architecture:** Keep Todo, Workflow definition, Workflow run, and Session as separate authorities. Persist one explicit `WorkflowRun.invocation` relation for a verified invoking Session, project run state into one durable chat block, and feed stable parked/terminal report episodes through the existing callback-delivery persistence and worker. Stop creating synthetic Workflow Sessions while retaining historical rows read-only, and replace Workflow–Todo approval bridges with native Workflow gate and poll-activation approval records.

**Tech Stack:** TypeScript ES2022 strict mode, Node.js 24, better-sqlite3, file-backed Workflow evidence, Vitest 4, React 19, React Router 7, Vite 7, Tailwind CSS 4.1, Radix UI, pnpm 10, Turborepo.

## Global Constraints

- Execute every task sequentially. Do not start the next task until the current task has recorded expected RED, minimal GREEN, focused review, and its scoped commit.
- Do not use parallel agents. After every scoped implementation commit, stop and wait for COO verification or a concrete follow-up before starting the next task.
- After COO accepts this plan, Task 0 commits this plan document before any production edit. The plan must not remain untracked during implementation.
- Before each production edit, add the named failing test and capture the exact failing assertion or missing symbol. A compile failure counts as RED only when the test intentionally imports the not-yet-created contract.
- Use the focused commands written under each task. The live package filters are `jinn-cli` and `@jinn/web`; do not substitute the stale `jimmy` or `web` filters.
- Run tests only with disposable `JINN_HOME` directories and non-default gateway ports. Never point implementation verification at an installed instance or port 7777.
- Preserve all unrelated dirty files. Stage only paths named by the current task and inspect `git diff --cached --name-only` before each commit.
- Do not add `Co-Authored-By` trailers.
- Keep every shipped path generic. No personal names, products, email addresses, Slack identifiers, API keys, or absolute personal home-directory paths may enter the repository.
- A Workflow run must remain executable and recoverable when chat activity projection or report delivery fails. Projection and session delivery are durable side effects of run state, never its lifecycle authority.
- No Workflow code may import a Todo write primitive after Task 3. The permitted Todo-status trigger reads a committed Todo event as one-way input and starts an independent run.
- `parentSessionId` means conversational ownership or callback ownership only. Workflow phase grouping uses `workflowRunId`; no Workflow run is represented by a Session.
- The only caller-facing reporting option is `reportMode: "resume" | "silent"`; the default is `"resume"`. Do not introduce `notify`, `callback`, `wait`, `detach`, COO-only, or employee-specific reporting variants.
- A browser/operator or CLI invocation authenticated only by gateway bearer has no invoking Session. It creates a durable run but no session callback owner. A verified MCP/session invocation always records its invoking Session, regardless of employee rank.
- Server-authored activity blocks are persisted before they are emitted. Reload and live WebSocket rendering must use the same block id, payload, fallback, and monotonic version.
- `callback_deliveries` is the single durable session-delivery mechanism. Generalize its source identity in place; do not add a Workflow report table, Workflow-specific acceptance id, retry worker, recovery loop, dead-letter endpoint, or requeue endpoint.
- A reportable Workflow transition has a stable persisted episode sequence. Updating unrelated metadata while parked never creates another episode; leaving park and later re-entering creates exactly one new parked episode; terminalization stamps one immutable terminal episode.
- Legacy `engine:"workflow"` run Sessions, their messages, queues, and callback rows are historical read-only evidence. This implementation may classify and redirect them but must not archive, copy, detach, rewrite, or delete them.
- Use one new WebSocket mutation event, `company:changed`, for Todo, Workflow definition, Workflow run, and Workflow trigger changes. Continue using the existing `session:created` event; do not add four entity-specific event names.

---

## Locked Contract and Surface Map

### Run invocation and report behavior

| Entry path | Current implementation | Persisted invocation | Target reporting | Todo effect |
|---|---|---|---|---|
| MCP `start_workflow_run` | `packages/jinn/src/mcp/workflow-tools.ts` → `POST /api/workflow-definitions/:id/run` | Verified `x-jinn-caller-session` | `reportMode` defaults to `resume`; `silent` only suppresses resumption | None |
| MCP `run_workflow_by_name` | `packages/jinn/src/mcp/workflow-tools.ts` → `POST /api/workflow-runs/by-name` | Verified `x-jinn-caller-session` | Same behavior as every other invoking Session | None |
| Browser Run composer | `packages/web/src/routes/workflow/run-view.tsx` → definition run route | None; authenticated operator is not a Session | Durable run and visible UI result, no session callback | None |
| CLI `jinn workflow run` | `packages/jinn/src/cli/workflow.ts` → by-name route | None | Durable run printed by CLI, no session callback | None |
| Managed schedule tick | `packages/jinn/src/cron/runner.ts` → `workflowCronFireHandler` | None | Durable run only | None |
| Manual cron fire | `POST /api/cron/:id/trigger` → the same managed Workflow fire | None | Durable run only | None |
| Webhook/event | `POST /api/workflow-events` → `fireWorkflowEvent` | None | Durable run only | None |
| Poll | `startPollTriggerRunner` / `runPollTriggerOnce` | None | Durable run only | None |
| Todo status event and replay | `fireTodoStatusChangeWorkflows` / `replayMissedTodoStatusChangeWorkflowFires` | None | Independent durable run only | Read event payload; never link or mutate the source Todo |
| Idempotency replay | `run-idempotency.ts` claim lookup | Original persisted invocation | No new report signal; return the original run | None |
| Crash reconciliation | `sweepWorkflowRuns` after listener startup | Persisted invocation | Recover missing activity/report claims exactly once through the shared delivery worker | None |

### Mutation, lifecycle, callback, and migration paths

| Surface | Exact current path or signature | Planned authority and receipt/report behavior |
|---|---|---|
| Workflow definition create/update/duplicate/retire | `POST /api/workflow-definitions`, `PUT /api/workflow-definitions/:id`, `POST /api/workflow-definitions/:id/duplicate`, `POST /api/workflow-definitions/:id/retire`; MCP `create_workflow`, `update_workflow`, `retire_workflow`; Workflow list/editor | Definition store commits first, then one definition activity receipt and one `company:changed`; read-only plan/validate/list/get stay generic-tool-only. |
| Workflow run start | `runWorkflowDefinitionFromHttp`, `POST /api/workflow-definitions/:id/run`, `POST /api/workflow-runs/by-name`; MCP `start_workflow_run`/`run_workflow_by_name`; browser run composer; CLI `jinn workflow run` | One durable run. Verified Session caller writes `invocation`; browser/CLI do not. Replay returns the original run/relation and never creates a second episode or receipt row. |
| Schedule/manual cron | `workflowCronFireHandler` in `packages/jinn/src/gateway/api.ts`, installed into the cron runner by `setWorkflowCronFire` in `gateway/server.ts`, and `POST /api/cron/:id/trigger` | Invocation-less independent run, no Todo. It updates run activity surfaces through `company:changed`, not a Session callback. |
| Event/webhook | `POST /api/workflow-events` → `fireWorkflowEvent` | Invocation-less independent run keyed by existing event/fire reference; exact replay returns the existing run. |
| Poll | `startPollTriggerRunner` → `runPollTriggerOnce` | Invocation-less independent run. Activation approval is stored on the trigger binding and never delegated to a Todo. |
| User-authored Todo-status trigger | `fireTodoStatusChangeWorkflows` and `replayMissedTodoStatusChangeWorkflowFires` | Reads immutable Todo event provenance as an advanced one-way input. The resulting run has no Todo ownership/link/write capability; event-id replay is idempotent. |
| Trigger create/delete/activation decision | `/api/workflow-triggers`, `/api/workflow-triggers/:name`, planned `/activation-approval` and `/activation-approval/escalate`; MCP `create_trigger`/`delete_trigger`; Workflow editor | Trigger store commits first, patches the definition activity receipt when Session-invoked, and emits `company:changed`; activation decisions remain native trigger records. |
| Pending-step edit | `PATCH /api/workflow-definitions/:id/runs/:runId/pending-steps/:nodeId`; MCP `edit_workflow_run_step_prompt`; run UI | Run mutation lock commits a new run revision, patches the stable run activity block, and creates no report episode unless this mutation itself crosses a reportable state boundary. |
| Gate approval/escalation | Current `/resolve-gate` becomes native run approval plus planned `/gate-approval/escalate`; Workflow run UI; `escalate_workflow_gate` only for escalation | Stored Workflow approval authority decides. Approve resumes, reject terminalizes, escalation changes approval routing; no path calls Todo approval APIs. Park entry and terminalization stamp stable report episodes. |
| Cancellation | Planned `POST /api/workflow-definitions/:id/runs/:runId/cancel`; MCP `cancel_workflow_run`; CLI `jinn workflow cancel`; run UI | Run authority stops real phase Sessions, persists `cancelled`, patches activity, and claims the one terminal episode when report mode is `resume`. |
| Retry and timeout | `advanceWorkflowRunById`, `sweepWorkflowRuns`, `driveRunLocked`, existing step retry/onError/timeout receipts | Intermediate retries/timeouts patch activity only. Retry exhaustion, terminal timeout, and non-retriable spawn/dispatch failure append the single terminal episode. |
| Callback acceptance/retry/recovery | `sessions/callbacks.ts`; `POST /api/sessions/:id/message` with `callbackDeliveryId`; `callback_deliveries`; current dead-letter/requeue routes; startup callback recovery | One generalized delivery identity and worker serves delegation plus Workflow episodes. Acceptance stays atomic; response loss is idempotent; one lease/retry cap, recovery pass, dead-letter list, and requeue action remain. |
| Chat/list live update | Existing `session:created`, `session:delta`; new `company:changed`; `use-query-invalidation.ts` | Persisted block is patched surgically in chat; list/detail/run/trigger caches patch or invalidate the smallest keys and refresh without reload. |
| Compatibility migrations | `normalizeRun`; registry open; trigger-store boot migration; shipped `0.27.0/MIGRATION.md`; legacy Session provenance | v2 input-shaped run `invocation` maps non-destructively to v3 `parameters`; callback identity generalizes in the same table; trigger schema migrates once; historical fake Sessions remain untouched/read-only and redirect directly. |

### Operation receipts

| Operation | Session-authored receipt | Browser/manual behavior |
|---|---|---|
| Create/update/retire Workflow definition | Persist or patch `workflow-definition:release-review`-shaped ids in the invoking transcript | Existing editor/list response; no fabricated chat owner |
| Create/delete/approve Workflow trigger | Patch the owning Workflow definition block in the invoking transcript | Existing editor refresh plus native approval UI |
| Start/replay/edit/approve/escalate/cancel Workflow run | Persist or patch `workflow-run:release-review:run-20260712010101-abcd1234`-shaped ids in the invoking Session transcript and in a distinct acting Session's transcript | Run canvas updates in place |
| Create/edit/assign/transition/request approval/decide/escalate/archive Todo | Persist or patch `todo:wi_release_review`-shaped ids in the invoking transcript | Todo ledger/detail refreshes normally |

Read-only list/get/plan/validate calls create no chat receipt. A failed validation or authorization creates no success block; MCP returns the existing structured error and its generic tool feedback remains visible. A successful Todo/Workflow mutation returns an `activityReceiptId`; the matching generic tool row is suppressed only after that persisted block is present.

### Exactly-once report matrix

| Run condition | Durable activity block | Shared session delivery in `resume` mode | Engine resumption |
|---|---|---|---|
| Successful terminal with output | Patch to `completed` | One shared-delivery claim for the immutable terminal episode | Exactly once |
| Successful terminal with blank phase/final output | Patch to `completed` | One deterministic nonblank completion message built from run receipts | Exactly once |
| Non-retriable spawn/dispatch failure | Patch to `error` | One terminal failure signal | Exactly once |
| Retriable spawn/dispatch failure | Patch attempt/error detail | No terminal signal while retry remains | None until terminal |
| Retry exhaustion | Patch to `error` | One terminal failure signal naming exhaustion | Exactly once |
| Step timeout with retry remaining | Patch retry state | No terminal signal | None |
| Timeout after retry policy exhausts | Patch to `error` | One terminal failure signal naming timeout | Exactly once |
| Cancellation | Patch to terminal `cancelled` with cancellation metadata | One terminal cancellation signal | Exactly once |
| First entry into a parked approval episode | Patch to `waiting` | One shared-delivery claim for that persisted parked episode sequence | Exactly once for the episode |
| Unrelated metadata changes while still parked | Patch the same block id at the newer run revision | Reuse the existing parked episode token/sequence; no new claim | None |
| Leave park, then enter a later park | Patch through running and back to waiting | Stamp the next parked episode sequence and claim it once | Exactly once for the new episode |
| Gate approval resumes the run | Patch back to `running` | No extra callback merely for unpark | None |
| Crash after run save but before report claim | Reloaded block reconstructed from run | Startup recovery claims the missing signal | Exactly once |
| Crash after claim but before HTTP acceptance | Existing/reconstructed block | Pending row is retried | Exactly once |
| HTTP response loss after acceptance | Existing block | Accepted row is immutable; retry is a no-op | No duplicate |
| Report delivery exhausts retries | Block remains visible; delivery diagnostics stay on the shared delivery row | Row becomes discoverable on the existing dead-letter operator surface | No hidden retry loop |
| Invoking Session was deleted | Run remains authoritative | Shared delivery exhausts to its existing dead-letter surface; it is not cascaded away | None |
| `reportMode:"silent"` | Every put/patch still persists and emits | No delivery row, notification, queue item, or engine wake | None |

---

## Existing Todo Execution Ledger

| Existing Todo | Scope in this plan | Satisfying tasks and commits |
|---|---|---|
| `wi_ad5650f0cd81` | Accepted plan persisted before implementation | Task 0 · `docs: plan chat-first workflow simplification` |
| `wi_35edbe6160c1` | Invocation relation, report episodes, shared exactly-once delivery, and cancellation reporting | Tasks 2, 5, and 6 · `feat(workflows): persist invoking session relation`, `feat(workflows): reuse session delivery for run reports`, and `feat(workflows): add native run cancellation` |
| `wi_069b54e2ea6c` | Stop synthetic Session creation; preserve and redirect legacy rows | Task 4 · `refactor(workflows): remove synthetic run sessions` |
| `wi_2f27e043fb11` | Full Workflow–Todo decoupling and native approvals | Task 3 · `refactor(workflows): decouple runs and todos` |
| `wi_6921c5ff3693` | Activity contracts, receipts, tool-row suppression, live updates, UI | Tasks 1, 7, and 8 · their three `feat(chat|web)` commits |
| `wi_acc19d92d2f8` | Compatibility, migration guidance, doctrine, and full verification | Tasks 9 and 10 · `docs: separate workflow runs from todos` plus the uncommitted final verification gate |

Todo status is never advanced by Workflow execution. The COO/reviewer updates each ledger item only after its mapped scoped commit passes review; producers stop after each commit and do not close their own Todo.

---

### Task 0: Persist the COO-accepted plan before production work

**Files:**
- Add: `docs/superpowers/plans/2026-07-12-jinn-chat-workflow-todo-kiss.md`

- [ ] **Step 1: Confirm acceptance and stage only the plan**

  ```bash
  git status --short -- docs/superpowers/plans/2026-07-12-jinn-chat-workflow-todo-kiss.md
  git add docs/superpowers/plans/2026-07-12-jinn-chat-workflow-todo-kiss.md
  git diff --cached --name-only
  git diff --cached --check
  ```

  Expected: the status changes from `??` to `A`, the staged-name list contains exactly the plan path, and the whitespace check prints nothing.

- [ ] **Step 2: Commit the accepted plan and stop for COO verification**

  ```bash
  git commit -m "docs: plan chat-first workflow simplification"
  ```

  Do not edit production code in the same turn. Report commit evidence against `wi_ad5650f0cd81`, then wait for COO follow-up.

---

### Task 1: Extend the persisted chat-block contract for company activity

**Files:**
- Modify: `packages/jinn/src/shared/types.ts`
- Modify: `packages/jinn/src/shared/blocks.ts`
- Modify: `packages/jinn/src/sessions/registry.ts`
- Modify: `packages/web/src/lib/blocks.ts`
- Create: `packages/jinn/src/shared/__tests__/fixtures/company-activity-blocks.json`
- Create: `packages/jinn/src/shared/__tests__/company-activity-blocks.test.ts`
- Create: `packages/web/src/lib/__tests__/company-activity-blocks.test.ts`
- Modify: `packages/jinn/src/sessions/__tests__/messages-partial.test.ts`

**Interfaces:**
- Extend `ChatBlockType` with `"todo-activity"`, `"workflow-definition"`, and `"workflow-run"` in backend and web types.
- Add typed payloads `TodoActivityPayload`, `WorkflowDefinitionActivityPayload`, and `WorkflowRunActivityPayload` to `packages/jinn/src/shared/types.ts`; mirror their wire shapes in `packages/web/src/lib/blocks.ts`.
- Add optional `activityReceipt?: { id: string; operationId: string; toolName: string }` to the three activity payloads. `id` must equal the containing block id; `operationId` and `toolName` are server-authored only and bounded by the existing structured-message limits.
- Keep `ChatBlockEnvelope` and `applyBlockEnvelope(sessionId, input, fallbackText?, options?)` signatures unchanged.
- Make `mergeBlock(existing, patch)` ignore a patch whose `version` is lower than the existing block version; equal versions remain idempotently mergeable for current version-1 delegation patches.

- [ ] **Step 1: Add the canonical fixture and failing backend contract test**

  Store three complete `put` envelopes in `company-activity-blocks.json`. Use generic ids and this exact run payload shape:

  ```json
  {
    "op": "put",
    "block": {
      "id": "workflow-run:release-review:run-20260712010101-abcd1234",
      "type": "workflow-run",
      "version": 3,
      "status": "waiting",
      "title": "Release review",
      "summary": "Waiting for approval",
      "payload": {
        "workflowId": "release-review",
        "runId": "run-20260712010101-abcd1234",
        "action": "started",
        "runStatus": "parked",
        "startedAt": "2026-07-12T01:01:01.000Z",
        "endedAt": null,
        "completedSteps": 1,
        "totalSteps": 3,
        "parkedDescription": "Approve the release candidate",
        "openPath": "/workflow/release-review?mode=runs&run=run-20260712010101-abcd1234"
      }
    }
  }
  ```

  The backend test must parse every fixture through `validateBlockEnvelope`, assert stable fallback text, and prove version 2 cannot overwrite version 3.

- [ ] **Step 2: Run backend RED**

  Run:

  ```bash
  pnpm --filter jinn-cli test -- src/shared/__tests__/company-activity-blocks.test.ts src/sessions/__tests__/messages-partial.test.ts
  ```

  Expected RED contains `block type is invalid` for `workflow-run` and a stale-version assertion showing version 2 replaced version 3.

- [ ] **Step 3: Implement validation, payload guards, fallbacks, and monotonic merge**

  Require full identity/title/status fields on `put`, permit partial payloads on `patch`, reject unsafe JSON through the existing guard, and cap every preview/error string. Use these exact fallback forms:

  ```text
  Todo “Prepare release” · in review
  Workflow “Release review” · updated to v4
  Workflow “Release review” · waiting for approval
  ```

  Keep fallback generation deterministic from block data only; do not read live Todo or Workflow stores.

- [ ] **Step 4: Add the failing web parity test, then implement web parsing**

  Load the same JSON fixture in `packages/web/src/lib/__tests__/company-activity-blocks.test.ts`, assert `isBlockEnvelope` accepts every envelope, and assert `blockFallbackContent` exactly equals the fixture's backend expected fallback strings.

  Run:

  ```bash
  pnpm --filter @jinn/web test -- src/lib/__tests__/company-activity-blocks.test.ts
  ```

  Expected RED says the new block type is unsupported. After implementing the mirrored wire guards and fallback branches, expected GREEN is the Vitest summary with all listed tests passing.

- [ ] **Step 5: Review, verify, and commit Task 1**

  Re-run both focused commands, inspect backend/web type and fallback parity, then commit only Task 1 files. Report the commit against `wi_6921c5ff3693` and stop for COO review:

  ```bash
  git commit -m "feat(chat): add company activity block contracts"
  ```

---

### Task 2: Persist the invoking-Session relation and the single report mode

**Files:**
- Modify: `packages/jinn/src/workflows/run-store.ts`
- Modify: `packages/jinn/src/workflows/advance.ts`
- Modify: `packages/jinn/src/workflows/run-reconciler.ts`
- Modify: `packages/jinn/src/workflows/run-idempotency.ts`
- Modify: `packages/jinn/src/gateway/api.ts`
- Modify: `packages/jinn/src/mcp/workflow-tools.ts`
- Modify: `packages/web/src/lib/api.ts`
- Modify: `packages/jinn/src/workflows/__tests__/run-store.test.ts`
- Modify: `packages/jinn/src/workflows/__tests__/run-reconciler.test.ts`
- Modify: `packages/jinn/src/workflows/__tests__/run-idempotency.test.ts`
- Modify: `packages/jinn/src/gateway/__tests__/workflow-definitions-route.test.ts`
- Modify: `packages/jinn/src/mcp/__tests__/workflow-tools.test.ts`
- Modify: `packages/jinn/src/mcp/__tests__/tool-manifest-budget.test.ts`
- Modify: `packages/jinn/src/mcp/__tests__/server.test.ts`

**Interfaces:**
- Bump `WORKFLOW_RUN_SCHEMA_VERSION` from 2 to 3.
- Add `export type WorkflowReportMode = "resume" | "silent"`.
- Rename the current v2 `WorkflowRunInvocation { input; idempotencyKey? }` contract to `WorkflowRunParameters`, rename its persisted field and `StartRunOptions` input from `invocation` to `parameters`, and update current phase-context reads from `run.invocation.input` to `run.parameters.input`.
- Add the unambiguous v3 relation `WorkflowRunInvocation { sessionId: string; reportMode: WorkflowReportMode }` and `WorkflowRun.invocation?: WorkflowRunInvocation`.
- Add `WorkflowRun.revision: number`; new runs start at 1, and every persisted mutation increments exactly once.
- Add `WorkflowRunRequestBody.reportMode?: unknown`; `validateWorkflowRunRequestBody` returns a validated `reportMode`, defaulting to `"resume"`.
- Add `StartRunOptions.invocation?: WorkflowRunInvocation`; preserve `input` and `idempotencyKey` through `StartRunOptions.parameters`. Include both parameters and invocation in the idempotency request fingerprint.
- `invocation` means both belonging and reporting to the same invoking Session. Do not add a separate owner, destination, callback target, employee-rank case, or client-supplied Session id. Resolve it only from `resolveScopedWriteCallerIdentity` after capability verification.

- [ ] **Step 1: Write failing v3 normalization and invocation tests**

  Add this assertion pattern to `run-store.test.ts`:

  ```ts
  const legacy = getRun(root, "legacy-workflow", "legacy-run")!;
  expect(legacy.schemaVersion).toBe(2);
  expect(legacy.parameters).toEqual({ input: { ticket: "ABC-42" }, idempotencyKey: "request-42" });
  expect(legacy.invocation).toBeUndefined();
  expect(legacy.revision).toBe(0);

  const current = makeRun({
    schemaVersion: 3,
    revision: 1,
    parameters: { input: { ticket: "ABC-42" }, idempotencyKey: "request-42" },
    invocation: { sessionId: "session-a", reportMode: "resume" },
  });
  saveRun(root, current);
  expect(getRun(root, current.workflowId, current.runId)?.invocation).toEqual({
    sessionId: "session-a",
    reportMode: "resume",
  });
  expect(getRun(root, current.workflowId, current.runId)?.parameters).toEqual({
    input: { ticket: "ABC-42" },
    idempotencyKey: "request-42",
  });
  ```

  Seed the raw v2 file with its current `invocation: { input, idempotencyKey }` wire shape. `normalizeRun` maps that object to in-memory `parameters`, leaves the new invocation relation absent, and never rewrites the file on read. Legacy v1/v2 evidence has no invoking Session; never infer one from phase Sessions or historical synthetic parents, because that would send surprise callbacks for historical runs.

- [ ] **Step 2: Run Task 2 RED**

  ```bash
  pnpm --filter jinn-cli test -- src/workflows/__tests__/run-store.test.ts src/workflows/__tests__/run-reconciler.test.ts src/workflows/__tests__/run-idempotency.test.ts src/gateway/__tests__/workflow-definitions-route.test.ts src/mcp/__tests__/workflow-tools.test.ts
  ```

  Expected RED includes missing `WorkflowRunParameters`/`reportMode` properties and the route body not forwarding `reportMode`.

- [ ] **Step 3: Implement v3 run records and monotonic revision**

  Make the initial v3 record carry `revision: 1`. Change current `persistRun(deps, run): string | undefined` to `persistRun(deps, candidate): WorkflowRun`: while already inside `withRunAdvanceLock`, re-read the prior record, assign `revision = max(previous.revision, candidate.revision) + 1`, save, run the existing best-effort Session projection for Task 2 compatibility, and return the stamped record. Update every caller to continue from that returned record; no caller may mutate and then ignore the stamped revision. Initial publication still writes revision 1 exactly once rather than immediately bumping to 2.

  `normalizeRun` must expose legacy v1/v2 as `revision: 0` and map their old input-shaped `invocation` into `parameters` in memory without rewriting their evidence file. The first actual mutation of a legacy active run writes schema 3/revision 1 with `parameters`, no inferred invocation relation, and all receipts preserved. New v3 parsing rejects an input-shaped `invocation`; only `{ sessionId, reportMode }` is valid there.

- [ ] **Step 4: Bind the invocation at both Session-capable HTTP entry paths**

  In `runWorkflowDefinitionFromHttp`, resolve the caller once after authorization:

  ```ts
  const identity = resolveScopedWriteCallerIdentity(req.headers, context);
  const invocation = identity.kind === "session"
    ? { sessionId: identity.callerId, reportMode: validated.reportMode }
    : undefined;
  ```

  Build `parameters` independently from `validated.input`/`validated.idempotencyKey`, replacing the current local variable named `invocation`, and pass both `parameters` and `invocation` into `startWorkflowRunFromTrigger`. Pass the same relation logic through `/api/workflow-runs/by-name` because it funnels into `runWorkflowDefinitionFromHttp`. Event, schedule, poll, Todo-status, CLI bearer, and browser operator paths pass no invocation relation.

  Extend the current `WorkflowRunInvocationRequest` idempotency claim payload with `invocation?: WorkflowRunInvocation`; keep its existing `input` field sourced from `parameters.input`. Reusing one employee-level idempotency key from a different Session or with a different report mode returns the existing typed 409 conflict; an exact retry returns the original run, parameters, and invocation relation.

- [ ] **Step 5: Advertise and forward only `reportMode` in MCP**

  Add this schema to both run tools:

  ```ts
  reportMode: {
    type: "string",
    enum: ["resume", "silent"],
    description: "resume reports parked/terminal run state back to this session; silent keeps durable activity without resuming it.",
  }
  ```

  Forward the field verbatim. Update returned hints so default invocations say `This run belongs and reports back to this session.` and silent invocations say `Silent mode: this run belongs to this session and updates its durable activity, but will not resume it.` Do not expose the Session id.

- [ ] **Step 6: Verify GREEN and commit Task 2**

  Confirm the focused suite passes, including ordinary employee and root/COO Sessions receiving identical persisted invocation shapes. Commit, report evidence against `wi_35edbe6160c1`, and stop for COO review:

  ```bash
  git commit -m "feat(workflows): persist invoking session relation"
  ```

---

### Task 3: Remove every Workflow–Todo write bridge and replace approval records natively

**Files:**
- Delete: `packages/jinn/src/work-items/workflow-bridge.ts`
- Delete: `packages/jinn/src/workflows/__tests__/run-reconciler-todos.test.ts`
- Delete: `packages/jinn/src/workflows/__tests__/run-reconciler-todo-transition.test.ts`
- Modify: `packages/jinn/src/workflows/run-reconciler.ts`
- Modify: `packages/jinn/src/workflows/run-store.ts`
- Modify: `packages/jinn/src/workflows/definition.ts`
- Modify: `packages/jinn/src/workflows/schema.ts`
- Modify: `packages/jinn/src/workflows/sop.ts`
- Modify: `packages/jinn/src/workflows/todo-status-trigger.ts`
- Modify: `packages/jinn/src/workflows/custom-triggers.ts`
- Modify: `packages/jinn/src/workflows/poll-trigger.ts`
- Modify: `packages/jinn/src/work-items/approvals.ts`
- Modify: `packages/jinn/src/work-items/reconcile.ts`
- Modify: `packages/jinn/src/work-items/store.ts`
- Modify: `packages/jinn/src/gateway/approval-authority.ts`
- Modify: `packages/jinn/src/gateway/api.ts`
- Modify: `packages/jinn/src/mcp/workflow-tools.ts`
- Modify: `packages/web/src/lib/api.ts`
- Modify: `packages/web/src/routes/workflow/edit.tsx`
- Create: `packages/jinn/src/workflows/approval-authority.ts`
- Create: `packages/jinn/src/workflows/__tests__/todo-decoupling.test.ts`
- Create: `packages/jinn/src/workflows/__tests__/native-approvals.test.ts`
- Modify: `packages/jinn/src/workflows/__tests__/definition.test.ts`
- Modify: `packages/jinn/src/workflows/__tests__/schema.test.ts`
- Modify: `packages/jinn/src/workflows/__tests__/todo-status-trigger.test.ts`
- Modify: `packages/jinn/src/workflows/__tests__/todo-replay-watermark.test.ts`
- Modify: `packages/jinn/src/workflows/__tests__/poll-trigger.test.ts`
- Modify: `packages/jinn/src/gateway/__tests__/work-item-approval-route.test.ts`
- Modify: `packages/jinn/src/gateway/__tests__/workflow-events-route.test.ts`
- Modify: `packages/jinn/src/mcp/__tests__/workflow-tools.test.ts`
- Modify: `packages/web/src/routes/workflow/__tests__/edit.test.tsx`

**Interfaces:**
- Remove `RunDriverDeps.workItems`, `RunDriverDeps.syncRunSession` remains until Task 4, `StartRunOptions.triggerTodoId`, `WorkflowTodoBridge`, and all `todoTransition` authoring/runtime fields.
- Keep the trigger event payload's `todoId` as inert provenance. Remove the top-level `WorkflowRun.triggerTodoId` from new writes; retain read normalization for historical records.
- Add `WorkflowGateApprovalRecord` directly to `WorkflowRun.parked` and `PollActivationApprovalRecord` directly to poll trigger bindings.
- Bump `TRIGGER_STORE_SCHEMA_VERSION` from 1 to 2 and add an explicit, idempotent `migrateWorkflowTriggerStore(root)` boot migration.

- [ ] **Step 1: Write native gate approval RED before changing gate production code**

  In `native-approvals.test.ts`, park a run without relying on a Todo and assert:

  ```ts
  expect(run.parked?.approval).toMatchObject({
    state: "pending",
    requestedBy: "workflow-run",
    targetKind: "employee",
  });
  expect(getWorkItemBySourceRef("workflow", `workflow:${run.workflowId}:${run.runId}`)).toBeUndefined();
  ```

  Route tests must prove the routed manager/root can approve, the requesting employee cannot self-approve unless they are the org root, an authenticated operator can decide a virtual-root or explicitly escalated approval, rejection fails the run, and a duplicate decision returns 409 without a second receipt.

- [ ] **Step 2: Run native gate RED**

  ```bash
  pnpm --filter jinn-cli test -- src/workflows/__tests__/native-approvals.test.ts src/gateway/__tests__/work-item-approval-route.test.ts
  ```

  Expected RED shows `run.parked.approval` is absent and `/resolve-gate` refuses to proceed without a mirrored Todo.

- [ ] **Step 3: Implement and verify native Workflow gate approval**

  `packages/jinn/src/workflows/approval-authority.ts` owns a domain-neutral route shape:

  ```ts
  export interface WorkflowApprovalRoute {
    requesterEmployee: string | null;
    target: string | null;
    targetKind: "employee" | "virtual" | "none";
    requestedAt: string;
    requestedBy: string;
    escalatedAt: string | null;
  }
  ```

  Determine the requester from the run invocation Session's employee; fall back to definition `owner`/`createdBy`; route to that employee's manager, then the hierarchy root, then the collision-safe virtual root already used by approval authority. Stamp the route when the run parks so later org edits do not silently change an outstanding decision.

  Replace Todo lookup in `projectWorkflowRunApprovalCapability` and `/resolve-gate` with this stored route plus verified caller identity. Persist `gateDecisions[]` with gate key, decision, actor, and ISO timestamp. Add `POST /api/workflow-definitions/:id/runs/:runId/gate-approval/escalate`; expose `escalate_workflow_gate` to an already-routed manager/root, but continue to keep gate approve/reject off the MCP toolbelt. Update parked hints to say the human Workflow approval surface will resume the run.

  Re-run the Step 2 command and require GREEN before changing poll approval code.

- [ ] **Step 4: Write native poll-activation approval RED**

  Add failing `poll-trigger.test.ts` and `workflow-events-route.test.ts` cases proving a poll trigger can be approved and execute without a Todo, while contract edits revoke approval. Expected RED shows `approvalSatisfied` still reads `approvalWorkItemId`.

- [ ] **Step 5: Implement and verify native poll-activation approval**

  Replace `approvalWorkItemId` with:

  ```ts
  export interface PollActivationApprovalRecord extends WorkflowApprovalRoute {
    state: "pending" | "approved" | "rejected";
    activationContractHash: string;
    decidedBy: string | null;
    decidedAt: string | null;
  }
  ```

  Add `POST /api/workflow-triggers/:name/activation-approval` and `/activation-approval/escalate`. `approvalSatisfied` must require an approved native record whose hash equals the current pinned activation contract and whose staged artifacts still verify. Any semantic binding edit clears the decision and creates a new pending native record.

  The v1→v2 store migration runs once under `withWorkflowMutationLock` and gives any legacy binding without `bindingRevision` the same deterministic revision that current binding normalization would derive from its authored fields. Any binding with legacy `approvalWorkItemId` becomes a native pending approval for its current activation contract, then schema 2 is written without that id. The migration never imports or reads a Todo store, never copies a Todo decision, and never mutates or links the historical Todo; fail-closed re-approval is the deliberate compatibility behavior.

  Run and require GREEN before removing the Workflow–Todo bridge:

  ```bash
  pnpm --filter jinn-cli test -- src/workflows/__tests__/poll-trigger.test.ts src/workflows/__tests__/event-trigger.test.ts src/gateway/__tests__/workflow-events-route.test.ts
  ```

- [ ] **Step 6: Write a failing negative-capability test**

  In `todo-decoupling.test.ts`, inject spies around every Todo write export and start manual, schedule, event, poll, and Todo-status runs. Assert zero calls through initial publish, spawn, retry, park, approval, completion, failure, timeout, and cancellation:

  ```ts
  expect(todoWrites).toEqual({
    createWorkItem: 0,
    linkSession: 0,
    transition: 0,
    transitionDerived: 0,
    requestApproval: 0,
    decideApproval: 0,
  });
  expect(sourceTodo.status).toBe("in_review");
  expect(run.trigger).toMatchObject({
    source: "todo-status-change",
    payload: { todoId: sourceTodo.id },
  });
  ```

- [ ] **Step 7: Run decoupling RED**

  ```bash
  pnpm --filter jinn-cli test -- src/workflows/__tests__/todo-decoupling.test.ts
  ```

  Expected RED records calls from `createWorkflowTodoBridge`, `applyTodoTransitions`, parked-gate mirroring, and terminal reflection.

- [ ] **Step 8: Remove run-level Todo coupling and verify GREEN**

  Delete the bridge module and its two bridge-specific suites. Remove `workItems` from `RunDriverDeps`; remove mint/link/mirror/clear/terminal calls; remove `applyTodoTransitions`; remove `triggerTodoId` from `StartRunOptions`. Keep `normalizeWorkflowTrigger(run.trigger, run.triggerTodoId)` solely as a legacy read adapter until the deletion criterion below is met.

  Remove the special `source === "workflow"` lifecycle branch from `work-items/reconcile.ts`. Keep `"workflow"` in `WorkItemSource` and the SQLite CHECK only as read compatibility for already-minted historical Todos; public creation still cannot choose provenance, and no current Workflow code may import Todo writes.

  Re-run `todo-decoupling.test.ts` and require GREEN before changing definition authoring.

- [ ] **Step 9: Write Todo-transition RED, remove authoring/runtime support, and verify GREEN**

  Reject `todoTransition` in create/update/SOP transport schemas as an unknown field. On definition-store reads, strip a legacy `todoTransition` before validation, log one bounded warning per definition id/version, and expose no executable transition. Frozen snapshots from old runs may retain the JSON field as evidence, but the v3 driver never reads it.

  Convert existing acceptance tests from “accepts todoTransition” to:

  ```ts
  expect(() => parseWorkflowCreateInput(withTodoTransition)).toThrow(/todoTransition.*not supported/i);
  expect(loadDefinitionWithLegacyTransition(root).nodes[1]).not.toHaveProperty("todoTransition");
  ```

  Run `definition.test.ts`, `schema.test.ts`, and `definition-store.test.ts` first for RED, implement the removal/read adapter, then rerun them for GREEN before changing Todo-status dispatch.

- [ ] **Step 10: Write one-way-trigger RED, remove active-run suppression, and verify GREEN**

  Delete `hasNonTerminalRunForTodo` and its use of `workflowRunTriggerTodoId`. Event claim/replay idempotency remains keyed by the immutable `work_item_events.id`/`fireRef`, not by Todo ownership. Two distinct status-change event ids may start two independent runs even if an earlier run is active; replaying the same event id returns the same run.

  Add two distinct-event cases to `todo-status-trigger.test.ts`, run it for RED, remove the suppression, and rerun it with `todo-replay-watermark.test.ts` for GREEN.

- [ ] **Step 11: Write Todo approval projection RED, then simplify Todo approvals**

  Remove `WORKFLOW_GATE_REF_PREFIX`, `WorkflowGateCancellationConflictError`, `recordMirroredApprovalDecision`, `ResolveWorkflowGateOutcome`, injected Workflow deps from `decideWorkItemApproval`, `mirrored`, and `runStatus` from approval responses. `archiveWorkItem` handles every pending Todo approval with the native Todo rules only.

  Remove `workflowRun` from `fullWorkItemPayload`, `WorkItemFullWire`, Todo row/detail/Needs-you renderers, and related tests. Historical `source:"workflow"` and `sourceRef` remain audit strings, not live navigation or lifecycle coupling.

  Run the affected gateway and web Todo suites for RED before removal and GREEN afterward.

- [ ] **Step 12: Run Task 3 aggregate GREEN, import audit, and commit**

  ```bash
  pnpm --filter jinn-cli test -- src/workflows/__tests__/todo-decoupling.test.ts src/workflows/__tests__/native-approvals.test.ts src/workflows/__tests__/definition.test.ts src/workflows/__tests__/definition-store.test.ts src/workflows/__tests__/schema.test.ts src/workflows/__tests__/todo-status-trigger.test.ts src/workflows/__tests__/todo-replay-watermark.test.ts src/workflows/__tests__/poll-trigger.test.ts src/workflows/__tests__/event-trigger.test.ts src/gateway/__tests__/work-item-approval-route.test.ts src/gateway/__tests__/workflow-events-route.test.ts src/mcp/__tests__/workflow-tools.test.ts
  rg -n "createWorkflowTodoBridge|WorkflowTodoBridge|todoTransition|approvalWorkItemId|workflow-gate:|applyTodoTransitions" packages/jinn/src packages/web/src
  rg --pcre2 -n "^import(?! type\\b).*work-items/(store|transitions|approvals)" packages/jinn/src/workflows
  ```

  Expected GREEN: all named tests pass. The first `rg` may hit only explicitly labeled legacy migration fixtures/read adapters; the second must print no Workflow runtime value import. Type-only `WorkItemStatus`/`WorkItemSource` vocabulary for the deliberately authored Todo-status event is permitted and cannot mutate a Todo. Commit, report evidence against `wi_2f27e043fb11`, and stop for COO review:

  ```bash
  git commit -m "refactor(workflows): decouple runs and todos"
  ```

---

### Task 4: Stop synthetic Workflow Sessions and preserve historical projections read-only

**Files:**
- Modify: `packages/jinn/src/shared/types.ts`
- Modify: `packages/jinn/src/sessions/registry.ts`
- Modify: `packages/jinn/src/sessions/callbacks.ts`
- Modify: `packages/jinn/src/gateway/api.ts`
- Modify: `packages/jinn/src/gateway/server.ts`
- Modify: `packages/jinn/src/gateway/status-reconciler.ts`
- Modify: `packages/jinn/src/gateway/manager-visibility.ts`
- Modify: `packages/web/src/lib/api.ts`
- Modify: `packages/web/src/routes/chat/page.tsx`
- Modify: `packages/web/src/components/chat/chat-route-helpers.ts`
- Modify: `packages/jinn/src/sessions/__tests__/workflow-provenance.test.ts`
- Modify: `packages/jinn/src/sessions/__tests__/callbacks.test.ts`
- Modify: `packages/jinn/src/gateway/__tests__/workflow-session-grouping.test.ts`
- Modify: `packages/jinn/src/gateway/__tests__/callback-reliability.test.ts`
- Modify: `packages/jinn/src/gateway/__tests__/status-reconciler.test.ts`
- Modify: `packages/jinn/src/gateway/__tests__/manager-visibility.test.ts`
- Modify: `packages/web/src/components/chat/__tests__/chat-route-helpers.test.ts`
- Create: `packages/jinn/src/sessions/__tests__/legacy-workflow-session-compat.test.ts`
- Create: `packages/web/src/routes/chat/__tests__/legacy-workflow-session-redirect.test.tsx`

**Interfaces:**
- Keep `WorkflowSessionProvenance.kind: "run" | "phase"` as a read-compatible historical union. Add `isLegacyWorkflowRunSession(session): boolean`, true only for `workflowProvenance.kind === "run"`.
- Real phase attempts remain Sessions with `workflowProvenance.kind:"phase"` and group through `workflowRunId`; new phase Sessions use no synthetic conversational parent.
- `legacyWorkflowRunLocation(session)` returns `{ workflowId, runId, openPath }` directly from existing provenance. It creates no table, alias, snapshot, or copied row.

- [ ] **Step 1: Write non-destructive compatibility RED using the exact old shape**

  Seed an `engine:"workflow"`, `workflow_kind:"run"` Session with messages, pending and accepted callback rows, queue rows, and a historical phase child. Reopen the DB and assert all primary keys and foreign references are byte-for-byte present:

  ```ts
  expect(getSession(legacyParent.id)?.workflowProvenance?.kind).toBe("run");
  expect(getMessages(legacyParent.id).map((message) => message.id)).toEqual(["legacy-message"]);
  expect(getQueueItems(legacyParent.sessionKey).map((item) => item.id)).toEqual(["legacy-queue"]);
  expect(getCallbackDelivery("legacy-delivery")).toBeDefined();
  expect(getSession(phase.id)?.parentSessionId).toBe(legacyParent.id);
  expect(legacyWorkflowRunLocation(getSession(legacyParent.id)!)).toEqual({
    workflowId: "release-review",
    runId: "run-old",
    openPath: "/workflow/release-review?mode=runs&run=run-old",
  });
  ```

  Add a DB checksum assertion over those rows before and after registry initialization. Expected RED is a missing classifier/location helper—not missing historical evidence.

- [ ] **Step 2: Run compatibility RED**

  ```bash
  pnpm --filter jinn-cli test -- src/sessions/__tests__/legacy-workflow-session-compat.test.ts src/sessions/__tests__/workflow-provenance.test.ts src/gateway/__tests__/workflow-session-grouping.test.ts
  ```

  Expected RED reports missing `isLegacyWorkflowRunSession` and `legacyWorkflowRunLocation`; the seeded row counts must already stay unchanged.

- [ ] **Step 3: Delete only current synthetic-parent production paths**

  Remove `workflowRunParentSessionKey`, `ensureWorkflowRunParentSession`, `workflowParentSessionState`, `syncWorkflowRunSession`, `RunDriverDeps.syncRunSession`, and every current `createSession({ engine:"workflow" })` call. `spawnWorkflowStepSession` persists phase provenance and leaves `parentSessionId` unset for new attempts. Do not update existing `parent_session_id`, `workflow_kind`, Session status, messages, queues, or delivery rows.

  Preserve the callback suppression for a historical parent whose provenance kind is `run`; rename its comment/test to state that legacy projections are never callback destinations. Current phase completion remains Workflow reconciler evidence and does not wake a fake parent.

- [ ] **Step 4: Exclude legacy projections from live treatment without rewriting them**

  Use `isLegacyWorkflowRunSession` at every live-status boundary:

  - `recoverStaleSessions` excludes `workflow_kind='run'` in its update/select logic;
  - `sweepOnce` in `gateway/status-reconciler.ts` skips them;
  - gateway graceful shutdown skips them instead of stamping `interrupted`;
  - `isSessionLiveRunning` returns false and `/api/status.running` does not count them;
  - `getSessionTransportState` serializes them as idle historical evidence without changing the stored status;
  - `resumePendingWebQueueItems` skips their pending/accepted historical queue and callback rows before engine lookup or any Session/queue update, including config-reload replay;
  - callback startup recovery and `_deliverClaimedCallback` skip a delivery whose parent is a legacy run projection before leasing or incrementing attempts, and the existing requeue endpoint returns 409 `historical workflow delivery is read-only` for its dead letters;
  - manager visibility never treats them as active work;
  - `isFocusedSession` returns false when `workflowProvenance.kind === "run"`.

  Add focused tests proving an old row stored as `running` remains stored as `running` after boot/status/shutdown/queue-replay/callback-recovery simulations, its pending queue and delivery rows remain byte-identical, dead-letter requeue is rejected without a field change, it contributes zero live engines, creates no manager visibility, and is absent from Focused while remaining visible in All/search history.

- [ ] **Step 5: Redirect direct legacy access from existing provenance and reject mutation**

  Centralize a loaded-Session guard and apply it before ordinary serialization or mutation. The read routes `GET /api/sessions/:id`, `/messages`, `/queue`, `/children`, `/context`, and `/transcript` return 410 without modifying the row:

  ```json
  {
    "error": "Workflow runs are no longer sessions.",
    "legacyWorkflowRun": {
      "workflowId": "release-review",
      "runId": "run-old",
      "openPath": "/workflow/release-review?mode=runs&run=run-old"
    }
  }
  ```

  `PUT|PATCH|DELETE /api/sessions/:id`, `/stop`, `/reset`, `/duplicate`, every queue mutation, `/message`, and `/attachments` return 409 with the same `legacyWorkflowRun` location plus `error:"Historical Workflow session is read-only."`. They must not touch Session, message, queue, callback, file, or engine state; callback acceptance against such a target is rejected before `acceptCallbackDelivery`.

  Add `LegacyWorkflowSessionError` in `packages/web/src/lib/api.ts`. The chat route preflight catches the 410 read response and performs `navigate(openPath, { replace:true })`. Unknown ordinary Session ids keep current not-found behavior; All/search may list legacy history, but selecting it redirects rather than opening a chat engine.

- [ ] **Step 6: Verify GREEN, non-deletion checks, and commit Task 4**

  ```bash
  pnpm --filter jinn-cli test -- src/sessions/__tests__/legacy-workflow-session-compat.test.ts src/sessions/__tests__/workflow-provenance.test.ts src/sessions/__tests__/callbacks.test.ts src/gateway/__tests__/workflow-session-grouping.test.ts src/gateway/__tests__/callback-reliability.test.ts src/gateway/__tests__/status-reconciler.test.ts src/gateway/__tests__/manager-visibility.test.ts
  pnpm --filter @jinn/web test -- src/routes/chat/__tests__/legacy-workflow-session-redirect.test.tsx src/components/chat/__tests__/chat-route-helpers.test.ts
  rg -n "createSession\\(\\{[^}]*engine: ['\"]workflow|syncWorkflowRunSession|workflowRunParentSessionKey|legacy_workflow_run_session_aliases" packages/jinn/src packages/web/src
  ```

  Expected GREEN: all tests pass; the grep prints no current synthetic creation/helper or alias-table name. Re-run the checksum fixture and require unchanged Session/message/queue/delivery rows. Commit, report evidence against `wi_069b54e2ea6c`, and stop for COO review:

  ```bash
  git commit -m "refactor(workflows): remove synthetic run sessions"
  ```

---

### Task 5: Project Workflow activity and reuse the single session-delivery mechanism

**Files:**
- Modify: `packages/jinn/src/shared/types.ts`
- Modify: `packages/jinn/src/sessions/registry.ts`
- Modify: `packages/jinn/src/sessions/callbacks.ts`
- Create: `packages/jinn/src/workflows/reporting.ts`
- Create: `packages/jinn/src/workflows/__tests__/reporting.test.ts`
- Modify: `packages/jinn/src/workflows/run-reconciler.ts`
- Modify: `packages/jinn/src/gateway/api.ts`
- Modify: `packages/jinn/src/gateway/server.ts`
- Create: `packages/jinn/src/gateway/__tests__/workflow-report-reliability.test.ts`
- Modify: `packages/jinn/src/gateway/__tests__/server-boot-ordering.test.ts`
- Modify: `packages/jinn/src/sessions/__tests__/callback-deliveries.test.ts`

**Interfaces:**
- Generalize `CallbackDeliveryIdentity` to `SessionDeliveryIdentity { targetSessionId, sourceKind, sourceId, sourceAttempt, sourceOutcome, sourceVersion, deliveryKind }`; generalize the associated payload/delivery/dead-letter type names. `sourceKind` is `"session" | "workflow-run"` in this change: `"session"` covers every existing child-Session callback kind, including delegation completion, rate-limit, attachment, nudge, and manager-visibility deliveries.
- Rename the registry lifecycle functions to `getSessionDelivery`, `getSessionDeliveryByQueueItemId`, `claimSessionDelivery`, `claimSessionDeliveryAttempt`, `recordSessionDeliveryFailure`, `acceptSessionDelivery`, `listPendingSessionDeliveries`, `listDeadLetterSessionDeliveries`, and `requeueDeadLetterSessionDelivery`. Delegation and Workflow reporting call these same functions.
- Keep the physical table `callback_deliveries`, the request field `callbackDeliveryId`, and the operator routes `/api/callback-deliveries/dead-letter` and `/api/callback-deliveries/:id/requeue` for compatibility. Their results add `sourceKind`; do not add another table, id field, route, retry timer, or recovery entry point.
- Add `WorkflowRunReportEpisode { sequence, token, kind, outcome, createdAt, summary }`, `WorkflowRun.reportSequence`, and append-only `WorkflowRun.reportEpisodes`.
- Add `projectWorkflowRunActivity(run, context, actingSessionId?)` and `recoverWorkflowRunReporting(root, context)`.
- `recoverWorkflowRunReporting` only reconstructs blocks and claims missing Workflow episodes into the shared delivery table; `recoverSessionDeliveryStateOnStartup` remains the sole delivery replay/retry recovery call.

- [ ] **Step 1: Write the backward-compatible generic identity migration RED**

  In `callback-deliveries.test.ts`, seed the exact current table columns and delegation row, reopen the registry, and expect the same id/payload/lifecycle under the generic identity:

  ```ts
  expect(getSessionDelivery("delivery-old")).toMatchObject({
    targetSessionId: "parent-a",
    sourceKind: "session",
    sourceId: "child-a",
    sourceAttempt: "attempt-a",
    sourceOutcome: "succeeded",
    sourceVersion: 1,
    deliveryKind: "parent-completion",
    status: "pending",
  });
  expect(database.prepare("SELECT COUNT(*) AS n FROM callback_deliveries").get()).toEqual({ n: 1 });
  ```

  The migrated table keeps `id`, payload, status, attempt/lease/error fields, message/queue ids, and timestamps unchanged. Its unique identity is:

  ```sql
  UNIQUE (target_session_id, source_kind, source_id, source_attempt, source_outcome, source_version, delivery_kind)
  ```

  Backfill the old columns as `parent_session_id→target_session_id`, literal `session→source_kind`, `child_session_id→source_id`, `attempt_token→source_attempt`, `terminal_outcome→source_outcome`, `terminal_version→source_version`, and `callback_kind→delivery_kind`. Poison rows retain the existing quarantine/dead-letter behavior.

- [ ] **Step 2: Run shared-delivery migration RED**

  ```bash
  pnpm --filter jinn-cli test -- src/sessions/__tests__/callback-deliveries.test.ts src/gateway/__tests__/callback-reliability.test.ts
  ```

  Expected RED is a missing `getSessionDelivery` export/generic columns while every pre-existing delegation expectation remains GREEN.

- [ ] **Step 3: Generalize the existing table and lifecycle without forking it**

  Rebuild `callback_deliveries` transactionally only when the current child-specific schema is detected; copy and validate every row before swapping tables. Update indexes in place. Rename application types/functions and update `sessions/callbacks.ts`, gateway acceptance, startup recovery, dead-letter listing/requeue, and delegation tests to the generic names.

  `acceptSessionDelivery` remains the one transaction that inserts the notification, internal queue item, optional block, and accepted receipt. `POST /api/sessions/:id/message` continues accepting only `{ callbackDeliveryId }`; it verifies `targetSessionId`, applies the stored payload, and returns the same id/messageId/queueItemId on accepted retries. Existing delegation fixtures must pass unchanged except for renamed TypeScript fields.

- [ ] **Step 4: Write stable Workflow episode RED**

  In `reporting.test.ts`, drive `running→parked`, two unrelated parked revisions, `parked→running→parked`, then `completed`. Assert sequences/tokens `[1,2,3]`, with exactly one first park, one re-entry park, and one terminal episode:

  ```ts
  expect(run.reportEpisodes.map(({ sequence, kind, token }) => ({ sequence, kind, token }))).toEqual([
    { sequence: 1, kind: "parked", token: `${run.runId}:parked:1` },
    { sequence: 2, kind: "parked", token: `${run.runId}:parked:2` },
    { sequence: 3, kind: "terminal", token: `${run.runId}:terminal:3` },
  ]);
  expect(deliveries.filter((row) => row.sourceOutcome === "parked")).toHaveLength(2);
  expect(deliveries.filter((row) => row.sourceOutcome === "completed")).toHaveLength(1);
  ```

  Append the episode in the same in-memory state transition and atomic run-file save under `withRunAdvanceLock` that enters the state. A patch with previous and next status both `parked` preserves the existing episode. Leaving park does not append. Re-entry from any non-parked state appends the next parked sequence. The first terminal transition appends one terminal sequence; terminal retries cannot append another.

- [ ] **Step 5: Write the complete report matrix RED against shared delivery**

  Build table-driven tests for every row in the exactly-once matrix above. Claim six concurrent copies of one Workflow episode and assert one `callback_deliveries` row/id; claim a later park episode and terminal episode and assert distinct ids. The blank-success assertion is concrete:

  ```ts
  expect(delivery.payload.message).toContain('Workflow "Release review" completed.');
  expect(delivery.payload.message).toContain("Completed 3 of 3 phases.");
  expect(delivery.payload.message.trim()).not.toBe("");
  ```

  Assert ordinary and COO/root invocation Sessions produce byte-equivalent payloads after substituting Session id. Assert silent runs still stamp episodes and persist `workflow-run` blocks while creating zero delivery rows.

- [ ] **Step 6: Project activity and claim report episodes after durable run saves**

  After initial publication and each revision-stamped save, derive one complete Workflow run block and apply it to `run.invocation.sessionId`. Emit `session:delta` only after persistence succeeds. If `actingSessionId` is verified and differs from the invocation Session, put/patch the same block in that acting transcript as an operation receipt.

  For every persisted episode lacking a shared-delivery claim, call `claimSessionDelivery` with:

  ```ts
  {
    targetSessionId: run.invocation.sessionId,
    sourceKind: "workflow-run",
    sourceId: `${run.workflowId}:${run.runId}`,
    sourceAttempt: episode.token,
    sourceOutcome: episode.outcome,
    sourceVersion: episode.sequence,
    deliveryKind: episode.kind === "parked" ? "workflow-parked" : "workflow-terminal",
    payload,
  }
  ```

  If `run.invocation` is absent or `run.invocation.reportMode === "silent"`, do not claim. Silent still stamps episodes and projects every activity revision. The immediate projector/claim is best-effort and logged; run state stays authoritative.

- [ ] **Step 7: Reuse the existing worker and startup recovery**

  Rename `_deliverClaimedCallback` to `deliverClaimedSessionDelivery` and let both Session callback producers and Workflow reporting call it. It keeps the current legacy-target read-only guard, lease, delays, four-attempt cap, POST to `/api/sessions/:id/message` with `{ callbackDeliveryId }`, atomic acceptance, event emission, and engine wake. Do not copy those constants or branches into `workflows/reporting.ts`.

  Before the single existing `recoverSessionDeliveryStateOnStartup` call, run `recoverWorkflowRunReporting` only to:

  1. Scan schema-3 runs with an invocation, including terminal evidence absent from the active index.
  2. Reconstruct/apply the latest block.
  3. Claim every persisted missing report episode into `callback_deliveries`.
  4. Never claim for invocation-less legacy runs or silent runs.

  Then the existing single recovery call leases/retries all eligible due `sourceKind` values, preserves Task 4's legacy-target skip, and performs orphaned-delegation checks. The existing dead-letter list/requeue routes display/filter both sources. Session deletion must not cascade either source; a missing target dead-letters visibly.

- [ ] **Step 8: Run shared reliability GREEN and mutation check**

  ```bash
  pnpm --filter jinn-cli test -- src/workflows/__tests__/reporting.test.ts src/gateway/__tests__/workflow-report-reliability.test.ts src/gateway/__tests__/server-boot-ordering.test.ts src/sessions/__tests__/callback-deliveries.test.ts
  ```

  Expected GREEN includes unchanged delegation behavior plus one Workflow message, one queue item, one accepted delivery, and one resumed invoking turn under six concurrent/retried producers and restart recovery.

  Temporarily remove the unique index in the test schema, rerun `workflow-report-reliability.test.ts`, and require its six-delivery assertion to fail with more than one row or queue item. Restore the index and rerun GREEN before committing.

- [ ] **Step 9: Review and commit Task 5**

  Review save-before-project ordering, episode stability, delegation regression coverage, response-loss behavior, silent behavior, one recovery loop, and one dead-letter surface. Verify these forbidden additions are absent:

  ```bash
  rg -n "workflow_run_report_deliveries|workflowReportDeliveryId|workflow-report-deliveries|claimWorkflowRunReport|recover.*Workflow.*Delivery" packages/jinn/src packages/web/src
  ```

  Expected: no hits. Commit, report evidence against `wi_35edbe6160c1`, and stop for COO review:

  ```bash
  git commit -m "feat(workflows): reuse session delivery for run reports"
  ```

---

### Task 6: Add native run cancellation across HTTP, MCP, CLI, and UI

**Files:**
- Modify: `packages/jinn/src/workflows/advance.ts`
- Modify: `packages/jinn/src/workflows/run-reconciler.ts`
- Modify: `packages/jinn/src/gateway/api.ts`
- Modify: `packages/jinn/src/mcp/workflow-tools.ts`
- Modify: `packages/jinn/src/cli/workflow.ts`
- Modify: `packages/jinn/bin/jinn.ts`
- Modify: `packages/web/src/lib/api.ts`
- Modify: `packages/web/src/routes/workflow/run-view.tsx`
- Modify: `packages/jinn/src/workflows/__tests__/run-reconciler.test.ts`
- Modify: `packages/jinn/src/gateway/__tests__/workflow-definitions-route.test.ts`
- Modify: `packages/jinn/src/mcp/__tests__/workflow-tools.test.ts`
- Modify: `packages/jinn/src/mcp/__tests__/tool-manifest-budget.test.ts`
- Modify: `packages/jinn/src/mcp/__tests__/server.test.ts`
- Modify: `packages/jinn/src/cli/__tests__/workflow.test.ts`
- Modify: `packages/web/src/routes/workflow/__tests__/run-view.test.tsx`

**Interfaces:**
- Add `cancelWorkflowRun(deps, workflowId, runId, input)` with `{ actor: string; reason?: string }`.
- Add `WorkflowRun.cancellation?: { requestedAt: string; requestedBy: string; reason: string | null }`.
- Add `POST /api/workflow-definitions/:id/runs/:runId/cancel`.
- Add MCP `cancel_workflow_run { workflowId, runId, reason? }`.
- Add CLI `jinn workflow cancel release-review run-20260712010101-abcd1234 --reason "superseded" --json` with positional Workflow id/run id and optional reason/JSON flags.
- Add web `api.cancelWorkflowRun` and an accessible Cancel action for `running`, `dispatched`, and `parked` runs.

- [ ] **Step 1: Write cancellation RED**

  Cover running fresh/shared phase Sessions, parked runs, already terminal runs, a stop failure, duplicate cancellation, and cancellation racing a settle under `withRunAdvanceLock`. Assert all in-flight Workflow phase attempts receive `stopStepSession`, the run persists `cancelled`, no Todo changes, and the original invocation Session gets one terminal cancellation report through shared session delivery.

- [ ] **Step 2: Run cancellation RED**

  ```bash
  pnpm --filter jinn-cli test -- src/workflows/__tests__/run-reconciler.test.ts src/gateway/__tests__/workflow-definitions-route.test.ts src/mcp/__tests__/workflow-tools.test.ts src/cli/__tests__/workflow.test.ts
  pnpm --filter @jinn/web test -- src/routes/workflow/__tests__/run-view.test.tsx
  ```

  Expected RED includes a missing cancel route/tool/API and a run remaining nonterminal.

- [ ] **Step 3: Implement cancellation in the run authority**

  Under the existing `withRunAdvanceLock(runId, fn)`, re-read the run, reject completed/failed with 409, return an idempotent cancelled snapshot for an identical duplicate, stamp cancellation evidence, request terminal cancellation through the existing terminal transition helper, and stop every in-flight Workflow phase Session. A stop failure is appended as bounded cancellation evidence but cannot resurrect the run.

- [ ] **Step 4: Add surfaces and hints**

  Authorize cancel with `authorizeWorkflowOperation(..., "run", context)`. MCP cancellation is an operational action, not a gate approval. CLI bearer cancellation has no invocation Session and does not change an existing run invocation. The UI confirmation dialog must name the run, return focus on dismiss, support Escape, expose `aria-describedby`, and disable its action while the request is pending.

- [ ] **Step 5: Verify GREEN and commit Task 6**

  Re-run both focused commands. Expected GREEN includes one terminal report under duplicate/racing cancellation. Commit only Task 6 files, report evidence against `wi_35edbe6160c1`, and stop for COO review:

  ```bash
  git commit -m "feat(workflows): add native run cancellation"
  ```

---

### Task 7: Project independent Todo and Workflow definition operation receipts

**Files:**
- Create: `packages/jinn/src/gateway/chat-activity.ts`
- Create: `packages/jinn/src/shared/activity-receipts.ts`
- Create: `packages/jinn/src/shared/__tests__/activity-receipts.test.ts`
- Modify: `packages/jinn/src/shared/types.ts`
- Modify: `packages/jinn/src/sessions/registry.ts`
- Modify: `packages/jinn/src/gateway/api.ts`
- Modify: `packages/jinn/src/workflows/reporting.ts`
- Modify: `packages/jinn/src/workflows/run-reconciler.ts`
- Modify: `packages/jinn/src/mcp/toolkit.ts`
- Modify: `packages/jinn/src/mcp/server.ts`
- Modify: `packages/jinn/src/mcp/work-item-tools.ts`
- Modify: `packages/jinn/src/mcp/approval-tools.ts`
- Modify: `packages/jinn/src/mcp/workflow-tools.ts`
- Modify: `packages/jinn/src/engines/claude-interactive.ts`
- Modify: `packages/jinn/src/engines/codex-interactive.ts`
- Modify: `packages/jinn/src/engines/pi.ts`
- Modify: `packages/jinn/src/engines/grok.ts`
- Modify: `packages/jinn/src/engines/hermes-protocol.ts`
- Modify: `packages/web/src/hooks/use-live-session.ts`
- Create: `packages/jinn/src/gateway/__tests__/chat-activity-route.test.ts`
- Modify: `packages/jinn/src/gateway/__tests__/streamed-turn-settlement.test.ts`
- Modify: `packages/jinn/src/mcp/__tests__/work-item-tools.test.ts`
- Modify: `packages/jinn/src/mcp/__tests__/workflow-tools.test.ts`
- Modify: `packages/jinn/src/mcp/__tests__/server.test.ts`
- Modify: `packages/jinn/src/mcp/__tests__/toolkit.test.ts`
- Modify: `packages/jinn/src/engines/__tests__/claude-interactive.test.ts`
- Modify: `packages/jinn/src/engines/__tests__/codex-interactive.test.ts`
- Modify: `packages/jinn/src/engines/__tests__/pi.test.ts`
- Modify: `packages/jinn/src/engines/__tests__/grok.test.ts`
- Modify: `packages/jinn/src/engines/__tests__/hermes-protocol.test.ts`
- Modify: `packages/web/src/hooks/__tests__/use-live-session.test.ts`
- Modify: `packages/jinn/src/gateway/__tests__/work-items-route.test.ts`
- Modify: `packages/jinn/src/gateway/__tests__/workflow-definitions-route.test.ts`

**Interfaces:**
- Add `persistAndEmitActivityBlock(context, sessionId, envelope)`.
- Add pure builders `todoActivityBlock(item, action)`, `workflowDefinitionActivityBlock(definition, action)`, and reuse `workflowRunActivityBlock(run, action)` from Task 5.
- Resolve the acting Session from verified caller headers. Never accept a body field naming the transcript.
- Add `JinnMcpContext.activityOperation?: { id: string; toolName: string }`. `handleMcpRequest` generates a UUID for each `tools/call`, clones the context with the operation/tool name, and `gatewayRequest` forwards signed-session-only `x-jinn-activity-operation` and `x-jinn-activity-tool` headers.
- Add `extractActivityReceiptId(value): string | undefined` and `StreamDelta.activityReceiptId?: string`. A successful mutation response contains `{ activityReceiptId }`; engine adapters preserve it on the matching `tool_result` delta.
- Add one discriminated `CompanyChangedEvent` union emitted as `company:changed` after durable mutation:

  ```ts
  type CompanyChangedBase = { action: string; id: string; sessionId?: string };
  export type CompanyChangedEvent =
    | (CompanyChangedBase & { entity: "todo"; version: number; value?: JsonObject })
    | (CompanyChangedBase & { entity: "workflow-definition"; version: number })
    | (CompanyChangedBase & { entity: "workflow-run"; workflowId: string; runId: string; version: number })
    | (CompanyChangedBase & { entity: "workflow-trigger"; workflowId: string; revision: string });
  ```

  Todo `version` is the current WorkItem version, definition `version` is its authored version, run `version` is `WorkflowRun.revision`, and trigger `revision` is the existing `bindingRevision` (for delete, the deleted binding's last revision). `sessionId` is present only for a verified acting Session.

- [ ] **Step 1: Write route-level activity RED**

  Call every mutation route with a bound Session capability and assert the resulting transcript has one stable block per object, updated in place:

  ```ts
  expect(activityMessages(parent.id)).toHaveLength(2);
  expect(block(parent.id, `todo:${item.id}`)).toMatchObject({
    type: "todo-activity",
    version: item.version,
    payload: { todoId: item.id, action: "approval-decided", status: "done" },
  });
  expect(block(parent.id, `workflow-definition:${definition.id}`)).toMatchObject({
    type: "workflow-definition",
    version: definition.version,
    payload: { action: "updated" },
  });
  expect(response.body).toMatchObject({
    activityReceiptId: `workflow-definition:${definition.id}`,
  });
  ```

  The two messages prove Todo and Workflow activity are independent; neither payload contains the other's id or status.

- [ ] **Step 2: Run activity RED**

  ```bash
  pnpm --filter jinn-cli test -- src/gateway/__tests__/chat-activity-route.test.ts src/gateway/__tests__/work-items-route.test.ts src/gateway/__tests__/workflow-definitions-route.test.ts
  ```

  Expected RED finds no activity block after a successful mutation.

- [ ] **Step 3: Instrument canonical Todo mutation boundaries**

  After each durable success, persist then emit for: create, metadata PATCH, status transition, assign, archive, approval request, approval decision, and approval escalation. A response replay with the same Todo version reapplies an equal-version idempotent patch; a stale response cannot overwrite a newer block.

  `delegate_task` retains its richer `delegation` card. It must not create a second Todo activity row for the same atomic delegation response; later explicit Todo mutations may create or patch that Todo's stable activity id independently.

- [ ] **Step 4: Instrument canonical Workflow definition/run/trigger boundaries and one live event**

  Cover plain HTTP create/update/duplicate/retire and the MCP atomic `/mutate` create/update path. Run start/replay/edit/gate decision/escalation/cancellation patches the run block. Trigger create/delete/native activation decision patches the target definition block with actions `trigger-created`, `trigger-deleted`, or `trigger-approval-decided`. Plan/validate/list/get remain read-only and silent.

  Every successful Todo/definition/run/trigger mutation emits one `company:changed` payload after persistence, whether invoked by MCP, browser, CLI, cron, event, poll, or replay. Include the serialized Todo in `value` so existing Todo caches can patch by version; Workflow events carry bounded ids/version and cause focused query invalidation in Task 8. Do not emit on validation/auth failure or idempotent read-only replay with no state change.

  Update MCP hints to mention `Preview or Open the persisted activity receipt in this chat.` Do not synthesize blocks client-side from tool responses.

- [ ] **Step 5: Write deterministic tool-correlation RED**

  Add tests proving a successful mutation response carries the persisted block id through MCP result parsing, gateway partial-message metadata, WebSocket state, and reload:

  ```ts
  expect(toolResult.activityReceiptId).toBe(`todo:${item.id}`);
  expect(getMessages(session.id).find((message) => message.toolCall === "update_work_item")?.meta).toMatchObject({
    activityReceiptId: `todo:${item.id}`,
  });
  ```

  In `server.test.ts`/`toolkit.test.ts`, assert one `tools/call` gets one UUID operation id, the signed internal request forwards it with the exact tool name, an unbound context cannot forge the activity headers, and the response id equals the persisted block id. In each named engine suite, feed that engine's existing native successful tool-result fixture containing `{ "activityReceiptId":"todo:wi_release" }` and require this common delta shape:

  ```ts
  expect(delta).toMatchObject({
    type: "tool_result",
    toolId: "call-1",
    activityReceiptId: "todo:wi_release",
  });
  ```

  Match by stream `toolId` when supplied. Maintain a map of open partial tool message ids instead of the current single `lastToolId`; only use the most recent still-open same-name tool when an adapter provides no id. `extractActivityReceiptId` accepts only a bounded exact JSON property from a successful tool result. Error results never gain receipt metadata.

- [ ] **Step 6: Implement MCP/engine/partial-row correlation**

  The gateway trusts activity headers only after `resolveScopedWriteCallerIdentity` verifies a Session capability and `x-jinn-tool-call` marks the built-in MCP. Persist `activityReceipt` inside the block and return its id. Each named engine adapter calls the shared extractor on raw tool output and copies the id to `StreamDelta`; `persistPartialDelta` and `use-live-session` patch the exact tool row's `meta.activityReceiptId`.

  If the HTTP response is lost after the mutation committed, the tool retains its error feedback even though the durable activity block exists. That is not a duplicate successful tool result. Retrying the idempotent mutation returns the same activity receipt id and patches the same block.

- [ ] **Step 7: Verify GREEN and commit Task 7**

  ```bash
  pnpm --filter jinn-cli test -- src/shared/__tests__/activity-receipts.test.ts src/gateway/__tests__/chat-activity-route.test.ts src/gateway/__tests__/streamed-turn-settlement.test.ts src/gateway/__tests__/work-items-route.test.ts src/gateway/__tests__/workflow-definitions-route.test.ts src/mcp/__tests__/work-item-tools.test.ts src/mcp/__tests__/workflow-tools.test.ts src/mcp/__tests__/server.test.ts src/mcp/__tests__/toolkit.test.ts src/engines/__tests__/claude-interactive.test.ts src/engines/__tests__/codex-interactive.test.ts src/engines/__tests__/pi.test.ts src/engines/__tests__/grok.test.ts src/engines/__tests__/hermes-protocol.test.ts
  pnpm --filter @jinn/web test -- src/hooks/__tests__/use-live-session.test.ts
  ```

  Expected GREEN includes browser/operator requests without a caller Session producing `company:changed` for durable mutations but no transcript block, while bound MCP mutations produce one receipt and correlated tool metadata. Commit, report evidence against `wi_6921c5ff3693`, and stop for COO review:

  ```bash
  git commit -m "feat(chat): persist todo and workflow receipts"
  ```

---

### Task 8: Design and render live Preview/Open activity cards

**Files:**
- Create: `packages/web/src/components/chat/company-activity-card.tsx`
- Modify: `packages/web/src/components/chat/chat-blocks.tsx`
- Modify: `packages/web/src/components/chat/chat-messages.tsx`
- Modify: `packages/web/src/hooks/use-query-invalidation.ts`
- Modify: `packages/web/src/lib/query-keys.ts`
- Modify: `packages/web/src/routes/todos/todo-edit-request.ts`
- Modify: `packages/web/src/routes/workflow/list.tsx`
- Modify: `packages/web/src/routes/workflow/page.tsx`
- Modify: `packages/web/src/routes/workflow/run-view.tsx`
- Modify: `packages/web/src/routes/workflow/edit.tsx`
- Modify: `packages/web/src/lib/api.ts`
- Create: `packages/web/src/components/chat/__tests__/company-activity-card.test.tsx`
- Modify: `packages/web/src/components/chat/__tests__/chat-messages-tool-group.test.tsx`
- Create: `packages/web/src/hooks/__tests__/use-query-invalidation-company.test.tsx`
- Modify: `packages/web/src/hooks/__tests__/use-query-invalidation-todos.test.tsx`
- Modify: `packages/web/src/components/chat/__tests__/comms-v2.test.tsx`
- Modify: `packages/web/src/routes/workflow/__tests__/list.test.tsx`
- Modify: `packages/web/src/routes/workflow/__tests__/page.test.tsx`
- Modify: `packages/web/src/routes/workflow/__tests__/run-view.test.tsx`
- Modify: `packages/web/src/routes/workflow/__tests__/edit.test.tsx`
- Temporary, delete before commit: `packages/web/company-activity.mock.html`
- Temporary, delete before commit: `packages/web/company-activity.mock-shot.mjs`

**Interfaces:**
- `CompanyActivityCard` accepts a validated Todo, Workflow definition, or Workflow run block.
- Workflow page accepts a `run` search parameter in runs mode and passes the validated value as `initialRunId` into `DefinitionRunView`.
- Todo Open uses React Router state `{ todoRef: todoPrivateRef(todoId) }`; canonical Todo ids never enter the URL.
- Workflow definition Open uses `/workflow/release-review?mode=edit`; run Open uses the block's validated `/workflow/release-review?mode=runs&run=run-20260712010101-abcd1234`-shaped path with both identifiers encoded.
- Add `queryKeys.workflows.all`, `queryKeys.workflows.definition(id)`, `queryKeys.workflows.runs(id)`, `queryKeys.workflows.run(id, runId)`, and `queryKeys.workflows.triggers`. Workflow list/edit/run loaders use these React Query keys so WebSocket invalidation reaches mounted surfaces.
- `useQueryInvalidation` handles existing `session:created` and the one new `company:changed` event. It patches versioned Todo caches immediately and invalidates only affected Workflow/session keys.
- A completed generic tool message is hidden only when `message.meta.activityReceiptId` equals a persisted activity block id. Reload compatibility may use a strict same-turn 1:1 `activityReceipt.toolName` match; ambiguity retains tool rows.

- [ ] **Step 1: Frame the activity surface before UI code**

  Record this design intent in the Task 8 review note before creating the mock: activity is a quiet inline object, not another voice; one soft token surface shows object name and honest status, Preview expands bounded evidence in place, and Open is a separate plain action. Use `--fill-tertiary`, `--shadow-subtle`, `--radius-xl`, existing text/system tokens, 34px minimum actions, no resting hairline, no hardcoded color, no avatar/sender label, and full-width-chat-safe wrapping. Desktop and mobile preserve the same information hierarchy with no horizontal scroll.

- [ ] **Step 2: Build and inspect the standalone token mock**

  Create temporary `packages/web/company-activity.mock.html` with `<link rel="stylesheet" href="/src/routes/globals.css">`, `data-theme` selected from `?theme=dark|light`, and four representative cards: Todo in review, Workflow definition updated, Workflow run parked with Preview open, and failed run with a bounded error. Every color, radius, shadow, font size, and spacing value uses an existing CSS variable from `packages/web/src/routes/globals.css`.

  Start a standalone Vite preview and capture desktop with system Chrome plus true mobile through Playwright:

  ```bash
  pnpm --filter @jinn/web exec vite --port 5199 --strictPort
  CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --window-size=1440,860 --screenshot=/tmp/jinn-activity-mock-dark-desktop.png "http://127.0.0.1:5199/company-activity.mock.html?theme=dark"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --window-size=1440,860 --screenshot=/tmp/jinn-activity-mock-light-desktop.png "http://127.0.0.1:5199/company-activity.mock.html?theme=light"
  pnpm --filter @jinn/web exec node company-activity.mock-shot.mjs
  ```

  `company-activity.mock-shot.mjs` creates Playwright contexts with `{ viewport:{ width:390, height:844 }, deviceScaleFactor:2, colorScheme:"dark" }` and the light equivalent, opens the two theme URLs, and writes `/tmp/jinn-activity-mock-dark-mobile.png` and `/tmp/jinn-activity-mock-light-mobile.png`. Inspect all four PNGs at original resolution and record card width, wrapping, tap targets, theme contrast, disclosure hierarchy, and absence of borders/clipping.

- [ ] **Step 3: Stop for the pre-code design checkpoint**

  Send the Frame plus four mock images to the COO. Do not write component production code until the COO approves or gives a concrete revision. Apply revisions only to the temporary mock, repeat all four captures, and obtain approval.

- [ ] **Step 4: Write renderer, suppression, invalidation, and deep-link RED**

  Test all statuses, long strings, absent optional data, Preview toggling, Open navigation, live patch, reload parity, keyboard operation, and reduced motion. Assert:

  ```ts
  expect(screen.getByRole("button", { name: "Preview Release review workflow run" })).toHaveAttribute("aria-expanded", "false");
  await user.click(screen.getByRole("button", { name: "Preview Release review workflow run" }));
  expect(screen.getByRole("region", { name: "Release review workflow run details" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Open Release review workflow run" }));
  expect(router.state.location.pathname + router.state.location.search).toBe(
    "/workflow/release-review?mode=runs&run=run-20260712010101-abcd1234",
  );
  ```

  In `chat-messages-tool-group.test.tsx`, render a successful `update_work_item` row with `meta.activityReceiptId:"todo:wi_release"` plus that persisted block and assert the card is visible while `Used update_work_item` is absent. Assert an error/read-only row without a receipt remains, a block not yet present does not suppress, and two uncorrelated same-name tool rows plus one block remain visible. Add one strict 1:1 legacy fallback case keyed by `activityReceipt.toolName` within one user turn.

  In `use-query-invalidation-company.test.tsx`, emit `session:created` and each `company:changed.entity`. Assert exact keys: Session list/work-item-session caches; Todo list/detail patch by newer `value.version`; Workflow list/definition; run list/detail; trigger list plus owning definition; and invoking transcript/detail when `sessionId` is present. An older Todo event cannot overwrite a newer cached value.

- [ ] **Step 5: Run web RED**

  ```bash
  pnpm --filter @jinn/web test -- src/components/chat/__tests__/company-activity-card.test.tsx src/components/chat/__tests__/chat-messages-tool-group.test.tsx src/hooks/__tests__/use-query-invalidation-company.test.tsx src/hooks/__tests__/use-query-invalidation-todos.test.tsx src/routes/workflow/__tests__/list.test.tsx src/routes/workflow/__tests__/page.test.tsx src/routes/workflow/__tests__/run-view.test.tsx src/routes/workflow/__tests__/edit.test.tsx
  ```

  Expected RED says `workflow-run` falls through to the task-list renderer, correlated tool rows remain visible, `session:created`/`company:changed` are ignored, and the `run` query is ignored.

- [ ] **Step 6: Implement the approved card and deterministic tool suppression**

  Follow the Jinn design tokens already used by chat: content-led spacing, no decorative nested card border, `var(--text-primary/secondary/tertiary)`, `var(--fill-secondary)`, and system colors only for semantic failure/success. Use a 34px minimum control height, visible `:focus-visible`, tabular numbers for versions/progress, optical icon alignment, and no hover-only information.

  Preview is an inline disclosure containing bounded status, actor/assignee, progress, approval ask, timestamps, and latest error already present in the block payload. It performs no network fetch. Open is a separate button; the entire row is not a hidden link.

  Build a set of present activity block ids. Suppress a completed tool row only for an exact `meta.activityReceiptId` match. For reloads produced before correlation metadata existed, partition by user turn and suppress only when exactly one unmatched successful activity block declares a tool name and exactly one completed row has that name. Never suppress an active tool, error, read-only tool, a row in another turn, or an ambiguous cardinality. Preserve existing delegation/dispatch suppression and fold counts.

- [ ] **Step 7: Implement live query updates and URL-selected run behavior**

  Add the Workflow query keys and migrate list/page/edit/run fetches from component-local effects to `useQuery` without changing loading/error copy. In `use-query-invalidation.ts`:

  - treat `session:created` like `session:started` for Session and linked-Todo Session lists;
  - on Todo `company:changed`, call the exported version-aware Todo cache merge when `value` is present, otherwise invalidate `['work-items']` and exact detail;
  - on Workflow definition, run, and trigger changes, invalidate only the keys named in Step 4;
  - when the event carries `sessionId`, invalidate that Session detail/transcript as loss recovery while normal `session:delta` remains the surgical live path;
  - keep the existing one-second debounce for refetch invalidations, but apply safe Todo patches synchronously.

  Parse `run` only in runs mode. Initialize selection from the query when it exists in the fetched list; if the run is not in the first summary page, fetch it directly and retain an explicit selected chip. Selecting a different run updates the URL with `replace:false`; refreshing retains selection; switching to Edit removes `run`; browser back restores the prior run. Starting a new run writes its id into the URL.

- [ ] **Step 8: Verify fallback and live/reload parity**

  Add a test that renders an unknown future block using its persisted fallback text, then renders a known activity block after a live patch and after API reload. The visible text and accessible names match; the live patch does not append another message. Emit each mutation event while list/detail/run/chat fixtures are mounted and prove the affected surface refreshes without a page reload.

- [ ] **Step 9: Capture real components in all four combinations before commit**

  Delete the temporary mock files. Run a fixture gateway with `/api/auth/state` returning `{ "authRequired":false }` and fixtures for Todo review, parked/re-entered Workflow, completed silent Workflow, failed Workflow, correlated success tool row, error tool row, and an unknown future block. Start Vite on port 5199 and capture the real chat/activity components at 1440×860 dark/light and true 390×844 dark/light using the same Chrome/Playwright rules as Step 2.

  Inspect all four screenshots at original resolution. Run keyboard-only Preview/Open/Cancel flows, `prefers-reduced-motion: reduce`, and axe in both themes. Require no horizontal clipping, duplicate tool row, resting hairline, hardcoded dark color, contrast violation, hidden hover-only data, focus loss, or animation under reduced motion. Fix any divergence from the approved mock with a new RED test before continuing.

- [ ] **Step 10: Run web GREEN and commit Task 8**

  ```bash
  pnpm --filter @jinn/web test -- src/lib/__tests__/company-activity-blocks.test.ts src/components/chat/__tests__/company-activity-card.test.tsx src/components/chat/__tests__/chat-messages-tool-group.test.tsx src/components/chat/__tests__/comms-v2.test.tsx src/hooks/__tests__/use-query-invalidation-company.test.tsx src/hooks/__tests__/use-query-invalidation-todos.test.tsx src/routes/workflow/__tests__/list.test.tsx src/routes/workflow/__tests__/page.test.tsx src/routes/workflow/__tests__/run-view.test.tsx src/routes/workflow/__tests__/edit.test.tsx
  ```

  Expected GREEN: all listed tests pass with no React act, key, or accessibility warnings; four real-component screenshots and axe/reduced-motion logs are attached to review. Commit only durable component/test files, confirm temporary mock and screenshot files are unstaged, report evidence against `wi_6921c5ff3693`, and stop for COO review:

  ```bash
  git commit -m "feat(web): render company activity receipts"
  ```

---

### Task 9: Update doctrine, shipped skills, API guidance, and instance migration

**Files:**
- Modify: `packages/jinn/template/CLAUDE.md`
- Modify: `packages/jinn/template/docs/company-doctrine.md`
- Modify: `packages/jinn/template/docs/org.md`
- Modify: `packages/jinn/template/skills/todo-handling/SKILL.md`
- Modify: `packages/jinn/template/skills/workflow/SKILL.md`
- Create: `packages/jinn/template/migrations/0.27.0/MIGRATION.md`
- Modify: `packages/jinn/src/shared/__tests__/template-company-doctrine.test.ts`
- Modify: `packages/jinn/src/cli/__tests__/migrate-prompt.test.ts`
- Modify: `packages/jinn/src/mcp/__tests__/context-diet.test.ts`
- Modify: `packages/jinn/src/mcp/__tests__/template-diet-tranche.test.ts`

**Interfaces:**
- Shipped doctrine states that Todos are deliberately authored/tracked work and Workflows are reusable procedures whose invocations never create or mutate Todos.
- Workflow skill documents `reportMode`, activity receipts, native human gate approval, cancellation, and invocation-session reporting.
- Todo skill removes all Workflow mirror/run ownership language.
- Migration guidance describes the in-place generalization of the existing callback-delivery identity and preserves its current operator requeue/dead-letter surface; it does not introduce a Workflow delivery store or lifecycle.

- [ ] **Step 1: Write doctrine RED**

  Assert shipped text contains these exact principles:

  ```text
  A Workflow invocation never creates, links, transitions, approves, or mutates a Todo.
  A Todo-status trigger is a one-way input; the resulting Workflow run is independent.
  A session-invoked Workflow reports to that same session unless reportMode is silent.
  Workflow runs are durable records, not Sessions.
  ```

  Assert shipped templates do not contain `mirrored workflow`, `run's Todo`, `Todo that records each live run`, `workflow runs are entered automatically`, or `todoTransition`.

- [ ] **Step 2: Run docs RED**

  ```bash
  pnpm --filter jinn-cli test -- src/shared/__tests__/template-company-doctrine.test.ts src/cli/__tests__/migrate-prompt.test.ts src/mcp/__tests__/context-diet.test.ts src/mcp/__tests__/template-diet-tranche.test.ts
  ```

  Expected RED identifies the current auto-mint and mirrored-gate wording.

- [ ] **Step 3: Rewrite shipped guidance and migration**

  Keep examples generic. The 0.27.0 migration instructs an existing instance agent to update personalized doctrine/skills semantically without overwriting custom employee names, org structure, secrets, or unrelated preferences. It must explicitly remove stale Workflow–Todo coupling guidance and explain that historical Workflow-source Todos remain ordinary audit records.

  Document all start surfaces:

  - A verified MCP Session invocation persists `invocation: { sessionId, reportMode }`; that one relation means the run belongs and reports to the same Session.
  - `reportMode:"silent"` suppresses only resumption.
  - browser, CLI, cron, webhook, poll, and Todo-status starts are invocation-less unless a verified Session invokes them.
  - human gate decisions use the Workflow run approval surface, never Todo approval tools.
  - `cancel_workflow_run` cancels a run without touching a Todo.
  - old `engine:"workflow"` run Sessions remain readable historical evidence, are excluded from Focused/status/live-engine treatment, and redirect from their existing Workflow provenance; this release does not delete or rewrite them.

- [ ] **Step 4: Run docs GREEN and commit Task 9**

  Re-run the focused tests. Expected GREEN: all template and migration prompt assertions pass. Commit only Task 9 files, report the commit against `wi_acc19d92d2f8`, and stop for COO review:

  ```bash
  git commit -m "docs: separate workflow runs from todos"
  ```

---

### Task 10: Sequential integration gates, visual QA, accessibility, and privacy review

**Files:**
- Review every file changed by Tasks 1–9.
- Do not modify unrelated files to make a gate pass.

**Interfaces:**
- Consumes every preceding contract.
- Produces reproducible RED/GREEN evidence, browser evidence, a privacy-clean scoped diff, and an independent review verdict.

- [ ] **Step 1: Run the complete focused backend matrix**

  ```bash
  pnpm --filter jinn-cli test -- src/shared/__tests__/company-activity-blocks.test.ts src/shared/__tests__/activity-receipts.test.ts src/sessions/__tests__/messages-partial.test.ts src/sessions/__tests__/workflow-provenance.test.ts src/sessions/__tests__/legacy-workflow-session-compat.test.ts src/sessions/__tests__/callback-deliveries.test.ts src/sessions/__tests__/callbacks.test.ts src/workflows/__tests__/run-store.test.ts src/workflows/__tests__/run-idempotency.test.ts src/workflows/__tests__/todo-decoupling.test.ts src/workflows/__tests__/native-approvals.test.ts src/workflows/__tests__/reporting.test.ts src/workflows/__tests__/todo-status-trigger.test.ts src/workflows/__tests__/todo-replay-watermark.test.ts src/workflows/__tests__/poll-trigger.test.ts src/workflows/__tests__/event-trigger.test.ts src/workflows/__tests__/run-reconciler.test.ts src/gateway/__tests__/workflow-definitions-route.test.ts src/gateway/__tests__/workflow-events-route.test.ts src/gateway/__tests__/workflow-session-grouping.test.ts src/gateway/__tests__/workflow-report-reliability.test.ts src/gateway/__tests__/chat-activity-route.test.ts src/gateway/__tests__/streamed-turn-settlement.test.ts src/gateway/__tests__/callback-reliability.test.ts src/gateway/__tests__/status-reconciler.test.ts src/gateway/__tests__/manager-visibility.test.ts src/gateway/__tests__/work-item-approval-route.test.ts src/gateway/__tests__/work-items-route.test.ts src/gateway/__tests__/server-boot-ordering.test.ts src/mcp/__tests__/workflow-tools.test.ts src/mcp/__tests__/work-item-tools.test.ts src/mcp/__tests__/tool-manifest-budget.test.ts src/mcp/__tests__/server.test.ts src/mcp/__tests__/toolkit.test.ts src/engines/__tests__/claude-interactive.test.ts src/engines/__tests__/codex-interactive.test.ts src/engines/__tests__/pi.test.ts src/engines/__tests__/grok.test.ts src/engines/__tests__/hermes-protocol.test.ts src/cli/__tests__/workflow.test.ts src/shared/__tests__/template-company-doctrine.test.ts src/cli/__tests__/migrate-prompt.test.ts
  ```

  Expected GREEN: every listed file passes. Record the Vitest file/test counts and duration in the implementation handoff.

- [ ] **Step 2: Run the complete focused web matrix**

  ```bash
  pnpm --filter @jinn/web test -- src/lib/__tests__/company-activity-blocks.test.ts src/components/chat/__tests__/company-activity-card.test.tsx src/components/chat/__tests__/chat-messages-tool-group.test.tsx src/components/chat/__tests__/chat-route-helpers.test.ts src/components/chat/__tests__/comms-v2.test.tsx src/hooks/__tests__/use-live-session.test.ts src/hooks/__tests__/use-query-invalidation-company.test.tsx src/hooks/__tests__/use-query-invalidation-todos.test.tsx src/routes/chat/__tests__/legacy-workflow-session-redirect.test.tsx src/routes/workflow/__tests__/list.test.tsx src/routes/workflow/__tests__/page.test.tsx src/routes/workflow/__tests__/run-view.test.tsx src/routes/workflow/__tests__/edit.test.tsx src/routes/todos/__tests__/row.test.tsx src/routes/todos/__tests__/needs-you-view.test.tsx src/routes/todos/__tests__/detail-sheet.test.tsx
  ```

  Expected GREEN: all listed files pass with no console warnings.

- [ ] **Step 3: Run full repository gates**

  ```bash
  pnpm typecheck
  pnpm test
  pnpm lint
  pnpm build
  git diff --check
  ```

  All commands must exit 0. If a failure is unrelated and pre-existing, preserve it, capture the exact command/output, and report it instead of editing out-of-scope code.

- [ ] **Step 4: Re-run isolated browser and accessibility regression QA**

  Start an isolated gateway on port 7800 with a disposable home, then start Vite with `GATEWAY_PORT=7800` on port 4174. Seed current generic Sessions, Todos, Workflow definitions, and runs only through the isolated gateway API. Before gateway boot, install the exact old-shape SQLite fixture from Task 4 solely for the historical redirect case; current APIs must have no way to create that projection. Capture these exact states at 1440×900 and 390×844, light and dark, normal and reduced motion:

  1. Todo created, assigned, in review, approved, and archived activity patches.
  2. Workflow definition created/updated/retired receipt.
  3. Workflow run running, parked, resumed, completed, failed, timed out, cancelled, and silent.
  4. Preview closed/open and Open navigation.
  5. Reload parity for every card.
  6. Old synthetic Session direct redirect from its existing Workflow provenance.
  7. URL-selected run restored on refresh/back.

  Require no horizontal overflow, clipped controls, duplicate cards, raw fallback duplication, layout shift on patch, unintended animation under reduced motion, console errors, failed network requests, or non-isolated origins. Keyboard-only QA must reach Preview, Open, approval, escalation, and Cancel in logical order; Escape closes dialogs/disclosures as specified; focus returns to the launching control; every icon-only control has an accessible name. This is a regression gate after Task 8's required Frame, standalone token mock, four-way mock review, and four-way real-component review; it does not replace or postpone either Task 8 checkpoint.

- [ ] **Step 5: Perform deletion-criteria and incomplete-text scans**

  ```bash
  rg -n "createWorkflowTodoBridge|WorkflowTodoBridge|applyTodoTransitions|recordMirroredApprovalDecision|workflow-gate:|syncWorkflowRunSession|workflowRunParentSessionKey" packages/jinn/src packages/web/src
  rg -n "approvalWorkItemId" packages/jinn/src packages/web/src
  rg -n "workflow_run_report_deliveries|workflowReportDeliveryId|workflow-report-deliveries|claimWorkflowRunReport|legacy_workflow_run_session_aliases" packages/jinn/src packages/web/src
  rg -n "engine: ['\"]workflow" packages/jinn/src packages/web/src
  rg -n "todoTransition" packages/jinn/src packages/web/src packages/jinn/template
  rg --pcre2 -n "^import(?! type\\b).*work-items/(store|transitions|approvals)" packages/jinn/src/workflows
  rg -n 'T[B]D|FIXM[E]|X{3}|implement lat[e]r|same as abov[e]|similar t[o]|placehold[e]r' docs/superpowers/plans/2026-07-12-jinn-chat-workflow-todo-kiss.md packages/jinn/src packages/web/src packages/jinn/template
  ```

  The coupling-symbol grep, parallel-delivery/alias grep, and runtime WorkItem-import grep must have no current production hit. `approvalWorkItemId` is accepted only in the schema-1 trigger migration adapter and its fixture; `engine:"workflow"` only in named read-compatibility fixtures/helpers that never create or mutate a Session; `todoTransition` only in the named legacy definition read adapter and fixture. Remove every accidental incomplete marker before handoff.

- [ ] **Step 6: Verify privacy and commit scope**

  ```bash
  git diff --cached --name-only
  git diff --cached --check
  git diff --cached | grep -iE 'h[r]isto|j[i]mmyenglish|p[r]avko|m[o]vekit|s[q]lnoir|h[o]my|s[p]ycam|a[s]omaniac|k[i]wilabs|t[u]cker@|/Us[e]rs/'
  ```

  The leak grep must have no hit outside the known repository metadata occurrence of the package/repository owner already documented by the repository privacy firewall. Inspect every allowed occurrence manually. Confirm no secret, generated evidence, database, screenshot, recording, lockfile, or installed-workspace file is staged.

- [ ] **Step 7: Independent sequential review**

  Give an independent reviewer the six locked decisions, commit list, RED/GREEN logs, shared-delivery mutation result, migration fixtures, browser captures, accessibility checklist, and privacy result. Require explicit review of:

  - every invocation path in the surface map;
  - no Todo runtime value imports or writes from Workflow code beyond the isolated event payload read performed by the authored Todo-status trigger;
  - native gate and poll approval authority;
  - single shared-delivery uniqueness, acceptance, recovery, requeue, and dead letters with delegation regression parity;
  - invocation equality and identical report behavior across employee ranks;
  - silent activity without resumption;
  - non-destructive historical classification and direct provenance redirect;
  - URL and Todo-id privacy;
  - fallback parity and stale patch rejection.

  Fix each material finding with a new RED test, rerun the affected focused gate and full gates, and obtain a clean follow-up verdict before completion. Report Task 10 evidence against `wi_acc19d92d2f8`; there is no verification-only commit. Stop for final COO acceptance.

---

## Compatibility and Deletion Criteria

- Workflow run schema v1/v2 files remain readable and are never rewritten merely by reading. Invocation-less legacy runs never generate historical callbacks. Active legacy runs upgrade only when the reconciler performs a real state mutation.
- The physical `callback_deliveries` table and its existing HTTP acceptance/requeue/dead-letter routes remain the sole delivery surface. The in-place generic-identity migration preserves every delivery id, payload, and lifecycle field; for a delivery targeting a historical synthetic run Session, only column naming changes and its lifecycle remains frozen. Keep the child-shaped migration fixture until the minimum supported pre-0.27.0 database version has aged out; removing it is a separate rollback-reviewed cleanup.
- `WorkflowRun.triggerTodoId` and legacy object-trigger normalization remain read-only adapters until two released versions have written only schema-3 trigger envelopes and migration telemetry shows no supported active v1/v2 run depends on them. They are not accepted on new run inputs.
- Legacy definition `todoTransition` is stripped and warned on read, rejected on every new write, and never executed. Remove the read adapter only after the minimum supported definition version has passed through the 0.27.0 migration.
- `WorkItemSource` keeps `"workflow"` solely so historical rows satisfy TypeScript and SQLite constraints. It is absent from public provenance creation and has no live Workflow projection. Removing it requires a separate rollback-safe WorkItem table rebuild and is not part of this change.
- Trigger store schema 1 is migrated once to schema 2. After the minimum supported instance version is 0.27.0, delete `approvalWorkItemId` parsing and its migration fixture in a dedicated cleanup change.
- Historical synthetic run Sessions, messages, queue items, and callback deliveries remain intact and read-only. Existing Workflow provenance supplies direct redirects; no alias/snapshot table or destructive cleanup belongs in this change. Cleanup may be proposed separately only after retention evidence, rollback design, and explicit approval exist.
- Keep legacy Workflow-run provenance parsing and legacy callback suppression until that separately approved cleanup removes the historical rows. Delete `packages/jinn/src/work-items/workflow-bridge.ts`, its two bridge suites, every current synthetic-parent creation helper, and dead compatibility exports that invite new callers.
- Keep the strict same-turn one-block/one-tool-name correlation fallback only for transcripts created before `meta.activityReceiptId`. Remove it only after the oldest supported transcript schema always carries explicit correlation and telemetry shows no fallback use for the published retention window.

## Scoped Commit Sequence

1. `docs: plan chat-first workflow simplification`
2. `feat(chat): add company activity block contracts`
3. `feat(workflows): persist invoking session relation`
4. `refactor(workflows): decouple runs and todos`
5. `refactor(workflows): remove synthetic run sessions`
6. `feat(workflows): reuse session delivery for run reports`
7. `feat(workflows): add native run cancellation`
8. `feat(chat): persist todo and workflow receipts`
9. `feat(web): render company activity receipts`
10. `docs: separate workflow runs from todos`

Each commit must be independently focused, GREEN for its named tests, reviewed before the next task, and free of unrelated dirty-worktree files. Stop after every numbered commit for COO verification; do not begin the next task in the same turn.

## Inspected Live Sources

This plan is based on the current monorepo rather than stale `jimmy/` or Next.js examples. The implementation owner should re-open these exact files before editing if main has advanced:

- `package.json`, `packages/jinn/package.json`, `packages/web/package.json`, `packages/web/vite.config.ts`
- `packages/jinn/src/shared/types.ts`, `packages/jinn/src/shared/blocks.ts`
- `packages/jinn/src/sessions/registry.ts`, `packages/jinn/src/sessions/callbacks.ts`, `packages/jinn/src/sessions/manager.ts`
- `packages/jinn/src/gateway/api.ts`, `packages/jinn/src/gateway/server.ts`, `packages/jinn/src/gateway/approval-authority.ts`, `packages/jinn/src/gateway/status-reconciler.ts`, `packages/jinn/src/gateway/manager-visibility.ts`
- `packages/jinn/src/workflows/definition.ts`, `schema.ts`, `sop.ts`, `definition-store.ts`, `advance.ts`, `run-store.ts`, `run-idempotency.ts`, `run-reconciler.ts`, `todo-status-trigger.ts`, `custom-triggers.ts`, `poll-trigger.ts`, `cron-sync.ts`, `trigger-dispatch.ts`
- `packages/jinn/src/work-items/store.ts`, `migrate.ts`, `transitions.ts`, `approvals.ts`, `reconcile.ts`, `workflow-bridge.ts`
- `packages/jinn/src/cron/runner.ts`, `packages/jinn/src/cron/scheduler.ts`
- `packages/jinn/src/mcp/toolkit.ts`, `server.ts`, `identity.ts`, `workflow-tools.ts`, `work-item-tools.ts`, `approval-tools.ts`
- `packages/jinn/src/engines/claude-interactive.ts`, `codex-interactive.ts`, `pi.ts`, `grok.ts`, `hermes-protocol.ts`
- `packages/jinn/src/cli/workflow.ts`, `packages/jinn/bin/jinn.ts`
- `packages/web/src/lib/api.ts`, `packages/web/src/lib/blocks.ts`
- `packages/web/src/hooks/use-live-session.ts`, `packages/web/src/hooks/use-query-invalidation.ts`, `packages/web/src/hooks/__tests__/use-query-invalidation-todos.test.tsx`
- `packages/web/src/lib/query-keys.ts`, `packages/web/src/routes/todos/todo-edit-request.ts`
- `packages/web/src/components/chat/chat-messages.tsx`, `chat-blocks.tsx`, `chat-route-helpers.ts`
- `packages/web/src/routes/chat/page.tsx`
- `packages/web/src/routes/workflow/page.tsx`, `run-view.tsx`, `edit.tsx`
- `packages/web/src/routes/todos/page.tsx`, `row.tsx`, `detail-sheet.tsx`, `needs-you-view.tsx`, `todo-private-state.ts`
- `packages/jinn/template/CLAUDE.md`, `packages/jinn/template/docs/company-doctrine.md`, `packages/jinn/template/docs/org.md`, `packages/jinn/template/skills/workflow/SKILL.md`, `packages/jinn/template/skills/todo-handling/SKILL.md`
- `docs/superpowers/plans/2026-07-12-callback-delivery-idempotency.md`
- `docs/superpowers/plans/2026-07-10-workflow-session-grouping.md`
- `docs/superpowers/specs/2026-07-10-workflow-session-grouping-design.md`
