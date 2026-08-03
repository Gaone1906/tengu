# ICI-682 — Connector identity gets one owner: the instance id

**Branch** `simplify/ICI-682-connector-identity` · **Base** `3bf137e81cc2be8761d4035ab738eddd04e4f0d4` (origin/main)
**Worktree** `~/Projects/.worktrees/jinn-simplify-ICI-682` · **Phase** constrain (this file replaces a stale tracked PLAN.md from ICI-680)

## The defect being removed

The registry is keyed by connector **instance id** (`gateway/server.ts:749`
`connectorMap.set(instance.id, connector)`, id injected into every constructor config at
`server.ts:390`), but every connector except Discord stamps `session.connector` with its
**type name** (`slack/index.ts:17,180,258,374`, `telegram/index.ts:29,305`,
`whatsapp/index.ts:46` + literal `"whatsapp"` at `:312`, `discord/remote.ts:22`). For a
named instance (`{id: "slack-support", type: "slack"}`) the lookup in
`deliverConnectorReply` (`gateway/api.ts:6868-6869`) misses and **silently returns** — the
sole reply-delivery path for `runWebSession` turns (call sites `api.ts:7215, 7398, 7477,
7595`). Session-key prefixes hardcode the type too (`slack/threads.ts:11-23`,
`telegram/threads.ts:14`, `whatsapp/index.ts:308`, reaction key `slack/index.ts:371`), so
two instances of one type collide into one session. `/api/status` keys health by
`connector.name` (`api.ts:2556`) so same-type instances overwrite each other, while
`GET /api/connectors` (`api.ts:6301-6306`) already reads per instance. `server.ts:726`
keeps a parallel `connectors: Connector[]` array whose only uses are push (`:748`), splice
(`:783`), and the shutdown loop — all served by `connectorMap.values()`.

**Load-bearing fact (verified):** legacy top-level config blocks get `id === type`
(`server.ts:397`, pinned by `gateway/__tests__/connectors.test.ts:22-31`), so for every
unnamed install this change is a behavior-preserving rename: stamps, session keys, and
status keys stay **byte-identical**. Only named `instances[]` users change — and their
replies are dropped today, so there is no working behavior to lose.

## The change (mechanical steps)

1. **`shared/types.ts` (~271)** — add `id: string` to the `Connector` interface with a
   one-line JSDoc: the instance id, the registry key; equals the type for legacy top-level
   config. No other interface change. (Sanctioned by the Todo's intended outcome; this is
   the one deliberate public-surface addition.)
2. **Connector classes** — each sets `id` from `config.id` with its type literal as the
   defensive fallback (same pattern Discord already uses):
   - `slack/index.ts`: add `id`; stamp `connector: this.id` at `:180,:258,:374`; derive
     session keys with the id prefix (thread keys via `threads.ts`, reaction key `:371`).
   - `telegram/index.ts`: add `id`; stamp at `:305`; id-prefixed session key.
   - `whatsapp/index.ts`: add `id`; replace literal at `:312`; prefix at `:308`.
   - `discord/index.ts`: delete `instanceId` (`:41,:53`); keep `name = "discord"` as the
     type constant, `id = config.id || "discord"`; replace `this.instanceId` uses
     (`:274,:290`) with `this.id`; fix `proxyToRemote` (`:329`) to pass `this.id` so the
     proxy path derives the same key as the inbound path (`:274`).
   - `discord/remote.ts`: `RemoteDiscordConfig` gains `id?: string`; class sets
     `id = config.id || "discord"`; `server.ts:422` passes `instance.config.id` through.
   - `cron/index.ts`: `id = "cron"` (interface conformance; never in `connectorMap`).
3. **`slack/threads.ts` / `telegram/threads.ts`** — `deriveSessionKey` gains a prefix
   parameter defaulting to the type literal, exactly the shape `discord/threads.ts:3`
   already has. Existing tests keep passing unchanged (default = legacy behavior).
4. **`gateway/api.ts:6868-6869`** — replace the silent `return` with a `logger.warn`
   naming the session id and the unresolved `session.connector` value, then return.
   This failure class must never be invisible again.
5. **`gateway/api.ts:2555-2557`** — key `/api/status` connectors by the registry key
   (iterate `.entries()`), not `connector.name`. Identical output for legacy configs.
6. **`gateway/server.ts:726,748,783` + shutdown loop (~1419)** — delete the parallel
   `connectors: Connector[]` array; use `connectorMap` everywhere.
7. **Prose this change falsifies (taste §4 exception — part of the change, not adjacent):**
   - `template/docs/connectors.md:24` — `connector: string; // Connector name` → instance id
     (resolves the file's self-contradiction with its own line 90).
   - `sessions/context.ts:399` and `:997` — `/api/connectors/<name>/send` → `<id>`.
   - `gateway/api.ts:6270` route comment and `gateway/server.ts:756-757` map comment —
     "names" → "ids". No route or param renames.
8. **Tests (the evidence, per rubric §5.1 — a "hole is shut" claim needs a test that fails
   on base and passes after):**
   - `gateway/__tests__/run-web-session-connector-reply.test.ts` — add the named-instance
     case: map keyed `"slack-support"`, session stamped `"slack-support"` → reply delivered
     (fails on base only via the connector-side stamp change, so pin it at the unit seam:
     lookup with matching id delivers). Rewrite the `:60-64` "missing from map" case — it
     currently pins the silent drop as correct; it now asserts the drop is logged and still
     does not throw.
   - `gateway/__tests__/connectors.test.ts` — assert a constructed named instance carries
     `id` from config and stamps it (slack or telegram, one case; this file already encodes
     the instance-id model).
   - `slack/threads.test.ts` / `telegram/__tests__/threads.test.ts` — one added case each:
     custom prefix yields `<id>:`-prefixed keys; existing literal-prefix assertions stay
     untouched (they now pin legacy byte-identity).
   - No test deletions: no covered behavior is deleted, only the silent-drop pin is
     rewritten into a logged-drop pin.

## Explicitly OUT of scope (report as follow-up Todos, do not touch)

- Hardcoded discord proxy URLs (`discord/index.ts:347`, `remote.ts:100`) — cross-gateway
  addressing, separate concern.
- `POST /api/connectors/:name/send` param rename and `mcp/connector-tools.ts` naming.
- `api.ts:6289-6291` hardcoded `get("whatsapp")` QR route.
- `template/docs/connectors.md:48` wrong channel-root key format (wrong today, not
  falsified by this change) and the stale interface snippet at `:8-20`.
- Web settings cron-delivery picker hardcoding type options
  (`packages/web/src/routes/settings/page.tsx:1776-1786`).
- `sessions/manager.ts:175` `connectorNames()` rename; session-fork connector carryover
  (`registry.ts:1686-1700`); DB backfill of pre-existing named-instance rows
  (`migrate.ts:372` `COALESCE(connector, source)` — legacy rows have `id === type` and
  keep resolving; named-instance rows are already broken today).
- The legacy vs `instances[]` config merge (PLA-53, merged).

## Budget (frozen)

| Field | Value | Note |
|---|---|---|
| `netLineDelta` | **≤ +40** total, **≤ 0 excluding `*.test.ts`** | Relaxation from ≤0 is evidenced: the Todo itself estimates product at −55/+40 ("the win is ownership… not raw line count") and rubric §5.1 mandates new regression tests for the shut hole. All growth budget is test lines. |
| `maxFilesTouched` | **17** | 11 product + 2 prose (`context.ts`, `connectors.md`) + 4 test files. `PLAN.md` excluded from all measurements. |
| `maxNewFiles` | **0** | Tests go into existing files. |
| `maxFileLines` | **7675** | = `api.ts` (7668) + the logged-drop lines. Only `api.ts` (+≤7), `types.ts` (+≤3), `remote.ts` (+≤4), `cron/index.ts` (+≤2), and the 4 test files may grow; every other touched file must not grow. |
| New deps / config options / public exports / single-caller abstractions | **0** | Sole sanctioned surface change: the `id` field on the existing `Connector` interface. The `deriveSessionKey` prefix param copies the existing Discord shape, gaining a second caller pattern — not a new abstraction. |

**budgetCommand** (run from the worktree; non-destructive):

```sh
BASE=3bf137e81cc2be8761d4035ab738eddd04e4f0d4; git diff --numstat "$BASE" -- . ':(exclude)PLAN.md' | awk '{add+=$1; del+=$2; files++} END {printf "netLineDelta=%d\nfilesTouched=%d\n", add-del, files}'; printf "productNetLineDelta=%d\n" "$(git diff --numstat "$BASE" -- . ':(exclude)PLAN.md' ':(exclude)**/*.test.ts' | awk '{add+=$1; del+=$2} END {print add-del+0}')"; printf "newFiles=%d\n" "$(git diff --diff-filter=A --name-only "$BASE" -- . ':(exclude)PLAN.md' | wc -l | tr -d ' ')"; printf "maxFileLines=%d\n" "$(git diff --name-only "$BASE" -- . ':(exclude)PLAN.md' | while IFS= read -r f; do if [ -f "$f" ]; then wc -l < "$f"; else echo 0; fi; done | sort -n | tail -1 | tr -d ' ')"
```

## Acceptance (mechanical)

1. Worktree `~/Projects/.worktrees/jinn-simplify-ICI-682`, branch
   `simplify/ICI-682-connector-identity`, based on `3bf137e81cc2be8761d4035ab738eddd04e4f0d4`.
2. `Connector` interface gains exactly one field, `id: string`, with JSDoc; no other
   interface changes.
3. Every connector class (slack, telegram, whatsapp, discord, discord-remote, cron) sets
   `id` from `config.id` with its type literal as fallback; `DiscordConnector.instanceId`
   is deleted; `createConnector` passes `id` to the remote-discord config.
4. All five `IncomingMessage.connector` stamp sites use the instance id
   (`slack/index.ts:180,258,374`, `telegram/index.ts:305`, `whatsapp/index.ts:312`,
   discord via `this.id`).
5. All session-key prefixes derive from the instance id (slack threads + reaction key,
   telegram threads, whatsapp `:308`, discord `proxyToRemote:329` now matching `:274`);
   for legacy `id === type` configs the keys are byte-identical, pinned by the existing
   unchanged threads-test assertions.
6. The `deliverConnectorReply` miss logs a warn with session id and connector value and
   still returns without throwing; the old silent-drop test is rewritten, not deleted.
7. `/api/status` connectors are keyed by registry key (`.entries()`), identical output for
   legacy configs.
8. The parallel `connectors: Connector[]` array in `server.ts` is deleted.
9. New tests: named-instance reply delivery; logged drop; one custom-prefix case each for
   slack and telegram key derivation; one named-instance stamp case in
   `connectors.test.ts`. No test deletions.
10. Prose fixed only where falsified: `connectors.md:24`, `context.ts:399,997`,
    `api.ts:6270` comment, `server.ts:756` comment. Nothing from the out-of-scope list.
11. `budgetCommand` prints `netLineDelta ≤ 40`, `productNetLineDelta ≤ 0`,
    `filesTouched ≤ 17`, `newFiles = 0`, `maxFileLines ≤ 7675`.
12. Zero new dependencies, config options, or single-caller abstractions; no public
    exports beyond the `id` interface field.
13. After the final commit: `pnpm typecheck`, `pnpm test`, `pnpm build` all green,
    verbatim tails quoted by whoever runs them.
