# Context Hygiene Implementation Plan

> **For agentic workers:** Execute this plan inline with red/green TDD and verify every command under Node 24.13.0.

**Goal:** Enforce the configured context cap, reduce redundant bootstrap prose, and remove stale or oversized employee instructions without changing role ownership.

**Architecture:** Keep context as ordered semantic sections. Progressively summarize and omit lower-priority sections, compact essential sections only as a last resort, and apply a deterministic final bound. Replace filesystem inventories and duplicated identity doctrine with short discovery and operating hints. Keep detailed operational playbooks in skills rather than employee personas.

**Tech Stack:** TypeScript, Vitest, js-yaml/YAML, pnpm, Turborepo.

## Global Constraints

- Keep the relationship-scoped roster and built-in Jinn MCP tool belt.
- Do not change employee role, engine, rank, department, or reporting relationships except removing invalid virtual-root references.
- Keep repository content generic; personal employee edits belong only in the live workspace.
- Do not restart or touch gateway processes.

---

### Task 1: Enforce `context.maxChars`

**Files:**
- Modify: `packages/jinn/src/sessions/context.ts`
- Test: `packages/jinn/src/sessions/__tests__/context.test.ts`

- [ ] Strengthen the existing cap test with an oversized persona and an exact `length <= maxChars` assertion.
- [ ] Run the focused test and confirm it fails because the current result exceeds the cap.
- [ ] Add essential summaries, omit lower tiers after summarization, and add a deterministic final bound.
- [ ] Run the focused context suite and confirm it passes.

### Task 2: Reduce composed bootstrap noise

**Files:**
- Modify: `packages/jinn/src/sessions/context.ts`
- Test: `packages/jinn/src/sessions/__tests__/context.test.ts`

- [ ] Add assertions that local discovery no longer lists directory contents or project names and employee identity is not repeated in the company block.
- [ ] Run focused tests and confirm the new assertions fail.
- [ ] Replace the environment dump with a compact on-demand discovery hint and deduplicate employee company doctrine.
- [ ] Run focused tests and record the post-change COO and employee bootstrap totals with the same measurement inputs as baseline.

### Task 3: Clean employee personas

**Files:**
- Modify: selected live `org/**/*.yaml` files identified by the context audit.
- Review: `packages/jinn/template/org/**/*.yaml`

- [ ] Remove stale stacks, dead paths, stripped CLI flags, unavailable-tool references, raw local delegation recipes, board references, and repeated procedures.
- [ ] Reduce oversized personas to stable role, constraints, skill routing, and reporting expectations.
- [ ] Confirm the shipped default assistant needs no equivalent cleanup; do not copy personal personas into the template.
- [ ] Parse all live and template YAML and build both org registries cleanly.

### Task 4: Verify and integrate

**Files:**
- Verify all changed files and generated tails.

- [ ] Run context/org focused suites, typecheck, lint, build, and the full test suite under Node 24.13.0.
- [ ] Stage the repository diff and run the privacy leak grep.
- [ ] Commit without co-author trailers.
- [ ] Fast-forward `main`, confirm the commit is an ancestor of `main`, capture concise verification tails, and remove the worktree.
