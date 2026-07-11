# Callback Delivery Idempotency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver each child callback outcome to its parent exactly once across duplicate settlement seams, HTTP retries, and gateway restarts.

**Architecture:** Persist a callback outbox row before any parent POST. Identify the row by parent, child, immutable attempt token, terminal outcome and version, and callback kind. The parent message route transactionally accepts that outbox row together with its internal queue item and durable notification message; accepted retries become no-ops, while pending rows are replayed after restart.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, React 19/Vite web tests.

## Global Constraints

- Follow strict red-green-refactor: no production behavior without a test that first failed for the expected reason.
- Use disposable `JINN_HOME` directories and non-default ports for process-level verification.
- Preserve unrelated Activity, Workflow, Todo, chat, and operator scratch changes.
- Keep every repository fixture generic and leak-check the staged diff before commit.
- Do not deduplicate by message text, timestamp, or child session alone.
- Do not add `Co-Authored-By` trailers.

---

### Task 1: Durable callback identity and schema

**Files:**
- Modify: `packages/jinn/src/shared/types.ts`
- Modify: `packages/jinn/src/sessions/registry.ts`
- Create: `packages/jinn/src/sessions/__tests__/callback-deliveries.test.ts`

**Interfaces:**
- Produces: `Session.attemptTerminalVersion: number`, `CallbackDeliveryIdentity`, `CallbackDeliveryPayload`, `claimCallbackDelivery`, `getCallbackDelivery`, `listPendingCallbackDeliveries`, and `acceptCallbackDelivery`.
- Consumes: existing session attempt tokens, terminal outcomes, queue rows, messages, and structured callback metadata.

- [ ] **Step 1: Write the failing migration and identity tests**

  Add tests that require an idempotent, rollback-safe `callback_deliveries` table and a unique identity across `(parent_session_id, child_session_id, attempt_token, terminal_outcome, terminal_version, callback_kind)`.

- [ ] **Step 2: Run the focused test and record RED**

  Run `pnpm --filter jinn-cli test -- src/sessions/__tests__/callback-deliveries.test.ts` and confirm failure because the schema/functions do not exist.

- [ ] **Step 3: Add the minimal schema and attempt version support**

  Add `attempt_terminal_version INTEGER NOT NULL DEFAULT 0`, reset it when `beginSessionAttempt` mints a generation, and increment it whenever that generation receives a terminal receipt. Add a transactional migration that validates the callback table shape before installing its unique/pending indexes.

- [ ] **Step 4: Implement atomic claim and acceptance**

  `claimCallbackDelivery` inserts the payload once and returns the existing row on conflicts. `acceptCallbackDelivery` verifies the parent, inserts one internal queue row and one notification message, and marks the receipt accepted in the same SQLite transaction.

- [ ] **Step 5: Run the focused test and record GREEN**

  Re-run the Task 1 command and confirm migration, rollback, idempotency, concurrent claim, and distinct identity cases pass.

### Task 2: Callback sender outbox and restart recovery

**Files:**
- Modify: `packages/jinn/src/sessions/callbacks.ts`
- Modify: `packages/jinn/src/sessions/__tests__/callbacks.test.ts`
- Modify: `packages/jinn/src/gateway/server.ts`

**Interfaces:**
- Consumes: Task 1 callback delivery claim/list APIs.
- Produces: `recoverPendingCallbackDeliveries()` and callback POSTs carrying only the claimed delivery id.

- [ ] **Step 1: Write failing sender tests**

  Cover six concurrent and sequential calls for one completed attempt, a response-loss retry, a pending claimed delivery replayed after restart, a new attempt, a changed terminal outcome/version, and a distinct callback kind.

- [ ] **Step 2: Run the focused tests and record RED**

  Run `pnpm --filter jinn-cli test -- src/sessions/__tests__/callbacks.test.ts` and confirm duplicate fetches or missing claim/recovery behavior.

- [ ] **Step 3: Claim before POST and recover pending rows**

  Build the callback payload first, claim its durable identity, skip already accepted rows, and POST pending delivery ids. On startup, replay pending rows only after the HTTP listener and engine-attachment gate are ready.

- [ ] **Step 4: Run the focused tests and record GREEN**

  Confirm the sender tests pass without changing completion-contract nudges, workflow-parent suppression, manager visibility, relays, or attachment wake behavior.

### Task 3: Transactional API acceptance and parent wake

**Files:**
- Modify: `packages/jinn/src/gateway/api.ts`
- Modify: `packages/jinn/src/gateway/__tests__/callback-reliability.test.ts`

**Interfaces:**
- Consumes: `acceptCallbackDelivery` and the stored callback payload.
- Produces: idempotent `POST /api/sessions/:id/message` behavior for `callbackDeliveryId`, returning the original accepted identifiers on retries without another emit or dispatch.

- [ ] **Step 1: Write failing end-to-end API tests**

  Post the same claimed delivery at least six times concurrently and sequentially, simulate accepted-response loss, recreate the queue to simulate restart, and assert one notification message, one internal queue row, one live arrival event, and one engine execution.

- [ ] **Step 2: Run the gateway reliability test and record RED**

  Run `pnpm --filter jinn-cli test -- src/gateway/__tests__/callback-reliability.test.ts` and confirm the current route creates duplicate queue/message/execution state.

- [ ] **Step 3: Route callback deliveries through transactional acceptance**

  Resolve the stored payload from the receipt, reject target mismatches, validate the engine before acceptance, and return early for accepted duplicates. Only the winning request emits the callback block/arrival event and dispatches the one persisted queue item.

- [ ] **Step 4: Run the gateway reliability test and record GREEN**

  Confirm one durable message, queue row, UI arrival, and parent turn, including restart replay and response-loss retry.

### Task 4: UI and surrounding contract regression coverage

**Files:**
- Modify only if RED exposes a gap: `packages/web/src/hooks/__tests__/use-live-session.test.ts`
- Test existing callback UI, delegation, work-item, Workflow, and queue suites.

**Interfaces:**
- Consumes: one `session:notification` event plus one reload-stable notification row.
- Produces: proof that the existing UI renders one callback arrival/block and surrounding contracts remain coherent.

- [ ] **Step 1: Run existing UI callback tests before changes**

  Run `pnpm --filter web test -- src/hooks/__tests__/use-live-session.test.ts src/components/chat/__tests__/teammate-reply.test.tsx src/components/chat/__tests__/comms-v2.test.tsx`.

- [ ] **Step 2: Add a failing duplicate-arrival test only if the gateway invariant is insufficient**

  Assert a single accepted callback event plus reload yields one rendered callback; do not hide gateway duplicates with text- or timestamp-based UI dedupe.

- [ ] **Step 3: Run focused surrounding suites**

  Run callback, queue, session-attempt, delegation, work-item, Workflow follow-up, Workflow queue replay, and Workflow run-reconciler tests.

### Task 5: Mutation, full verification, commit, and independent QA

**Files:**
- Review every changed file and the staged diff.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a scoped commit and an independent QA verdict.

- [ ] **Step 1: Mutation-check the claim**

  Temporarily bypass the callback claim/id path, rerun the six-delivery regression, and require duplicate message/queue/execution evidence or a failing assertion. Restore the implementation and rerun GREEN.

- [ ] **Step 2: Run full relevant verification**

  Run the focused suites, the relevant gateway package suite, `pnpm typecheck`, `pnpm build`, and `pnpm lint`. Use only disposable homes and non-default process-level ports.

- [ ] **Step 3: Review and leak-check**

  Inspect `git diff --check`, staged paths, and run the repository privacy guard plus the operator-provided staged-diff leak check. Remove every non-generic hit before commit.

- [ ] **Step 4: Commit scoped changes**

  Commit only callback-idempotency implementation, tests, and this plan with a concise message and no co-author trailer.

- [ ] **Step 5: Obtain independent QA**

  Give an independent reviewer the contract, commit, RED/GREEN/mutation evidence, and request code/test/privacy review. Address every material finding and rerun verification before reporting completion.
