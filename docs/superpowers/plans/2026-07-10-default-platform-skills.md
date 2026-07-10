# Default Platform Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship focused workflow, Todo, and delegation playbooks so every fresh Jinn install can operate the platform's core company surfaces.

**Architecture:** Add the playbooks under the existing `packages/jinn/template/skills/` seed tree, which `jinn setup` already copies recursively and the gateway skill watcher already mirrors into Claude and Codex discovery directories. Extend the template doctrine test to enforce discoverable frontmatter, setup wiring, MCP-first instructions, and exact current tool/CLI terminology.

**Tech Stack:** Markdown skill playbooks, YAML frontmatter, TypeScript, Vitest, pnpm.

## Global Constraints

- Work only in `/private/tmp/jinn-skills` and never touch ports 7777/7788 or `~/.jinn`.
- Keep all shipped content generic; no personal names, projects, emails, IDs, keys, or absolute home-directory paths.
- Use canonical kebab-case workflow names and current MCP/CLI contracts.
- Do not add `Co-Authored-By` trailers.

---

### Task 1: Lock the fresh-install skill contract

**Files:**
- Modify: `packages/jinn/src/shared/__tests__/template-company-doctrine.test.ts`
- Test: `packages/jinn/src/shared/__tests__/template-company-doctrine.test.ts`

**Interfaces:**
- Consumes: `packages/jinn/template/skills/<name>/SKILL.md` and `copyTemplateDir(template/skills, SKILLS_DIR, ...)`.
- Produces: regression coverage for the `workflow`, `todo-handling`, and `delegation` shipped skills.

- [ ] **Step 1: Write the failing test**

Add a test that expects all three files, parses their `name` and `description` frontmatter, confirms setup recursively copies template skills, rejects raw gateway HTTP instructions, and checks the exact core tool/CLI names.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter jinn-cli exec vitest run src/shared/__tests__/template-company-doctrine.test.ts`

Expected: FAIL because the three template skills do not exist yet.

- [ ] **Step 3: Commit with the implementation after Task 2 is green**

Stage this test together with the playbooks after all checks pass.

### Task 2: Author the default company-surface playbooks

**Files:**
- Create: `packages/jinn/template/skills/workflow/SKILL.md`
- Create: `packages/jinn/template/skills/todo-handling/SKILL.md`
- Create: `packages/jinn/template/skills/delegation/SKILL.md`

**Interfaces:**
- Consumes: workflow tools from `src/mcp/workflow-tools.ts`, Todo tools from `src/mcp/work-item-tools.ts`, delegation/session/org tools, and `jinn workflow run <name>` from `src/cli/workflow.ts`.
- Produces: skill packages discovered as `workflow`, `todo-handling`, and `delegation`.

- [ ] **Step 1: Write minimal workflow instructions**

Document discovery, SOP planning/validation, creation, named invocation with `input` and `idempotencyKey`, CLI parity, run tracking, frozen definition snapshots, PLAN → IMPLEMENT → VERIFY phases, bounded loops, human gates, and manual/schedule/event/poll/todo-status triggers.

- [ ] **Step 2: Write minimal Todo instructions**

Document ledger-vs-HOW boundaries, list/search/get/create/assign/update/archive tools, legal agent status transitions, reviewer-owned completion, verification policy, and durable provenance rules.

- [ ] **Step 3: Write minimal delegation instructions**

Document roster-first selection, tracked `delegate_task` versus untracked `spawn_session`, idempotent retries, callback/end-turn behavior, bounded review loops, follow-ups, stop conditions, and escalation.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm --filter jinn-cli exec vitest run src/shared/__tests__/template-company-doctrine.test.ts`

Expected: PASS.

### Task 3: Verify and integrate

**Files:**
- Modify: none beyond Tasks 1–2.

**Interfaces:**
- Consumes: repository build/test/lint scripts and Git worktree state.
- Produces: one privacy-clean commit fast-forwarded onto `main` with ancestry confirmed.

- [ ] **Step 1: Run scoped tests and typecheck**

Run the focused template test and `pnpm typecheck`; both must exit 0.

- [ ] **Step 2: Run full verification**

Run `pnpm test`, `pnpm lint`, and `pnpm build`; each must exit 0.

- [ ] **Step 3: Review and privacy-check**

Inspect `git diff --check`, stage intended files, and run the required leak grep over `git diff --cached`; it must produce no unexpected match.

- [ ] **Step 4: Commit and fast-forward**

Commit with a focused message, fast-forward the primary worktree's `main` branch, and verify `git merge-base --is-ancestor <commit> main` succeeds.

- [ ] **Step 5: Remove the worktree**

Remove `/private/tmp/jinn-skills` after capturing the commit SHA and verification output tails.
