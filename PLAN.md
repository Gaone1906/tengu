# ICI-659 — Todos don't update in realtime in the dashboard

**Base:** `77d864630b4bd087e4942c6197d3386239e71670` (main)
**Branch:** `build/ICI-659-todo-live-updates`
**Scope:** `packages/web` only. The gateway already emits everything we need.

> Note: this file arrived on main carrying the ICI-648 plan. Each build branch overwrites it;
> the ICI-648 text is preserved in that branch's history.

---

## What the operator asked for

> Todos don't seem to be updating always in realtime when I change their status or sth like
> that. We need an optimal way that is not too boggy that will allow realtime or near-real
> time updates so that the user can see everything update. You can also introduce optimistic
> updates since I can see that it takes time to update a record in the db. but I want to see
> state change snappy.

Two asks: (a) remote changes must land live and reliably, (b) the operator's own changes must
feel instant. "Not too boggy" rules out polling and rules out a refetch storm per event.

---

## What the code actually does today

The gateway side is fine. `notifyTodoChanged` / `persistTodoMutationActivity`
(`packages/jinn/src/work-items/live-events.ts`, `packages/jinn/src/gateway/api.ts:1485`) emit
`company:changed` with `entity: "todo"` **and the full `WorkItem` as `value`** on every status
transition, metadata edit, delegation, and projection write. No gateway change is needed.

The client drops it. Four independent defects in `packages/web`:

**D1 — the debounce can starve forever.**
`use-query-invalidation.ts:157` clears and re-arms a 1000 ms trailing timer on *every* accepted
event. There is no max-wait. On a busy gateway (several agents running → a steady stream of
`session:updated` / `company:changed` / `cron:*` at under 1 s intervals) the flush never runs,
so the todo reconciliation pass never runs. This is the "doesn't update **always**" in the
report: it fails precisely when the company is busy, which is when the operator is watching.

**D2 — the defer is global, not todo-scoped.**
`use-query-invalidation.ts:164` holds every todo invalidation while `qc.isMutating() > 0`.
`isMutating()` counts *all* mutations app-wide — spawning a session, saving a note, saving a
skill (`hooks/use-sessions.ts`, `routes/notes/use-notes.ts`, `routes/skills/detail.tsx`). A
slow unrelated mutation blocks todo freshness for its whole duration. The guard is meant to
protect an in-flight *todo* write from a mid-flight clobber; it should only fire for those.

**D3 — the surgical patch cannot move a card between columns.**
`mergeTodoIntoCaches` (`routes/todos/todo-edit-request.ts:72`) rewrites the matching item
in-place inside every `["work-items"]` cache. The board is one infinite query *per status*
(`board/use-board.ts:88`), and `itemsByStatus` (`board/board-page.tsx:137`) renders a column
straight from `data.columns[status].items` without consulting `item.status`. So a live status
change patches the item to `status: "done"` while it keeps rendering in `executing` until a
full refetch lands. The card is stale *and* internally contradictory.

**D4 — a WS reconnect never reconciles Todos.**
`connectionSeq` (`hooks/use-gateway.tsx:60`) drives catch-up for chat (`use-live-session.ts`)
and engine limits (`routes/limits/use-engine-limits.ts:201`), but nothing on the Todos side
listens. After a sleep/drop/reconnect, every event missed while the socket was down is lost;
only an incidental window-focus refetch recovers it.

Separately, on the write side: `useSetWorkItemStatus` and `useBoardTransition`
(`use-todos.ts:113`, `board/use-board.ts:213`) have no `onMutate` at all. Each surface
reinvents its own local optimism — the board's `moves` map, needs-you's `resolvingIds`, the
task page's detail-only `setQueryData` — so a status change made on the task page leaves the
board's cached copy stale, and vice versa.

---

## The change

### 1. Fix the delivery lane (`hooks/use-query-invalidation.ts`)

- Add a **max-wait** to the debounce: keep the 1000 ms quiet window, but also record the
  timestamp of the first pending event and force a flush once 2000 ms have elapsed since it,
  no matter how much traffic keeps arriving. Coalescing is preserved (the existing burst test
  still passes); starvation is not possible.
- Scope the defer: replace `qc.isMutating() > 0` with
  `qc.isMutating({ mutationKey: TODO_WRITE_KEY }) > 0`, and tag the todo write mutations
  (`useSetWorkItemStatus`, `useBoardTransition`, `useBoardRank`, `useDecideApproval`,
  `useCreateSubTask`) with that key. Export the key from `lib/query-keys.ts` so both sides
  read one constant.

### 2. Reconcile on reconnect (`hooks/use-query-invalidation.ts`)

Consume `connectionSeq` from `useGateway`. When it bumps past the first mount, queue the same
`todos` reconciliation the debounced flush performs. Debounced through the existing timer, so
a flapping socket cannot produce a refetch storm.

### 3. Derive a card's column from its own status (`board/board-page.tsx`)

In `itemsByStatus`:
- **evict** items from a column whose patched `item.status` no longer equals that column;
- **adopt** items found in any other loaded column whose `item.status` now equals it, inserted
  in rank order.

This makes a merged WS payload move the card immediately, with no refetch — the "near-real
time without being boggy" requirement. The existing `moves` overlay stays (it carries the
drop *slot*), but its insertion is guarded so it can never produce a duplicate of a card the
cache already relocated.

Column counts follow the same overlay: displayed total = server total + adopted − evicted, so
a header can never contradict the cards beneath it. This mirrors the existing due-filter
fallback at `board-page.tsx:525`.

### 4. One shared optimistic status write (`use-todos.ts`, `board/use-board.ts`)

Give `useSetWorkItemStatus` and `useBoardTransition` a real `onMutate` that patches `status`
into **every** cached projection of that Todo (both `["work-items"]` and `["work-item"]`),
snapshots the prior value, and rolls back on error. Combined with (3), a status change made on
any surface moves the card on every other surface within a frame, and a gateway refusal puts
it back.

The optimistic patch must not disturb the version fence: it writes `status` only and leaves
`version` at the cached value, so a later server payload (version strictly greater) always
wins in `mergeTodoValue`.

---

## Acceptance criteria

1. A continuous stream of gateway events arriving faster than the quiet window still flushes
   the pending todo reconciliation within the max-wait. Test: fire an event every 200 ms for
   3 s with fake timers, assert `invalidateQueries({queryKey:["work-items"]})` was called.
   Must fail on the current code (revert the fix, watch it go red).
2. A todo event is **not** deferred by an unrelated in-flight mutation (one built with no
   mutation key), and **is** still deferred by an in-flight todo write (built with the todo
   write key). Both assertions in one test file.
3. A `company:changed` todo payload whose `value.status` differs from the column the card is
   cached in causes the board to render that card in the new column, and only there (no
   duplicate), **before** any refetch resolves.
4. That same relocation moves the column counts: the source header decrements and the target
   header increments, so header count === rendered card count in both.
5. Calling the status mutation optimistically shows the new status immediately in both the
   board caches and the `["work-item", id]` detail cache; a rejected request restores the
   previous status in both.
6. A `connectionSeq` bump (WS reconnect) triggers the todo reconciliation pass; the initial
   mount does not.
7. `pnpm typecheck`, `pnpm lint`, `pnpm test` all pass from the worktree root, and the
   existing `use-query-invalidation-todos.test.tsx`, `board-page.test.tsx`,
   `board-drag.test.tsx`, `task-pickers.test.tsx` suites still pass unmodified except where a
   test asserts behaviour this change deliberately replaces (each such edit justified in the
   commit body).

Manual/browser check (mandatory, `jinn-sandbox` on 7778+, never 7777/7788): with the board
open, transition a Todo from a second client and confirm the card moves without a page
refresh; drag a card and confirm it lands instantly and does not snap back. Screenshot at
1440×900 and 390×844, light and dark. Destroy the sandbox afterwards even if the run failed.

---

## Out of scope

- Any change to `packages/jinn` — the gateway emits correctly today.
- Polling, SSE, or any new transport. The existing WS lane is sufficient once it is honoured.
- Reworking the board's `moves` / needs-you `resolvingIds` / task-page local overlays into one
  mechanism. Guarded against duplication here; a genuine unification is a follow-up.
- Optimistic writes for metadata edits, labels, comments, and attachments. Status is what the
  operator named.
- Any change to the version-fencing/CAS contract in `todo-edit-request.ts` beyond adding the
  guarded optimistic patch.
- The `total`/pagination contract on the gateway list endpoint.
