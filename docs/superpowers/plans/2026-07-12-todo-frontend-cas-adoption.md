# Todo Frontend CAS Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt the canonical Todo whole-row CAS/idempotency wire across detail editing, inline rename, and manual rank without weakening draft recovery, privacy, or mobile behavior.

**Architecture:** Every logical Todo edit is an immutable request containing the editable patch, a positive expected version, and one cryptographically random idempotency key. The request is persisted before dispatch and replayed byte-for-byte after ambiguous transport; confirmed results advance the authoritative version, while typed conflicts enter one shared Reload/Rebase/Overwrite recovery surface. Detail edits use the per-item detail version; row edits preflight a detail read and compare it with the maximum version across duplicate query caches.

**Tech Stack:** React 19, TypeScript, TanStack Query, Vitest, Testing Library, Playwright, Tailwind/Ledger tokens, canonical Jinn Todo REST wire.

## Global Constraints

- Frontend base is `a3c0a8cc26dccadce237bfb4032544fcb8393495`; frontend commits must remain separately cherry-pickable.
- Integrated verification uses backend `3633f634… → 62f877f… → 9fdf73e… → 55dfcd74… → ee6d307…` in `/private/tmp/jinn-todo-cas-frontend-integrated-a3c0`.
- The supplied `55dfcd7c…` object does not exist; `55dfcd74ed371272a11fd9a9bd0cab79ffc652a1` is the actual parent of `ee6d307…`.
- Do not edit gateway files in the frontend commit. No force/missing-precondition path.
- `WorkItem.version` is a positive monotonic whole-row revision. `updatedAt` is display-only.
- One logical save gets one cryptographically random key before dispatch. Exact retries reuse patch, expectedVersion, and key; changed content/version always gets a new key.
- Preserve structured `TodoApiError { status, code, currentVersion }`; never render backend diagnostics.
- Store only minimal dirty fields and immutable request metadata behind the existing salted private Todo surrogate, TTL, and 50-entry cap.
- Verify fresh sanitized ports `8044+`; never access, mutate, or restart `:7777`.
- Preserve the six-remediation contracts from `a3c0a8c`, unrelated shared changes, and operator scratch files. No `Co-Authored-By`.

---

### Task 1: Canonical wire and authoritative cache version

**Files:**
- Modify: `packages/web/src/lib/api.ts`
- Modify: `packages/web/src/lib/todos.ts`
- Create: `packages/web/src/routes/todos/todo-edit-request.ts`
- Test: `packages/web/src/lib/__tests__/api-errors.test.ts`
- Create: `packages/web/src/routes/todos/__tests__/todo-edit-request.test.ts`

**Interfaces:**
- Produces `WorkItemEditPatch`, `WorkItemEditRequest`, `WorkItemEditResultWire`, `TodoApiError`, `newTodoEditRequest(patch, expectedVersion)`, `maximumTodoVersion(queryClient, id)`, and cache merge/invalidation helpers.
- Consumes canonical body `{...patch, expectedVersion, idempotencyKey}` and response `{workItem,replayed}`.

- [ ] **Step 1: Write failing API and cache tests**

```ts
it("sends the canonical conditional edit body and preserves replay metadata", async () => {
  const request = { patch: { title: "Desired" }, expectedVersion: 7, idempotencyKey: "crypto-key" }
  await api.updateWorkItem("private-id", request)
  expect(JSON.parse(String(fetchInit.body))).toEqual({ title: "Desired", expectedVersion: 7, idempotencyKey: "crypto-key" })
})

it("chooses the maximum Todo version across adversarial duplicate caches", () => {
  seedListVersion(9); seedDetailVersion(4); seedNeedsVersion(12)
  expect(maximumTodoVersion(queryClient, "private-id")).toBe(12)
})
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @jinn/web exec vitest run src/lib/__tests__/api-errors.test.ts src/routes/todos/__tests__/todo-edit-request.test.ts`

Expected: FAIL because version/replayed/request helpers do not exist and `updateWorkItem` still sends a blind patch.

- [ ] **Step 3: Implement the typed boundary and immutable request helper**

```ts
export interface WorkItemEditRequest {
  patch: WorkItemEditPatch
  expectedVersion: number
  idempotencyKey: string
}

export function newTodoEditRequest(patch: WorkItemEditPatch, expectedVersion: number): WorkItemEditRequest {
  return { patch, expectedVersion, idempotencyKey: crypto.randomUUID() }
}
```

`TodoApiError` must extend `ApiError` without flattening `status`, `code`, or `currentVersion`. `updateWorkItem` must rethrow this structured subtype and type the `replayed` response.

- [ ] **Step 4: Implement maximum-version cache reads and version-monotonic cache merges**

Scan objects under all `work-items` and `work-item` queries; accept only objects whose `id` matches and whose `version` is a positive safe integer. Return `Math.max(...)`; never use concatenation order. Merge a response only when its version is at least the cached row version, then invalidate all list/search/detail caches for the item.

- [ ] **Step 5: Re-run focused tests and targeted mutations**

Mutate `Math.max` to last-observed and remove `replayed`; each test must fail before restoration.

---

### Task 2: Journal an immutable logical request

**Files:**
- Modify: `packages/web/src/routes/todos/todo-private-state.ts`
- Modify: `packages/web/src/routes/todos/__tests__/todo-private-state.test.ts`

**Interfaces:**
- Produces `TodoJournalRequest { revision, patch, expectedVersion, idempotencyKey, state }` and `TodoJournalPayload.request`.
- Preserves existing minimal dirty `patch`, field baseline, TTL, salted surrogate, orphan cleanup, and exact cap.

- [ ] **Step 1: Write failing journal tests**

```ts
it("persists one immutable request fingerprint before dispatch", () => {
  persistTodoJournal(id, { revision: 2, patch, baseline, baselineVersion: 7, request })
  expect(loadTodoJournal(id)?.request).toEqual(request)
})
```

Cover dispatched/uncertain/failed/conflict states, reload, malformed keys/versions, legacy v2 payload recovery without treating `updatedAt` as a CAS version, TTL, privacy, and cap.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @jinn/web exec vitest run src/routes/todos/__tests__/todo-private-state.test.ts`

Expected: FAIL because numeric baseline versions and exact request metadata are not accepted or persisted.

- [ ] **Step 3: Extend validation and persistence minimally**

```ts
export interface TodoJournalRequest extends WorkItemEditRequest {
  revision: number
  state: "dispatched" | "uncertain" | "failed" | "conflict"
}
```

Reject non-positive versions, empty/non-random-looking request keys, patch mismatches, and unsupported fields. Preserve authored patch values as intentional same-origin draft data; do not claim encryption.

- [ ] **Step 4: Re-run tests and mutate request/key persistence**

Removing `request.idempotencyKey`, changing the stored patch, or accepting a string CAS version must fail.

---

### Task 3: Exact-replay detail draft state machine

**Files:**
- Modify: `packages/web/src/routes/todos/use-todo-draft.ts`
- Modify: `packages/web/src/routes/todos/__tests__/todo-draft.test.tsx`

**Interfaces:**
- Changes save callback to `(request: WorkItemEditRequest) => Promise<{ remote: TodoRemoteSnapshot; replayed: boolean }>`.
- `TodoRemoteSnapshot.version` becomes a positive number.
- Produces `reloadRemote`, `rebaseRemote`, `overwriteRemote`, `conflictFields`, and exact retry/recovery behavior.

- [ ] **Step 1: Replace obsolete ambiguity tests with failing exact-replay tests**

```ts
it("replays the same immutable request after two lost responses and remount", async () => {
  // Assert all three calls have the same patch, expectedVersion, and key.
  // Assert no GET or compensating request precedes the replay.
})
```

Also cover edit-during-save creating a new key after acknowledgement, response replay returning a later row that does not match desired fields, typed version/idempotency conflict, definitive failure retry, revert cleanup, item switch, unmount, and close gating.

- [ ] **Step 2: Run hook tests and verify RED for the canonical reasons**

Expected failures: save receives only a patch, journal lacks the exact request, retry performs GET-first compensation, and string `updatedAt` is used as version authority.

- [ ] **Step 3: Make `PendingSave` an immutable request envelope**

```ts
interface PendingSave extends WorkItemEditRequest { revision: number }
```

Create it once from the current aggregate intent and baseline version. Persist it before transport. Local edits during transport update aggregate intent only; after confirmed acknowledgement, settle sent fields, adopt the returned numeric version, and create a new request/key for remaining intent.

- [ ] **Step 4: Implement exact ambiguous retry and result confirmation**

Retry/remount must dispatch the stored envelope first. A 200 replay confirms execution but not necessarily final desired state: compare returned editable fields, retain any still-different desired fields, and queue a new conditional request only after the replay outcome is known.

- [ ] **Step 5: Implement explicit conflict reconciliation**

`rebaseRemote(fresh)` adopts unrelated remote fields, compares each dirty field against its stored baseline, and writes with a new key/current version only when no same-field conflict remains. `overwriteRemote(fresh)` retains desired dirty fields, uses a new key and the fresh version, and leaves the conflict surface mounted until acknowledgement. `reloadRemote` is the only remote-discard action.

- [ ] **Step 6: Run tests and mutations**

Mutate key reuse, key rotation, expectedVersion advancement, replay ordering, same-field detection, and conflict persistence; each mutation must fail.

---

### Task 4: Shared calm reconciliation surface and detail integration

**Files:**
- Create: `packages/web/src/routes/todos/conflict-actions.tsx`
- Modify: `packages/web/src/routes/todos/detail-sheet.tsx`
- Modify: `packages/web/src/routes/todos/__tests__/detail-sheet.test.tsx`
- Create outside repo: `/tmp/jinn-todo-cas-conflict-mock.html`

**Interfaces:**
- Produces `TodoConflictActions` with Reload remote, Rebase edits, and Overwrite remote.
- Detail uses the exact detail `workItem.version` and never `updatedAt` for edits.

- [ ] **Step 1: Mock and screenshot conflict states before implementation**

Use real Ledger tokens. Capture `390×844` and `1440×900`, dark/light, for an unrelated conflict and a same-field conflict after Rebase. Verify 40px+ targets, wrapping, focus order, and no new borders.

- [ ] **Step 2: Write failing detail integration tests**

Assert canonical request bodies, lost-response exact replay, 409 action routing, unrelated Rebase merge, same-field Rebase block, Overwrite GET→new key/current expectedVersion→PATCH, second 409 persistence, 400/409/428 privacy, and close blocking.

- [ ] **Step 3: Run tests and verify RED**

Expected: missing Rebase control; blind patch bodies; overwrite clears conflict before acknowledgement; errors lack canonical typed distinctions.

- [ ] **Step 4: Implement the shared token-only surface and detail wiring**

Keep the existing fill/shadow/whitespace grammar. Copy must be concise: “Reload remote” discards local intent, “Rebase edits” preserves unrelated remote work, and “Overwrite remote” explicitly replaces only the locally edited fields against the latest row.

- [ ] **Step 5: Re-run tests and visually compare real implementation to the mock**

Mutate each action to blind Retry or missing preflight and require a failure.

---

### Task 5: Conditional inline rename and rank controller

**Files:**
- Create: `packages/web/src/routes/todos/use-todo-quick-edit.ts`
- Create: `packages/web/src/routes/todos/__tests__/todo-quick-edit.test.tsx`
- Modify: `packages/web/src/routes/todos/use-todos.ts`
- Modify: `packages/web/src/routes/todos/page.tsx`
- Modify: `packages/web/src/routes/todos/active-view.tsx`
- Modify: `packages/web/src/routes/todos/row.tsx`
- Modify: `packages/web/src/routes/todos/__tests__/page-history.test.tsx`
- Modify: `packages/web/src/routes/todos/__tests__/row.test.tsx`

**Interfaces:**
- Produces one per-item serialized quick-edit controller that preflights detail, selects the maximum authoritative version, persists the logical request, exact-replays ambiguity, and exposes the shared conflict actions.
- Adds a rank override reset revision so Reload/error reconciliation cannot leave a false saved order.

- [ ] **Step 1: Write failing inline/rank tests**

Cover canonical rename body, rapid rank serialization/coalescing, lost response + reload exact replay, typed conflict actions, stale duplicate caches, Reload clearing local rank override, unrelated Rebase, same-field block, explicit Overwrite, and safe 400/409/428 output.

- [ ] **Step 2: Run tests and verify RED**

Expected: page sends blind concurrent patches, converts errors to strings, has no recovery state, and rank override masks rejection.

- [ ] **Step 3: Implement the quick-edit controller**

Before the first PATCH, fetch exact detail, take the maximum positive version across fresh detail and duplicate caches, mint/persist the request, then dispatch. Disable React Query blind retry. A second edit for the same item waits for acknowledgement and gets a new key/current returned version.

- [ ] **Step 4: Integrate inline rename and rank UI**

Render `TodoConflictActions` in the existing quiet edit-error position. On typed conflict retain the desired patch. Reload discards and resets row/rank optimistic state; Rebase and Overwrite follow the same canonical rules as detail.

- [ ] **Step 5: Re-run tests and mutation gates**

Mutate max→last version, remove preflight, reuse a key after content/version change, stringify `TodoApiError`, blind-retry conflict, and keep rank override after Reload; every mutation must fail.

---

### Task 6: Integrated backend verification and handoff

**Files:**
- Update: `docs/superpowers/plans/2026-07-12-todo-frontend-cas-adoption.md`
- Artifacts only: fresh sanitized `JINN_HOME` and `/tmp/.../sandbox-artifacts/final/`

**Interfaces:**
- Consumes frontend-only commit(s) and the isolated backend merge worktree.
- Produces separate frontend commit hashes, integrated test/browser evidence, and an explicit pending-backend-review caveat.

- [ ] **Step 1: Run focused and full frontend gates on the frontend branch**

Run focused Vitest, full web Vitest, typecheck, production build, `git diff --check`, privacy/storage scans, and every targeted mutation.

- [ ] **Step 2: Commit only frontend files**

Stage exact `packages/web/**` files and this plan. Leak-grep staged content; no gateway files, personal data, or trailers.

- [ ] **Step 3: Cherry-pick the frontend commit into the isolated integration worktree**

Verify the integration branch contains exact backend history plus the separately cherry-pickable frontend commit. Build backend/web and run relevant gateway route/store tests without changing the frontend branch.

- [ ] **Step 4: Run a fresh browser matrix on pinned ports `8044+`**

Prove detail/rename/rank canonical bodies, two lost responses + restart exact replay, same-field and unrelated conflicts, Reload/Rebase/Overwrite, stale duplicate caches, 400/409/428 privacy, Back/Forward/reload, offline recovery, mobile sheet, dark/light, normal/reduced motion, and prior six-remediation contracts.

- [ ] **Step 5: Stop only sandbox processes and request integrated independent QA**

Report exact frontend and integration hashes plus artifacts. State that end-to-end PASS remains pending both backend independent review and integrated independent QA.
