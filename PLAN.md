# ICI-658 — Persist pinned sessions in the session DB

**Todo (operator's words):** "I want to be able to have the same pinned sessions on all my
devices on all browsers of the same instance. + have an easy way to pull pinned sessions via
MCP & API if not already easy."

**Base:** `main` @ `77d864630b4bd087e4942c6197d3386239e71670`
**Branch:** `build/ICI-658-pinned-sessions-db`
**Feedback this round:** none (first run).

---

## What exists today

Pins are browser-local only. `packages/web/src/components/chat/chat-sidebar.tsx` holds
`pinnedSessions: Set<string>` (line 1223), hydrated from `localStorage["jinn-pinned-sessions"]`
via `getPinnedSessions()` / `savePinnedSessions()` (lines 188-201) and mutated by `togglePin`
(1341) plus two delete-cleanup paths (1364, 1378, 1417).

Two things matter about that Set and constrain the design:

1. **The keys are not all session ids.** Employee groups pin under `emp:<slug>`
   (`pinKey`, lines 1555 / 1578). The same Set, the same menu item, the same toggle.
2. **Order is irrelevant.** Every consumer sorts by activity (`pinnedRows.sort` line 1540,
   `pinnedFlat.sort` line 1586). Only membership is read.

So the durable model the UI actually needs is *a set of opaque pin keys*, not a per-session
boolean. The server nonetheless has to answer "which **sessions** are pinned" for the MCP/API
half of the ask.

There is no server-side pin state at all: no column, no table, no route, no MCP field.

## Approach

**Storage — one table, `chat_pins`,** added to the existing additive/idempotent DDL sequence in
`packages/jinn/src/sessions/registry.ts` (alongside `CREATE_FILES_TABLE` / `CREATE_META_TABLE`):

```sql
CREATE TABLE IF NOT EXISTS chat_pins (
  pin_key   TEXT PRIMARY KEY,
  pinned_at TEXT NOT NULL
)
```

Considered and rejected: a `sessions.pinned_at` column mirroring `archived_at`. It is the
closer neighbour and gets delete-cascade for free, but it cannot hold `emp:` group pins, so it
would leave the sidebar reading one Set from two sources. One mechanism beats two.

The cost of the table is that pin rows must be reaped explicitly when a session is deleted.
That goes **inside** the existing `deleteSession` / `deleteSessions` transactions in
`registry.ts` (2657, 2671), next to the `messages` / `queue_items` deletes — one choke point,
impossible to forget, and it retires the client-side cleanup at chat-sidebar 1378/1417.

**API:**

| Route | Purpose |
| --- | --- |
| `GET /api/pins` | `{ pins: [{ key, kind: 'session' \| 'employee', pinnedAt }] }` — what the sidebar hydrates from |
| `POST /api/pins` `{ key }` | pin (idempotent) |
| `DELETE /api/pins/:key` | unpin (idempotent; `:key` is URI-encoded, `emp:` keys included) |
| `GET /api/sessions?pinned=1` | pinned sessions, serialized through the existing `serializeSessionList` — the operator's "pull pinned sessions via API" |

Writes `context.emit("pins:changed")` so every other browser refetches — this is what makes
"same pins on all my devices" live rather than reload-only.

**MCP:** `list_sessions` gains `scope: "pinned"`, backed by `GET /api/sessions?pinned=1`.
A new enum value on an existing tool, not a new tool — cheaper on the manifest budget and it
lands where an agent already looks.

⚠️ `mcp/__tests__/tool-manifest-budget.test.ts` is a hard gate with **1 token of headroom**
(pi 4910 / ceiling 4911). Adding `"pinned"` will break it. Follow the practice documented in
that file's own comments: buy the tokens back from dead prose first, and only rebase
`MAX_MANIFEST_TOKENS` + the `ATTESTED` hashes with a comment explaining what was bought and
what remains. Do not silently bump the ceiling.

**Web:** replace the two localStorage helpers with a `usePins()` query + pin/unpin mutations
(`lib/api.ts`, `hooks/use-pins.ts`, mirroring `useArchiveSession` in `hooks/use-sessions.ts`),
add `pins` to `lib/query-keys.ts` and a `pins:changed` case to
`hooks/use-query-invalidation.ts`. `pinnedSessions` stays a `Set<string>` derived from the
query, so **every render, sort, float and menu path in chat-sidebar.tsx is untouched.**

Mutations must be **optimistic** — the pin glyph moves on click, not on round-trip. A pin that
waits for the network reads as lag (taste §2, "motion is crisp").

**One-shot migration:** on first load after upgrade, if `localStorage["jinn-pinned-sessions"]`
exists, POST its keys as a **union** with the server set, then remove the localStorage key so
it can never run twice on that browser. Union, not replace: a second device carrying stale
local pins must not clobber the server. Losing the operator's existing pins on upgrade is a
failure, not a nit.

## Acceptance criteria

1. Pinning a chat in browser A makes it appear in the Pinned section of browser B (different
   browser profile, same instance) without either browser being reloaded.
2. Pins survive a gateway restart: pin, restart the sandbox gateway, reload — still pinned.
3. Pinning an employee **group** (`emp:<slug>`) persists identically; group pins and session
   pins round-trip through the same endpoints.
4. Deleting a pinned session removes its `chat_pins` row (asserted directly against the DB),
   and `GET /api/pins` never returns a key for a session that no longer exists.
5. `GET /api/sessions?pinned=1` returns exactly the pinned, non-archived sessions in
   `last_activity DESC` order, in the same serialized shape as `GET /api/sessions`.
6. MCP `list_sessions { scope: "pinned" }` returns those same sessions; an unknown scope still
   errors with the existing message listing the valid scopes.
7. `tool-manifest-budget.test.ts` passes, with either the buy-back or an explicit rebase
   comment naming what was spent.
8. A browser holding pins in `localStorage["jinn-pinned-sessions"]` uploads them once on first
   load (union with whatever the server already has), then the localStorage key is gone; a
   second load performs no further upload.
9. Pin/unpin is optimistic: the glyph and the Pinned section update on click, and a failed
   request rolls the state back rather than leaving a phantom pin.
10. `pnpm typecheck`, `pnpm test`, `pnpm lint` all pass; no regression in the existing
    `chat-sidebar-helpers.test.ts` / `registry.test.ts` suites.

## Tests

- `sessions/__tests__/pins.test.ts` — set/remove idempotency; `emp:` keys round-trip; the
  delete-reaps-pins assertion for AC 4 (write the assertion first, watch it fail against the
  un-reaped code, then wire the reap — taste §5 rule 1, implementer half).
- `sessions/registry.test.ts` — `chat_pins` is created on a legacy DB that predates it.
- `gateway/__tests__` — the four routes: shapes, idempotent double-pin/double-unpin,
  URI-encoded `emp:` key on DELETE, `?pinned=1` ordering and archived-exclusion.
- `mcp/__tests__/session-tools.test.ts` — `scope: "pinned"` hits the right path; unknown scope
  still errors.
- `web/hooks/__tests__/use-pins.test.ts` — the one-shot localStorage union + key removal, and
  optimistic rollback on failure.

## Manual verification

Sandbox only — **never 7777, never 7788, never `~/.jinn`**. Use
`jinn-sandbox.sh up qa-ICI-658 --build --seed` on 7778+, confirm its `config.yaml` port before
starting, drive it with `agent-browser`, and `destroy` it even if the run fails.

Two browser profiles against the same sandbox for AC 1 (a second profile, not a second tab —
localStorage is per-profile and that is the whole point of the ticket). Screenshot the sidebar
Pinned section at 1440×900 and 390×844, light and dark, per taste §2 — the section is existing
UI and must look identical to before; the ticket changes where pins live, not how they look.

## Out of scope

- The tab-level `pinned` flag in `hooks/use-chat-tabs.ts` (`localStorage["jinn-chat-tabs"]`).
  Same word, different feature: VS Code-style preview-tab pinning, per-device by design.
- Every other sidebar localStorage key (`jinn-read-sessions`, `jinn-sidebar-collapsed`,
  `jinn-sidebar-expanded`, `jinn-sidebar-older-expanded`, `jinn-sidebar-focus-mode`). If
  syncing those is wanted, it is a follow-up Todo.
- Any change to how the Pinned section looks, sorts, or which sessions float into it
  (`shouldFloatPinned`'s cron exemption stays exactly as it is).
- Per-user pin scoping. Pins are per-instance, which is what "same pins on all my devices on
  all browsers of the same instance" asks for.

## Noted, not fixed

`PLAN.md` is tracked at the repo root and each build overwrites the previous ticket's plan —
this worktree started with ICI-648's. Adjacent to the ticket, so it is reported rather than
fixed (taste §4). Worth a follow-up: the build pipeline should write plans to an ignored path.
