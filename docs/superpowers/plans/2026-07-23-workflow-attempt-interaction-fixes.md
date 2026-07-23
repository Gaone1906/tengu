# Workflow Attempt Interaction Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep workflow attempt transcripts live during engine execution and treat operator-message interruptions as ordinary turn ends without weakening explicit workflow cancellation.

**Architecture:** Extract the existing web-turn partial-stream writer into a session-level helper and use it from both web and workflow dispatch. Extend workflow turn receipts with an explicit interruption cause, publish receipts for API-dispatched follow-up turns, and let only user-message interruptions enter the existing reminder-ladder branch.

**Tech Stack:** TypeScript ES2022, Vitest, better-sqlite3, SessionManager, WorkflowRunner.

## Global Constraints

- Work only in the dedicated `jinn-wf-interaction-fix` worktree; do not modify the main working tree.
- Do not start or restart a gateway.
- Do not use any personal Jinn instance as `JINN_HOME`.
- Do not bind ports 7777, 7788, 7801, 7850, or 7910.
- Do not kill any process that this test run did not start.
- Turn-end never completes a workflow Employee node; only `workflow_submit_output` or a valid `jinn-output` fenced block completes it.
- Commit Bug A and Bug B separately, with their regression tests in the same commit as each fix.
- After the final edit, run the complete backend and web test suites and retain their verbatim output tails.

---

### Task 1: Persist Workflow-Dispatched Streaming Activity

**Files:**
- Create: `packages/jinn/src/sessions/partial-stream.ts`
- Modify: `packages/jinn/src/gateway/api.ts`
- Modify: `packages/jinn/src/sessions/manager.ts`
- Test: `packages/jinn/src/sessions/__tests__/workflow-attempt-turns.test.ts`

**Interfaces:**
- Consumes: `StreamDelta`, registry partial-message primitives, and block-envelope validation.
- Produces: `createPartialStreamWriter(sessionId)`, `foldPartialText(curText, delta)`, and `normalizeBlockDeltaForTurn(delta, turnStartedAt)`.

- [ ] **Step 1: Write the failing workflow-stream regression**

Add a deferred test engine that emits text and tool deltas before its `run()` promise resolves. Start a workflow attempt, wait for the engine call, and assert:

```ts
expect(runs[0]?.onStream).toBeTypeOf("function");
expect(registry.getPartialMessages(sessionId)).toEqual([
  expect.objectContaining({ role: "assistant", content: "Inspecting the workspace.", partial: true }),
  expect.objectContaining({ role: "assistant", content: "Used Search", partial: true, toolCall: "Search" }),
]);
```

Resolve the turn and assert that the retained activity rows are non-partial and precede the canonical final assistant row.

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm --filter jinn-cli test -- src/sessions/__tests__/workflow-attempt-turns.test.ts
```

Expected: FAIL because `runs[0].onStream` is undefined and no partial rows exist.

- [ ] **Step 3: Extract the shared partial-stream writer**

Create a writer with this public surface:

```ts
export interface PartialStreamWriter {
  persist(delta: StreamDelta): void;
  finish(): void;
}

export function createPartialStreamWriter(sessionId: string): PartialStreamWriter;
export function foldPartialText(curText: string, delta: StreamDelta): string;
export function normalizeBlockDeltaForTurn(
  delta: StreamDelta,
  turnStartedAt: number,
): { ok: true; delta: StreamDelta } | { ok: false; error: string };
```

The writer must preserve the existing behavior: debounced growing text rows, immediate snapshot replacement, one row per tool call, tool-result correlation by `toolId` then most-recent same-name fallback, activity receipt persistence, and structured block-envelope persistence.

- [ ] **Step 4: Reuse the writer in web and workflow dispatch**

In `runWebSession`, replace the inline partial writer with `createPartialStreamWriter(currentSession.id)` and preserve the existing normalization, WebSocket emission, settlement, and final-row ordering.

In `SessionManager.runSession`, normalize each engine delta, update context/last-activity receipts, persist it with the shared writer, settle completed streamed evidence with `completedStreamedBlockIds`, and insert the canonical final row with `insertMessageAfter`.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
pnpm --filter jinn-cli test -- src/sessions/__tests__/workflow-attempt-turns.test.ts src/gateway/__tests__/block-finalize.test.ts src/gateway/__tests__/streamed-turn-settlement.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 6: Commit Bug A**

```bash
git add docs/superpowers/plans/2026-07-23-workflow-attempt-interaction-fixes.md \
  packages/jinn/src/sessions/partial-stream.ts \
  packages/jinn/src/gateway/api.ts \
  packages/jinn/src/sessions/manager.ts \
  packages/jinn/src/sessions/__tests__/workflow-attempt-turns.test.ts
git commit -m "fix(workflows): persist live attempt activity"
```

---

### Task 2: Preserve Attempts Across User-Message Interruptions

**Files:**
- Create: `packages/jinn/src/sessions/workflow-interruptions.ts`
- Modify: `packages/jinn/src/shared/types.ts`
- Modify: `packages/jinn/src/sessions/manager.ts`
- Modify: `packages/jinn/src/workflows/session-executor.ts`
- Modify: `packages/jinn/src/workflows/runner.ts`
- Modify: `packages/jinn/src/gateway/api.ts`
- Test: `packages/jinn/src/workflows/__tests__/reminder-ladder.test.ts`
- Test: `packages/jinn/src/workflows/__tests__/workflow-vertical.test.ts`

**Interfaces:**
- Consumes: the durable session attempt receipt (`attemptTurn`, `attemptTerminalVersion`, `attemptOutcome`) and the existing run `cancelRequestedAt` marker.
- Produces: `WorkflowAttemptInterruptionCause`, `USER_MESSAGE_INTERRUPTION_REASON`, and `SessionManager.emitWorkflowAttemptTurnCompletion(sessionId)`.

- [ ] **Step 1: Write the failing interruption regressions**

Add focused tests for all required cases:

```ts
// B1: user message interruption is a turn end.
expect(detail).toMatchObject({
  status: "running",
  attempts: [{
    status: "running",
    remindersSent: 0,
    lastProcessedTurn: 1,
    nextReminderAt: expect.any(String),
  }],
});

// B2: later workflow submission still wins.
expect(completed).toMatchObject({
  status: "completed",
  attempts: [{ status: "completed", output: { fields: { result: "published" } } }],
});

// B3/B4: run cancellation and stopWorkflowAttempt remain cancellation paths.
expect(cancelled.attempts[0]).toMatchObject({ status: "cancelled" });

// B5: user turns advance only the receipt fence, not reminder rungs.
expect(afterTurns.attempts[0]).toMatchObject({
  status: "running",
  remindersSent: 0,
  lastProcessedTurn: 3,
});
```

Exercise B1, B2, and B5 through the actual `/api/sessions/:id/message` route and deferred engine; do not call `runner.complete()` directly for those integration cases.

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm --filter jinn-cli test -- src/workflows/__tests__/reminder-ladder.test.ts src/workflows/__tests__/workflow-vertical.test.ts
```

Expected: user-message interruption settles the attempt/run instead of scheduling the ladder, and API follow-up turns do not advance `lastProcessedTurn`.

- [ ] **Step 3: Add explicit interruption classification**

Extend the completion receipt:

```ts
export type WorkflowAttemptInterruptionCause = "user-message" | "attempt-stop";

export interface WorkflowAttemptCompletion {
  sessionId: string;
  owner: { workflowId: string; runId: string; nodeId: string; attempt: number };
  turn: number;
  terminalVersion: number;
  outcome: "succeeded" | "failed" | "interrupted";
  interruptionCause?: WorkflowAttemptInterruptionCause;
  finalText?: string;
  error?: string;
  completedAt: string;
}
```

Use a single exported `USER_MESSAGE_INTERRUPTION_REASON` constant at the API kill site and infer the cause from durable `lastError` during completion recovery. `stopWorkflowAttempt` must emit `attempt-stop`.

- [ ] **Step 4: Route user interruption through the normal turn-end ladder**

In `WorkflowRunner.complete`, compute:

```ts
const userMessageTurnEnd =
  event.outcome === "interrupted"
  && event.interruptionCause === "user-message"
  && !run.cancelRequestedAt;
const cleanTurnEnd = event.outcome === "succeeded" || userMessageTurnEnd;
```

Use `cleanTurnEnd` for reminder scheduling and exhaustion. Keep failed engine/process outcomes on `settleFailure`, keep `run.cancelRequestedAt` on the workflow-cancelled path, and keep unknown/explicit-stop interruptions on the cancelled attempt path.

- [ ] **Step 5: Publish API follow-up receipts and preserve workflow MCP scope**

Make `SessionManager.emitWorkflowAttemptTurnCompletion(sessionId)` public and idempotent by `(sessionId, turn)`. Call it after each `runWebSession` completion and dispatch error. Pass:

```ts
workflowAttempt: currentSession.workflowProvenance?.kind === "phase"
```

to `resolveEngineRunMcp` so user follow-up turns retain `workflow_submit_output` and `workflow_extend_deadline`.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
pnpm --filter jinn-cli test -- src/workflows/__tests__/reminder-ladder.test.ts src/workflows/__tests__/workflow-vertical.test.ts src/sessions/__tests__/workflow-attempt-turns.test.ts
```

Expected: all selected tests PASS, including B1-B5.

- [ ] **Step 7: Commit Bug B**

```bash
git add packages/jinn/src/shared/types.ts \
  packages/jinn/src/sessions/workflow-interruptions.ts \
  packages/jinn/src/sessions/manager.ts \
  packages/jinn/src/workflows/session-executor.ts \
  packages/jinn/src/workflows/runner.ts \
  packages/jinn/src/gateway/api.ts \
  packages/jinn/src/workflows/__tests__/reminder-ladder.test.ts \
  packages/jinn/src/workflows/__tests__/workflow-vertical.test.ts
git commit -m "fix(workflows): keep attempts alive across user turns"
```

---

### Task 3: Full Verification and Privacy Gate

**Files:**
- No production changes expected.
- Create ignored or temporary log files outside the repository for verbatim command tails.

- [ ] **Step 1: Run static and build checks**

```bash
pnpm typecheck
pnpm lint
pnpm build
```

- [ ] **Step 2: Run the complete backend suite**

```bash
pnpm --filter jinn-cli test
```

- [ ] **Step 3: Run the complete web suite**

```bash
pnpm --filter @jinn/web test
```

Use the actual package name reported by `packages/web/package.json` if it differs.

- [ ] **Step 4: Inspect committed scope and leak-grep**

```bash
git status --short
git log --oneline main..HEAD
git diff --stat main...HEAD
git diff main...HEAD --check
pnpm --filter jinn-cli exec vitest run src/shared/__tests__/privacy-guard.test.ts
```

Expected: no committed diff contains any personal identifier or path.

- [ ] **Step 5: Report**

Provide both commit hashes, changed-file summary, focused RED/GREEN evidence, full backend and web suite counts, and verbatim output tails. End with `DONE` or `BLOCKED: <reason>`.
