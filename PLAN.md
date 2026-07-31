# ICI-658 — Pinned sessions persisted in DB · RESUME (land the reviewed branch)

**Todo (operator's words):** "I want to be able to have the same pinned sessions on all my
devices on all browsers of the same instance. + have an easy way to pull pinned sessions via
MCP & API if not already easy."

**Feedback this round:** "intuitively merge it. resolve conflicts" (operator, on the blocked
`land` node).

**Branch:** `build/ICI-658-pinned-sessions-db` @ `4055a2f4`
**Base:** `main` @ `5242f915b009cc2b26fe416aaaff01c73e30532b`

---

## State

The feature is built and independently verified `ship` (Blockers 0, Majors 0, Minors 0,
comment `wic_7671127032ba`). The operator approved the land. The `land` node then failed:
`main` had moved from `77d86463` to `5242f915` and no longer merged cleanly.

So this round is not a rebuild. It is: bring the branch up to current `main`, resolve the
conflict, re-run the gates on the merged HEAD, and hand back a branch that lands.

## What actually conflicts

`git merge-tree 5242f915 4055a2f4` reports exactly one conflict:

| File | Verdict |
|---|---|
| `PLAN.md` | **CONFLICT** — both sides rewrote it whole. It is a per-build scratch artifact tracked at the repo root; every build overwrites the previous ticket's plan. |
| `packages/web/src/hooks/use-query-invalidation.ts` | Auto-merges. `main` restructured the file (156 lines); the branch adds a 3-line `case 'pins:changed'`. Merged output keeps that case at the head of the same `switch`, next to `notes:changed`, both immediate-invalidate-and-`return`. Structurally correct — but it is a textual auto-merge into a heavily rewritten file, so it gets verified by tests, not by inspection. |
| `packages/web/src/lib/query-keys.ts` | Auto-merges. `main` adds `TODO_WRITE_KEY`, the branch adds `queryKeys.pins`. Both survive. |

Nothing else on the branch (gateway `api.ts`, `registry.ts`, `session-tools.ts`,
`chat-sidebar.tsx`, the six test files, `use-pins.ts`) is touched by `main` since the base.

## Approach

1. In the existing worktree `~/Projects/.worktrees/jinn-build-ICI-658`, on
   `build/ICI-658-pinned-sessions-db`, merge current `main` (`5242f915`) **into the branch**.
   Merge, not rebase: it leaves the two reviewed commits (`1c8768f8`, `4055a2f4`)
   byte-identical, so the `ship` verdict still applies to them and only the merge commit is new.
2. Resolve `PLAN.md` to **this file** (the branch side). `PLAN.md` always reflects the most
   recently landed build; taking the incoming ticket's plan is the consistent rule.
3. Run the full gates on the merged HEAD. `main`'s rewrite of `use-query-invalidation.ts` is
   the only place the merge could have gone semantically wrong, and both invalidation suites
   cover it.
4. Re-run the cross-browser pin QA on the merged HEAD in an isolated sandbox, because AC1/AC2
   were proven on pre-merge code.

## Acceptance criteria

1. `git merge-tree --write-tree main <new HEAD>` exits 0 — current `main` merges the branch
   with zero conflicts.
2. `packages/web/src/lib/query-keys.ts` on the merged HEAD exports **both** `TODO_WRITE_KEY`
   (from `main`) and `queryKeys.pins` (from the branch).
3. `packages/web/src/hooks/use-query-invalidation.ts` on the merged HEAD still routes
   `pins:changed` to an immediate `invalidateQueries({ queryKey: queryKeys.pins })`, and
   `main`'s Todo invalidation is intact — proven by `use-query-invalidation-company.test.tsx`
   **and** `use-query-invalidation-todos.test.tsx` both passing.
4. `pnpm typecheck`, `pnpm test`, and `pnpm build` are green on the merged HEAD, run after the
   final edit. Test count is at or above the 5,068 the round-2 verifier recorded.
5. Browser QA on the merged HEAD, in a throwaway sandbox on a non-production port: pinning a
   chat in browser A makes it appear under Pinned in browser B with neither reloaded, and the
   pin survives a gateway restart. (Re-proves original AC1 and AC2 post-merge.)
6. The diff `4055a2f4..<new HEAD>` contains no product-code changes — only the merge of `main`
   and `PLAN.md`. No new feature work, no refactors.
7. Leak-grep of the full branch diff against `main` is clean.

## Out of scope

- **Untracking `PLAN.md`.** It is the systemic cause of this conflict and it will block the
  next build the same way, but fixing it changes the `jinn-build` workflow contract, not this
  ticket. Reported, not fixed. (Also flagged in round 1.)
- Any change to pin behaviour, schema, API shape, or the Pinned section's visuals. The feature
  passed review; a merge round is not the place to touch it.
- The other open build worktrees (ICI-640, ICI-651, ICI-660) that will hit the same `PLAN.md`
  conflict.
- Pushing or deploying. The `land` node merges.

## Safety

Sandbox QA only: throwaway `JINN_HOME`, port 7778+ (never 7777, never 7788), via the
`jinn-sandbox` skill, destroyed afterwards even on failure. Kill only PIDs this run started.
No other worktree is touched.
