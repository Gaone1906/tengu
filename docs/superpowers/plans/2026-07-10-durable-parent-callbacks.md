# Durable Parent Callbacks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every parent-session callback before dispatch so rapid child completions are each consumed exactly once during normal operation and unconsumed callbacks replay after a gateway restart.

**Architecture:** Reuse the existing SQLite `queue_items` table and boot replay path instead of adding a second outbox. Add an `internal` flag so callback work participates in durable ordering/recovery while remaining absent from operator queue controls; the API notification route writes one internal row per accepted callback and dispatches that row through the existing per-session `SessionQueue`.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, Node.js 24.13.0, pnpm 10.6.4.

## Global Constraints

- Build from `main` HEAD `45b38fdae3c7cd5e8cdca089e7fc512c9c820928` in the isolated callback-reliability worktree.
- Use `JINN_HOME=$HOME/.jinn-cbrel` and port `7889` for live testing only.
- Never access the production gateway on port `7777`, the instance on `7788`, or write to the production Jinn home.
- Preserve unrelated files and production work items; no `Co-Authored-By` trailer.
- Run with Node.js `24.13.0` and pnpm.

---

### Task 1: Durable internal queue rows

**Files:**
- Modify: `packages/jinn/src/sessions/registry.ts`
- Modify: `packages/jinn/src/sessions/registry.test.ts`

**Interfaces:**
- Consumes: the existing `queue_items` table and queue-item CRUD helpers.
- Produces: `migrateQueueItemsSchema(database)`, `QueueItem.internal`, and `enqueueQueueItem(sessionId, sessionKey, prompt, { internal: true })`.

- [ ] **Step 1: Write the failing migration and visibility tests**

```ts
test("migrateQueueItemsSchema adds an internal flag to legacy queue tables", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE queue_items (id TEXT PRIMARY KEY, session_id TEXT, session_key TEXT, prompt TEXT, status TEXT, position INTEGER, created_at TEXT, started_at TEXT, completed_at TEXT)");
  migrateQueueItemsSchema(db);
  expect(db.prepare("PRAGMA table_info(queue_items)").all()).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "internal" })]),
  );
});
```

- [ ] **Step 2: Run the focused registry test and verify RED**

Run: `PATH=~/.nvm/versions/node/v24.13.0/bin:$PATH pnpm --filter jinn-cli exec vitest run src/sessions/registry.test.ts`

Expected: FAIL because `migrateQueueItemsSchema` and the internal option do not exist.

- [ ] **Step 3: Add the additive schema migration and internal-aware queries**

```ts
export function migrateQueueItemsSchema(database: Database.Database): void {
  const columns = database.prepare("PRAGMA table_info(queue_items)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "internal")) {
    database.exec("ALTER TABLE queue_items ADD COLUMN internal INTEGER NOT NULL DEFAULT 0");
  }
}
```

Call the migration after creating `queue_items`; write `internal=1` for callback entries; keep `listAllPendingQueueItems()` inclusive for boot replay, but filter `getQueueItems()` and `cancelAllPendingQueueItems()` to `internal=0` so system callbacks never appear in or get cleared by operator queue controls.

- [ ] **Step 4: Run the focused registry test and verify GREEN**

Run: `PATH=~/.nvm/versions/node/v24.13.0/bin:$PATH pnpm --filter jinn-cli exec vitest run src/sessions/registry.test.ts`

Expected: PASS.

### Task 2: Persist callback dispatch and prove concurrency/restart behavior

**Files:**
- Create: `packages/jinn/src/gateway/__tests__/callback-reliability.test.ts`
- Modify: `packages/jinn/src/gateway/api.ts`

**Interfaces:**
- Consumes: `enqueueQueueItem(..., { internal: true })`, `dispatchWebSessionRun`, `resumePendingWebQueueItems`, and `SessionQueue`.
- Produces: one durable internal queue row for every notification-role API message.

- [ ] **Step 1: Write failing route-level tests**

```ts
it("replays an accepted but unconsumed callback after restart", async () => {
  await postNotification(preRestartContext, parent.id, "callback-one");
  expect(registry.listAllPendingQueueItems()).toEqual([
    expect.objectContaining({ prompt: "callback-one", internal: true }),
  ]);
  api.resumePendingWebQueueItems(postRestartContext);
  await eventually(() => expect(seenPrompts).toEqual(["callback-one"]));
});

it("delivers two rapid child callbacks exactly once each", async () => {
  await Promise.all([
    postNotification(context, parent.id, "callback-one"),
    postNotification(context, parent.id, "callback-two"),
  ]);
  await eventually(() => expect(seenPrompts).toEqual(["callback-one", "callback-two"]));
  expect(new Set(seenPrompts).size).toBe(2);
});
```

- [ ] **Step 2: Run the callback reliability test and verify RED**

Run: `PATH=~/.nvm/versions/node/v24.13.0/bin:$PATH pnpm --filter jinn-cli exec vitest run src/gateway/__tests__/callback-reliability.test.ts`

Expected: the restart test fails because notification-role messages have no durable `queue_items` row.

- [ ] **Step 3: Persist notification work before dispatch**

```ts
const queueItemId = enqueueQueueItem(session.id, sessionKey, prompt, {
  internal: isNotification,
});
dispatchWebSessionRun(session, prompt, engine, config, context, { queueItemId });
```

Keep notification banners/messages unchanged, keep notification turns non-interrupting, and emit queue-panel updates only for visible user items.

- [ ] **Step 4: Run callback, sessions, and gateway tests and verify GREEN**

Run: `PATH=~/.nvm/versions/node/v24.13.0/bin:$PATH pnpm --filter jinn-cli exec vitest run src/gateway/__tests__/callback-reliability.test.ts src/sessions/__tests__/callbacks.test.ts src/sessions/queue.test.ts src/gateway/__tests__/workflow-queue-replay.test.ts`

Expected: PASS with both callback prompts observed once and the pending callback replayed.

### Task 3: Live QA, full verification, integration, and cleanup

**Files:**
- No production-source additions beyond Tasks 1–2.

**Interfaces:**
- Consumes: built Jinn CLI, throwaway `JINN_HOME`, gateway REST API, git worktree.
- Produces: live evidence, full-suite tails, one leak-clean commit fast-forwarded to `main`, and no remaining task worktree.

- [ ] **Step 1: Build and run the isolated gateway**

Run the built CLI with `JINN_HOME=$HOME/.jinn-cbrel`, port `7889`, and owned PID tracking; create a parent plus two child callbacks, post the completions near-simultaneously, and assert the parent stores/consumes each callback once.

- [ ] **Step 2: Simulate restart with one unconsumed callback**

Pause/hold the parent queue, post one callback, stop only the owned 7889 gateway PID, restart it, and assert the pending internal row is replayed once and drained.

- [ ] **Step 3: Run requested verification and capture tails**

Run under Node 24.13.0: `pnpm typecheck`, sessions/gateway focused tests, `pnpm test`, and `pnpm build`. Save the verbatim tail of each result for the report.

- [ ] **Step 4: Leak-check and commit**

Stage only intended files, run the required staged-diff leak grep, and commit without co-author trailers.

- [ ] **Step 5: Fast-forward main, confirm ancestry/state, and remove worktree**

Fast-forward `main` to the task commit, prove `git merge-base --is-ancestor <commit> main`, verify the production `work_items` fingerprint is unchanged, remove `$HOME/.jinn-cbrel`, stop only owned port-7889 processes, and remove the worktree.
