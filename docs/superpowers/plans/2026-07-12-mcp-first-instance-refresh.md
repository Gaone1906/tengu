# MCP-First Callback and Instance Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven-development and systematic-debugging while executing these steps.

**Goal:** Make child-session callbacks MCP-native and reconcile the operator's personalized Jinn instance with the current MCP-first template without losing private customizations.

**Architecture:** Change the callback's engine-facing guidance at its source and pin the behavior with focused tests. Refresh only template-owned workspace material: selectively reconcile the canonical manual, replace reference docs and stock skills from the current template after backups, and leave custom business skills and private operating procedures untouched.

**Tech Stack:** TypeScript, Vitest, Markdown, YAML, Jinn MCP/company tools.

## Global Constraints

- Preserve all unrelated and untracked repository work.
- Keep the public repository generic and privacy-scan the staged diff.
- Back up every existing personal file before replacing or materially editing it.
- Use Jinn MCP for normal company operations; retain HTTP only as a labeled maintenance fallback.
- Do not restart the gateway unless verification proves it is required.

---

### Task 1: MCP-native child completion guidance

**Files:**
- Modify: `packages/jinn/src/sessions/__tests__/callbacks.test.ts`
- Modify: `packages/jinn/src/sessions/callbacks.ts`

- [x] Replace the existing test assertion that requires raw HTTP guidance with assertions for `read_session` and `send_to_session` and against `/api/sessions` leakage.
- [x] Run the focused callback test and observe the expected failure.
- [x] Change the callback message to MCP-native guidance.
- [x] Run the focused callback suite and observe it pass.

### Task 2: Personalized MCP-first manual reconciliation

**Files:**
- Modify: `~/.jinn/CLAUDE.md` (`AGENTS.md` remains its symlink)

- [x] Back up the manual.
- [x] Replace boards with Todos, raw HTTP child mechanics with MCP session tools, and stale ticket delegation with `delegate_task`.
- [x] Add Workflows, Triggers, persistent delegation, bounded autonomy, and the Company Operations Surface while preserving private sections.
- [x] Remove the employee-facing raw gateway endpoint table and retain only a maintenance-fallback pointer.

### Task 3: Template-owned docs and skills refresh

**Files:**
- Refresh: `~/.jinn/docs/*.md`
- Refresh/add: current stock skills under `~/.jinn/skills/`
- Modify: `~/.jinn/config.yaml`

- [x] Back up existing template-owned docs and skills.
- [x] Copy current reference docs and stock skills from `packages/jinn/template/`.
- [x] Preserve every non-template custom skill untouched.
- [x] Stamp `jinn.version: 0.26.0` and preserve all other config values.
- [x] Verify skill frontmatter and engine skill links.

### Task 4: Verification

- [x] Run focused callback tests, typecheck, and relevant template/MCP tests.
- [x] Scan the personal manual and stock skills for stale raw session API instructions.
- [x] Scan the repository diff for private data and unrelated files.
- [x] Report exact changes, backups, and any remaining intentional HTTP fallback.
