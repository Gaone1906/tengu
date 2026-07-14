# JIN-N Sole Todo Identifier Implementation Plan — v6

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` or `executing-plans` with `dev-workflow` and `test-driven-development` to implement this plan task by task. This document is architecture and implementation sequencing; it does not authorize implementation or production cutover.

**Goal:** Make `JIN-1`, `JIN-2`, and so on the sole Todo identifier: the actual database primary key and the value used visibly and internally by API, MCP, UI, routes, search, logs, accessibility, copy/share, browser DOM, and browser storage.

**Architecture:** Rekey the Todo primary key and every mutable structured reference in one offline SQLite transaction. Leave unstructured historical prose and contractually immutable evidence byte-identical and non-resolving; use a small event-keyed presentation only where immutable Activity structure cannot be rewritten. Allocate all future ordinals through a durable multi-process-safe high-water and append-only burn ledger, with a guard release before the migration release and forward-only recovery after the served seal.

**Tech Stack:** TypeScript, SQLite through `better-sqlite3`, Vitest, Commander, MCP tools, React 19, React Router 7, TanStack Query, Playwright/browser QA, and a reviewed descriptor-relative filesystem helper for Workflow/native transcript reads.

## Global Constraints

- This architecture phase changes and commits this plan only. It does not change production code, tests, schemas, fixtures, runtime data, company state, the running gateway, deployment, release, or publication.
- The fixed v1 canonical grammar is `^JIN-[1-9][0-9]*$`. The exact legacy grammar is `^wi_[0-9a-f]{12}$`.
- `JIN-N` is deliberately visible and predictable. It is not a secret, bearer token, capability, or authorization decision. Every read and write continues through normal authentication and authorization.
- `work_items.id` is the sole Todo identity. No numeric surrogate, opaque public/private Todo ID, compatibility alias, salted Todo route reference, or live old-to-new resolver survives cutover.
- Historical `wi_*` literals may remain in immutable evidence and unstructured prose. Post-cutover they are inert text: no resolver accepts them, no UI auto-links them, no route redirects them, and no action treats them as a Todo.
- Structured, live, or executable Todo references are rekeyed or rejected. Ambiguous structured state fails closed; prose is never mass-rewritten merely because it contains an exact token.
- Workflows never create or mutate Todos. Todo-status events remain a one-way Workflow trigger; `source=workflow` remains historical provenance only.
- Todo versions and non-identity evidence do not change during migration.
- Production cutover remains a later explicit operational approval.

---

## Accepted Decisions

The operator's superseding decision is accepted as **Decision A**:

- `JIN-N` is the canonical database key and the normal product identifier everywhere.
- Browser URLs use `/todos/JIN-42`; authenticated REST continues to use `/api/work-items/JIN-42`.
- UI text, accessibility, DOM attributes, history, storage, React keys, logs, search, copy, and share may contain `JIN-N` intentionally.
- There is no Todo privacy layer. Remove the v5 A/B rendering branch, `td_*` private Todo resolver, message-reference epoch, content-origin/presentation tables, DOM masking, and transcript sanitizer work that existed only to hide canonical or inert historical literals.

The remaining conservative defaults are architecture decisions, not open product questions:

| Decision | v6 choice |
|---|---|
| Allocation failure | Permanently burn every ordinal committed before Todo creation; gaps are normal and numbers are never reused |
| Migration order | `created_at COLLATE BINARY`, then legacy `id COLLATE BINARY` |
| Recovery after serving | Forward repair only; never restore the legacy backup, reverse-rekey, or reseed |
| Nonterminal Workflow runs | Any exact legacy token in executable state blocks migration; no execution projection |
| Immutable callback/Activity bytes | Preserve raw evidence; rekey live copies and use event-keyed Activity presentation where raw hashes forbid rewrite |
| Cross-instance behavior | Refusal-only; no import, merge, collision remap, or alias protocol |
| Browser drafts | Clean-tab/no-draft-loss cutover; stale journals remain copyable and never auto-map |
| Release boundary | Guard release `G = 0.27.0`, migration release `M = 0.28.0`; changing either requires an explicit plan amendment |
| Prefix | Fixed `JIN-` for v1 |

No irreversible product choice remains outstanding. The later irreversible action is operational: authorizing the maintenance window and publishing the served seal after rehearsal.

## Identity Semantics

### Canonical and legacy parsing

Add one shared Todo identity module with:

```ts
parseLegacyTodoId(value: unknown): string | null
findLegacyTodoIds(value: string): string[]
parseTodoId(value: unknown): { id: string; ordinal: number } | null
formatTodoId(ordinal: number): string
```

`parseLegacyTodoId` accepts the whole exact lowercase 12-hex form only. `findLegacyTodoIds` recognizes the same token only when adjacent characters are absent or outside `[A-Za-z0-9_]`, then revalidates each candidate through `parseLegacyTodoId`. The canonical parser rejects zero, leading zeroes, signs, whitespace, case variants, separators, and values above `Number.MAX_SAFE_INTEGER`.

Every Todo identity ingress uses this module. No route trims, case-folds, follows a legacy redirect, accepts a numeric suffix alone, or consults the migration manifest.

### Why inert text is not a hidden second identity

Identity is behavior, not spelling. A historical sentence such as `previous attempt used wi_00000000000a` is not a second Todo identity after cutover because:

1. `parseTodoId` rejects it;
2. store/API/MCP/UI resolvers do not query it;
3. no old-to-new map remains at runtime;
4. search returns it only as ordinary text evidence, never as an ID equality match;
5. links, buttons, callbacks, Workflow conditions, and mutation paths do not act on it.

Do not add transcript sanitizers, provenance tables, private message references, or DOM masking to remove such text. Preserve authored prose, titles, excerpts, errors, historical prompts, tool output, and immutable evidence unless an enumerated schema says a field is a live Todo reference.

## Authoritative Structured Reference Graph

The migration owns this closed graph. A repository-wide structural sweep is repeated immediately before implementation to catch drift.

### SQLite and structured JSON

| Reference | Current producer/consumer | Class | v6 action |
|---|---|---|---|
| `work_items.id` | `work-items/store.ts`, store CRUD, REST, MCP, UI | Canonical identity | Rebuild as the checked `JIN-N` primary key; preserve every non-ID field and `version` |
| `work_items.source_ref` | source idempotency/provenance and unique `(source, source_ref)` lookup | Non-Todo producer identity | Preserve byte-for-byte; never parse or rewrite it as a Todo even if an external value coincidentally matches legacy grammar |
| `work_items.approval_ref` | approval correlation | Non-Todo approval identity | Preserve byte-for-byte; it is not a Todo resolver input |
| `work_item_events.work_item_id` | Todo event append/list and `workflow-event-feed.ts` | Live logical edge | Rekey; preserve event ID (`wie_*`), order, timestamps, actor, status, and `detail` bytes |
| `sessions.work_item_id` | session linking, spend/reconcile/completion/deletion | Live logical edge | Rekey every non-null value |
| `sessions.session_key` / `source_ref` exactly `delegation:<TodoID>` | delegation route and queue routing | Structured routing identity | Rekey each recognized field independently and matching `queue_items.session_key` |
| `sessions.transport_meta.delegationCompletionContract.workItemId` | completion claim/surface/release | Structured live metadata | Rekey linked and detached duplicated contracts; malformed supported shape or inconsistent linked value aborts |
| Pending/dead manager callback `source_attempt=manager-visibility:<TodoID>` | `sessions/callbacks.ts` | Retryable structured identity | Rekey with its coupled payload and live projections |
| Pending/dead manager callback `payload.meta.workItemId` and exact platform Todo line in `payload.message` | callback delivery/requeue | Retryable executable identity | Rekey as one validated schema before retry can occur |
| Accepted callback row | exactly-once evidence | Immutable structured evidence | Preserve bytes; it is never requeued, resolved, or returned as a live Todo contract |
| Accepted callback linked `queue_items.prompt` and notification `messages.meta` | acceptance fan-out | Mutable live copies | Rekey recognized Todo line/metadata while preserving row identity/status/timestamps |
| `messages.blocks` Todo block `id=todo:<id>` + `payload.todoId` | `gateway/chat-activity.ts`, block replay/UI | Structured live identity | Rekey the coupled fields and validate equality |
| Delegation block `id=dg-<id>` + `payload.workItemId` | delegation callback/route | Structured live identity | Rekey the coupled fields and all duplicate copies |
| Block `payload.activityReceipt.id` and `messages.meta.activityReceiptId` | activity receipt/reload suppression | Structured reference | Rekey when tied to a rewritten Todo/delegation block |
| `messages.meta.workItemId` / exact `sourceAttempt` | manager visibility and duplicates | Structured live metadata | Rekey by recognized schema, independently of callback links |
| Synthetic `messages.id=block-${block.id}-${uuid}` | `applyBlockEnvelope`; page/search/context/reload | Live message identity containing structured Todo text | Directly rekey recognized Todo/delegation rows, preserving UUID suffix; update every mutable durable message-ID reference in the same transaction |
| `work_item_edit_receipts` fingerprint | CAS/idempotency | Old-epoch derived receipt | Preserve bytes, stamp identity epoch, and refuse epoch-1 replay with reload/new-key; never resolve through it |
| `workflow_todo_event_claims.event_id` | Todo-status trigger claim | Non-Todo identity | Preserve; it references `work_item_events.id`, not a Todo |

The current schema has logical edges without complete SQL foreign keys, so the migration must validate and update them explicitly. It may add foreign keys only if the complete existing lifecycle is proven compatible; FK introduction is not required to deliver this ticket.

### Synthetic message IDs: direct rekey

Do not create `message_public_refs`, a message-reference epoch, or opaque block/message aliases.

For an exact validated block row:

```text
block-todo:wi_00000000000a-<uuid> -> block-todo:JIN-42-<same uuid>
block-dg-wi_00000000000a-<uuid>   -> block-dg-JIN-42-<same uuid>
```

Precompute a collision-free old-message-ID to new-message-ID set. In the SQLite swap, update `messages.id`, any `callback_deliveries.message_id`, and every other discovered mutable structured reference to that message ID. FTS is rowid-backed, so the text primary-key rewrite does not require an alias. Old external page/context cursors cease resolving after the clean-tab boundary. APIs, MCP, WebSocket, DOM, and browser history may emit/use the rekeyed actual message ID normally.

Terminal immutable Workflow evidence may still mention an old message ID as inert evidence. A mutable or unknown reference blocks migration rather than creating a compatibility resolver.

### Accepted callback states

Every accepted callback is exactly one of:

- **fully projected:** target session, linked notification message, and linked internal queue row all exist and belong together; preserve the callback row and rekey the live copies;
- **all-absent tombstone:** target session, linked message, and linked queue row are all absent after supported session deletion; preserve the callback row and prove it is excluded from pending/dead/requeue/replay/live serializers.

Every partial presence permutation, ownership mismatch, or accepted row exposed through a retry path is corruption and aborts migration. Full-scan duplicated `transport_meta`, `messages.meta`, and `messages.blocks`; supported duplication breaks original relational links and is not corruption.

### Immutable Activity

`activity_events` rows and payload hashes are immutable, while current projection/query code reconstructs structured object IDs, hrefs, links, and search rows from raw bytes. Rewriting raw events would violate audit integrity.

Add one authoritative epoch-2 Activity presentation keyed by Activity event ID. It stores only current structured presentation fields—canonical Todo object ID, canonical `/todos/JIN-N` href/link, and enumerated Todo identity members—plus the identity epoch. It contains no legacy key and accepts no lookup by old ID, so it is not a second Todo identity or alias.

Activity list, story, search, projection rebuild, and REST/MCP serializers must join this presentation for migrated Todo events. Raw labels, summary, detail, and historical prose remain byte-identical. The presentation is authoritative current state, not rebuildable from raw legacy Activity after the temporary map is dropped. A missing or epoch-mismatched presentation refuses serving/search and may be restored only from a verified current epoch-2 snapshot/replica; otherwise the instance remains offline. No repair path consults a retained legacy map.

### Immutable Workflow evidence

Terminal `completed`, `failed`, and `cancelled` Workflow bytes may retain old structured fields and prose only as explicitly inert historical evidence. Current serializers may display them inside an evidence envelope marked non-resolving, but must not project an old value into a current `todoId`/`workItemId`, produce a Todo link/action, or feed it into a new condition, prompt, callback, retry, resume, or resolver.

Every `running` run—including one carrying a `stopping` drain field—plus every `parked` or `dispatched` run is nonterminal. Any exact legacy token in raw bytes or recursively decoded executable keys/values blocks migration, regardless of active-index, engine, or queue state.

## Session-Level Field Classification

This closes the v5 session-field omission without inventing a presentation layer.

| Session field | Classification | v6 treatment |
|---|---|---|
| `work_item_id` | Todo identity | Rekey |
| `session_key`, `source_ref` | Mixed | Rekey exact `delegation:<legacyId>` only; preserve all other producer/session identities |
| `transport_meta` | Mixed structured JSON | Rekey enumerated completion/manager Todo fields; preserve other known metadata; unknown metadata claiming a Todo identity aborts |
| `title` | Display prose | Preserve byte-for-byte; render/search as inert text |
| `prompt_excerpt` | Historical prompt prose | Preserve byte-for-byte; render/search as inert text |
| `last_error` | Diagnostic prose | Preserve byte-for-byte; render through existing error surfaces |
| `reply_context` | Connector routing object | Preserve exactly; channel/thread/chat/message values belong to connector namespaces and must continue routing |
| `message_id` | Connector message identity | Preserve exactly; it is not a Todo ID even if the external value coincidentally matches the legacy grammar |
| `engine_session_id`, `engine_sessions` | Native engine identities | Preserve as their own namespace; no Todo alias behavior |
| parent/workflow/run/phase/user/attempt fields | Other typed identities/state | Preserve; they do not resolve a Todo |

Message `content`, attachment labels/URLs, `tool_call`, `tool_id`, generic queue prompts, callback errors, and block title/summary/error/preview are prose or non-Todo protocol fields. Preserve them. Rekey only the enumerated block/meta/callback shapes above.

## Epoch-2 Workflow Ingress

Add one shared guard:

```ts
rejectLegacyTodoTokensAtWorkflowIngress(value: unknown, identityEpoch: number): void
```

At epoch 2 it recursively visits every own decoded string key and string value under bounded depth/node/byte limits and rejects exact boundary-delimited legacy IDs using the shared parser. It does not echo the token in errors. JSON escapes such as `wi_00000000000\u0061` are caught after decode.

Call the guard before filters, static-output `fireRef` derivation, idempotency hashing/claim, persistence, condition evaluation, prompt construction, session spawn, or Activity at all executable ingress points:

- Workflow definition/SOP create, update, and duplicate;
- custom webhook/poll trigger create, update, approval, and activation contract;
- manual run `input`, `stepOverrides`, and idempotency request envelope;
- pending step-prompt edit;
- webhook event name/payload/keys/values/fireRef;
- parsed poll payload/keys/values/fireRef;
- internal custom-event producers;
- engine/probe step settlement outcome, nested fields, failure/error detail, and any value persisted for successor conditions or prompts;
- every loaded nonterminal run before save/resume/sweep/advance, complete definition at the final run boundary, and decoded live `state.json` control fields before gate/path evaluation;
- final `startWorkflowRun` and `startWorkflowRunFromTrigger` boundaries, plus the complete effective condition/prompt envelope immediately before every dispatch, as defense in depth.

Canonical `JIN-N` values execute normally. Near matches are ordinary text. Todo-status triggers source their canonical ID from the rekeyed event feed.

## Closed Workflow Artifact Inventory

Migration scans only the managed, authority-bearing set, plus named legacy inputs still consumed by current code:

- `<evidenceRoot>/workflows/*.definition.json`;
- `<evidenceRoot>/workflow-triggers/triggers.json`;
- `<pollExecutionCwd>/workflow-trigger-artifacts/<64-lower-hex>/poll-script` (a second pinned root, normally the instance home);
- `<evidenceRoot>/reports/runs/<safe-workflow>/<safe-run>.json`;
- `<evidenceRoot>/reports/runs/_active-index.json` as derived data, never status authority;
- `<evidenceRoot>/reports/run-idempotency/<64-lower-hex>.json`;
- legacy `<evidenceRoot>/state.json`;
- legacy `<evidenceRoot>/workflows/*.workflow.yaml`;
- legacy `<evidenceRoot>/reports/waves/wave-<N>.json`.

Classification follows current consumers. `state.json` fields that gate live work are executable. Legacy YAML/wave fields used only for history are inert; any decoded field still controlling a path, gate, or execution must pass the epoch-2 guard. Unexpected managed suffixes, temp/orphan artifacts, invalid encodings, unknown run status, malformed JSON/YAML, or budget overflow fail closed or require explicit operator cleanup.

### Staged poll executables

Every trigger-referenced staged script and every unexpected/orphan staging entry is inventoried through the pinned poll-artifact root. Verify the stored digest, parse the allowed static `printf` output with the runtime parser, and recursively reject legacy keys/values.

At migration, every pre-`M` poll approval is logically invalid because its activation contract lacks `identityEpoch: 2`. Readers expose it as pending/disabled without rewriting `triggers.json`; only a later authenticated reapproval writes the new epoch-2 activation contract with artifact and static-output digests. Dirty or unprovable artifacts remain disabled. Runtime still guards the parsed payload so a changed/dynamic result cannot create an epoch-2 legacy-bearing run.

## Descriptor-Relative Filesystem Safety

Path `lstat` plus final-component `O_NOFOLLOW` is insufficient because a parent can be swapped to a symlink and restored (ABA). Add a small reviewed handle-relative helper using native `openat`/`fdopendir`-equivalent operations:

1. open the configured trusted root with directory-only/no-follow flags and keep the descriptor;
2. enumerate through that descriptor;
3. validate each relative component against the closed grammar;
4. open every parent relative to the prior descriptor with directory-only/no-follow flags and retain the full chain;
5. open the final file relative to its pinned parent with read-only/no-follow/nonblocking flags;
6. `fstat` regular type, ownership/mode/link/device expectations, and size caps;
7. read bounded chunks only from the descriptor, then post-`fstat` before accepting bytes.

Never reopen, enumerate, or authorize by string path after the root is pinned. Diagnostics include only artifact class, validated relative locator, phase/reason, and digest—never absolute paths, raw foreign bytes, token values, prose, or symlink targets. If a supported platform cannot provide equivalent handle-relative ancestry guarantees, migration and native adoption are hard no-go on that platform; there is no path-based fallback.

Use the same helper for current native transcript adoption and reopen. Bind authenticated engine generation, validated relative locator/component identities, file device/inode or platform file identity, expected size/offset, and prefix digest. Rotation, truncation/regrowth, path reuse, ancestry drift, or descriptor loss freezes ingestion until fresh authenticated adoption. Do not sanitize transcript prose or sever native history merely because it contains `wi_*` or `JIN-N` text.

## Allocator and Sole-ID Schema

Rebuild `work_items.id` with a database check equivalent to the canonical parser and no legacy/public/surrogate column.

Add:

```sql
CREATE TABLE todo_id_allocator (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_value INTEGER NOT NULL CHECK (
    typeof(last_value) = 'integer'
    AND last_value >= 0
    AND last_value <= 9007199254740991
  )
) WITHOUT ROWID;

CREATE TABLE todo_id_allocations (
  value INTEGER PRIMARY KEY CHECK (
    typeof(value) = 'integer'
    AND value >= 1
    AND value <= 9007199254740991
  ),
  allocated_at TEXT NOT NULL
) WITHOUT ROWID;
```

Database triggers reject allocator singleton delete/reinsert/replace, equal/decreasing/skipped high-water updates, and allocation-ledger update/delete. Migration seeds before installing guards.

Future creation uses two `BEGIN IMMEDIATE` transactions:

1. recheck `(source, source_ref)` under the SQLite write lock;
2. increment high-water by exactly one, insert the same ledger value, validate high-water equals ledger max, commit, then return `JIN-N`;
3. in a second immediate transaction, recheck `(source, source_ref)` and either return the winner while leaving `N` burned, or atomically insert the Todo and its `created` event.

An allocation transaction that never commits never hands out a number. Every ordinal returned by the allocator already has durable burn evidence and can never be reused after Todo failure, duplicate race, archive, delete, crash, or repair. Multi-process writers serialize on SQLite's lock. Boot and repair require:

```text
last_value = MAX(todo_id_allocations.value) (or zero/empty)
last_value >= maximum live JIN suffix
```

The burn ledger is not a Todo identity table and is never queried by Todo resolvers.

## Deterministic Offline Migration

### Map and manifest

Validate every source primary key against exact legacy grammar. Assign ordinals by:

```sql
ORDER BY created_at COLLATE BINARY ASC, id COLLATE BINARY ASC
```

The unique old ID makes this a total stable order independent of rowid, insertion order, copy, rebuild, or `VACUUM`. The temporary bidirectional map exists only during offline staging/swap and is dropped before validation completes.

Write a permission-restricted manifest with source/backup digests, `G`, `M`, exact grammars, ordering rule, row count, mapping digest, immutable evidence inventory, and pre/post invariant hashes. The retained manifest contains no per-Todo old/new pairs. It is offline audit/recovery evidence, never a resolver, and no supported code can recover an old-to-new correspondence from it after the temporary map is dropped.

### Preflight

Before opening request intake:

1. acquire exclusive instance ownership before ordinary `initDb()` migration/startup;
2. refuse a second gateway, active/waiting/partial turn, pending executable queue item, dirty transcript sync, or nonterminal legacy-bearing Workflow run;
3. checkpoint WAL, take an exclusive lock, run `PRAGMA integrity_check`, and validate exact supported schemas;
4. create a SQLite backup through the backup API, fsync it, reopen it independently, run integrity check, and record its digest;
5. require recorded clean-tab/no-draft-loss attestation from guard release `G`;
6. full-scan the structured reference graph, duplicates, accepted callback states, message-ID references, Activity rows, and edit receipts;
7. descriptor-scan the closed Workflow and staged poll inventories;
8. verify mixed-version guard marker `G`, target release `M`, and no unsupported opener;
9. build/fsync the deterministic manifest and invariant snapshot before destructive SQL.

### Atomic SQLite swap

Inside one exclusive transaction:

1. create and validate the one-to-one temporary Todo map and message-ID rekey map;
2. rebuild `work_items` with the checked `JIN-N` primary key;
3. rekey events, sessions, delegation routing/queue keys, completion contracts, pending/dead callbacks, accepted callback live copies, duplicated structured metadata, blocks, receipts, and synthetic message primary keys;
4. preserve accepted callback bytes, all-absent tombstones, Todo/event prose/detail, session prose/non-Todo identities, and generic message/queue content;
5. add identity epoch 2 to edit receipts and refuse epoch-1 replay;
6. materialize authoritative Activity presentation for immutable migrated events without changing raw rows/hashes;
7. seed allocation ledger `1..N` and high-water `N`, then install immutability guards;
8. record identity epoch 2, manifest digest, `G`, and `M`;
9. drop the temporary maps;
10. run transaction-local invariants and commit once.

Filesystem Workflow evidence is never pseudo-transactionally rewritten. Nonterminal offenders block; pre-`M` poll approval is computed inactive until an authenticated epoch-2 reapproval writes a new contract; terminal evidence stays inert.

### Post-commit validation

Before serving, prove:

- every Todo primary key is canonical and every mutable structured reference resolves to one current Todo;
- no alias column/table/resolver, private Todo route ref, temporary map, or legacy identity ingress remains;
- Todo counts, versions, states, timestamps, source/provenance, approvals, event order, and non-ID bytes match the pre-snapshot;
- structured duplicates, callbacks, blocks, receipts, direct-rekeyed message IDs, page/search/context/MCP/WebSocket outputs, and Activity links consistently use `JIN-N`;
- all-absent accepted tombstones stay absent/inert and partial accepted states are zero;
- title/excerpt/error/message/tool/connector/reply prose and identities remain byte-identical and do not auto-resolve;
- every nonterminal Workflow artifact and every epoch-2 executable ingress is legacy-free; terminal raw hashes are unchanged;
- Activity raw rows/hashes are unchanged and list/story/search/rebuild/API uses current presentation;
- allocator high-water, ledger max, live suffix, and permanent-burn invariants hold;
- `PRAGMA integrity_check` succeeds;
- a second migration invocation is a byte/counter no-op with the same manifest digest.

## Recovery and Mixed-Version Boundary

Migration states are:

```text
legacy -> staged -> swapping -> validated -> complete-unserved -> served
             \-> failed (startup refused)
```

- Backup restoration is allowed only in `complete-unserved`, while the external served seal is absent and no post-migration write/allocation occurred.
- Immediately before `server.listen`, atomically publish and fsync an external seal binding instance identity, manifest digest, target epoch, and first-served timestamp. The seal lives outside the restorable database backup and dominates the DB marker after a crash.
- After the seal exists, legacy restore, reverse rekey, allocator reseed, and downgrade are categorically forbidden.
- Forward repair starts from the current epoch-2 DB/WAL, snapshots it, preserves every post-cutover Todo/event/session/message/callback write and burn, and proves `H_after >= H_before`. Failed repair rolls back to the current migrated state, never the legacy backup.

Release `G = 0.27.0` serves only exact guarded legacy state, installs epoch/draft/executable-ingress guards, and refuses staged/newer/mixed state. Release `M = 0.28.0` performs migration only through the explicit offline command and serves epoch 2 only after the seal. Binaries `<G` must be stopped before cutover; binaries `[G,M)` refuse staged or migrated state; binaries `>=M` refuse unguarded legacy, incomplete, corrupt, mixed, or newer epochs. Request/client epoch mismatch returns one consistent upgrade-required response before any mutation.

## API, MCP, CLI, UI, Search, and Copy Contract

### API and MCP

- REST Todo routes use `/api/work-items/JIN-42`; every route parameter/body field parses canonical grammar before lookup.
- MCP Todo, approval, delegation, and session-link tools accept and emit `JIN-N` in their documented structured fields.
- Exact legacy and malformed identity input rejects without redirect, mapping, or old-to-new disclosure.
- Response objects, event feeds, callback live data, logs, and errors identify current Todos as `JIN-N`.
- Existing authority checks for operator, owner, manager/root, reviewer, approval, and bound session remain independent of ID parsing.

### CLI

There is no current live Todo CRUD CLI, so do not invent one for parity. The offline migration/status command emits canonical IDs after cutover and never exposes a lookup/remap operation. Unknown `todos import`/merge commands remain unsupported.

### Web

- Add canonical `/todos/:todoId`; Todo row, Activity/delegation Open, reload, back/forward, and share use `/todos/JIN-42`.
- Show `JIN-N` adjacent to the title in list/detail/Activity/delegation, include it in accessible names, and add Copy ID plus Copy Link.
- React Query keys, React keys, DOM/data attributes, history, URL search, `sessionStorage`, and `localStorage` may contain canonical IDs normally.
- Delete `todoPrivateRef`, tab salts, `td_*` resolution, private Todo history state, and privacy comments/masking. Do not add `cm_*`, `cb_*`, `mr_*`, or opaque block/message refs for Todo hiding.
- Fresh draft journals key by canonical ID and identity epoch.

Guard release `G` requires dirty legacy drafts to be completed or explicitly copied before offline cutover. An epoch-2 client seeing an unexpected old `td_*` journal preserves it read-only with explicit Copy/Discard; it never clears it silently and never resolves `td_*` or `wi_*` to a Todo. Old history/private refs are ignored, not mapped.

### Search and copy

- Exact canonical search performs ID equality and returns the canonical Todo.
- Free-text title/body/session/history search remains text search. A historical `wi_*` prose match is displayed only as text and never linked/resolved as a Todo.
- Search query URLs/storage may contain `JIN-N`.
- Copy/share emits `JIN-N` and `/todos/JIN-N` intentionally.

## Authentication, Authorization, and Enumeration

Predictable IDs must never weaken authority:

- gateway authentication runs before Todo grammar/existence checks;
- MCP tools require their existing authenticated/bound caller context;
- mutation routes retain row/role/approval authority checks after ID parsing;
- the store never treats successful parsing as authorization;
- Todo links do not carry bearer secrets.

Authenticated operator/company-ledger readers may enumerate the instance ledger by design. Unauthorized callers may not infer existence by guessing sequential IDs: known and unknown candidates receive the same pre-auth response. An unauthorized bound employee guessing adjacent IDs cannot mutate them. Same-origin loopback with explicitly disabled auth is operator authority by configuration, not knowledge-of-ID authority.

## Refusal-Only Cross-Instance Contract

Two independent instances may each own `JIN-1`. REST/MCP always resolves within the selected instance. Current product surfaces have no Todo/session database import, merge, or collision-remap operation.

- `/api/work-items/import` remains unknown;
- `import_work_items` remains absent;
- no `jinn todos import` command is added;
- instance listing/creation moves no data;
- manual database copying is unsupported filesystem mutation, not an import contract.

Any future import/merge requires separate architecture. This ticket contains no remapper, alias, source fingerprint, or compatibility protocol.

## RED to GREEN Implementation Sequence

Every task starts with a focused failing test, demonstrates the expected failure, adds the smallest production change, reruns focused tests, and commits independently. Implementation may start only after this docs-only architecture handoff is accepted.

### Task 1: Parser, checked primary key, and permanent-burn allocator

**Files:**

- Add `packages/jinn/src/work-items/id.ts`
- Add `packages/jinn/src/work-items/allocator.ts`
- Modify `packages/jinn/src/work-items/migrate.ts`
- Modify `packages/jinn/src/work-items/store.ts`
- Add/modify focused tests under `packages/jinn/src/work-items/__tests__/`

**RED:** grammar/boundary corpus, malformed/overflow values, 16/32-process distinct and duplicate sourceRefs, fail-after-burn, restart, archive/delete nonreuse, singleton/ledger SQL attacks, exhaustion, and numeric ordering.

**GREEN:** one parser/formatter, checked actual primary key, `BEGIN IMMEDIATE` allocator, append-only burn evidence, and separate atomic Todo/event creation.

### Task 2: Guard release `G`, migration state, backup, seal, and forward repair

**Files:**

- Add `packages/jinn/src/work-items/identity-migration.ts`
- Add `packages/jinn/src/work-items/identity-manifest.ts`
- Add `packages/jinn/src/work-items/identity-cutover.ts`
- Add `packages/jinn/src/work-items/identity-forward-repair.ts`
- Modify `packages/jinn/src/sessions/registry.ts`
- Modify `packages/jinn/src/gateway/server.ts`
- Add `packages/jinn/src/cli/todo-identity.ts`
- Modify `packages/jinn/bin/jinn.ts`
- Add migration/fault-injection worker tests

**RED:** deterministic maps across shuffled/rowid-varied databases with tied timestamps; malformed/mixed schemas; exclusive-owner races; crash at every state/manifest/seal boundary; pre-serve restore; seal-before-listen crash; create-after-cutover then restore refusal; forward repair preserving high-water and new rows; full `G`/`M` mixed-version matrix.

**GREEN:** exact preflight, verified backup, one swap transaction, durable manifest/seal, idempotent completion, pre-serving-only restore, and forward-only repair.

### Task 3: Complete structured reference graph and direct message-ID rekey

**Files:**

- Modify `packages/jinn/src/work-items/identity-migration.ts`
- Modify `packages/jinn/src/work-items/store.ts`
- Modify `packages/jinn/src/sessions/registry.ts`
- Modify `packages/jinn/src/sessions/callbacks.ts`
- Modify `packages/jinn/src/sessions/delegation-completion-contract.ts`
- Modify `packages/jinn/src/gateway/chat-activity.ts`
- Modify `packages/jinn/src/shared/blocks.ts`
- Add focused session/callback/block/migration tests

**RED:** one graph fixture containing event/session edges, delegation keys/queue, linked and detached completion contracts, pending/dead callback, accepted fully-projected callback, all-absent tombstone, every partial corruption, duplicated manager metadata/blocks, receipts, and synthetic Todo/delegation message PKs. Assert direct PK/reference rekey, no collision, no opaque ref schema, no structured legacy ID, and byte-identical prose/session connector fields.

**GREEN:** schema-aware transactional rewrite of every mutable reference, preserved accepted evidence, and direct actual-ID output through page/search/context/MCP/WebSocket.

### Task 4: Activity presentation for immutable structured evidence

**Files:**

- Modify `packages/jinn/src/activity/migrate.ts`
- Modify `packages/jinn/src/activity/projection.ts`
- Modify `packages/jinn/src/activity/store.ts`
- Modify `packages/jinn/src/activity/query.ts`
- Modify Activity REST/MCP serializers and tests

**RED:** snapshot raw rows/hashes containing Todo object IDs/hrefs/links and inert prose; migrate; rebuild/search/list/story/API twice after temporary map deletion; expect JIN structured fields, unchanged raw hashes/prose, no old-ID resolver, and refusal on missing/wrong-epoch presentation.

**GREEN:** authoritative event-keyed epoch presentation used by every current Activity consumer.

### Task 5: Workflow executable guard, closed scan, and staged poll reapproval

**Files:**

- Add `packages/jinn/src/workflows/todo-identity.ts`
- Modify `packages/jinn/src/workflows/custom-triggers.ts`
- Modify `packages/jinn/src/workflows/poll-trigger.ts`
- Modify `packages/jinn/src/workflows/poll-artifacts.ts`
- Modify `packages/jinn/src/workflows/definition-store.ts`
- Modify `packages/jinn/src/workflows/run-store.ts`
- Modify `packages/jinn/src/workflows/run-reconciler.ts`
- Modify Workflow API/MCP ingress and focused tests

**RED:** nested/escaped legacy keys and values at webhook, poll, manual start, definition, trigger, idempotency, and prompt-edit ingress; assert no filter/claim/run/file/session/prompt/Activity side effect. Cover direct internal start defense; engine/probe outcome and error detail feeding a successor; the complete pre-dispatch condition/prompt envelope; post-seal mutation of a parked/running run or live `state.json`; every nonterminal form regardless of stale/omitted active index; terminal inert evidence; corrupt/unknown status; static poll output with a legacy token; logical pending state for a clean pre-`M` approval without trigger-store rewrite; and runtime rejection after reapproval.

**GREEN:** one bounded recursive guard at every ingress and executable artifact read/settlement/dispatch, fail-closed nonterminal preflight, exact terminal inertness, and crash-safe epoch-2 poll approval contract.

### Task 6: Descriptor-relative Workflow/native transcript reads

**Files:**

- Add a focused native/TypeScript handle-relative reader under `packages/jinn/src/shared/`
- Route Workflow artifact readers in `definition-store.ts`, `custom-triggers.ts`, `run-store.ts`, `derive.ts`, `index.ts`, and `poll-artifacts.ts` through it
- Route native adoption/reopen in `gateway/external-turns.ts`, `engines/transcript-tailer.ts`, and current Codex/Grok/Antigravity discovery through it
- Add hostile-filesystem and native-rotation tests

**RED:** final symlink, FIFO/device/socket, sparse/oversize, parent ABA swap-and-restore, final replacement during read, truncation/growth, unsupported platform, native rotate-before-open, truncate/regrow, reopen/path reuse. Assert zero foreign read/hash/diagnostic/persist/emit.

**GREEN:** pinned-root, component-relative no-follow descriptor traversal with bounded reads; native binding freezes on ancestry/file drift and performs no transcript sanitization.

### Task 7: Canonical API/MCP/routes/search/copy and authorization

**Files:**

- Modify Todo REST and MCP tools to share the parser
- Modify `packages/web/src/main.tsx`
- Modify `packages/web/src/lib/todos.ts`
- Remove/simplify `packages/web/src/routes/todos/todo-private-state.ts`
- Modify Todo page/hooks/rows/detail, Activity/delegation cards, draft journals, global search, and tests
- Update active public template skill examples; leave historical migrations/plans unchanged

**RED:** API/MCP grammar matrix; unauthenticated known/unknown/sequential IDs all fail before existence; unidentified MCP/tool caller refusal; unauthorized adjacent-ID mutation leaves versions unchanged; authorized operator/owner/manager/root/reviewer cases; canonical deep-link/reload/back/forward/search/share/copy/a11y/DOM/storage; Activity click; stale `G` tab receives upgrade response with journal retained; orphan `td_*` journal is copy-only; no private resolver/salt/alias.

**GREEN:** intentional `JIN-N` use on every product surface with auth/authz independent of predictability and no legacy acceptance.

### Task 8: Full rehearsal and release gates

**Files:** test harnesses, release constants, active docs/templates, and the new versioned migration note only.

**RED/GREEN evidence:** full tests, typecheck, lint, build; disposable `G -> M` migration; backup digest; crash matrix; poll reapproval; clean-tab/no-draft-loss; Activity/search/API/browser inspection; direct SQL invariant scan; cross-instance refusal; leak scan; second-run no-op; independent implementation review.

## Architecture and Deployment Gates

### Implementation NO-GO

Implementation stops if any of the following becomes true:

- a hidden/opaque/secondary Todo identity or runtime legacy map is required;
- a mutable structured reference is unclassified;
- synthetic message IDs cannot be rekeyed transactionally without an unknown mutable reference;
- nonterminal Workflow legacy state can execute after cutover;
- webhook/poll/manual/internal Workflow ingress can persist an exact legacy token;
- parent-safe descriptor-relative traversal is unavailable on a supported platform;
- allocator burn/high-water invariants can be reduced, deleted, skipped, or reused;
- backup restoration remains possible after the served seal;
- predictable ID knowledge bypasses authentication or authorization;
- dirty draft bytes would be discarded or silently mapped;
- cross-instance import/remap is added to this ticket.

### Deployment GO

Production cutover requires all tasks green, disposable rehearsal evidence, a clean independent implementation review, exact `G` and `M` artifacts, proof all binaries `<G` are stopped, a maintenance window, named pre-serving restore owner, named post-serving forward-repair owner, and explicit authorization to publish the served seal.

Until then, do not migrate, restart for migration, deploy, release, publish, or mutate a production instance.

## Current-Code Audit Evidence

The v6 graph was re-audited against current source after all v1-v5 reports:

- Todo PK/events/allocation: `packages/jinn/src/work-items/migrate.ts`, `store.ts`, `workflow-event-feed.ts`.
- Sessions/duplication/callbacks/message PKs: `packages/jinn/src/sessions/registry.ts`, `callbacks.ts`, `delegation-completion-contract.ts`.
- Manager fan-out and block producers: `packages/jinn/src/gateway/api.ts`, `chat-activity.ts`, `packages/jinn/src/shared/blocks.ts`.
- Session raw consumers: `packages/jinn/src/gateway/api.ts`, `packages/jinn/src/talk/graph.ts`, `packages/jinn/src/mcp/session-tools.ts`, `packages/web/src/components/global-search.tsx`, `packages/web/src/hooks/use-live-session.ts`.
- Workflow run/ingress/conditions/prompts: `packages/jinn/src/workflows/run-store.ts`, `run-reconciler.ts`, `custom-triggers.ts`, `poll-trigger.ts`, `poll-artifacts.ts`, `definition-store.ts`, `condition.ts`, `handoff.ts`, `derive.ts`, `index.ts`.
- Activity immutability/raw reconstruction: `packages/jinn/src/activity/migrate.ts`, `projection.ts`, `store.ts`, `query.ts`, and Activity REST serialization.
- Native path readers: `packages/jinn/src/gateway/external-turns.ts`, `packages/jinn/src/engines/transcript-tailer.ts`, and Codex/Grok/Antigravity discovery adapters.
- Auth boundary: `packages/jinn/src/gateway/auth.ts`, `server.ts`, Todo route authority helpers, and MCP caller binding.
- Web route/private-state stack: `packages/web/src/main.tsx`, `lib/todos.ts`, `routes/todos/todo-private-state.ts`, Todo page/hooks/detail/rows, and `components/chat/company-activity-card.tsx`.
- Cross-instance surface: `packages/jinn/bin/jinn.ts`, CLI instance commands, gateway API routing, and MCP tool registry expose no Todo import/merge.

The simplification is deliberate: v6 retains data integrity, execution safety, filesystem ancestry safety, immutable evidence, recovery, mixed-version, draft, and authorization protections while deleting machinery whose only purpose was to conceal the canonical identifier or inert historical text.
