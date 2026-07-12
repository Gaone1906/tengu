# Todo Residual Re-QA Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the seven residual Todo frontend failures from the independent review of `9a25339` without changing gateway behavior or inventing optimistic concurrency.

**Architecture:** Make local intent explicit with a dirty-field mask, per-field baseline, and uncertain-transport field set. Recovery, conflict resolution, pagination restoration, and orphan cleanup operate on the existing per-tab safe surrogate; the API client exposes typed HTTP status/code errors while Todo surfaces render only closed, fixed copy. The visible design adds two quiet inline states inside the existing detail sheet/dialog grammar.

**Tech Stack:** React 19, TypeScript, TanStack Query, React Router history state, Vitest/Testing Library, Playwright, Tailwind with Ledger tokens.

## Global Constraints

- Frontend only: do not edit gateway files or fake conditional-write/CAS support.
- Preserve user-authored dirty draft text in same-origin `sessionStorage`; never persist an internally generated opaque Todo ID.
- Use exact 390×844 and 1440×900 at dark/light and normal/reduced motion.
- Start only a fresh sanitized `JINN_HOME` pinned to ports 7970+ before any lifecycle command; never access or mutate production `:7777`.
- Preserve unrelated shared changes and scratch files.
- Commit scoped remediation, report RED/GREEN evidence, and request independent re-QA without marking the work complete.

---

### Task 1: Ambiguous transport and explicit conflict resolution

**Files:**
- Modify: `packages/web/src/routes/todos/use-todo-draft.ts`
- Modify: `packages/web/src/routes/todos/todo-private-state.ts`
- Modify: `packages/web/src/routes/todos/detail-sheet.tsx`
- Test: `packages/web/src/routes/todos/__tests__/todo-draft.test.tsx`
- Test: `packages/web/src/routes/todos/__tests__/detail-sheet.test.tsx`

**Interfaces:**
- Consumes: actual `WorkItemFullWire.updatedAt` as recovery metadata and `api.getWorkItem(id)` for preflight/reconciliation.
- Produces: dirty-field/baseline/uncertain-field journal state; `retry()` reconciliation; `reloadRemote()` and explicit `overwrite()` conflict actions.

- [ ] Add an adversarial test where PATCH commits but its response rejects after the operator reverts the field; verify Retry refetches, compensates, confirms, and only then acknowledges.
- [ ] Run the focused draft test and verify the old implementation clears its journal and performs no compensating write.
- [ ] Replace derived-only dirtiness with an explicit dirty-field mask, per-field baseline, and uncertain-field set that survive ambiguous failures and coalesce later edits.
- [ ] Re-run the focused draft test and verify ambiguous retries refetch before any write and refetch after compensation.
- [ ] Add a same-field recovered conflict component test that verifies Close/automatic Save are blocked and the two explicit actions are keyboard accessible.
- [ ] Run the component test and verify the conflict is currently invisible.
- [ ] Add the calm Ledger-token conflict surface. `Reload remote` discards the local overlapping fields after a fresh GET; `Overwrite` performs a fresh GET, then sends the current dirty patch explicitly. Do not send an `expectedVersion` field until it exists in the backend contract.
- [ ] Re-run draft/detail tests and verify unrelated remote fields still merge.

### Task 2: Typed errors and closed safe copy

**Files:**
- Modify: `packages/web/src/lib/api.ts`
- Modify: `packages/web/src/lib/todos.ts`
- Test: `packages/web/src/lib/__tests__/todos.test.ts`
- Test: `packages/web/src/routes/todos/__tests__/detail-sheet.test.tsx`

**Interfaces:**
- Consumes: HTTP status and optional response `code` from the existing API response.
- Produces: exported `ApiError`; `operatorSafeTodoError(error, fallback)` that returns only fixed allowlisted copy.

- [ ] Add failing tests for SQL, filesystem, token, stack, connector, HTML, and unknown 4xx/5xx payloads in visible and accessible output.
- [ ] Verify RED: raw diagnostic fragments are rendered.
- [ ] Make API helpers throw typed status/code errors while retaining raw diagnostics only on the error object.
- [ ] Map known Todo codes/status signatures to fixed copy; unknown errors always return the caller-supplied generic fallback.
- [ ] Verify GREEN for escalated, conflict, missing, and arbitrary diagnostic cases.

### Task 3: Paginated anchor restoration and deleted Todo recovery

**Files:**
- Modify: `packages/web/src/routes/todos/use-todos.ts`
- Modify: `packages/web/src/routes/todos/page.tsx`
- Modify: `packages/web/src/routes/todos/row.tsx`
- Modify: `packages/web/src/routes/todos/group.tsx`
- Test: `packages/web/src/routes/todos/__tests__/page-history.test.tsx`
- Test: `packages/web/src/routes/todos/__tests__/use-todos-pagination.test.tsx`

**Interfaces:**
- Consumes: existing infinite-query page offsets and safe `todoPrivateRef(id)`.
- Produces: history state `{ todoAnchorRef, todoAnchorOffset, todoPageDepth }`; `restorePageDepth(depth)`; explicit orphan dialog whose discard clears journal and replaces the current history entry.

- [ ] Add a failing second-page reload test that records an anchor-relative offset and loaded page depth, reloads, and expects enough pages to be fetched before exact nested scroll restoration.
- [ ] Verify RED: only the first page is loaded and numeric scroll clamps.
- [ ] Expose loaded page depth and a bounded sequential page-restoration function from `useLedgerItems`.
- [ ] Persist a safe row anchor, relative offset, and status page-depth map on open; restore after the anchor mounts; cancel pending restoration on wheel/touch/pointer/scroll keys.
- [ ] Verify GREEN with no extra history entry.
- [ ] Add a failing remote-deletion test where all candidate queries settle without resolving `todoRef` while a journal remains.
- [ ] Verify RED: detail disappears and private recovery remains inaccessible.
- [ ] Render `Todo no longer exists` with a single explicit `Discard recovered draft` action that clears the safe-ref journal and replaces the current history state.
- [ ] Verify GREEN for storage, history, focus, and Back behavior.

### Task 4: Honest storage boundary and exact cap

**Files:**
- Modify: `packages/web/src/routes/todos/todo-private-state.ts`
- Test: `packages/web/src/routes/todos/__tests__/todo-draft.test.tsx`

**Interfaces:**
- Consumes: dirty patch, per-dirty-field baseline, version metadata, and uncertain-field names.
- Produces: directly inspectable JSON storage containing recoverable user-authored draft data but no internally generated Todo ID; deterministic maximum of 50 envelopes.

- [ ] Replace the misleading literal-regex privacy test with a failing boundary test: arbitrary user text including `wi_*` remains recoverable, while the generated item ID is absent from every key/value/history reference.
- [ ] Verify RED against the Base64 payload and dishonest assertion.
- [ ] Remove Base64 encoding and its confidentiality implication; validate the minimal JSON payload directly.
- [ ] Add a same-timestamp 51-insert cap test and verify RED at 51 entries.
- [ ] Insert/update first, deterministically order by expiry, sequence, and safe ref, slice to exactly 50, then perform one storage write.
- [ ] Verify GREEN for TTL, malformed/orphan cleanup, update ordering, and immediate raw count.

### Task 5: Full verification and handoff

**Files:**
- Modify only scoped frontend/tests/plan files found above.
- Artifacts: `/tmp/jinn-todo-remediation-20260712-02/sandbox-artifacts/`

**Interfaces:**
- Consumes: all green focused behavior and existing prior contracts.
- Produces: mutation logs, browser screenshots/results, scoped commit, and independent re-QA request.

- [ ] Re-run all seven residual mutations plus prior draft/history/privacy/lifecycle/row mutations and confirm every revert fails meaningfully.
- [ ] Run focused Todo tests, full web tests, typecheck, build, and `git diff --check`.
- [ ] Create a fresh sanitized home with configuration pinned to `127.0.0.1:7970+` before starting the fixture gateway and preview.
- [ ] Capture conflict, orphan, pagination, ambiguous retry, error, and storage states across the required theme/motion/breakpoint matrix.
- [ ] Inspect rendered DOM, accessibility tree, history, and storage for internally generated opaque IDs and raw diagnostic fragments.
- [ ] Stage only scoped files, run the required personal-data leak grep, commit without a co-author trailer, stop the sandbox, and request independent re-QA.
