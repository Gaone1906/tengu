# Default Platform Skills QA Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the shipped Workflow, Todo, and delegation playbooks so they teach the current routed-approval and managed-attachment contracts.

**Architecture:** Keep the correction entirely in the default template playbooks and their existing content-regression test. Pin exact MCP tool names and prohibit the stale operator-only and workspace-path guidance so future platform wording changes fail visibly.

**Tech Stack:** Markdown, YAML frontmatter, TypeScript, Vitest, pnpm.

## Global Constraints

- Work in the isolated QA worktree from current `main`.
- Make one focused commit and fast-forward `main` only after verification.
- Keep shipped content generic and MCP-first.
- Do not add co-author trailers.

---

### Task 1: Lock the corrected platform contract

**Files:**
- Modify: `packages/jinn/src/shared/__tests__/template-company-doctrine.test.ts`
- Test: `packages/jinn/src/shared/__tests__/template-company-doctrine.test.ts`

**Interfaces:**
- Consumes: the three default `SKILL.md` playbooks.
- Produces: positive assertions for approval tools and managed file IDs, plus negative assertions for operator-only gate wording.

- [ ] **Step 1: Write the failing regression assertions**

Require `request_work_item_approval`, `decide_work_item_approval`, and `escalate_work_item_approval` in the appropriate skills; require `managed file IDs` in delegation; reject the old “approval gates are human-only” and unconditional operator-routing language.

- [ ] **Step 2: Run the focused test and verify RED**

Run `pnpm --filter jinn-cli exec vitest run src/shared/__tests__/template-company-doctrine.test.ts` and confirm failure on missing approval-tool/attachment prose.

### Task 2: Correct the three playbooks

**Files:**
- Modify: `packages/jinn/template/skills/workflow/SKILL.md`
- Modify: `packages/jinn/template/skills/todo-handling/SKILL.md`
- Modify: `packages/jinn/template/skills/delegation/SKILL.md`

**Interfaces:**
- Consumes: `approval-tools.ts`, approval authority and consequence code, workflow Todo mirror code, and delegation attachment validation.
- Produces: instructions matching routed manager/COO decisions, approval request/decision/escalation effects, and managed attachment IDs.

- [ ] **Step 1: Correct workflow gate routing**

Teach authorized routed managers/COO agents to use `decide_work_item_approval`, use `escalate_work_item_approval` only for deliberate operator escalation, and preserve the self-approval ban.

- [ ] **Step 2: Document the complete Todo approval flow**

Teach request idempotency, authority rules, approve/reject consequences, bounded review rounds, mirrored workflow-gate resolution, and why `update_work_item` is not a decision substitute.

- [ ] **Step 3: Correct delegation attachments**

State that `attachments` accepts managed file IDs returned by the managed-files surface, never workspace or absolute paths.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same focused Vitest command and confirm all assertions pass.

### Task 3: Verify and integrate

**Files:**
- Modify: none beyond Tasks 1–2.

**Interfaces:**
- Consumes: repository verification scripts and Git ancestry.
- Produces: a privacy-clean commit on `main` with the QA worktree removed.

- [ ] **Step 1: Run `pnpm typecheck` and the full `pnpm test` suite**

Both commands must exit zero; preserve their final output tails.

- [ ] **Step 2: Run build, diff, and privacy checks**

Run `pnpm build`, `git diff --check`, and the required staged privacy grep.

- [ ] **Step 3: Commit and fast-forward**

Create one focused commit, rebase if `main` advanced, rerun affected verification, then fast-forward `main`.

- [ ] **Step 4: Confirm ancestry and remove the worktree**

Verify the commit is an ancestor of `main`, remove the branch worktree, and report the exact verification tails.
