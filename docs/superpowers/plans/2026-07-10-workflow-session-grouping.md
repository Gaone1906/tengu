# Workflow Session Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist explicit workflow phase provenance and group workflow-owned phase sessions beneath a visible workflow-run parent.

**Architecture:** Keep the workflow engine storage-agnostic by adding an optional run-session synchronization dependency. Persist provenance in additive session columns, reuse `parentSessionId` and `/children`, and attach provenance at the gateway spawn boundary.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, existing workflow reconciler and session registry.

## Global Constraints

- Work only in `/private/tmp/jinn-wfgroup` from current `main`.
- Do not touch live gateways, ports 7777/7788, or the installed workspace.
- Do not redesign the chat-list UI.
- Keep shipped content generic and add no co-author trailer.

---

### Task 1: Persist session provenance

**Files:**
- Modify: `packages/jinn/src/shared/types.ts`
- Modify: `packages/jinn/src/sessions/registry.ts`
- Test: `packages/jinn/src/sessions/__tests__/workflow-provenance.test.ts`

**Interfaces:**
- Produces: `WorkflowSessionProvenance`, `CreateSessionOpts.workflowProvenance`, and workflow filters on `SearchSessionsFilter`.

- [ ] **Step 1: Write the failing registry test**

Create a run parent and phase child with `workflowProvenance`, then assert `getSession`, `searchSessionsFiltered({ workflowRunId })`, and `listChildSessions` return the exact typed provenance and grouping.

- [ ] **Step 2: Run the test to verify RED**

Run: `pnpm --filter jinn-cli test -- src/sessions/__tests__/workflow-provenance.test.ts`

Expected: TypeScript/build failure because `workflowProvenance` and workflow filters do not exist.

- [ ] **Step 3: Add the minimal schema and registry implementation**

Add nullable workflow columns, an additive migration, an index on run id, row hydration, create bindings, and bound SQL filters. Hydrate phase fields only for `kind: "phase"`.

- [ ] **Step 4: Verify GREEN**

Run the same targeted test and expect all assertions to pass.

### Task 2: Synchronize a visible workflow-run parent

**Files:**
- Modify: `packages/jinn/src/workflows/run-reconciler.ts`
- Modify: `packages/jinn/src/gateway/api.ts`
- Test: `packages/jinn/src/gateway/__tests__/workflow-session-grouping.test.ts`

**Interfaces:**
- Consumes: `WorkflowSessionProvenance` and session registry create/update methods.
- Produces: optional `RunDriverDeps.syncRunSession(run): string | undefined` and `syncWorkflowRunSession`.

- [ ] **Step 1: Write failing manual and schedule grouping tests**

Assert deterministic parent titles/keys, trigger provenance, list visibility, parent state mirroring, and `/children` enumeration.

- [ ] **Step 2: Run the tests to verify RED**

Run: `pnpm --filter jinn-cli test -- src/gateway/__tests__/workflow-session-grouping.test.ts`

Expected: missing synchronizer/export and absent parent/provenance assertions.

- [ ] **Step 3: Implement synchronization**

Wrap run persistence with a best-effort synchronizer callback. In the gateway, create/update `workflow-run:<runId>:parent`, map run states to session states, and emit session-list invalidation events.

- [ ] **Step 4: Verify GREEN**

Run the grouping test and expect manual and schedule cases to pass.

### Task 3: Attach phase sessions to the parent

**Files:**
- Modify: `packages/jinn/src/workflows/advance.ts`
- Modify: `packages/jinn/src/workflows/run-reconciler.ts`
- Modify: `packages/jinn/src/gateway/api.ts`
- Test: `packages/jinn/src/gateway/__tests__/workflow-session-grouping.test.ts`
- Test: `packages/jinn/src/workflows/__tests__/run-reconciler.test.ts`

**Interfaces:**
- Consumes: workflow run parent key and session provenance.
- Produces: required spawn context fields `workflowName`, `triggerSource`, and `phaseIndex`.

- [ ] **Step 1: Add failing phase-context assertions**

Assert the driver supplies the canonical name, normalized trigger source, and one-based execution index; assert the gateway child uses the parent's id and exact phase provenance.

- [ ] **Step 2: Verify RED**

Run the workflow reconciler and grouping test files; expect missing context fields or ungrouped children.

- [ ] **Step 3: Implement minimal phase plumbing**

Derive name from `definition.name ?? definition.id`, trigger source from the persisted trigger, and index from frozen run order. Ensure the parent at the spawn boundary and pass `parentSessionId`, deterministic title, and provenance to `createSession`.

- [ ] **Step 4: Verify GREEN and refactor**

Run the same scope, then remove duplicate provenance construction through focused helpers while keeping behavior unchanged.

### Task 4: Verify and integrate

**Files:**
- Review: all changed files

- [ ] Run workflow/session scoped tests.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm lint` and `pnpm build`.
- [ ] Stage changes and run the required privacy leak grep.
- [ ] Commit without co-author trailers.
- [ ] Fast-forward `main`, verify `git merge-base --is-ancestor <commit> main`, remove the worktree, prune worktrees, and report verbatim verification tails.
