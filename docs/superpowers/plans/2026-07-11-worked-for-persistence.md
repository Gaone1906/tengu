# Worked-for Persistence Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the same completed-turn evidence and canonical final-response boundary that the live web completion path renders.

**Architecture:** Keep mid-turn streaming in the existing `partial=1` rows. At accepted terminal settlement, classify those rows with the same parity rules as `use-live-session.ts`, atomically finalize the durable evidence subset, delete transient/duplicate rows, and append the one canonical final assistant row. All stale, preempted, rate-limited, interrupted, and result-less paths retain cleanup behavior.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, React 19/Vite web contract tests.

## Global Constraints

- Work directly on current `main`; do not restart the live gateway on port 7777.
- Use strict RED/GREEN TDD and capture the focused failure before production edits.
- Preserve rate-limit, retry/fallback, engine-switch, interruption, search, pagination, and ordering behavior.
- Keep all public repository fixtures generic and run the required staged leak grep before commit.
- Do not add a co-author trailer.

---

### Task 1: Gateway settlement contract regression

**Files:**
- Create: `packages/jinn/src/gateway/__tests__/streamed-turn-settlement.test.ts`
- Modify: `packages/jinn/src/gateway/__tests__/streamed-blocks.test.ts`

**Interfaces:**
- Consumes: real `handleApiRequest`, engine `onStream`, session registry reads, and GET-session reload serialization.
- Produces: regression coverage for completed evidence ordering, exact final dedup, concatenated fragment handling, transient block filtering, and preempted/result-less cleanup.

- [ ] **Step 1: Write the failing route-level tests**

Drive `POST /api/sessions` with a stub engine that emits interim text/tool/block deltas and returns a terminal result, then poll the real queue/registry and reload with `GET /api/sessions/:id`. Assert normalized rows are `user -> interim prose -> tool evidence -> durable block evidence -> canonical final`, with no `partial` flags and no task-list row.

- [ ] **Step 2: Add edge cases**

Assert a single exact streamed result row is removed before the canonical final is appended; multiple prose fragments that concatenate to the result remain evidence while the canonical full result is appended; stopped/preempted and result-less turns do not persist a final assistant boundary.

- [ ] **Step 3: Run focused tests to verify RED**

Run: `pnpm --filter jinn-cli exec vitest run src/gateway/__tests__/streamed-turn-settlement.test.ts src/gateway/__tests__/streamed-blocks.test.ts`

Expected: completed-evidence and concatenated-fragment assertions fail because `shouldPreserveStreamedBlocks()` returns `false`; safety cases remain green.

### Task 2: Selective partial-row settlement

**Files:**
- Modify: `packages/jinn/src/sessions/registry.ts`
- Modify: `packages/jinn/src/sessions/__tests__/messages-partial.test.ts`

**Interfaces:**
- Consumes: `sessionId` and an ordered set of message ids selected for preservation.
- Produces: `settlePartialMessages(sessionId: string, preserveMessageIds: ReadonlySet<string>): number`, which deletes non-selected partial rows and clears `partial` only on selected rows in one SQLite transaction.

- [ ] **Step 1: Add a failing registry test**

Insert prose, tool, and transient rows; settle with only prose/tool ids; assert selected row identity/order survives without `partial`, transient rows disappear, and unrelated final rows remain untouched.

- [ ] **Step 2: Run the registry test to verify RED**

Run: `pnpm --filter jinn-cli exec vitest run src/sessions/__tests__/messages-partial.test.ts`

Expected: FAIL because `settlePartialMessages` does not exist.

- [ ] **Step 3: Implement the transaction minimally**

Use the existing partial-row index and a transaction containing one delete of non-selected ids plus one update of selected ids. Keep `deletePartialMessages`, `finalizePartialMessages`, and boot cleanup behavior unchanged for existing callers.

- [ ] **Step 4: Run the registry test to verify GREEN**

Run the same focused registry command and expect all tests to pass.

### Task 3: Live-parity gateway settlement

**Files:**
- Modify: `packages/jinn/src/gateway/streamed-blocks.ts`
- Modify: `packages/jinn/src/gateway/api.ts`
- Modify: `packages/jinn/src/gateway/__tests__/block-finalize.test.ts` only if the obsolete transient blocks-only expectation conflicts with the accepted final-boundary contract.

**Interfaces:**
- Consumes: streamed `SessionMessage` rows plus `quietPreempted`, rate-limit detection, terminal result, and terminal error.
- Produces: preserved message ids matching web completion: media, tools, plain non-empty interim prose except an exact trimmed result match, and blocks containing `delegation` or `dispatch`; task-list rows are transient.

- [ ] **Step 1: Implement the minimal classifier**

Return no preserved ids unless settlement has a true accepted terminal result/error and is neither quiet-preempted nor rate-limited. Use trimmed exact equality only; never whitespace-normalize and never treat concatenated fragments as a final duplicate.

- [ ] **Step 2: Wire settlement at the root cause**

Detect rate limiting before partial settlement, selectively settle preserved evidence, discard transient/duplicate partial rows, and let the existing canonical final/error insert run. Do not attach dropped task-list blocks to the final answer.

- [ ] **Step 3: Run focused gateway and web parity tests to verify GREEN**

Run:

```bash
pnpm --filter jinn-cli exec vitest run src/gateway/__tests__/streamed-turn-settlement.test.ts src/gateway/__tests__/streamed-blocks.test.ts src/sessions/__tests__/messages-partial.test.ts src/gateway/__tests__/block-finalize.test.ts
pnpm --filter @jinn/web exec vitest run src/hooks/__tests__/use-live-session.test.ts src/components/chat/__tests__/comms-v2.test.tsx
```

Expected: all focused tests pass; reload rows match the existing live completion expectations.

### Task 4: Full verification and commit

**Files:**
- Review all modified files; do not touch the existing `.tmp-record-*.mjs` files.

**Interfaces:**
- Consumes: completed change set.
- Produces: verified main-branch commit and handoff evidence.

- [ ] **Step 1: Run full verification**

Run gateway suite, web suite, root typecheck, root lint when configured, and root build. Record exact test counts and any expected warnings.

- [ ] **Step 2: Review behavior-sensitive seams**

Inspect the final diff for retry/fallback, engine switch, interruption, search indexing, pagination order, task-list filtering, and exact final-response identity.

- [ ] **Step 3: Stage and leak-grep**

Run the mandated staged-diff grep for private names, emails, Slack ids, and absolute home-directory paths. Any hit outside the known repository metadata exception must be genericized.

- [ ] **Step 4: Commit directly to main**

Commit with a focused message and no co-author trailer, then report the SHA, commands/counts, migration implications, and restart requirement after independent QA.
