# Workflow Phase Prompt Overrides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-run phase prompt overrides, audited pending-phase prompt edits, and loop exits driven by declared verifier handoff fields without mutating frozen invocation input.

**Architecture:** Store effective phase prompt overrides and their append-only edit audit at the run-record top level, separate from immutable `invocation.input` and the frozen definition snapshot. Serialize pending-step edits with the existing per-run advance lock so a prompt cannot be edited while the reconciler dispatches it. Represent handoff-driven loop exits as the existing deterministic `WorkflowCondition[]` language on a loop edge and evaluate those conditions against the final settled receipt at the round boundary.

**Tech Stack:** TypeScript, file-backed JSON workflow evidence, Vitest, gateway REST API, Jinn MCP tools.

## Global Constraints

- Work from Node 24.13.0 with pnpm.
- Do not read from or write to the live gateway on ports 7777/7788 or the live `~/.jinn` runtime state.
- Keep the public repository generic and leak-check the staged diff before commit.
- Never add `Co-Authored-By` commit trailers.
- Preserve frozen per-run input byte-for-byte; prompt overrides and edits are a separate run-local layer.

---

### Task 1: Run-local prompt override contract

**Files:**
- Modify: `packages/jinn/src/workflows/run-store.ts`
- Modify: `packages/jinn/src/workflows/run-reconciler.ts`
- Test: `packages/jinn/src/workflows/__tests__/run-reconciler.test.ts`

**Interfaces:**
- Consumes: `WorkflowRunInvocation`, `WorkflowRun.steps`, `withRunAdvanceLock()`.
- Produces: `WorkflowStepPromptOverride`, `WorkflowStepPromptEdit`, `WorkflowRun.stepOverrides`, `WorkflowRun.stepPromptEdits`, and `editPendingWorkflowStepPrompt()`.

- [ ] Add a failing reconciler test that starts a run with `{ stepOverrides: { verify: { prompt: "..." } } }`, proves only VERIFY receives the replacement task, mutates the caller's input/override objects, and proves persisted invocation input and overrides remain isolated copies.
- [ ] Run the reconciler test and confirm it fails because `stepOverrides` is not accepted or rendered.
- [ ] Add the run-record types, deep-copy start options, effective prompt selection in `stepPromptFor()`, and persistence.
- [ ] Run the reconciler test and confirm it passes.
- [ ] Add failing tests for a pending edit applying to the later spawn and appending an actor/timestamp/before/after audit entry, plus rejection of running/completed phases.
- [ ] Implement `editPendingWorkflowStepPrompt()` under `withRunAdvanceLock()` with typed not-found/not-pending outcomes and immutable audit-array replacement.
- [ ] Run the reconciler tests and confirm they pass.

### Task 2: HTTP and MCP surfaces

**Files:**
- Modify: `packages/jinn/src/gateway/api.ts`
- Modify: `packages/jinn/src/mcp/workflow-tools.ts`
- Test: `packages/jinn/src/gateway/__tests__/workflow-definitions-route.test.ts`
- Test: `packages/jinn/src/mcp/__tests__/workflow-tools.test.ts`

**Interfaces:**
- Consumes: `startWorkflowRunFromTrigger()`, `editPendingWorkflowStepPrompt()`, workflow operation authority.
- Produces: start payload `stepOverrides` and `PATCH /api/workflow-definitions/:id/runs/:runId/pending-steps/:nodeId`; MCP `edit_workflow_run_step_prompt`.

- [ ] Add failing route tests that validate and persist start overrides, preserve original frozen input during a pending edit, record the authenticated actor, and return 409 for non-pending phases.
- [ ] Add failing MCP schema/forwarding tests for start overrides and the pending-step edit tool.
- [ ] Run both targeted test files and confirm the new cases fail for missing surfaces.
- [ ] Add strict override validation: known actor-backed step ids only, exact `{ prompt }` shape, non-empty bounded text, and no control characters except tab/newline.
- [ ] Wire the PATCH route through workflow authority and the run-local edit function; map typed outcomes to 404/409.
- [ ] Extend start tools and add the edit tool as a deterministic HTTP wrapper.
- [ ] Run both targeted test files and confirm they pass.

### Task 3: Handoff-field loop exits

**Files:**
- Modify: `packages/jinn/src/workflows/definition.ts`
- Modify: `packages/jinn/src/workflows/execution-plan.ts`
- Modify: `packages/jinn/src/workflows/advance.ts`
- Modify: `packages/jinn/src/workflows/handoff.ts`
- Test: `packages/jinn/src/workflows/__tests__/run-reconciler.test.ts`
- Test: `packages/jinn/src/workflows/__tests__/handoff-fields.test.ts`

**Interfaces:**
- Consumes: `WorkflowCondition`, `evaluateConditions()`, `ConditionEvidence`, receipt outcomes.
- Produces: `LoopPlan.exitWhen` and loop-edge `when` validation/compilation.

- [ ] Add a failing driver test for PLAN → IMPLEMENT → VERIFY where the loop edge exits on `steps.verify.outcome.fields.approved == true`: false repeats, true exits before the maximum, and VERIFY's prompt advertises `approved`.
- [ ] Run the test and confirm definition validation rejects loop-edge `when`.
- [ ] Allow validated conditions on loop edges, reject conflicting legacy gate plus conditions, and compile them to `LoopPlan.exitWhen`.
- [ ] Evaluate exit conditions at the round boundary using the latest settled receipt position frame already used by switches and prompt handoffs.
- [ ] Extend handoff-field contract comments/tests so loop conditions advertise verifier fields.
- [ ] Run workflow tests and confirm the loop branches correctly.

### Task 4: Verification and integration

**Files:**
- Review all modified files and tests.

**Interfaces:**
- Consumes: all preceding tasks.
- Produces: one generic, tested commit fast-forwarded to `main`.

- [ ] Run the workflow-scoped test set under Node 24.13.0.
- [ ] Run `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm lint` under Node 24.13.0.
- [ ] Review the diff for accidental scope expansion, secrets, personal data, and live-instance paths.
- [ ] Stage the intended files and run the required leak grep over the staged diff.
- [ ] Commit without co-author trailers.
- [ ] Fast-forward `main`, confirm the feature commit is an ancestor of `main`, record verbatim command tails, remove the worktree, and confirm removal.
