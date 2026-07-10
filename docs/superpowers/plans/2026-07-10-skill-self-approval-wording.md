# Skill Self-Approval Wording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the shipped workflow and Todo playbooks describe the approval authority implementation exactly without changing approval code.

**Architecture:** Keep the authority implementation untouched. Pin the public wording in the existing template-doctrine regression test, then minimally revise the two shipped skill paragraphs to distinguish the routed owner ban from the hierarchy-root/COO exception while retaining conservative best-practice guidance.

**Tech Stack:** Markdown skill playbooks, TypeScript, Vitest, pnpm/Turborepo.

## Global Constraints

- Do not modify `approval-authority.ts` or any approval runtime behavior.
- State that the resolved routed owner cannot decide their own approval.
- State that an employee hierarchy root/COO is exempt from that enforcement check.
- Advise managers/COO not to approve work they personally executed even though linked execution alone is not rejected by the current authority check.
- Produce one commit, then fast-forward `main` and confirm ancestry.

---

### Task 1: Pin and correct the shipped wording

**Files:**
- Modify: `packages/jinn/src/shared/__tests__/template-company-doctrine.test.ts`
- Modify: `packages/jinn/template/skills/workflow/SKILL.md`
- Modify: `packages/jinn/template/skills/todo-handling/SKILL.md`

**Interfaces:**
- Consumes: `resolveApprovalDecisionAuthority`, whose owner check exempts an employee hierarchy root and does not inspect linked execution sessions.
- Produces: accurate, regression-tested operator guidance in both pre-packaged skills.

- [ ] **Step 1: Write the failing regression assertions**

Replace the universal no-self-approval string expectation with assertions requiring the phrases `resolved routed owner`, `hierarchy root/COO is exempt`, and `avoid approving work you personally executed`, and rejecting the former universal claims.

- [ ] **Step 2: Run the focused test to verify RED**

Run: `pnpm --filter jinn-cli exec vitest run src/shared/__tests__/template-company-doctrine.test.ts`

Expected: FAIL because the current playbooks do not contain the corrected contract wording.

- [ ] **Step 3: Make the minimal playbook edits**

Update the workflow gate paragraph and Todo approval paragraph to state the routed-owner check, hierarchy-root/COO exception, linked-executor limitation, and best-practice advice without changing tool or transition guidance.

- [ ] **Step 4: Verify GREEN and repository gates**

Run the focused Vitest file, `pnpm typecheck`, and the full `pnpm test` suite under Node 24.13.0. Confirm build/test output and inspect the final diff.

- [ ] **Step 5: Commit and fast-forward main**

Commit the plan, regression test, and two playbooks once. Fast-forward `main` to that commit, confirm the old main is an ancestor, and remove the worktree.
