# Todo Frontend Six-Residual Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and superpowers:systematic-debugging task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Remove the six independent frontend re-QA residuals without adopting or modifying the backend CAS series.

**Architecture:** Keep draft transport truth inside `useTodoDraft`, including the original structured API error object, and derive visible copy only at the sheet boundary. Restore navigation state from safe history metadata with deterministic focus and scroll fallbacks; keep the existing Ledger surfaces unchanged.

**Tech Stack:** React 19, TypeScript, TanStack Query, React Router, Vitest, Testing Library, Tailwind/Ledger tokens, Playwright.

## Global Constraints

- Do not edit gateway files or integrate backend CAS commits `3633f63`, `62f877f`, or `9fdf73e`.
- Use strict RED→GREEN and run a direct mutation for every finding.
- Preserve all prior Todo recovery, privacy, mobile-sheet, lifecycle, and filter contracts.
- Verify only with a fresh sanitized `JINN_HOME` and ports `8040+`; never access port `7777`.
- Preserve unrelated scratch files and commit only scoped frontend changes.

---

### Task 1: Definitive failed-save revert

**Files:**
- Modify: `packages/web/src/routes/todos/use-todo-draft.ts`
- Test: `packages/web/src/routes/todos/__tests__/todo-draft.test.tsx`

**Interfaces:**
- Consumes: dirty fields, uncertain fields, transport refs, and revision refs already owned by `useTodoDraft`.
- Produces: a clean acknowledged state after a definitive failure is manually reverted, while ambiguous failures remain recoverable.

- [x] Add a hook test that rejects a PATCH with a definitive typed error, reverts the field to its baseline, and asserts `status="idle"`, no error, no Retry state, no journal, and no later replay.
- [x] Run the test and confirm it fails because `failedRef` and `pendingRef` remain set.
- [x] Add one helper that clears definitive failure/pending state only when there is no active transport, dirty field, uncertain field, or conflict.
- [x] Re-run the focused hook tests and an ambiguity regression test.

### Task 2: Structured PATCH errors and conflict routing

**Files:**
- Modify: `packages/web/src/lib/api.ts`
- Modify: `packages/web/src/lib/todos.ts`
- Modify: `packages/web/src/routes/todos/use-todo-draft.ts`
- Modify: `packages/web/src/routes/todos/detail-sheet.tsx`
- Test: `packages/web/src/lib/__tests__/api-errors.test.ts`
- Test: `packages/web/src/routes/todos/__tests__/detail-sheet.test.tsx`
- Test: `packages/web/src/routes/todos/__tests__/todo-draft.test.tsx`

**Interfaces:**
- Consumes: `ApiError.status`, `ApiError.code`, optional `currentVersion`, and the existing conflict surface.
- Produces: `draftState.error: unknown | null`, exact typed-error preservation, safe closed-copy rendering, and 409/412 conflict promotion without blind Retry.

- [x] Add failing API/hook/sheet tests for structured 403, 409, 412, and arbitrary diagnostic PATCH responses, including visible and `role=alert` assertions.
- [x] Extend `ApiError` parsing to retain optional numeric `currentVersion` without exposing diagnostic text.
- [x] Preserve the original caught object in the hook and classify Todo version conflicts by typed status/code.
- [x] Render draft errors through `operatorSafeTodoError(error, "Couldn't save")`; suppress Retry and show existing conflict actions for typed conflicts.
- [x] Directly mutate draft error rendering to raw/plain output and structured error storage to strings; require the new tests to fail.

### Task 3: Missing-anchor scroll fallback

**Files:**
- Modify: `packages/web/src/routes/todos/page.tsx`
- Test: `packages/web/src/routes/todos/__tests__/page-history.test.tsx`

**Interfaces:**
- Consumes: safe anchor surrogate, numeric scroll position, restored page depth, and user-cancellation token.
- Produces: anchor-relative restoration when possible and a clamped numeric fallback when the anchor is filtered, deleted, or reordered away.

- [x] Add failing reload/Back/Forward tests where a second-page anchor disappears after restored pages settle.
- [x] Replace the missing-row early return with a clamped numeric restoration, retaining the layout-less test fallback and cancellation guard.
- [x] Mutate the fallback back to zero and require the test to fail.

### Task 4: Orphan discard focus

**Files:**
- Modify: `packages/web/src/routes/todos/page.tsx`
- Test: `packages/web/src/routes/todos/__tests__/page-history.test.tsx`

**Interfaces:**
- Consumes: original opener when still connected, ledger heading, New Todo control, and Search.
- Produces: post-dialog focus on the opener or a stable ledger target, never `BODY`.

- [x] Add failing keyboard/reload orphan tests for opener and no-opener cases.
- [x] Capture the opener during detail navigation and focus it after discard when connected; otherwise focus a programmatically focusable Todos heading.
- [x] Remove the focus call as a mutation and require the assertions to fail.

### Task 5: Bidirectional breakpoint focus transfer

**Files:**
- Modify: `packages/web/src/routes/todos/filter-bar.tsx`
- Test: `packages/web/src/routes/todos/__tests__/filter-bar.test.tsx`

**Interfaces:**
- Consumes: media-query transitions, mobile-sheet state, the current trigger ref, and active-element ownership.
- Produces: closed-sheet focus continuity across repeated `390↔844` replacement in normal and reduced-motion modes.

- [x] Extend the existing crossover test to assert the final mobile trigger and repeated oscillations.
- [x] Track crossover-owned focus and transfer it to the newly rendered trigger in both directions without stealing focus from another stable control.
- [x] Remove reverse transfer as a mutation and require the final-focus assertion to fail.

### Task 6: Full verification and handoff

**Files:**
- Update: `docs/superpowers/plans/2026-07-12-todo-frontend-six-residuals.md`

**Interfaces:**
- Consumes: all six green test cycles.
- Produces: a scoped commit and fresh independent re-QA evidence.

- [x] Run focused and full web tests, typecheck, build, `git diff --check`, privacy scans, and all targeted mutations.
- [x] Launch a brand-new sanitized 8040+ fixture gateway and Vite preview.
- [x] Screenshot exact 390×844 and 1440×900 across dark/light and normal/reduced motion; replay failed revert, typed errors, missing anchor, orphan focus, crossover focus, and prior lost-response/conflict/storage contracts.
- [x] Inspect screenshots, stop only sandbox processes, stage scoped files, leak-grep, commit without trailers, and request same-reviewer independent re-QA.
