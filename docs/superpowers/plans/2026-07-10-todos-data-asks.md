# Todos Data Asks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the four backend capabilities required by the Todos ledger: paginated list/search responses with true totals, server-side filters, persisted manual rank, and operator-only metadata editing.

**Architecture:** Keep `work-items/store.ts` as the single persistence/query boundary. A shared query builder will AND-compose list/search filters, supply both paged rows and unpaged counts, and apply the canonical `rank`/recency order. The gateway will expose one backward-compatible enriched list/search payload and one operator-only PATCH route; lifecycle status remains exclusively behind the existing guarded transition endpoint.

**Tech Stack:** TypeScript ES2022 strict mode, better-sqlite3, Vitest, Node 24.13.0, pnpm 10.6.4.

## Global Constraints

- Backend only: do not modify `packages/web`.
- Work from local `main` HEAD in an isolated worktree and fast-forward local `main` after verification.
- Never touch gateway ports 7777/7788 or personal `~/.jinn` runtime data.
- Public repository content must stay generic and pass the privacy leak scan.
- No `Co-Authored-By` commit trailers.
- Every behavior change follows a witnessed red-green-refactor cycle.
- `PATCH /api/work-items/:id` must never accept `status`; legal lifecycle transitions remain on `POST /api/work-items/:id/status`.

---

### Task 1: Paginated, filterable query substrate with true totals

**Files:**
- Modify: `packages/jinn/src/work-items/store.ts`
- Test: `packages/jinn/src/work-items/__tests__/list-limit.test.ts`

**Interfaces:**
- Consumes: the existing `WorkItem`, `WorkItemStatus`, `WorkItemSource`, and SQLite `work_items` table.
- Produces: `queryWorkItems(filter): WorkItemPage`, where `WorkItemPage` has `workItems`, `total`, `totals`, `limit`, `offset`, and `nextOffset`; `listWorkItems` and `searchWorkItems` remain compatibility wrappers returning arrays.

- [ ] **Step 1: Write failing store tests for pagination and totals**

Add tests that seed more than 20 rows across statuses and assert:

```ts
const first = store.queryWorkItems({ status: "backlog", limit: 20, offset: 0 })
expect(first.workItems).toHaveLength(20)
expect(first.total).toBe(27)
expect(first.totals.backlog).toBe(27)
expect(first.nextOffset).toBe(20)

const second = store.queryWorkItems({ status: "backlog", limit: 20, offset: 20 })
expect(second.workItems).toHaveLength(7)
expect(second.nextOffset).toBeNull()
```

- [ ] **Step 2: Write failing tests for every filter**

Seed distinct `status`, `assignee`, `department`, `source`, `updated_at`, title, and body values. Assert exact AND-composed results for `text`, `since`, and `until`, alongside each already-supported structured field.

- [ ] **Step 3: Run the focused store tests and verify RED**

Run:

```bash
pnpm --filter jinn-cli exec vitest run src/work-items/__tests__/list-limit.test.ts
```

Expected: FAIL because `queryWorkItems`, `offset`, date filters, and true totals do not exist.

- [ ] **Step 4: Implement the shared query builder and page result**

Add these shapes and behavior:

```ts
export interface ListWorkItemsFilter {
  status?: WorkItemStatus
  department?: string
  assignee?: string
  source?: WorkItemSource
  needsAttentionFor?: string
  text?: string
  since?: string
  until?: string
  limit?: number
  offset?: number
}

export type WorkItemTotals = Record<WorkItemStatus, number>

export interface WorkItemPage {
  workItems: WorkItem[]
  total: number
  totals: WorkItemTotals
  limit: number
  offset: number
  nextOffset: number | null
}
```

Generate one shared `WHERE` clause, use it for the row query and `GROUP BY status` count query, and order rows by ranked items first, `rank ASC`, then `updated_at DESC`, `created_at DESC`, `id ASC`. `listWorkItems` returns `queryWorkItems(filter).workItems`; `searchWorkItems` preserves its “at least one semantic filter” guard.

- [ ] **Step 5: Run the focused store tests and verify GREEN**

Run the Step 3 command. Expected: all focused tests pass.

- [ ] **Step 6: Commit the query substrate**

```bash
git add packages/jinn/src/work-items/store.ts packages/jinn/src/work-items/__tests__/list-limit.test.ts
git commit -m "feat(todos): add paginated filtered work-item queries"
```

### Task 2: Rank schema and persisted manual ordering

**Files:**
- Modify: `packages/jinn/src/work-items/migrate.ts`
- Modify: `packages/jinn/src/work-items/store.ts`
- Test: `packages/jinn/src/work-items/__tests__/migrate.test.ts`
- Test: `packages/jinn/src/work-items/__tests__/store.test.ts`

**Interfaces:**
- Consumes: the query ordering from Task 1.
- Produces: nullable `WorkItem.rank`, additive schema migration for existing databases, and `updateWorkItem(id, patch, actor)` persistence.

- [ ] **Step 1: Write failing migration tests**

Assert fresh schema and an already-migrated schema both expose nullable `rank`, existing rows preserve `rank = null`, and the manual-order index is present.

- [ ] **Step 2: Run migration tests and verify RED**

```bash
pnpm --filter jinn-cli exec vitest run src/work-items/__tests__/migrate.test.ts
```

Expected: FAIL because `rank` and its index are absent.

- [ ] **Step 3: Implement the additive rank migration**

Add `rank REAL` to `WORK_ITEMS_TABLE_DDL`, add a status/rank/recency index, and extend the already-migrated additive-column helper with:

```ts
if (!cols.has("rank")) alters.push("ALTER TABLE work_items ADD COLUMN rank REAL")
```

- [ ] **Step 4: Run migration tests and verify GREEN**

Run the Step 2 command. Expected: migration tests pass.

- [ ] **Step 5: Write failing store tests for persisted rank and fallback order**

Assert ranked rows sort by ascending rank within a status, rank persists across reads, rank `null` restores the unranked bucket, and unranked rows stay deterministically newest-first.

- [ ] **Step 6: Run store tests and verify RED**

```bash
pnpm --filter jinn-cli exec vitest run src/work-items/__tests__/store.test.ts src/work-items/__tests__/list-limit.test.ts
```

Expected: FAIL because work-item updates and rank mapping are absent.

- [ ] **Step 7: Implement metadata/rank persistence**

Extend `WorkItem`/`rowToWorkItem` with `rank: number | null`. Add a whitelist-driven update primitive accepting only:

```ts
export interface UpdateWorkItemInput {
  title?: string
  body?: string | null
  assignee?: string | null
  department?: string | null
  priority?: number
  rank?: number | null
}
```

The update changes only supplied columns, stamps `updated_at`, and appends a `note` event listing changed field names without copying body content into the audit trail.

- [ ] **Step 8: Run focused store tests and verify GREEN**

Run the Step 6 command. Expected: all focused tests pass.

- [ ] **Step 9: Commit rank persistence**

```bash
git add packages/jinn/src/work-items/migrate.ts packages/jinn/src/work-items/store.ts packages/jinn/src/work-items/__tests__/migrate.test.ts packages/jinn/src/work-items/__tests__/store.test.ts
git commit -m "feat(todos): persist manual work-item rank"
```

### Task 3: Gateway list/search shapes and filters

**Files:**
- Modify: `packages/jinn/src/gateway/api.ts`
- Test: `packages/jinn/src/gateway/__tests__/work-items-route.test.ts`

**Interfaces:**
- Consumes: `queryWorkItems` from Task 1 and `WorkItem.rank` from Task 2.
- Produces: identical enriched responses from `GET /api/work-items` and `GET /api/search/work-items`.

- [ ] **Step 1: Write failing route tests**

Assert both endpoints accept `status`, `assignee`, `department`, `source`, `since`, `until`, and `q`; page 2 returns rows beyond 20; invalid offsets/dates are 400; and responses have:

```ts
{
  workItems: WorkItemCompactWire[],
  total: number,
  totals: {
    backlog: number,
    assigned: number,
    executing: number,
    in_review: number,
    done: number,
    blocked: number,
    escalated: number,
    cancelled: number,
  },
  limit: number,
  offset: number,
  nextOffset: number | null,
}
```

- [ ] **Step 2: Run route tests and verify RED**

```bash
pnpm --filter jinn-cli exec vitest run src/gateway/__tests__/work-items-route.test.ts
```

Expected: FAIL because list/search do not expose pagination metadata, `q`, or date filters.

- [ ] **Step 3: Implement route parsing and payloads**

Add strict integer pagination parsing (`limit` default/max 20/100, `offset` default 0), ISO date parsing with inclusive bounds, `q` as the preferred text parameter while preserving legacy search `text`, and compact `rank`. Both routes call `queryWorkItems` and serialize the exact shape above.

- [ ] **Step 4: Run route tests and verify GREEN**

Run the Step 2 command. Expected: route tests pass.

- [ ] **Step 5: Commit the API query surface**

```bash
git add packages/jinn/src/gateway/api.ts packages/jinn/src/gateway/__tests__/work-items-route.test.ts
git commit -m "feat(todos): expose totals pagination and filters"
```

### Task 4: Operator-only Todo metadata PATCH

**Files:**
- Modify: `packages/jinn/src/gateway/api.ts`
- Test: `packages/jinn/src/gateway/__tests__/work-items-route.test.ts`

**Interfaces:**
- Consumes: `updateWorkItem` from Task 2 and existing scoped caller identity/auth logic.
- Produces: `PATCH /api/work-items/:id` with `{ title?, body?, assignee?, department?, priority?, rank? }` and response `{ workItem }`.

- [ ] **Step 1: Write failing PATCH authority and validation tests**

Cover authenticated operator success for title/body and rank, unauthenticated failure, capability-scoped session failure even when assigned, unknown-field failure, status-field failure with transition guidance, non-empty patch requirement, and value validation.

- [ ] **Step 2: Write the lifecycle separation regression test**

Assert `PATCH { status: "done" }` is rejected and leaves status unchanged; then assert the existing `POST /api/work-items/:id/status` path still enforces declared transitions.

- [ ] **Step 3: Run route tests and verify RED**

```bash
pnpm --filter jinn-cli exec vitest run src/gateway/__tests__/work-items-route.test.ts
```

Expected: FAIL because the PATCH route does not exist.

- [ ] **Step 4: Implement operator-only PATCH**

Resolve caller identity through the existing capability-aware seam, require `caller.kind === "operator"`, reject every key outside the metadata/rank whitelist, explicitly reject `status`, validate title/body/nullable ownership fields/priority/rank, roster-check a non-null assignee, call `updateWorkItem`, and return 404 for unknown ids.

- [ ] **Step 5: Run route tests and verify GREEN**

Run the Step 3 command. Expected: route tests pass.

- [ ] **Step 6: Commit operator editing**

```bash
git add packages/jinn/src/gateway/api.ts packages/jinn/src/gateway/__tests__/work-items-route.test.ts
git commit -m "feat(todos): add operator metadata editing"
```

### Task 5: Verification, privacy scan, and integration

**Files:**
- Review: every file changed on the feature branch.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: verified commits fast-forwarded to local `main`, with the worktree removed.

- [ ] **Step 1: Run focused work-items/gateway tests**

```bash
pnpm --filter jinn-cli exec vitest run src/work-items src/gateway/__tests__/work-items-route.test.ts
```

- [ ] **Step 2: Run typecheck and full monorepo suite**

```bash
pnpm typecheck
pnpm test
```

- [ ] **Step 3: Review and leak-scan the staged diff**

```bash
git diff main...HEAD --check
# Run the repository privacy-firewall pattern mandated by the operator instructions.
```

Expected: no whitespace errors and no privacy hits.

- [ ] **Step 4: Fast-forward local main and confirm ancestry**

From the main checkout, ensure it is still at the branch base, run `git merge --ff-only feat/todos-data-asks`, rerun focused tests on the merged result, and verify:

```bash
git merge-base --is-ancestor <feature-sha> main
git rev-parse main
```

- [ ] **Step 5: Remove the owned worktree and feature branch**

```bash
git worktree remove .worktrees/todos-data-asks
git worktree prune
git branch -d feat/todos-data-asks
```
