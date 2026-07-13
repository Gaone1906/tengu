# JIN-N Sole Todo Identifier Implementation Plan

> **Required execution skill:** Use `dev-workflow` and `test-driven-development` task by task. This document is an architecture gate, not implementation authorization.

**Goal:** Replace every live canonical Todo identifier with one immutable, instance-local `JIN-N` identifier, with no runtime `wi_*` alias and no observable mixed identity.

**Architecture:** A fixed-format text primary key remains the sole Todo identity. A SQLite singleton allocator mints monotonically increasing numbers inside the same immediate transaction that inserts the Todo. A one-time, offline, manifest-backed migration deterministically rekeys authoritative references while preserving approved immutable evidence as inert, non-resolving history. The gateway refuses incomplete, corrupt, newer, or mixed identity epochs.

**Tech stack:** TypeScript, SQLite through `better-sqlite3`, Vitest, Commander, MCP tools, React 19, React Router 7, TanStack Query, Playwright/browser QA.

## Gate Status and Scope

This plan is the only artifact permitted by the architecture phase. Production code, tests, schemas, fixtures, runtime databases, instance files, and the running gateway remain unchanged.

Implementation is **blocked** until a fresh reviewer who did not author this plan approves the reference map, historical-evidence policy, migration state machine, privacy interpretation, and go/no-go decisions in this document. Approval must be recorded outside the repository plan before the first RED test is added.

The migration must eventually satisfy all of these invariants:

1. `JIN-1`, `JIN-2`, and so on are the only identifiers accepted or emitted by live Todo resolvers.
2. The canonical ID is the `work_items.id` primary key. There is no hidden numeric key, alias table, compatibility resolver, or runtime old-to-new map.
3. The allocator is transactional, concurrency-safe, immutable after commit, monotonic within one instance, and never reuses a committed number.
4. Existing Todos are mapped deterministically by creation order with a stable tie-breaker.
5. Every authoritative live reference changes atomically with the primary key.
6. Historical evidence that is contractually immutable stays byte-identical, is inventoried in the manifest, and becomes permanently non-resolving.
7. Workflows never create or mutate Todos. Todo-status events continue to trigger Workflows in one direction. `source=workflow` remains historical provenance only.
8. Todo versions do not change during identity migration. Existing optimistic-concurrency semantics remain intact.
9. Canonical Todo IDs may traverse authenticated API/MCP network payloads, but must not enter browser URL/history, browser storage, or rendered DOM. The UI uses salted private references.
10. The production gateway is not migrated until sandbox rehearsal, independent review, and an explicit deployment decision are complete.

## Decisions Proposed for Approval

### Fixed identifier format

Use a fixed uppercase `JIN-` prefix for v1. The grammar is:

```text
^JIN-[1-9][0-9]*$
```

The number is a positive base-10 integer with no sign, whitespace, separators, zero, or leading zeroes. Prefix configurability is deliberately excluded from v1: it adds parser, migration, privacy, import, and support states without improving the required instance-local identity model.

### Sole-ID schema

`work_items.id` remains the only canonical identity. Do not add `legacy_id`, `public_id`, `todo_number`, or a numeric surrogate. Rebuild the table with an ID constraint equivalent to:

```sql
CHECK (
  substr(id, 1, 4) = 'JIN-'
  AND length(id) >= 5
  AND substr(id, 5) NOT GLOB '*[^0-9]*'
  AND substr(id, 5, 1) BETWEEN '1' AND '9'
  AND length(substr(id, 5)) <= 16
  AND (
    length(substr(id, 5)) < 16
    OR substr(id, 5) <= '9007199254740991' COLLATE BINARY
  )
)
```

SQLite `GLOB '*'` is not a digit quantifier, so the negative character-class check is required. The application parser additionally converts the suffix to a safe integer and rejects values above `Number.MAX_SAFE_INTEGER`.

### Allocator

Add one singleton table:

```sql
CREATE TABLE todo_id_allocator (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_value INTEGER NOT NULL CHECK (
    last_value >= 0 AND last_value <= 9007199254740991
  )
) WITHOUT ROWID;
```

`createWorkItem()` must execute this order under `BEGIN IMMEDIATE`:

1. Recheck `(source, source_ref)` idempotency inside the transaction. If it exists, return it without consuming a number.
2. Atomically increment `last_value` while it is below the safe-integer ceiling and use the returned value as `N`.
3. Insert the Todo and its `created` event.
4. Commit once.

Concurrent writers serialize at SQLite's write lock. A rolled-back candidate was never committed or observable and may be attempted again; every committed identifier is permanent and is not reused after archive or deletion. If “never reused” is intended to include uncommitted attempted numbers, that is a different durability contract and is a no-go decision because it conflicts with an atomic transactional allocator.

### Canonical ordering

Human-facing Todo ordering must not use lexicographic ID order (`JIN-10` before `JIN-2`). Existing semantic sort keys remain primary; an ID tie-break uses the parsed numeric suffix or allocator ordinal. Migration assignment uses byte-stable legacy ordering, not the new display ordering.

## Reference Classification

Every discovered occurrence belongs to exactly one class:

| Class | Meaning | Migration rule |
|---|---|---|
| Authoritatively rewritable | Live structured state whose value resolves, joins, patches, or emits a Todo | Rewrite atomically; dangling, malformed, or ambiguous values abort |
| Derived/rebuildable | Cache, index, projection, browser-private state, or operational receipt that can be regenerated or epoch-invalidated | Rebuild or invalidate; never preserve as an alias |
| Immutable historical evidence | Audit bytes covered by accepted history, payload-hash, callback, or legacy Workflow preservation contracts | Preserve bytes; inventory; disable resolution/navigation/requeue |
| External/exported | Value already returned to a caller or copied outside the instance | Cannot be recalled; reject old input after cutover and publish an epoch boundary |
| Non-reference string | Opaque provenance, identifier in another namespace, prose, user data, or a coincidental substring | Preserve exactly; never regex-rewrite |

The phrase “sole canonical ID” applies to resolvable live identity. It cannot mean deleting every `wi_*` byte: user prose, frozen evidence, old plans, cron job IDs such as `wi-job`, event IDs such as `wie_*`, and the offline migration manifest legitimately retain those bytes. The proof boundary is that no such byte can resolve, mutate, navigate to, or be emitted as the current identity of a Todo.

## Exhaustive Producer/Consumer Graph

### Canonical SQLite state

| Reference | Producer | Consumers | Class | Migration action and invariant |
|---|---|---|---|---|
| `work_items.id` | `work-items/store.ts:generateWorkItemId`, `createWorkItem` | Store CRUD, REST, MCP, delegation, cron, UI payloads | Authoritatively rewritable | Rebuild PK with strict `JIN-N` check; preserve every non-ID column byte/value and `version` |
| `work_items.source_ref` | REST create, cron, delegation, historical Workflow imports | Unique `(source, source_ref)`, session provenance projection | Non-reference string | Preserve bytes; values identify producer executions, not the Todo |
| `work_items.approval_ref` | `work-items/approvals.ts` | Approval request/decision evidence | Non-reference string | Preserve bytes; contract explicitly defines it as opaque correlation data |
| `work_item_events.id` (`wie_*`) | `work-items/store.ts:appendEvent` | Event list, Workflow claim identity | Non-reference string | Preserve; it is an event identity, not a Todo identity |
| `work_item_events.work_item_id` | Todo transitions and creation | Event history, `workflow-event-feed.ts`, Todo-status trigger | Authoritatively rewritable with audit exception | Rekey only this relational envelope; preserve event ID, row order, timestamps, statuses, actor, and `detail` bytes |
| `work_item_events.detail` | Transitions, approvals, reconciliation | Audit/UI/Workflow provenance snapshot | Immutable evidence or non-reference | No recursive replacement. Enumerate any future structured field before migration; arbitrary JSON/prose stays byte-identical |
| `work_item_edit_receipts` fingerprint | `canonicalUpdateFingerprint({id, expectedVersion, patch})` | Conditional update replay | Derived operational evidence | Preserve v1 bytes under receipt epoch 1; epoch 2 uses JIN IDs. A pre-cutover key returns reload/fresh-key, never replays or aliases |
| Work-item indexes | Schema migration | Search/order/filter | Derived/rebuildable | Recreate after table rebuild; change ID tie-break to numeric semantics |
| `workflow_todo_event_claims.event_id` | Workflow event feed | Claim/replay/outcome | Non-reference string | Preserve. It references `work_item_events.id`, not a Todo ID |
| Claim outcome detail | Workflow event feed | Diagnostics | Immutable evidence/non-reference | Preserve; do not substring-rewrite |

`work_item_events.work_item_id` is described as append-only application evidence but lacks an SQL immutability trigger. Rekeying it is functionally required so pending and future event replay can resolve the Todo. This plan requests one narrowly defined identity-rekey exception. No other event field may change, and the manifest records pre/post relationship hashes. Reviewer rejection is a hard no-go.

### Sessions, delegations, queues, and callbacks

| Reference | Producer | Consumers | Class | Migration action and invariant |
|---|---|---|---|---|
| `sessions.work_item_id` | `work-items/store.ts:linkSession`, delegation/cron | Spend, linked attempts, transition/reconciliation, deletion retention | Authoritatively rewritable for ordinary live sessions | Rekey exact values; every non-null live value must resolve after swap |
| Legacy `workflow_kind='run'` session `work_item_id` | Historical Workflow bridge | Legacy read compatibility | Immutable historical evidence | Default policy: preserve whole legacy row bytes and make the old value inert. Any still-actionable row aborts migration |
| `sessions.transport_meta.delegationCompletionContract.workItemId` | Delegation completion contract | Completion CAS and validation | Authoritatively rewritable | Parse exact JSON shape, rekey with `sessions.work_item_id`, serialize canonically only for approved nonlegacy rows; malformed/mismatch aborts |
| `sessions.session_key` and `source_ref` exactly `delegation:<TodoID>` | Non-idempotent delegation | Session lookup/routing and provenance | Authoritatively rewritable structured reference | Rekey exact recognized format and all `queue_items.session_key` joins in one transaction; do not rewrite unrelated prefixes |
| `queue_items.session_key` | Session enqueue | Queue dispatch | Authoritatively rewritable when it equals a rewritten delegation key | Rekey exact join; no partial/running queue may exist at cutover |
| `queue_items.prompt` copied from an accepted callback | Callback acceptance | Future internal turn | Immutable evidence while completed; live actionable input while pending | Preserve completed bytes. Refuse cutover when a pending prompt contains a structured old Todo instruction; do not rewrite arbitrary prompt prose |
| Delegation chat block `id=dg-<TodoID>` and `payload.workItemId` | Delegation route/callback | Chat activity card patch/open behavior | Authoritatively rewritable for nonlegacy rows | Rewrite coupled block ID and payload together; validate exact structure/version |
| Todo activity block `id=todo:<TodoID>` and `payload.todoId` | `gateway/chat-activity.ts` | Chat rendering, replay, patch | Authoritatively rewritable for nonlegacy rows | Rewrite coupled block/payload; malformed or duplicate identity aborts |
| `payload.activityReceipt.id` | Activity envelope | Block validator and replay | Authoritatively rewritable | Must remain equal to rewritten block ID |
| Tool `messages.meta.activityReceiptId` | Stream/tool settlement | Web tool-row suppression | Authoritatively rewritable when it exactly matches a rewritten block | Rewrite the full receipt token; missing/ambiguous correlations abort or are explicitly inert evidence |
| Synthetic message PK `block-${block.id}-${uuid}` | `applyBlockEnvelope` | Message context/jump anchors; rendered `data-message-id` today | Non-reference opaque message identity after block rekey | Do not parse as a Todo alias or rewrite historical PKs. Future producer uses `block-${uuid}`; web must never render raw backend IDs |
| Callback `source_attempt=manager-visibility:<TodoID>` and payload/meta/block | `sessions/callbacks.ts` | Durable delivery claim and eventual parent message | Authoritatively rewritable only while pending/dead-letter and repairable | Quiesce producers; structurally rekey pending/dead rows so no stale ID can deliver. Poison/malformed rows abort |
| Accepted callback identity, payload, `message_id`, `queue_item_id` | `acceptSessionDelivery` | Exactly-once delivery evidence | Immutable historical evidence | Preserve bytes. Old IDs are inert; accepted deliveries cannot be requeued or used to resolve a Todo |
| Legacy Workflow callback/message/queue rows | Historical Workflow session bridge | Legacy transcript/diagnostics | Immutable historical evidence | Preserve Task 4/5 byte checksums and keep the session unreachable through current mutation/navigation surfaces |
| Pending partial messages/active sessions | Live engine turn | Stream settlement | Live transient state | Must be zero. Migration is offline and refuses active/partial work rather than guessing ownership |

`callback_deliveries.message_id` points to the notification message inserted during acceptance, not the synthetic block row inserted by `applyBlockEnvelope`. Nevertheless, migration preflight must prove there is no callback or other direct reference to a candidate message PK before classifying it as opaque. Search/context anchors that escape to clients are external and expire at the identity epoch.

For edit receipts, rebuild the table so its durable key is `(schema_epoch, key_digest)` while preserving every existing row as epoch 1. Epoch-2 lookup first checks whether the same digest exists in epoch 1; if so, it returns the cutover reload/fresh-key result rather than applying a request. It then performs normal epoch-2 fingerprint matching. This preserves old receipt bytes, prevents cross-identity replay, and does not create an old-ID resolver.

### Workflows and historical compatibility

| Reference | Producer | Consumers | Class | Migration action and invariant |
|---|---|---|---|---|
| New `trigger.payload.todoId` | `workflows/todo-status-trigger.ts` from `event.workItemId` | Conditions, run details/UI | New authoritative output | After cutover newly published runs contain JIN IDs only |
| Existing run `trigger.payload.todoId` | Frozen Workflow run JSON | Read-time condition/UI normalization | Immutable historical evidence | Preserve run-file bytes; block Todo lookup/open from an old value |
| Legacy run `triggerTodoId` | Old run schema | `run-store.ts` read-time normalization | Immutable historical evidence | Preserve file bytes; normalization remains display/provenance only and never becomes an alias |
| Legacy trigger-store `approvalWorkItemId` | Schema-1 custom trigger | Existing v1-to-v2 trigger migration | Authoritative legacy data already retired by its own migration | Preserve existing migration ordering; verify it is removed before Todo-ID rekey or refuse |
| `source=workflow` and `workflow:<definition>:<run>` source refs | Historical Todo bridge | Reconciliation/read provenance | Historical provenance/non-reference | Preserve. Workflows never create or mutate Todos; automatic reconciliation remains disabled |
| Workflow run/definition IDs and active-run indexes | Workflow runtime | Workflow routes/UI | Non-reference strings | Preserve; distinct namespaces |

Task 4 requires legacy synthetic Workflow Session rows, messages, queue entries, and callbacks to remain byte-identical. Task 5 gives accepted callback deliveries immutable evidence semantics. Therefore a blanket historical rewrite is forbidden. The approved interpretation must be: frozen old identifiers are historical literals, not canonical aliases. If a frozen value is still used by any current resolver, condition that mutates a Todo, navigation path, callback retry, or replay path, preflight refuses until that consumer is removed or a reviewer approves a narrower preservation exception.

### Activity and audit projections

| Reference | Producer | Consumers | Class | Migration action and invariant |
|---|---|---|---|---|
| `activity_events.object_id`, href, correlation/idempotency fields, detail, links | Generic activity append API | Activity story/search projection | Immutable historical evidence | SQL triggers reject update/delete and payload hash covers fields. Preserve bytes and hash; old IDs are inert |
| `activity_stories`, versions, event/story links, activity FTS | Projection builder | Activity APIs/UI | Derived/rebuildable | Rebuild from immutable events; never synthesize a resolvable old Todo link |
| Company changed event `{entity:'todo', id}` | Todo mutation | WebSocket query invalidation | Derived/transient | Post-cutover emit JIN in memory; not persisted as identity |
| Chat activity receipt IDs | Todo mutation activity | MCP/REST result, session blocks, web suppression | Live structured reference or external receipt | Rekey stored live coupled structures; old external receipts expire at epoch and cannot replay |

There is currently no production caller of the normalized activity append API outside the activity module, but existing instance data cannot be assumed empty. Any immutable activity row with a structured old Todo link is listed in the manifest. If the current UI would navigate through it, migration is a no-go until navigation is made non-resolving without changing the event bytes.

### REST, MCP, CLI, search, and types

| Surface | Current behavior | Required behavior | Class/action |
|---|---|---|---|
| REST `/api/work-items` list/create | Emits random `wi_*`; create does not accept an ID | Emit allocated JIN ID | Live producer/consumer |
| REST `/api/work-items/:id` and mutation/session/approval subroutes | Accept any path-safe string | Central parser accepts only `JIN-N`; old/malformed IDs return an explicit non-alias error | Live resolver |
| Delegation REST input/output | Accepts/emits `workItemId`; can mint | Accept/emit JIN only; mint through allocator transaction | Live producer/consumer |
| Search REST | Searches title/body and returns IDs | Exact valid JIN query may resolve ID; arbitrary old strings remain text search only | Live resolver plus non-reference prose |
| MCP work-item, approval, and delegation tools | Schemas accept generic strings | Share canonical grammar/description; REST remains defense-in-depth | Live resolver |
| Shared TypeScript `WorkItem.id`, events, blocks, company change | Plain `string` | Keep wire type string but validate at construction/boundaries; do not create a second ID type/value | Live type surface |
| CLI | No Todo CRUD command exists | Do not invent Todo CRUD for parity. Add only the reviewed offline migration/inspection entrypoint if operationally required | Current absence / future command |

All handlers call one parser. No route-specific fallback, case folding, whitespace trimming, numeric-only lookup, or `wi_*` redirect is allowed. Error responses may quote the rejected caller input only when necessary; they must never return an old-to-new value.

### Web UI, privacy, React Query, and CAS

| Surface | Current behavior | Required behavior | Class/action |
|---|---|---|---|
| Todo navigation | Single `/todos` route; selected Todo represented by salted per-tab `td_*` private ref | Preserve. No `/todos/JIN-N` route and no canonical ID in history state | Privacy boundary |
| `todo-private-state.ts` | Maps private refs in memory and browser state | Version namespace at epoch; invalidate old refs/journals without an old-ID map | Derived/rebuildable |
| React Query keys/cache | Raw IDs can exist in memory; no persistence provider | In-memory JIN is allowed; invalidate all Todo/session queries at epoch | Derived/rebuildable |
| Quick-edit/CAS journals | Persist private `td_*`, expected version, and patch intent | Bump journal schema/epoch; stale pre-cutover entries fail closed and request reload/fresh edit | Derived operational state |
| Network fetch paths | Authenticated requests may include canonical ID | JIN is allowed on the network path, but not copied into browser location/history/storage/DOM | External transport |
| Todo cards and technical refs | Card uses private refs; `publicWorkItemReference` suppresses old scheme | Suppress every canonical JIN ID from source/approval technical labels too | Privacy boundary |
| Chat message wrapper | Renders raw backend `msg.id` in `data-message-id` | Render a salted/private message anchor; keep backend ID in memory only | Privacy defect to fix RED-first |
| Activity cards/inline cards | Card omits block ID and uses private open action | Preserve; full-transcript privacy test must include parent wrappers, attributes, links, storage, and location | Privacy boundary |

The contract phrase “routes/UI accept and emit JIN-N” is reconciled as follows:

- REST/MCP and in-memory UI data accept/emit JIN.
- The browser's address bar, History API state, `sessionStorage`, `localStorage`, rendered text, rendered attributes, links, and serialized DOM never contain a system-generated canonical ID.
- A user may type the literal text `JIN-7`; user-authored content is not a system privacy leak and must not be rewritten.
- A human-visible “copy Todo ID” feature would conflict with the approved privacy contract and is out of scope unless that contract is explicitly changed.

The current full chat transcript leaks the block-derived message primary key through `data-message-id`, even though the activity card itself hides `data-block-id`. The implementation must first add a failing full-transcript privacy canary, then use private message anchors in the DOM and make future synthetic block-message IDs domain-independent. Historical message primary keys remain opaque message identities; parsing the embedded substring as a Todo is forbidden.

### Import, export, backups, templates, tests, and docs

| Surface | Current fact | Required treatment |
|---|---|---|
| Instance storage | Each selected instance home owns one `sessions/registry.db` | Allocator and namespace are instance-local |
| Instance creation/listing | `jinn create` seeds a fresh home; instance listing reports metadata | Fresh DB starts `last_value` at 0; first allocation returns 1; no data merge occurs |
| Todo/session DB import/export/merge/restore | No supported CLI, API, or MCP surface exists | Do not invent current behavior. Specify future import contract only |
| Same-instance session duplication | Copies transcript/session bytes | Preflight scans duplicates; this is not cross-instance import |
| SQLite backup | No user-facing Todo backup command | Migration itself creates a verified offline backup as an operational prerequisite |
| Template `todo-handling` and related public skills/docs | Current examples contain legacy IDs | Update active public examples to `JIN-N`; do not rewrite historical migration prompts/plans |
| Existing template migrations | Historical versioned prompts | Add a new versioned migration note when implementation ships; preserve old prompts |
| Tests and fixtures | Many current fixtures use `wi_*` | Convert current-behavior fixtures to JIN; retain explicitly named legacy/corrupt migration fixtures |

## Deterministic Migration Map

### Ordering

For every valid legacy `work_items` row, assign ordinal `row_number()` in:

```sql
ORDER BY created_at COLLATE BINARY ASC, id COLLATE BINARY ASC
```

Map ordinal 1 to `JIN-1`, ordinal 2 to `JIN-2`, and so on. The old primary key is unique and provides a stable tie-breaker. Do not use `rowid`, which can change after copy, rebuild, or `VACUUM`. The preflight accepts the existing timestamp bytes as the historical ordering key but rejects null/non-text values and schemas outside the supported legacy contract. Rehearsal proves identical database bytes produce the same map repeatedly.

### Manifest

The migration writes a permission-restricted audit manifest outside the live lookup path. It is never loaded by REST, MCP, store, UI, or Workflow resolvers. The generic shape is:

```json
{
  "schemaVersion": 1,
  "kind": "todo-identifier-rekey",
  "sourceScheme": "wi-v1",
  "targetScheme": "jin-v1",
  "scope": "instance-local",
  "createdAt": "<ISO-8601>",
  "sourceDatabaseSha256": "<digest>",
  "backupSha256": "<digest>",
  "rows": [
    { "ordinal": 1, "oldId": "wi_legacy_a", "newId": "JIN-1", "createdAt": "<stored value>" }
  ],
  "immutableEvidence": [
    { "surface": "workflow-run", "locatorDigest": "<digest>", "count": 1 }
  ],
  "preInvariantSha256": "<digest>",
  "postInvariantSha256": "<digest>"
}
```

The manifest is an offline audit, rollback, and future import artifact, not a dual-identity feature. Runtime packages contain no function that resolves `oldId` through it.

### Migration state machine

Add an explicit identity schema epoch and migration record in SQLite metadata. Supported states are:

```text
legacy -> staged -> swapping -> validated -> complete
             \-> failed (startup refused)
```

- `legacy`: exact supported old schema, no JIN rows.
- `staged`: backup and temporary manifest are fsynced and their digests recorded.
- `swapping`: exclusive SQLite transaction is in progress; uncommitted crashes roll back wholesale.
- `validated`: database commit succeeded and post-invariants match, but manifest publication may need recovery.
- `complete`: final manifest rename and digest verification succeeded; request serving is allowed.
- `failed`: unexpected schema, corrupt data, digest mismatch, or ambiguous recovery; no request serving.

Completed runs are idempotent no-ops keyed by the identity epoch and manifest digest. A mixed set of legacy and JIN primary keys is never treated as resumable input. No DDL-substring sentinel is sufficient.

### Offline staging and preflight

1. Stop request intake and background producers using the reviewed deployment procedure. Acquire exclusive instance ownership before `initDb()` can mutate schemas; current startup initializes the DB before all process cleanup, so implementation must reorder/gate this path.
2. Refuse active engine turns, partial messages, pending queue execution, or a second gateway process.
3. Checkpoint WAL, acquire an exclusive lock, run `PRAGMA integrity_check`, and verify the exact supported table/index/trigger schemas.
4. Create a restorable SQLite backup using the SQLite backup API, fsync it, reopen it independently, run integrity check, and record its digest.
5. Inventory every class in the graph. Direct references must resolve. Structured JSON must parse and match its paired relational value. Unknown reference-bearing shapes abort.
6. Inventory immutable evidence without altering it. Prove each old literal is unreachable from live Todo lookup, mutation, navigation, callback requeue, or Workflow mutation behavior.
7. Refuse a schema-1 trigger store until its existing `approvalWorkItemId` retirement migration is complete.
8. Build the deterministic map, invariant snapshot, and temporary manifest; fsync before destructive SQL.

### Atomic SQLite swap

Inside one exclusive/immediate transaction:

1. Create a temporary mapping table keyed both ways and verify one-to-one cardinality.
2. Rebuild `work_items` with the strict ID check and mapped primary keys.
3. Rekey `work_item_events.work_item_id` under the approved audit exception.
4. Rekey ordinary live `sessions.work_item_id`.
5. Rekey exact nonlegacy delegation session keys/source refs and matching queue keys.
6. Structurally rekey supported completion-contract JSON, Todo/delegation blocks, receipts, tool metadata, and pending/dead-letter callback state. Do not recursive-search JSON or prose.
7. Preserve legacy Workflow session/callback/transcript bytes and accepted callback bytes. Mark their old identities as inert through resolver/requeue guards outside the evidence rows.
8. Add receipt epoch 2 while retaining epoch-1 receipt bytes. Pre-cutover retries receive a reload/fresh-key outcome.
9. Rebuild derived indexes/projections as required.
10. Seed `todo_id_allocator.last_value = count(work_items)`; verify safe-integer range.
11. Record identity epoch and manifest digest, then drop the temporary live map so no alias survives.
12. Run transaction-local invariants and commit once.

Structured transcript rewrites are allowed only for nonlegacy machine-authored live blocks whose coupled fields can be proven exact. Message prose, tool result text, and opaque message primary keys remain unchanged. If changing a block would violate a frozen-row checksum or leave mismatched receipt correlation, the migration aborts.

### Post-commit validation

Before serving requests, prove:

- every `work_items.id` matches the strict grammar and maps to one ordinal;
- every live relational Todo reference resolves to exactly one row;
- no live structured resolver input contains a legacy ID;
- counts, statuses, versions, source/sourceRef, approvals, timestamps, event IDs/order, and event `detail` bytes match the pre-snapshot;
- every coupled block ID/payload/receipt/tool-meta set is internally consistent;
- pending callbacks contain only current identities; accepted/legacy evidence hashes are unchanged;
- Workflow run files and legacy session evidence hashes are unchanged;
- immutable Activity rows and payload hashes are unchanged; projections contain no resolvable old links;
- allocator `last_value` equals the greatest allocated suffix after migration and is never decremented;
- no temporary mapping table, compatibility column, or alias resolver remains;
- `PRAGMA integrity_check` succeeds;
- a second migration invocation is a no-op with the same manifest digest.

The process then atomically renames the staged manifest into its final audit location and marks `complete`. If the DB commit succeeded but the rename was interrupted, boot validates the recorded digest and completes only the rename. A missing or mismatched staged manifest is a refusal, not a remap rerun.

### Rollback and recovery

- A crash before SQLite commit rolls the transaction back; recovery verifies the legacy invariant and discards no evidence automatically.
- A crash after commit but before final manifest rename resumes publication by digest, not data mutation.
- A failed validation keeps the gateway closed and preserves diagnostics plus the backup.
- Rollback after a committed cutover restores the entire verified SQLite backup while offline. It does not reverse-map selected rows in place.
- External frozen Workflow files are not mutated, so they require no rollback.
- Restore must also restore the matching identity epoch and invalidate browser state again.

## Mixed-Version Refusal and Deployment Boundary

The current CLI merely warns about an old instance/template version and current binaries do not understand a future Todo identity epoch. A database CHECK prevents old writers from inserting `wi_*` but cannot force an arbitrary old process to refuse reads.

The safe rollout is two-stage:

1. Ship a guard-capable release that understands the legacy epoch and refuses unknown/newer/incomplete epochs while still using the old identity scheme.
2. After it is deployed everywhere that may open the database, ship the migration-capable release and run the reviewed offline cutover.

The migration-capable gateway publishes an identity epoch in bootstrap/status responses. Mutations carry the epoch; mismatched clients receive upgrade/reload-required (`409` or `426`, selected consistently) before any write. Request serving never starts in `staged`, `swapping`, `validated`, `failed`, corrupt, or mixed states.

An unsupported old binary remains outside the supported downgrade boundary. Migration is no-go until the independent reviewer accepts the two-stage requirement and the exact minimum compatible release.

## Cross-Instance Behavior

`JIN-N` is intentionally instance-local, so two independent instances may both own `JIN-1`. Current product surfaces do not import, export, restore, or merge Todo/session databases. `jinn create` creates a fresh home; instance selection and listing do not copy work. Therefore this ticket must not pretend to retrofit a nonexistent merge API.

Current behavior:

- Whole-home/database cloning preserves the source allocator and IDs in a separate instance.
- Manual JSON copied from one instance has no trustworthy namespace identity and must not be accepted as a local Todo reference merely because it matches `JIN-N`.
- REST/MCP inputs always mean the currently selected instance.

Future import/merge contract, explicitly not implemented in this ticket:

1. Require a source instance fingerprint and exported identity manifest.
2. Detect every incoming `JIN-N` collision before writing.
3. Allocate target-local JIN IDs transactionally in deterministic source order.
4. Rewrite all import-authorized structured references as one import transaction.
5. Emit a signed/digested source-to-target remap manifest.
6. Never install that remap as a runtime alias.
7. Reject imports lacking provenance or containing immutable evidence whose semantics cannot survive remap.

## RED to GREEN Implementation Sequence

Each implementation task begins with a failing focused test, demonstrates the expected failure, adds the smallest production change, reruns the focused test, and commits independently. No task begins before architecture approval.

### Task 0: Record independent architecture approval

**Files:** Review this plan; no production files.

- Reviewer verifies every graph class against the repository.
- Reviewer records decisions for every item in “Open Decisions and Risks.”
- Gate remains closed if any required decision is absent or conditional.

### Task 1: Canonical parser and transactional allocator

**Files:**

- Add `packages/jinn/src/work-items/id.ts`
- Modify `packages/jinn/src/work-items/migrate.ts`
- Modify `packages/jinn/src/work-items/store.ts`
- Add `packages/jinn/src/work-items/__tests__/id.test.ts`
- Modify `packages/jinn/src/work-items/__tests__/store.test.ts`

RED cases: grammar edges, safe-integer overflow, empty/one/many allocations, deletion nonreuse, duplicate sourceRef without number consumption, rollback behavior, and numeric tie-break ordering.

GREEN: central parser/formatter, allocator table, and same-transaction creation. Run focused tests, then work-item tests.

### Task 2: Migration state, deterministic map, backup, and fault recovery

**Files:**

- Add `packages/jinn/src/work-items/identity-migration.ts`
- Add `packages/jinn/src/work-items/identity-manifest.ts`
- Modify `packages/jinn/src/sessions/registry.ts`
- Modify the reviewed CLI/startup migration entrypoint under `packages/jinn/src/cli/`
- Add `packages/jinn/src/work-items/__tests__/identity-migration.test.ts`
- Add `packages/jinn/src/work-items/__tests__/identity-migration-worker.mjs`

RED fixtures: empty/current databases, equal creation timestamps, malformed IDs/timestamps, mixed/newer schemas, deterministic rerun, exclusive-lock races, and fault injection at every state boundary.

GREEN: state machine, backup verification, manifest staging, exact map, single swap transaction, postvalidation, recovery, idempotent completion, and hard startup refusal.

### Task 3: Relational references and receipt epoch

**Files:**

- Modify `packages/jinn/src/work-items/identity-migration.ts`
- Modify `packages/jinn/src/work-items/store.ts`
- Modify `packages/jinn/src/work-items/workflow-event-feed.ts`
- Modify `packages/jinn/src/sessions/registry.ts`
- Modify `packages/jinn/src/sessions/delegation-completion-contract.ts`
- Add/modify focused tests under `packages/jinn/src/work-items/__tests__/` and `packages/jinn/src/sessions/__tests__/`

RED: dangling event/session references, event byte-preservation, linked spend/attempt lookup, delegation key plus queue rewrite, completion-contract match/mismatch, epoch-1 edit retry, and epoch-2 CAS replay.

GREEN: approved event-envelope rekey, live session/key rewrites, strict structured JSON handling, and receipt epoch boundary without version bumps.

### Task 4: Workflow and immutable-evidence barriers

**Files:**

- Modify `packages/jinn/src/workflows/run-store.ts` only where needed to prohibit lookup/navigation
- Modify `packages/jinn/src/workflows/todo-status-trigger.ts`
- Modify `packages/jinn/src/work-items/reconcile.ts` only if a guard is missing
- Modify `packages/jinn/src/sessions/registry.ts` for legacy-session guards
- Add migration and compatibility tests under `packages/jinn/src/workflows/__tests__/`, `packages/jinn/src/sessions/__tests__/`, and `packages/jinn/src/gateway/__tests__/`

RED: modern and legacy trigger payloads, frozen run checksums, `source=workflow` negative capability, legacy Workflow session byte checksums, accepted callback checksums, and attempted mutation/navigation/requeue through inert old identifiers.

GREEN: new runs emit JIN; frozen evidence remains byte-identical and non-resolving; any unsafe active legacy row causes preflight refusal.

### Task 5: Blocks, receipts, callbacks, and full-transcript privacy

**Files:**

- Modify `packages/jinn/src/gateway/chat-activity.ts`
- Modify `packages/jinn/src/shared/blocks.ts`
- Modify `packages/jinn/src/sessions/registry.ts`
- Modify `packages/jinn/src/sessions/callbacks.ts`
- Modify `packages/web/src/components/chat/chat-messages.tsx`
- Modify mirrored web block validation/types as applicable
- Add backend and web privacy/correlation tests

RED: coupled Todo/delegation block migration, duplicate/malformed blocks, tool suppression, pending/dead/accepted callbacks, future domain-independent synthetic message IDs, and full rendered transcript scan across text, attributes, hrefs, location, history, `sessionStorage`, and `localStorage`.

GREEN: structural rewrite for approved live state, stale callback barriers, private DOM message anchors, and zero system-generated canonical IDs in browser persistence/DOM.

### Task 6: REST, MCP, search, cron, and delegation producers

**Files:**

- Modify `packages/jinn/src/gateway/api.ts`
- Modify `packages/jinn/src/mcp/work-item-tools.ts`
- Modify `packages/jinn/src/mcp/approval-tools.ts`
- Modify `packages/jinn/src/mcp/delegation-tools.ts`
- Modify `packages/jinn/src/cron/runner.ts` only where it consumes/returns Todo identity
- Modify related gateway/MCP/cron tests

RED: every route/tool accepts JIN, rejects legacy/malformed/case variants, never returns a remap, exact-ID search, duplicate sourceRef, cron reuse, delegation mint/existing-ID paths, and activity receipt outputs.

GREEN: all boundaries share the parser; all producers use allocator; old strings can only match user text, never identity.

### Task 7: Web epoch, private references, React Query, and CAS

**Files:**

- Modify `packages/web/src/routes/todos/todo-private-state.ts`
- Modify `packages/web/src/lib/todos.ts`
- Modify `packages/web/src/routes/todos/use-todos.ts`
- Modify Todo page/group/card/edit components and focused tests
- Modify gateway bootstrap/status typing and web query client handling

RED: stale `td_*` selection, stale edit journal, dirty-draft cutover, epoch mismatch, technical source/approval labels containing JIN, query invalidation, reload behavior, and browser privacy canaries.

GREEN: versioned private namespace, fail-closed journal invalidation, neutral reload message, full query reset, epoch handshake, and private-only navigation state.

### Task 8: Current fixtures, templates, and active documentation

**Files:**

- Update current-behavior ID fixtures across work-item, gateway, MCP, session, engine/shared, Workflow, and web tests
- Keep explicit legacy/corrupt fixtures named as migration evidence
- Modify `packages/jinn/template/skills/todo-handling/SKILL.md`
- Modify related active public template skills/docs discovered by literal sweep
- Add a new versioned template migration note; do not edit historical migration prompts

RED: repository classification test/lint that flags unexplained legacy literals in active code/templates while allowlisting named historical fixtures, schema object names, `wie_*`, and `wi-job`.

GREEN: current examples use JIN; historical artifacts retain documented purpose; public templates remain generic.

### Task 9: Full rehearsal, verification, and independent implementation review

**Files:** Test artifacts only until reviewer approves deployment; no production instance data.

1. Build a disposable instance fixture containing every reference class.
2. Run preflight, backup, migration, restart, idempotent rerun, and backup restore.
3. Run concurrent allocator/boot workers.
4. Run browser QA against the disposable gateway.
5. Run privacy and repository leak sweeps.
6. Have a reviewer who did not implement the migration compare manifest, pre/post invariants, and acceptance criteria.
7. Keep production closed until that reviewer gives an explicit go.

## Verification Matrix

| Scenario | Required fixture/evidence | Pass condition |
|---|---|---|
| Empty instance | No Todos, allocator absent | Complete epoch, `last_value=0`, empty manifest rows, first create is JIN-1 |
| Current linked data | Todos/events/sessions/delegation/blocks/pending callback | Deterministic map; every live relation resolves; semantic bytes/versions preserved |
| Equal timestamps | Multiple legacy IDs with identical `created_at` | Binary old-ID tie-break gives identical manifest on rerun |
| Corrupt canonical row | Malformed old ID/null or wrong timestamp type | Preflight refusal; no DB or manifest publication change |
| Dangling direct reference | Event/session/block points to missing Todo | Preflight refusal with exact class/locator digest |
| Corrupt structured JSON | Completion contract/block/callback cannot parse or mismatches pair | Preflight refusal; no recursive best-effort rewrite |
| Immutable Workflow evidence | Current and legacy run payloads plus legacy run Session | Run/session evidence checksum unchanged; old ID cannot resolve/open/mutate |
| Activity audit evidence | Immutable event contains old ID and valid payload hash | Event/hash unchanged; projection has no actionable old link |
| Callback lifecycle | Pending, dead-letter, accepted, poison, legacy | Pending/dead rekey safely or refuse; accepted/legacy checksum unchanged and non-requeueable |
| CAS boundary | Pre-cutover receipt plus post-cutover edit | Old key requests reload/fresh key; JIN retry is idempotent; Todo version unchanged by migration |
| Interrupted transaction | Fault before/inside commit | SQLite rollback returns exact legacy invariant; rerun maps identically |
| Commit/manifest interruption | Fault after commit before rename | Boot refuses serving, verifies digest, completes rename only |
| Concurrent allocation | 16 and 32 worker processes, duplicate/nonduplicate sourceRefs | Unique contiguous committed IDs; one Todo per idempotency key; no committed reuse |
| Concurrent boot | Multiple migration-capable processes | One owner migrates; others wait/refuse; no partial schema |
| Mixed/newer binary | Legacy, guard-only, migrated, and unsupported epoch combinations | Matrix matches documented refusal; no old writer can commit |
| Browser privacy | Todos, chat activity, search jump, reload, private selection/edit | No system-generated JIN in URL/history/storage/DOM; network/in-memory remains functional |
| Same-instance duplicate | Duplicated sessions with block/contract refs | All nonlegacy live copies rekey consistently; frozen copies remain inert |
| Cross-instance collision | Two fixtures each owning JIN-1 | Current APIs stay instance-local; future import fixture refuses without manifest and deterministically remaps with one |
| Idempotent rerun | Completed migration invoked again | No bytes/counters/manifest rows change |
| Rollback | Restore verified backup offline | Exact legacy state/epoch restored; migrated process refuses incompatible state as designed |

### Required command gates during implementation

Run focused RED/GREEN commands specified by each test file, then at minimum:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Also run backend and web package-specific suites where the monorepo scripts permit, the concurrent worker harness, the disposable migration rehearsal, and browser QA. Production port/process state is checked before and after rehearsal to prove it was untouched.

## Risks and Open Decisions

These decisions require explicit independent approval. The recommended answer is shown first.

1. **Append-only Todo events:** Approve rekeying only `work_item_events.work_item_id`; preserve all event evidence bytes and record relationship hashes. Rejecting this makes the migration impossible without a runtime alias.
2. **Frozen Workflow runs:** Preserve old ID literals as inert historical evidence. Rewriting violates the accepted frozen-run contract; treating them as resolvable aliases violates the sole-ID contract.
3. **Legacy Workflow Sessions:** Preserve Task 4 bytes and refuse migration if any row remains operationally actionable. A blanket `sessions.work_item_id` rewrite is not acceptable for these rows without amending Task 4.
4. **Accepted callbacks:** Preserve Task 5 identity/payload bytes and make old Todo-bearing deliveries permanently non-requeueable. Pending/dead-letter rows are live state and must rekey or block migration.
5. **Live transcript blocks:** Approve narrow structural rewrites for nonlegacy machine-authored blocks only. Preserve prose and opaque message IDs. Abort on ambiguity.
6. **Edit receipts:** Preserve epoch-1 receipt bytes but invalidate their operational replay across cutover; require reload/fresh key. Deleting receipts loses audit evidence, while recomputation is impossible because the original request is absent.
7. **Never reused:** Define it as committed identifiers. Requiring durable burn of rolled-back attempts needs a separate nontransactional sequence and is not recommended.
8. **Mixed-version boundary:** Approve a guard release before the migration release and name the minimum compatible version. A single-release live migration cannot protect against arbitrary old binaries.
9. **Browser drafts:** Approve fail-closed invalidation of stale private refs/edit journals at cutover. Migration should otherwise wait until no dirty drafts/tabs remain.
10. **Human-visible IDs:** Keep canonical IDs out of DOM and browser persistence. Any copy/display feature requires a separate privacy-contract decision.
11. **Migration orchestration:** Approve an explicit offline command/maintenance gate rather than implicit migration during ordinary startup. The existing template-oriented `jinn migrate` command must not be overloaded ambiguously.
12. **Cross-instance scope:** Approve current-surface refusal and a future-only remap manifest contract. Do not add import/merge APIs in this ticket.

## Exact Go/No-Go Criteria

### Architecture GO

Implementation may begin only when an independent reviewer explicitly approves all twelve decisions above and confirms:

- every field in the producer/consumer graph was checked against current source;
- immutable evidence is separated from live resolvable state without a hidden alias;
- the deterministic ordering and fixed prefix are accepted;
- the backup/manifest/state-machine design is recoverable and idempotent;
- the two-stage mixed-version boundary is operationally acceptable;
- the browser privacy interpretation is accepted;
- the implementation sequence and fixture matrix cover the contract.

### Architecture NO-GO

Do not implement if any of the following remains true:

- “rewrite every reference” is interpreted to require mutating frozen Workflow/Activity/accepted-callback evidence without amending those audit contracts;
- a legacy Workflow session or accepted/dead callback still uses an old ID for a live action;
- epoch-1 edit-receipt behavior is unspecified;
- old binaries may open the migrated database;
- dirty browser drafts must survive without a permitted old-ID map;
- a cross-instance merge is expected through a surface that does not exist;
- the independent reviewer is also the migration-map author.

### Deployment GO

Production cutover is a later gate. It additionally requires:

- all RED-to-GREEN tasks complete;
- full test/typecheck/lint/build gates green;
- current, corrupt, interrupted, concurrent, and cross-instance fixture evidence attached;
- disposable migration and rollback rehearsals pass with matching digests;
- browser QA and privacy scans pass;
- leak scan finds no personal data in shipped changes;
- a fresh independent implementation reviewer signs off;
- an explicit maintenance window and rollback owner are named.

Until then, do not restart, deploy, release, publish, or migrate a production instance.

## Audited File Inventory

This is the concrete repository reference graph used to produce the classifications above. Implementation must repeat the literal/structural sweep because the repository may change after approval.

### Production and schema files

- Canonical Todo schema/store/transitions/approvals: `packages/jinn/src/work-items/migrate.ts`, `store.ts`, `transitions.ts`, `approvals.ts`, `reconcile.ts`, and `workflow-event-feed.ts`.
- Session schema and durable state: `packages/jinn/src/sessions/registry.ts`, `callbacks.ts`, and `delegation-completion-contract.ts`.
- Gateway producers/consumers: `packages/jinn/src/gateway/api.ts`, `chat-activity.ts`, and `manager-visibility.ts`.
- Workflow evidence and triggers: `packages/jinn/src/workflows/run-store.ts`, `todo-status-trigger.ts`, `custom-triggers.ts`, `condition.ts`, and `advance.ts`.
- Activity audit/projection: `packages/jinn/src/activity/migrate.ts`, `payload.ts`, `store.ts`, `projection.ts`, and `query.ts`.
- MCP: `packages/jinn/src/mcp/work-item-tools.ts`, `approval-tools.ts`, `delegation-tools.ts`, `server.ts`, and shared toolkit/error handling.
- Other producers and shared contracts: `packages/jinn/src/cron/runner.ts`, `packages/jinn/src/shared/types.ts`, `blocks.ts`, and `activity-receipts.ts`.
- Startup/instances/migration boundary: `packages/jinn/src/sessions/registry.ts`, `packages/jinn/src/gateway/server.ts`, `packages/jinn/src/cli/start.ts`, `migrate.ts`, `create.ts`, `instances.ts`, `packages/jinn/bin/jinn.ts`, and `packages/jinn/src/shared/paths.ts`.
- Web privacy/data/CAS: `packages/web/src/lib/todos.ts`, `query-client.ts`, `packages/web/src/routes/todos/todo-private-state.ts`, `todo-edit-request.ts`, `use-todo-quick-edit.ts`, `use-todo-draft.ts`, `use-todos.ts`, `page.tsx`, `group.tsx`, `row.tsx`, `detail-sheet.tsx`, and `packages/web/src/components/chat/chat-messages.tsx` plus `company-activity-card.tsx`.

### Existing tests and fixtures with current or legacy ID literals

- Work items: `packages/jinn/src/work-items/__tests__/store.test.ts`, `migrate.test.ts`, `fixtures/migration-worker.mjs`, `approvals.test.ts`, `approvals-atomicity.test.ts`, `transitions.test.ts`, `reconcile.test.ts`, `optimistic-concurrency.test.ts`, `version-mutations.test.ts`, and `list-limit.test.ts`.
- Gateway: `packages/jinn/src/gateway/__tests__/work-items-route.test.ts`, `work-item-approval-route.test.ts`, `delegations-route.test.ts`, `manager-visibility.test.ts`, `callback-reliability.test.ts`, `chat-activity-route.test.ts`, `streamed-turn-settlement.test.ts`, `legacy-workflow-mutation-boundaries.test.ts`, and `workflow-session-grouping.test.ts`.
- Sessions: `packages/jinn/src/sessions/registry.test.ts`, `__tests__/callback-deliveries.test.ts`, `callback-concurrent-init.test.ts`, `delegation-completion-contract.test.ts`, `legacy-workflow-session-compat.test.ts`, `messages-partial.test.ts`, and message-search/context tests.
- Workflows: `packages/jinn/src/workflows/__tests__/run-store.test.ts`, `todo-status-trigger.test.ts`, `todo-replay-watermark.test.ts`, `todo-capability-boundary.test.ts`, `condition.test.ts`, and `poll-trigger.test.ts`.
- MCP: `packages/jinn/src/mcp/__tests__/work-item-tools.test.ts`, `delegation-tools.test.ts`, `server.test.ts`, `toolkit.test.ts`, and read-capability tests.
- Engine/shared receipt propagation: Claude, Codex, Grok, Hermes, and Pi interactive/protocol tests; `packages/jinn/src/shared/__tests__/activity-receipts.test.ts`, `blocks.test.ts`, `company-activity-blocks.test.ts`, and `fixtures/company-activity-blocks.json`.
- Web: Todo route detail/page/history/private-state/edit/draft/quick-edit/CAS/pagination tests; `packages/web/src/lib/__tests__/todos.test.ts`, `company-activity-blocks.test.ts`; chat block, tool-group, activity-card, parity, jump, and live-session/query-invalidation tests.
- Activity: `packages/jinn/src/activity/__tests__/migration.test.ts`, `store.test.ts`, `query.test.ts`, and `performance.test.ts`.

### Templates and historical documentation

- Active public examples: `packages/jinn/template/skills/todo-handling/SKILL.md`, `delegation/SKILL.md`, and `management/SKILL.md`.
- Historical template migrations: `packages/jinn/template/migrations/0.26.0/MIGRATION.md` and `0.27.0/MIGRATION.md` remain immutable; implementation adds a new version rather than editing them.
- Historical architecture plans under `docs/superpowers/plans/` are evidence, not active examples, and are not mass-rewritten.
- `idx_wi_events_item`, `wie_*`, cron `wi-job` values, and explicitly labeled legacy fixtures are not canonical Todo references.

## Self-Audit Checklist

- [x] Canonical store, allocator, schema constraints, indexes, and ordering are covered.
- [x] Events, sourceRef/idempotency, approvals, sessions, delegations, callbacks, queues, and receipts are classified.
- [x] Workflow Todo-status triggers, legacy compatibility, `source=workflow`, and one-way capability boundaries are preserved.
- [x] Chat activity blocks, receipts, synthetic message IDs, CAS, React Query, private refs, and DOM privacy are reconciled.
- [x] REST, MCP, CLI absence, search, shared types, cron, and WebSocket activity are covered.
- [x] Activity immutability, projections/FTS, imports/exports/backups, instances, tests, templates, docs, and migrations are covered.
- [x] Deterministic map, staging, atomic swap, invariant validation, idempotence, crash recovery, rollback, and mixed-version refusal are specified.
- [x] Cross-instance behavior is grounded in current surfaces; future behavior is labeled.
- [x] RED-to-GREEN tasks and verification fixtures cover current, corrupt, interrupted, concurrent, and collision cases.
- [x] Risks, unresolved decisions, and exact architecture/deployment gates are explicit.
- [x] No production implementation or runtime mutation is authorized by this document.
