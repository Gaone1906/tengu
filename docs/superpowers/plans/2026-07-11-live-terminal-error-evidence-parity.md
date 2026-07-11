# Live Terminal Error Evidence Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make live success and terminal-error completion reconcile the current turn through one evidence classifier so live error membership matches persisted reload membership.

**Architecture:** Extract the existing successful-completion evidence filtering into one small pure helper in the live-session hook module. Both terminal branches supply their canonical final row through that helper; success alone supplies the canonical result as the exact streamed-row dedup value, while error supplies no dedup value to match gateway `completedStreamedBlockIds`.

**Tech Stack:** TypeScript, React 19 hooks, Vitest, Testing Library.

## Global Constraints

- Preserve all transcript rows before the current-turn evidence start unchanged.
- Preserve current-turn user, media, tool, notification/callback/relay, durable delegation/dispatch, and plain non-empty interim assistant rows.
- Drop transient task-list/progress rows and normalize unfinished tools to `Used <tool>`.
- Deduplicate only an exact streamed canonical success result; do not deduplicate terminal errors.
- Append exactly one canonical final assistant row with caller-supplied id, content, and timestamp.
- Keep result-less completion, batching, pending state, live final identity, animation, history, and cache behavior unchanged.
- Do not change or restart the gateway unless a proven contract mismatch requires it.
- Commit directly to `main` without a co-author trailer after privacy and whitespace checks.

---

### Task 1: Share Current-Turn Completion Reconciliation

**Files:**
- Modify: `packages/web/src/hooks/use-live-session.ts`
- Test: `packages/web/src/hooks/__tests__/use-live-session.test.ts`

**Interfaces:**
- Consumes: `Message[]`, current-turn start index, canonical final `Message`, and optional exact success-result dedup content.
- Produces: `reconcileCompletedTurnMessages({ messages, turnStart, finalMessage, exactResult? }) => Message[]` used by both successful and terminal-error completion.

- [x] **Step 1: Write the failing tests**

Add a hook regression that hydrates an older completed turn, emits a current error turn containing interim prose, an unfinished tool, transient task-list, delegation and dispatch blocks, a notification/callback, and media, then asserts exact membership, unchanged older object identities, normalized tool content, and exactly one canonical error final id. Add a direct pure-helper parity fixture that feeds identical evidence to success and error and asserts identical classified evidence while success alone drops an exact streamed result copy.

- [x] **Step 2: Run the focused test to verify RED**

Run: `pnpm --filter @jinn/web exec vitest run src/hooks/__tests__/use-live-session.test.ts`

Expected: FAIL because terminal errors still append to the entire previous array and the shared reconciliation helper does not exist.

- [x] **Step 3: Implement the minimal shared helper**

Move the existing success classifier and tool normalization into the pure helper. Replace the success branch's inline update and terminal-error branch's append-only update with calls that differ only in canonical final content and whether exact-result dedup is supplied.

- [x] **Step 4: Run focused GREEN and contract suites**

Run the live-session hook test, focused web comms tests, and gateway streamed-block/settlement tests. Expect every test to pass with no snapshots changed outside the requested contract.

- [x] **Step 5: Run repository verification**

Run full web tests, full gateway tests, root typecheck, configured lint, and root build. Run `git diff --check`, stage only owned files, and leak-grep the staged diff for private identifiers and absolute user paths.

- [x] **Step 6: Commit**

Commit the tested hook, tests, and plan directly to `main` with a concise `fix(web): ...` message and no co-author trailer.
