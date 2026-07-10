# Template Doctrine Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the shipped operating manual fully MCP/Todo/Workflow/Trigger-first and make the 0.26.0 autonomy migration reachable and accurate without overwriting a customized live instance.

**Architecture:** Keep the canonical fresh-install doctrine in `template/CLAUDE.md`; setup continues to expose the same content to Codex through the `AGENTS.md` symlink/copy path. Keep version-range migration mechanics unchanged, but align `jinn-cli`'s package version with the already-staged 0.26.0 migration so `(instance, package]` scanning reaches it. Strengthen release-facing tests against real template and package files, and place the operator-specific proposed reconciliation outside the public repository.

**Tech Stack:** TypeScript, Vitest, Markdown templates, pnpm, Node.js 24.13.0

## Global Constraints

- Never write the live `~/.jinn/CLAUDE.md` or its `AGENTS.md` alias.
- Public repository content must stay generic and contain no personal names, projects, credentials, Slack IDs, emails, or absolute user-home paths.
- Use MCP as the primary company-state surface; Todos are the live ledger; Workflows are reusable HOW; Triggers wake Workflows.
- Remove stale board-first, raw-HTTP-first, and unimplemented service-routing claims.
- Use Node.js 24.13.0 and pnpm; never add `Co-Authored-By` trailers.

---

### Task 1: Lock current template doctrine in tests

**Files:**
- Modify: `packages/jinn/src/shared/__tests__/template-company-doctrine.test.ts`
- Modify: `packages/jinn/template/CLAUDE.md`

**Interfaces:**
- Consumes: the canonical shipped Markdown template.
- Produces: regression assertions for MCP-first state operations, Todos, Workflows, Triggers, manager-visible skip-level routing, and absence of legacy boards/raw HTTP/unimplemented service menus.

- [ ] **Step 1: Write the failing doctrine assertions**

Add expectations that `CLAUDE.md` contains a dedicated `### Triggers` section with `list_triggers`/`create_trigger`, retains manager notification for skip-level delegation, and does not contain `Cross-Department Services`, `org/service tools`, or an injected service menu claim.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter jinn-cli test -- src/shared/__tests__/template-company-doctrine.test.ts`

Expected: FAIL because the dedicated Trigger doctrine is absent and stale service-routing claims remain.

- [ ] **Step 3: Make the template minimally current**

Remove the obsolete service-routing subsection and `provides` example. Add concise Trigger doctrine after Workflows:

```markdown
### Triggers

Triggers are durable bindings that wake Workflows when supported events or polls match. Keep the wake-up binding separate from the Workflow procedure and the Todo that records each live run. Inspect bindings with `list_triggers`; use `create_trigger` only for supported webhook or poll bindings. Configure schedule and `todo-status` wake-ups through the Workflow definition, and avoid duplicate bindings.
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same focused Vitest command. Expected: PASS.

### Task 2: Make the 0.26.0 migration reachable and complete

**Files:**
- Modify: `packages/jinn/src/cli/__tests__/migrate-prompt.test.ts`
- Modify: `packages/jinn/package.json`
- Modify: `packages/jinn/template/migrations/0.26.0/MIGRATION.md`

**Interfaces:**
- Consumes: `scanMigrationPrompts()`'s existing `(fromVersion, packageVersion]` contract and the real package version.
- Produces: a package/migration version alignment test and a composed prompt containing the full company doctrine reconciliation instructions.

- [ ] **Step 1: Write failing real-package reachability/composition tests**

Read `packages/jinn/package.json`, scan the real template migrations from `0.25.0` to that version, and assert that `0.26.0` is reachable rather than future. Compose it and assert the prompt covers MCP, Todos, Workflows, Triggers, manager-visible skip-level delegation, board/raw-HTTP replacement, preservation of custom content, CLAUDE/AGENTS consistency, and the correct 0.26.0 marker.

- [ ] **Step 2: Run the focused migration test and verify RED**

Run: `pnpm --filter jinn-cli test -- src/cli/__tests__/migrate-prompt.test.ts`

Expected: FAIL because package `0.25.0` cannot reach migration `0.26.0` and the prompt lacks some reconciliation clauses.

- [ ] **Step 3: Align the package and migration**

Set `packages/jinn/package.json` to `0.26.0`. Update `MIGRATION.md` so its exact release marker is no longer conditional; explicitly replace board/raw-HTTP-first doctrine, add Trigger and manager-visible skip-level wording, preserve local customizations, handle canonical/symlinked AGENTS safely, and remove obsolete service-menu claims. Reference shipped source paths only where the prompt provides a resolvable location.

- [ ] **Step 4: Run the focused migration test and verify GREEN**

Run the same focused Vitest command. Expected: PASS.

### Task 3: Produce the operator reconciliation artifact

**Files:**
- Create outside repo: `~/.jinn-audits/prod-claude-md-reconciliation.md`

**Interfaces:**
- Consumes: read-only live `~/.jinn/CLAUDE.md` line anchors and the current shipped template doctrine.
- Produces: a reviewable, manually applicable replacement plan that preserves all custom/operator sections.

- [ ] **Step 1: Write exact replacements**

Document the stale live board bullets, raw session HTTP child protocol, self-modification primacy, `/sync` HTTP wording, gateway endpoint-table primacy, and board convention. For each, include the exact proposed replacement text using MCP tools, Todos, Workflows, and Triggers.

- [ ] **Step 2: Add preservation boundaries**

Explicitly list operator-specific memory, cron, reaction approvals, toolbox, credentials references, package hardening, and project-specific content as preserved/non-targeted. State that `CLAUDE.md` remains canonical and `AGENTS.md` must follow via its existing alias/copy relationship.

- [ ] **Step 3: Confirm the live file was not modified**

Compare its checksum captured before and after implementation. Expected: identical.

### Task 4: Verify, commit, integrate, and clean up

**Files:**
- Verify all modified repo files and the external reconciliation artifact.

**Interfaces:**
- Consumes: completed implementation and tests.
- Produces: one generic commit fast-forwarded to `main`, verified ancestry, and a removed worktree.

- [ ] **Step 1: Run scoped and full verification on Node 24.13.0**

Run focused template/migrate tests, `pnpm typecheck`, `pnpm test`, and `pnpm build`; inspect verbatim command tails.

- [ ] **Step 2: Review diffs and privacy scan**

Check `git diff --check`, confirm the live manual checksum is unchanged, stage only intended repo files, and run the required leak grep over the staged diff.

- [ ] **Step 3: Commit**

Commit with a focused message and no co-author trailer.

- [ ] **Step 4: Fast-forward main and confirm ancestry**

From the primary checkout, run `git merge --ff-only fix/reconcile-template-doctrine`, then confirm `git merge-base --is-ancestor <commit> main` succeeds and `git rev-parse main` equals the commit.

- [ ] **Step 5: Remove the worktree**

Remove the isolated worktree and report the commit SHA, ancestry result, test/build tails, and reconciliation summary.
