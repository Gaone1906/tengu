# Notification Lifecycle Idempotency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent passive skip-level visibility and callback replay from reviving terminal conversations or surfacing duplicate/blank parent notifications.

**Architecture:** Keep the existing callback outbox and message-route transaction as the single durable delivery boundary. Narrow manager-session selection to conversations that are currently running or waiting, route manager visibility through a stable outbox identity, and suppress assistant completions whose content contains only whitespace or zero-width formatting characters.

**Tech Stack:** TypeScript, SQLite via better-sqlite3, Vitest, gateway REST/session queue, WebSocket events.

## Global Constraints

- Do not change production code before reproducing the missing invariants with failing tests.
- Do not touch the installed gateway database, the QA Todo/session, or the operational `parent_session_id = NULL` mitigation.
- Avoid broad refactors; preserve distinct rate-limited, rate-limit-resumed, and parent-completion callback kinds.
- Commit without `Co-Authored-By` trailers and leak-grep the staged diff before commit.
- Do not restart the gateway without explicit COO/operator approval.

---

### Task 1: Terminal Manager Session Selection

**Files:**
- Modify: `packages/jinn/src/gateway/__tests__/manager-visibility.test.ts`
- Modify: `packages/jinn/src/gateway/manager-visibility.ts`

**Interfaces:**
- Consumes: `Session.status`, `surfaceManagerVisibility(input, deps)`
- Produces: `isEligibleManagerVisibilitySession(session: Session): boolean`

- [ ] **Step 1: Write the failing lifecycle tests**

Add table-driven cases where `findManagerSession` returns `idle`/`succeeded`, `interrupted`, and `error` manager sessions. Assert `notifyManager` is not called and `appendFallback` records the Todo/manager/child reference. Add `running` and `waiting` controls that still notify once.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter jinn-cli test -- packages/jinn/src/gateway/__tests__/manager-visibility.test.ts`

Expected: terminal-session cases fail because `surfaceManagerVisibility` currently accepts any injected session and the default finder only excludes `error`.

- [ ] **Step 3: Implement the minimum eligibility predicate**

Add a pure predicate returning `session.status === "running" || session.status === "waiting"`. Use it in the default registry search and defensively before `notifyManager`; otherwise execute the existing fallback path.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same command and expect all manager-visibility tests to pass.

### Task 2: Durable Manager-Visibility Identity

**Files:**
- Modify: `packages/jinn/src/sessions/__tests__/callbacks.test.ts`
- Modify: `packages/jinn/src/gateway/__tests__/callback-reliability.test.ts`
- Modify: `packages/jinn/src/sessions/callbacks.ts`

**Interfaces:**
- Consumes: `claimCallbackDelivery(input)`, `_deliverClaimedCallback(deliveryId)`
- Produces: one stable `manager-visibility` receipt keyed by manager session, child session, Todo-derived attempt token, outcome/version, and callback kind

- [ ] **Step 1: Write the failing sender and durable-boundary tests**

Call `notifyManagerVisibility` repeatedly with identical details. Assert every claim has the same canonical identity, only one `callbackDeliveryId` reaches the route, the accepted replay returns `duplicate`, and SQLite contains one notification row, one internal queue row, one live WebSocket arrival, and one parent engine turn.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm --filter jinn-cli test -- packages/jinn/src/sessions/__tests__/callbacks.test.ts packages/jinn/src/gateway/__tests__/callback-reliability.test.ts`

Expected: manager visibility performs repeated raw posts without `callbackDeliveryId`, creating no stable outbox receipt.

- [ ] **Step 3: Route manager visibility through the existing outbox**

Claim with `parentSessionId = managerSessionId`, `childSessionId = details.childSessionId`, `attemptToken = "manager-visibility:" + details.workItemId`, `terminalOutcome = "manager-visibility"`, `terminalVersion = 1`, and `callbackKind = "manager-visibility"`. Return immediately for an accepted receipt; otherwise deliver the claimed row.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same callback test command and expect one durable acceptance and one delivery.

### Task 3: Blank Completion and Rate-Limit Replay Guards

**Files:**
- Modify: `packages/jinn/src/sessions/__tests__/callbacks.test.ts`
- Modify: `packages/jinn/src/gateway/__tests__/callback-reliability.test.ts`
- Modify: `packages/jinn/src/sessions/callbacks.ts`

**Interfaces:**
- Consumes: `notifyParentSession(child, result)`, rate-limit callback kinds
- Produces: `hasMeaningfulCallbackResult(result): boolean` or equivalent source guard

- [ ] **Step 1: Write blank/zero-width and composite rate-limit tests**

For `""`, ordinary whitespace, `U+200B`, `U+200C`, `U+200D`, `U+2060`, and `U+FEFF`, assert a successful child result creates no callback claim/post. In the route-backed suite, replay waiting/resumed/final callbacks for one attempt and assert exactly one `parent-completion` durable row, child-reply message, WebSocket arrival, and parent engine execution.

- [ ] **Step 2: Run focused tests and verify RED where behavior is missing**

Run the callback commands from Task 2. Expected: zero-width results currently generate `(no output)` child replies; the existing durable rate-limit path should remain green as a prerequisite guard.

- [ ] **Step 3: Add the narrow source guard**

Before attached-talk or parent delivery, treat a success result as empty after removing `[\u200B-\u200D\u2060\uFEFF]` and applying `trim()`. Preserve all error callbacks and all meaningful text.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the callback commands again and expect all lifecycle/idempotency cases to pass.

### Task 4: Verification and Commit

**Files:**
- Inspect all modified files and this plan.

**Interfaces:**
- Consumes: repository scripts and staged diff
- Produces: one reviewed commit on `fix/wi-883144-notification-lifecycle`

- [ ] **Step 1: Run targeted and relevant gateway/session suites**

Run manager visibility, delegations route, callback reliability, callback delivery, callback unit, rate-limit handler, queue, and session communication tests.

- [ ] **Step 2: Run repository verification**

Run `pnpm typecheck`, the relevant `packages/jinn` test suite, and lint. Investigate any failure before claiming completion.

- [ ] **Step 3: Review diff and privacy boundary**

Inspect `git diff --check`, `git diff --stat`, and the complete diff. Stage only scoped files, then run the mandated staged leak grep for personal names/projects/emails/paths.

- [ ] **Step 4: Commit**

Commit with a focused `fix(gateway): make notification delivery lifecycle-safe` message and no co-author trailers.

## Self-Review

- Spec coverage: tasks cover manager selection/fallback, durable manager notification cardinality, rate-limit replay, blank replies, stable accepted replay, verification, commit, and restart reporting.
- Placeholder scan: no deferred implementation placeholders are present.
- Type consistency: all proposed identities use the existing `CallbackDeliveryIdentity` fields and the existing callback outbox acceptance path.
