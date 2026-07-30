# ICI-648 — Optimise Web UI performance

Branch `build/ICI-648-web-perf` · base `16e1bdff907e538f0e758c297394cda07ebebfdb`

The request names five axes: page loading, todo loading, asset loading, rendering,
scrolling. Each one below is tied to a measured baseline taken on this branch, so
"measurable gains" means a number that moved, not an impression.

---

## Measured baseline (taken on this worktree, `pnpm --filter @jinn/web build`)

| Thing | Baseline | Where |
|---|---|---|
| `/todos/:todoId` route chunk | **519.38 kB raw / 170.10 kB gzip** | `out/assets/task-page-*.js` |
| Tiptap + ProseMirror inside it | present (`grep` hit) | `routes/todos/task-page/body-editor.tsx` static import |
| Board cold-load enrichment requests | **up to 120** (60 `GET /api/work-items/:id/tree` + 60 `GET /api/work-items/:id`) | `use-board.ts:useBoardTrees`, `use-todos.ts:useOpenDetails`, cap `boardDetailIds(…, 60)` |
| Static asset compression | re-run **per request** (brotli q5, no cache) | `gateway/server.ts:295-302` |
| Board card memoisation | none | `routes/todos/board/card.tsx` |
| Route chunk prefetch | none — every navigation shows a spinner while its chunk downloads | `main.tsx` + `lib/lazy-route.tsx` |
| Total built JS | 3,402,356 B across 336 files | `out/assets` |

Already good, deliberately left alone: route-level code splitting, `PrismAsyncLight`
with a registered language subset, lazy emojilib / xterm / xyflow / global-search,
passive scroll listeners, memoised `MessageRow` in chat, immutable `Cache-Control`
on hashed assets, brotli/gzip negotiation, react-query `staleTime`/`gcTime`.

---

## Work

### W0 — Lock the gains in a harness (do this first)
Files: `packages/web/scripts/perf-budget.mjs` (new), `packages/web/perf-budgets.json`
(new), `packages/web/package.json` (add `perf:budget` script).

Reads the emitted `out/assets/*`, gzips each tracked chunk, and exits non-zero when a
tracked chunk or the initial critical path exceeds its budget. Also asserts named
modules are absent from named chunks (e.g. `prosemirror` must not appear in the
task-page chunk). Budgets file records `baseline` (today's number) next to `budget`
(the new ceiling) so the diff itself carries the evidence.

### W1 — Page + asset loading
1. `routes/todos/task-page/body-editor.tsx` — move the tiptap editor behind
   `React.lazy` + `Suspense`. The read-only path already renders `MarkdownView`;
   the ProseMirror bundle loads on entering edit mode. No visual change.
2. `gateway/server.ts:serveStatic` — memoise compressed bytes for hashed
   `/assets/*` responses, keyed by resolved path + mtime + encoding, with a bounded
   cache. These files are content-addressed and immutable, so compressing them once
   is correct. Non-hashed paths keep streaming as today.
3. `lib/lazy-route.tsx` + the nav component — expose a `prefetch()` on each lazy
   route and call it on `pointerenter`/`focus` of a nav link, plus `requestIdleCallback`
   for the two most-used routes. Failures are swallowed; prefetch never surfaces an
   error or blocks navigation.

### W2 — Todo loading (the N+1)
4. Gateway: add `GET /api/work-items/trees?ids=a,b,c` in `gateway/api.ts`, backed by a
   new `getWorkItemTrees(ids)` in `work-items/store.ts` that does one `WHERE root_id IN (…)`
   read and one grouped session-spend query for the whole set. Same auth as the
   single-item route. Additive only: `GET /api/work-items/:id/tree` stays.
5. Same shape for the detail fan-out (`useOpenDetails`) — either a batch
   `ids=` form of the list route or fold the two `reason` fields the board needs into
   the batch tree payload, whichever keeps the wire type honest. Decide in code review
   of the wire types; do not invent a third contract.
6. Web: `useBoardTrees` / `useOpenDetails` call the batch endpoints. Query keys,
   `staleTime`, and `placeholderData` behaviour unchanged.

### W3 — Rendering
7. Memoise `routes/todos/board/card.tsx` (and its `CardTree` child) so a column
   refetch that changes one card does not re-render the other 59. Stabilise the
   callbacks passed into it in `board-page.tsx`.

### W4 — Scrolling
8. `content-visibility: auto` + `contain-intrinsic-size` on board cards and chat
   message rows, so offscreen rows skip layout and paint. CSS-only; keeps drag,
   FLIP, streaming, and auto-scroll intact. Verified by a style assertion plus the
   manual browser pass — no virtualisation, see out of scope.

---

## Acceptance criteria

1. `pnpm --filter @jinn/web build && pnpm --filter @jinn/web perf:budget` exits 0, and
   exits non-zero when a tracked chunk is inflated past its budget (prove by
   temporarily raising a chunk, capturing the red output, reverting).
2. The `/todos/:todoId` route chunk is **≤ 85 kB gzip** (from 170.10 kB), and a grep of
   that built chunk finds no `prosemirror` / `tiptap`. Both asserted by the harness.
3. Editing a Todo body still works: the body renders read-only markdown on load, and
   entering edit mode loads the editor, focuses it, and saves the same markdown as
   today. Existing `routes/todos/__tests__/task-page.test.tsx` passes, plus a new test
   for the lazy boundary.
4. Rendering the board with 60 enrichable cards issues **≤ 2** enrichment fetches
   (was up to 120). Asserted by a web test counting `fetch` calls.
5. `GET /api/work-items/trees?ids=…` returns, for every id, a payload deep-equal to
   `GET /api/work-items/:id/tree` for that id. Asserted by a gateway test over a seeded
   set including a root with children and a leaf.
6. The batch route rejects more than 100 ids with a readable 400, omits unknown ids
   without failing the request, and refuses unauthenticated callers exactly as the
   single-item route does. One test each.
7. Serving the same hashed asset twice compresses once: a counter/spy shows one
   compression pass for two requests, and the two responses are byte-identical with
   identical headers.
8. Re-rendering the board after one card's data changes re-renders that card only.
   Asserted by a render-count test.
9. Hovering a nav link starts its route chunk load at most once; a rejected prefetch
   surfaces no error and does not break the subsequent real navigation. One test.
10. No functional regression: `pnpm typecheck`, `pnpm lint`, `pnpm test` green in both
    packages, verbatim tails pasted. Plus a manual pass on a **throwaway sandbox**
    (own `JINN_HOME`, own non-prod port — never 7777, never 7788) covering chat
    load + stream, board load + drag + column paging, task page open + body edit +
    save, org map, workflow run, notes; screenshotted at 1440×900 and 390×844 in
    **both** light and dark.
11. A before/after table is posted to the Todo: per-chunk gzip bytes, board enrichment
    request count, and the static-serve compression count.

---

## Out of scope (report, do not do)

- **Virtualising the Todos board columns or the chat message list.** Both carry drag,
  FLIP, streaming and auto-scroll; virtualising them is its own Todo with its own
  verification. `content-visibility` is the low-risk substitute this round.
- Replacing `react-syntax-highlighter`, `@xterm`, `@xyflow`, or `@dagrejs/dagre` with
  lighter dependencies.
- HTTP/2 / TLS on the gateway; router-level data loaders; any form of SSR.
- Reworking `chat-messages.tsx` — its rows are already memoised; touching it here is a
  refactor of code the bug is not in.
- The 336-file language-chunk tail from `PrismAsyncLight`: those load on demand and do
  not sit on any critical path.
- Anything under `~/.jinn`, and any process on port 7777 or 7788.

---

## Risks

- **New wire contract.** The batch endpoints are additive and the single-item routes
  stay, so an old web build against a new gateway keeps working. Do not delete either
  single-item route.
- **Lazy editor changes focus timing.** The edit-mode test must assert focus lands in
  the editor after the chunk resolves, or body editing regresses silently on slow links.
- **Compression cache is memory.** Bound it (count and total bytes) and key on mtime so
  a rebuilt `dist/web` is never served stale.
