# JIN-N Sole Todo Identifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` or `executing-plans` with `dev-workflow` and `test-driven-development` to implement this plan task by task. This document is an architecture gate, not implementation authorization.

**Goal:** Replace every live canonical Todo identifier with one immutable, instance-local `JIN-N` identifier, with no runtime `wi_*` alias and no observable mixed identity.

**Architecture:** A fixed-format text primary key remains the sole Todo identity. A guarded SQLite high-water plus append-only burn ledger permanently allocates each ordinal in a committed immediate transaction before a separate atomic Todo/event insert, so failed creates leave intentional gaps but can never reuse an issued number. A one-time, offline, manifest-backed migration deterministically rekeys authoritative references while preserving approved immutable evidence behind epoch-aware, non-resolving presentation boundaries. The gateway refuses incomplete, corrupt, newer, or mixed identity epochs.

**Tech Stack:** TypeScript, SQLite through `better-sqlite3`, Vitest, Commander, MCP tools, React 19, React Router 7, TanStack Query, Playwright/browser QA.

## Global Constraints

- This phase may change and commit this plan only. No production code, tests, schemas, fixtures, runtime data, or live instance state may change.
- Implementation is forbidden until the operator accepts every decision in the operator table and a fresh independent reviewer approves the revised migration map.
- The canonical prefix is fixed as `JIN-` for v1; no runtime alias or old-to-new resolver may survive migration.
- Canonical `JIN-N` is locked out of browser URL, history, `sessionStorage`, `localStorage`, and rendered DOM; private salted references remain mandatory.
- Workflows never create or mutate Todos; Todo-status triggers remain one-way and `source=workflow` remains historical provenance only.
- Production request serving, restart, deployment, release, publish, and migration remain outside this architecture phase.

---

## Gate Status and Scope

This plan is the only artifact permitted by the architecture phase. Production code, tests, schemas, fixtures, runtime databases, instance files, and the running gateway remain unchanged.

Implementation is **blocked** until the operator explicitly accepts all recommended decisions below and a fresh reviewer who did not author this revision approves the reference map, historical-evidence policy, migration state machine, and go/no-go criteria. Both approvals must be recorded outside the repository plan before the first RED test is added.

The migration must eventually satisfy all of these invariants:

1. `JIN-1`, `JIN-2`, and so on are the only identifiers accepted or emitted by live Todo resolvers.
2. The canonical ID is the `work_items.id` primary key. There is no hidden numeric key, alias table, compatibility resolver, or runtime old-to-new map.
3. The allocator is transactional, concurrency-safe, immutable after its burn commit, strictly monotonic within one instance, and never reuses a number handed to Todo creation even when creation later fails or rolls back. Gaps are expected.
4. Existing Todos are mapped deterministically by creation order with a stable tie-breaker.
5. Every authoritative live reference changes atomically with the primary key.
6. Historical evidence that is contractually immutable stays byte-identical, is inventoried in the manifest, and becomes permanently non-resolving.
7. Workflows never create or mutate Todos. Todo-status events continue to trigger Workflows in one direction. `source=workflow` remains historical provenance only.
8. Todo versions do not change during identity migration. Existing optimistic-concurrency semantics remain intact.
9. Canonical Todo IDs may traverse authenticated API/MCP network payloads, but must not enter browser URL/history, browser storage, or rendered DOM. The UI uses salted private references.
10. The production gateway is not migrated until sandbox rehearsal, independent review, and an explicit deployment decision are complete.

## Operator Decision Gate

Every row requires an explicit operator acceptance. `YES` is the recommended default for the smallest safe v1.

| Operator decision | Recommended | Consequence |
|---|---:|---|
| Permanently burn every rolled-back allocation handed to Todo creation | **YES** | Allocation commits before Todo/event insertion; failed creates and racing duplicate sourceRefs leave permanent gaps |
| Forbid full legacy-backup restoration after the migrated instance begins serving | **YES** | A pre-listen external seal makes recovery forward-only after service; post-cutover writes and allocator high-water are never discarded |
| Block migration on every nonterminal Workflow run containing a legacy Todo ID | **YES** | Full-scan `running`, `parked`, and `dispatched` runs, including stopping/indexed cases; no new execution projection |
| Keep immutable callback/Activity bytes frozen while live copies, projections, and serializers rekey or neutralize them | **YES** | Audit hashes remain stable; current APIs/search/engine input never expose or execute old identity |
| Make cross-instance import refusal-only in this ticket | **YES** | No remap protocol or import surface is invented; unsupported/unprovenanced imports fail closed |

The locked browser privacy contract is not an operator choice: canonical IDs stay out of URL/history/browser storage/DOM through salted private references.

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

Add a singleton high-water, an append-only burn ledger, and database guards:

```sql
CREATE TABLE todo_id_allocator (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_value INTEGER NOT NULL CHECK (
    typeof(last_value) = 'integer'
    AND last_value >= 0 AND last_value <= 9007199254740991
  )
) WITHOUT ROWID;

CREATE TABLE todo_id_allocations (
  value INTEGER PRIMARY KEY CHECK (
    typeof(value) = 'integer'
    AND value >= 1 AND value <= 9007199254740991
  ),
  allocated_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE TRIGGER todo_id_allocator_no_delete
BEFORE DELETE ON todo_id_allocator
BEGIN
  SELECT RAISE(ABORT, 'Todo allocator high-water cannot be deleted');
END;

CREATE TRIGGER todo_id_allocator_no_replace
BEFORE INSERT ON todo_id_allocator
WHEN EXISTS (SELECT 1 FROM todo_id_allocator WHERE singleton = 1)
BEGIN
  SELECT RAISE(ABORT, 'Todo allocator singleton already exists');
END;

CREATE TRIGGER todo_id_allocator_strict_increase
BEFORE UPDATE ON todo_id_allocator
WHEN NEW.singleton != OLD.singleton OR NEW.last_value != OLD.last_value + 1
BEGIN
  SELECT RAISE(ABORT, 'Todo allocator high-water must increase by exactly one');
END;

CREATE TRIGGER todo_id_allocations_no_update
BEFORE UPDATE ON todo_id_allocations
BEGIN
  SELECT RAISE(ABORT, 'Todo allocation evidence is append-only');
END;

CREATE TRIGGER todo_id_allocations_no_delete
BEFORE DELETE ON todo_id_allocations
BEGIN
  SELECT RAISE(ABORT, 'Todo allocation evidence is append-only');
END;
```

Install/seed the tables before installing the guards during migration. Thereafter `createWorkItem()` uses two transactions:

1. Perform a non-authoritative `(source, source_ref)` fast lookup; return an existing Todo when found.
2. Under allocator `BEGIN IMMEDIATE`, recheck `(source, source_ref)`. If it now exists, commit no allocation and return it.
3. Update `last_value = last_value + 1`, insert the same value and timestamp into `todo_id_allocations`, validate ledger max equals high-water, and commit. Only after this commit is `JIN-N` handed to creation.
4. Under a second immediate transaction, recheck `(source, source_ref)`. If a concurrent creator won, return that Todo and leave `N` permanently burned.
5. Otherwise insert `JIN-N` and its `created` event atomically, then commit.

Concurrent writers serialize at SQLite's write lock. A crash or rollback after step 3 leaves a durable allocation row and an intentional gap. A duplicate-sourceRef race may burn more than one number while still creating one Todo. The Todo and its `created` event remain atomic, but allocation cannot share their transaction because a failed Todo transaction must not roll the high-water back.

An allocator transaction that itself never commits did not hand out a number and has no durable attempt to preserve. “Permanently burn rolled-back attempts” therefore means every ordinal returned from the allocation primitive is committed before return and can never be reused. Boot and forward repair require `last_value = MAX(todo_id_allocations.value)` (or both zero/empty) and `last_value >= MAX(live JIN suffix)`; neither high-water nor ledger rows may ever be deleted, replaced, or reduced through supported code.

The burn ledger is not a Todo identity table: it has no Todo foreign key, contains ordinals for failed/gapped attempts, and is never queried by Todo lookup/API/MCP/UI. `work_items.id` remains the sole identity.

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
| Manager-visibility callback `payload.message` Todo prose, `payload.meta.workItemId`, and `source_attempt=manager-visibility:<TodoID>` | `notifyManagerVisibility` | Retry/requeue, callback recovery API, acceptance | Live/retryable while pending/dead-letter | Structurally rekey all three as one coupled value; template mismatch, malformed JSON, or identity collision aborts |
| Accepted manager-visibility callback row | `acceptSessionDelivery` | Exactly-once evidence and duplicate receipt | Immutable historical evidence | Preserve every callback row byte, including old prose/meta/source attempt; never requeue, resolve, or return its raw payload from a current API |
| Accepted callback's linked `queue_items.prompt` | Callback acceptance copies `payload.message` | Restart replay, engine input, queue API | Authoritatively rewritable machine copy | Follow accepted callback `queue_item_id`; rekey the exact manager-visibility Todo line for pending, running, completed, and cancelled rows while preserving row identity/status/timestamps; arbitrary prompts are untouched |
| Accepted callback's linked notification `messages.meta.workItemId` | Callback acceptance copies `payload.meta` | Message page/detail APIs and live WebSocket | Authoritatively rewritable transcript projection | Follow accepted callback `message_id`; rewrite only `workItemId` and any exact structured `sourceAttempt` if present; preserve unrelated meta, message ID, content, timestamp |
| Manager-visibility notification `messages.content` | Callback `displayMessage` | Transcript APIs/UI/search | Non-reference string | Preserve; current display text contains employee/title but no Todo ID |
| Session message/queue and dead-letter API serialization | `rowToMessage`, `getMessagePage`, `getQueueItems`, callback recovery list | Browser/MCP/operator clients | Live presentation boundary | Require current-epoch JIN in structured metadata, return rekeyed queue prompts, and neutralize/refuse frozen legacy callback payloads; never emit accepted callback raw evidence |
| Delegation chat block `id=dg-<TodoID>` and `payload.workItemId` | Delegation route/callback | Chat activity card patch/open behavior | Authoritatively rewritable for nonlegacy rows | Rewrite coupled block ID and payload together; validate exact structure/version |
| Todo activity block `id=todo:<TodoID>` and `payload.todoId` | `gateway/chat-activity.ts` | Chat rendering, replay, patch | Authoritatively rewritable for nonlegacy rows | Rewrite coupled block/payload; malformed or duplicate identity aborts |
| `payload.activityReceipt.id` | Activity envelope | Block validator and replay | Authoritatively rewritable | Must remain equal to rewritten block ID |
| Tool `messages.meta.activityReceiptId` | Stream/tool settlement | Web tool-row suppression | Authoritatively rewritable when it exactly matches a rewritten block | Rewrite the full receipt token; missing/ambiguous correlations abort or are explicitly inert evidence |
| Synthetic message PK `block-${block.id}-${uuid}` | `applyBlockEnvelope` | Message context/jump anchors; rendered `data-message-id` today | Non-reference opaque message identity after block rekey | Do not parse as a Todo alias or rewrite historical PKs. Future producer uses `block-${uuid}`; web must never render raw backend IDs |
| Accepted callback identity, payload, `message_id`, `queue_item_id` | `acceptSessionDelivery` | Exactly-once delivery evidence | Immutable historical evidence | Preserve bytes. Old IDs are inert; accepted deliveries cannot be requeued or used to resolve a Todo |
| Legacy Workflow callback/message/queue rows | Historical Workflow session bridge | Legacy transcript/diagnostics | Immutable historical evidence | Preserve Task 4/5 byte checksums and keep the session unreachable through current mutation/navigation surfaces |
| Pending partial messages/active sessions | Live engine turn | Stream settlement | Live transient state | Must be zero. Migration is offline and refuses active/partial work rather than guessing ownership |

`callback_deliveries.message_id` points to the notification message inserted during acceptance, not the synthetic block row inserted by `applyBlockEnvelope`. Acceptance separately copies callback data into the queue and notification message, so freezing the accepted callback does not freeze those copies. Migration follows the callback's durable `queue_item_id`/`message_id`, rewrites those live projections, and verifies message pages, session detail, queue APIs, dead-letter APIs, restart replay, and live WebSocket output cannot expose the old ID. Search/context anchors that escape to clients expire at the identity epoch.

For edit receipts, rebuild the table so its durable key is `(schema_epoch, key_digest)` while preserving every existing row as epoch 1. Epoch-2 lookup first checks whether the same digest exists in epoch 1; if so, it returns the cutover reload/fresh-key result rather than applying a request. It then performs normal epoch-2 fingerprint matching. This preserves old receipt bytes, prevents cross-identity replay, and does not create an old-ID resolver.

### Workflows and historical compatibility

| Reference | Producer | Consumers | Class | Migration action and invariant |
|---|---|---|---|---|
| New `trigger.payload.todoId` | `workflows/todo-status-trigger.ts` from `event.workItemId` | Conditions, run details/UI | New authoritative output | After cutover newly published runs contain JIN IDs only |
| Nonterminal run containing a mapped legacy ID anywhere in its raw file | Frozen Workflow run JSON | Step prompt, condition evaluation, resume, reconcile sweep | Executable frozen evidence | Hard preflight blocker for `running`, `parked`, and `dispatched`, including `running` with `stopping`; terminalize before cutover or do not migrate |
| Terminal run `trigger.payload.todoId`, legacy `triggerTodoId`, or other old literal | Frozen Workflow run JSON | Historical list/detail/MCP | Immutable historical evidence | Preserve file bytes; central read serializer neutralizes old identity/links before REST/MCP/UI output |
| Legacy trigger-store `approvalWorkItemId` | Schema-1 custom trigger | Existing v1-to-v2 trigger migration | Authoritative legacy data already retired by its own migration | Preserve existing migration ordering; verify it is removed before Todo-ID rekey or refuse |
| `source=workflow` and `workflow:<definition>:<run>` source refs | Historical Todo bridge | Reconciliation/read provenance | Historical provenance/non-reference | Preserve. Workflows never create or mutate Todos; automatic reconciliation remains disabled |
| Workflow run/definition IDs | Workflow runtime | Workflow routes/UI | Non-reference strings | Preserve; distinct namespaces |
| `_active-index.json` | Run store save/rebuild | Startup and periodic sweep | Derived/rebuildable | Never trust for preflight. Full-scan every run file; stale/missing/corrupt positive or negative index entries cannot change the decision |

Task 4 requires legacy synthetic Workflow Session rows, messages, queue entries, and callbacks to remain byte-identical. Task 5 gives accepted callback deliveries immutable evidence semantics. Therefore a blanket historical rewrite is forbidden. The smallest safe rule is unconditional: full-scan every run directory and refuse migration when any nonterminal `running`, `parked`, or `dispatched` run contains a mapped legacy ID anywhere in the raw bytes. This includes quiet parked runs, parked runs with in-flight siblings, stopping drains, normalized `triggerTodoId`, frozen conditions/prompts/parameters/receipts, and runs omitted from or wrongly present in the active index. The scan reports a structural JSON location when parseable but does not rely on parsing to find the old ID.

There is no new execution projection. Blocking runs must reach a terminal state before cutover under the legacy epoch. Terminal files remain byte-identical; an epoch-aware Workflow read serializer neutralizes legacy identity for list/detail/MCP output without changing execution evidence. Parked resume and startup/interval sweep cannot run while the migration gate owns the instance.

### Activity and audit projections

| Reference | Producer | Consumers | Class | Migration action and invariant |
|---|---|---|---|---|
| `activity_events.object_id`, href, summary, actor/outcome text, correlation/idempotency fields, detail, links | Generic activity append API | Activity story/search projection and raw row converter | Immutable historical evidence | SQL triggers reject update/delete and payload hash covers fields. Preserve every row byte/hash; never serialize the raw event directly after epoch 2 |
| Epoch-aware Activity presentation | New `activity/presentation.ts` | List stories, preview events, story events/links, REST JSON | Derived live serializer | At epoch 2 recursively neutralize strict legacy Todo tokens, represent an exact legacy Todo object as a noncanonical historical object with no href, and drop any link whose decoded href contains a legacy token; no old-to-new lookup |
| `activity_stories`, versions, `activity_event_search`, projection metadata | Projection builder | Activity page filtering/search | Derived/rebuildable | Record Todo identity epoch and sanitizer version; index presentation-safe values only; rebuild at cutover and fail closed when projection epoch mismatches |
| Company changed event `{entity:'todo', id}` | Todo mutation | WebSocket query invalidation | Derived/transient | Post-cutover emit JIN in memory; not persisted as identity |
| Chat activity receipt IDs | Todo mutation activity | MCP/REST result, session blocks, web suppression | Live structured reference or external receipt | Rekey stored live coupled structures; old external receipts expire at epoch and cannot replay |

There is currently no production caller of the normalized activity append API outside the activity module, but existing instance data cannot be assumed empty. Projection rebuild alone is unsafe because current search indexes raw `object_id` and list/story queries reconstruct raw events and links. Add `activity_projection_meta(singleton, todo_identity_epoch, sanitizer_version)`, make rebuild take the identity epoch, and make list/story queries fail closed unless projection and Todo epochs match.

At epoch 2, the presentation function recognizes only boundary-delimited legacy canonical tokens matching `wi_[0-9a-f]{12}`, sanitizes every public string/nested detail value containing one, replaces an exact legacy Todo object ID with a stable noncanonical `historical-todo:<activity-event-id>` marker plus `historical: true`, omits its href, and drops links whose safely decoded href contains a legacy token. It does not know the migration map and cannot resolve the marker. Activity cursor payloads include the identity epoch so old cursors fail. List, preview, story detail, aggregate links, FTS input, repeated rebuilds, and API JSON all use the same deterministic presentation function. Invalid encoding, unsafe JSON, or any value that cannot be safely neutralized makes Activity queries and migration fail closed rather than emit raw evidence.

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
| Todo/session DB import/export/merge/restore | No supported CLI, API, or MCP surface exists | Refusal-only: do not add or imply import/remap behavior in this ticket |
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

The manifest is an offline audit and pre-serving recovery artifact, not a dual-identity or import feature. Runtime packages contain no function that resolves `oldId` through it.

### Migration state machine

Add an explicit identity schema epoch and migration record in SQLite metadata. Supported states are:

```text
legacy -> staged -> swapping -> validated -> complete-unserved -> served
             \-> failed (startup refused)
```

- `legacy`: exact supported old schema, no JIN rows.
- `staged`: backup and temporary manifest are fsynced and their digests recorded.
- `swapping`: exclusive SQLite transaction is in progress; uncommitted crashes roll back wholesale.
- `validated`: database commit succeeded and post-invariants match, but manifest publication may need recovery.
- `complete-unserved`: final manifest rename and digest verification succeeded, but no request has been allowed and pre-serving backup restoration remains possible.
- `served`: an external irreversible cutover seal was fsynced before `server.listen`; legacy restore and reverse rekey are permanently forbidden.
- `failed`: unexpected schema, corrupt data, digest mismatch, or ambiguous recovery; no request serving.

Completed runs are idempotent no-ops keyed by the identity epoch and manifest digest. A mixed set of legacy and JIN primary keys is never treated as resumable input. No DDL-substring sentinel is sufficient. The served seal is a permission-restricted, atomically published and fsynced artifact adjacent to the manifest, outside the database backup; supported tooling cannot delete it. It binds instance identity, manifest digest, target epoch, and first-served timestamp.

### Offline staging and preflight

1. Stop request intake and background producers using the reviewed deployment procedure. Acquire exclusive instance ownership before `initDb()` can mutate schemas; current startup initializes the DB before all process cleanup, so implementation must reorder/gate this path.
2. Refuse active engine turns, partial messages, pending queue execution, or a second gateway process.
3. Checkpoint WAL, acquire an exclusive lock, run `PRAGMA integrity_check`, and verify the exact supported table/index/trigger schemas.
4. Create a restorable SQLite backup using the SQLite backup API, fsync it, reopen it independently, run integrity check, and record its digest.
5. Inventory every class in the graph. Direct references must resolve. Structured JSON must parse and match its paired relational value. Unknown reference-bearing shapes abort.
6. Full-scan every raw Workflow run file, ignoring the active index. If any mapped old ID occurs in a nonterminal `running`, `parked`, or `dispatched` run—including a running/stopping drain—abort. Missing/corrupt/unreadable run files or indexes also fail closed.
7. Inventory terminal Workflow and other immutable evidence without altering it. Prove each old literal is behind an epoch-aware serializer and unreachable from live Todo lookup, mutation, navigation, callback requeue, Workflow execution, or engine prompt behavior.
8. Refuse a schema-1 trigger store until its existing `approvalWorkItemId` retirement migration is complete.
9. Build the deterministic map, invariant snapshot, and temporary manifest; fsync before destructive SQL.

### Atomic SQLite swap

Inside one exclusive/immediate transaction:

1. Create a temporary mapping table keyed both ways and verify one-to-one cardinality.
2. Rebuild `work_items` with the strict ID check and mapped primary keys.
3. Rekey `work_item_events.work_item_id` under the approved audit exception.
4. Rekey ordinary live `sessions.work_item_id`.
5. Rekey exact nonlegacy delegation session keys/source refs and matching queue keys.
6. Structurally rekey supported completion-contract JSON, Todo/delegation blocks, receipts, tool metadata, and pending/dead-letter callback state. Do not recursive-search arbitrary JSON or prose.
7. For every accepted manager-visibility callback, preserve the callback row bytes but follow its linked queue/message IDs: rekey the exact queue prompt Todo line and notification metadata while preserving their identity/status/timestamps/content.
8. Preserve legacy Workflow session/callback/transcript bytes and accepted callback bytes. Install central serializers/requeue guards so old evidence is neither actionable nor emitted raw.
9. Add receipt epoch 2 while retaining epoch-1 receipt bytes. Pre-cutover retries receive a reload/fresh-key outcome.
10. Rebuild Activity projections through the epoch-2 presentation sanitizer, write projection epoch/sanitizer metadata, and invalidate old Activity cursors. Immutable events/hashes remain untouched.
11. Seed `todo_id_allocations` with ordinals `1..N` and `todo_id_allocator.last_value = N`, where `N` is the deterministic migration row count; then install no-delete/strict-increase/append-only guards. Live Todo suffixes may be sparse only after serving begins.
12. Rebuild other derived indexes/projections as required.
13. Record identity epoch and manifest digest, then drop the temporary live map so no alias survives.
14. Run transaction-local invariants and commit once.

Structured transcript rewrites are allowed only for nonlegacy machine-authored live blocks whose coupled fields can be proven exact. Message prose, tool result text, and opaque message primary keys remain unchanged. If changing a block would violate a frozen-row checksum or leave mismatched receipt correlation, the migration aborts.

### Post-commit validation

Before serving requests, prove:

- every `work_items.id` matches the strict grammar and maps to one ordinal;
- every live relational Todo reference resolves to exactly one row;
- no live structured resolver input contains a legacy ID;
- counts, statuses, versions, source/sourceRef, approvals, timestamps, event IDs/order, and event `detail` bytes match the pre-snapshot;
- every coupled block ID/payload/receipt/tool-meta set is internally consistent;
- pending/dead callbacks contain only current identities; accepted/legacy callback evidence hashes are unchanged; their linked queue/message/API projections contain no old identity;
- no nonterminal Workflow run contains a mapped legacy ID; all terminal run and legacy session evidence hashes are unchanged; REST/MCP read serialization contains no old identity;
- immutable Activity rows and payload hashes are unchanged; projection metadata matches epoch 2; list/story/search/rebuild/API output contains no old token or link;
- allocator `last_value = MAX(todo_id_allocations.value)`, the ledger contains exactly `1..N` immediately after migration, and high-water is at least the maximum live JIN suffix;
- no temporary mapping table, compatibility column, or alias resolver remains;
- `PRAGMA integrity_check` succeeds;
- a second migration invocation is a no-op with the same manifest digest.

The process then atomically renames the staged manifest into its final audit location and marks `complete-unserved`. If the DB commit succeeded but the rename was interrupted, boot validates the recorded digest and completes only the rename. A missing or mismatched staged manifest is a refusal, not a remap rerun.

### Rollback and recovery

- A crash before SQLite commit rolls the transaction back; recovery verifies the legacy invariant and discards no evidence automatically.
- A crash after commit but before final manifest rename resumes publication by digest, not data mutation.
- A failed validation keeps the gateway closed and preserves diagnostics plus the backup.
- Full legacy-backup restoration is permitted only in `complete-unserved`, while the external served seal is absent and invariants prove no post-migration allocation or write occurred. Restore is offline, whole-database, and revalidated before any old binary may open it.
- Immediately before `server.listen`, atomically publish and fsync the external served seal, then mark the DB `served`. A crash after the seal but before the DB marker/listen resumes only the forward transition to `served`; it can never reopen legacy restore.
- Once the external seal exists, full legacy-backup restoration, reverse rekey, allocator reseed, and downgrade are categorically forbidden. The legacy backup becomes forensic evidence only.
- Post-serving recovery is forward-only: quiesce request/background intake, snapshot the current migrated DB/WAL, record the current high-water and allocation-ledger digest, and apply the smallest epoch-2 repair transaction or repaired clone against that current state. Preserve every post-cutover Todo/event/session/queue/message/callback write and every burn ledger row.
- A failed forward-repair transaction rolls back to the current migrated state, not the legacy backup. Before reopen, prove `H_after >= H_before`, `H_after = MAX(ledger)`, every pre-repair live JIN row still exists with the same version/evidence, and all new invariants pass. If preservation cannot be proven, remain offline and escalate; data loss is not a rollback strategy.
- External frozen Workflow files are not mutated, so forward repair verifies their hashes rather than restoring them.

## Mixed-Version Refusal and Deployment Boundary

The current CLI merely warns about an old instance/template version and current binaries do not understand a future Todo identity epoch. A database CHECK prevents old writers from inserting `wi_*` but cannot force an arbitrary old process to refuse reads.

The safe rollout is two-stage:

1. Ship a guard-capable release that understands the legacy epoch and refuses unknown/newer/incomplete epochs while still using the old identity scheme.
2. After it is deployed everywhere that may open the database, ship the migration-capable release and run the reviewed offline cutover.

The migration-capable gateway publishes an identity epoch in bootstrap/status responses. Mutations carry the epoch; mismatched clients receive upgrade/reload-required (`409` or `426`, selected consistently) before any write. Request serving never starts in `staged`, `swapping`, `validated`, `complete-unserved` without completing the served seal, `failed`, corrupt, or mixed states.

An unsupported old binary remains outside the supported downgrade boundary. Migration is no-go until the independent reviewer accepts the two-stage requirement and the exact minimum compatible release.

## Cross-Instance Behavior

`JIN-N` is intentionally instance-local, so two independent instances may both own `JIN-1`. Current product surfaces do not import, export, restore, or merge Todo/session databases. `jinn create` creates a fresh home; instance selection and listing do not copy work. Therefore this ticket must not pretend to retrofit a nonexistent merge API.

This ticket's complete cross-instance contract is refusal-only:

- REST/MCP Todo IDs always resolve in the currently selected instance. A foreign value that happens to equal a local ID is indistinguishable and therefore means the local Todo; it is not an import operation.
- There is no `/api/work-items/import`, import/merge MCP tool, Todo import CLI command, or instance-registry data-copy operation. Unknown routes/tools/options fail through existing 404/unknown-command behavior and create no rows.
- `/api/instances` and instance CLI listing expose health/metadata only and cannot move data.
- Manual JSON insertion or whole-home/database copying is unsupported filesystem mutation outside the product import contract. A whole-home clone preserves its own database/allocator as a clone; it is not merged into another namespace.
- Any proposed cross-instance import, merge, collision remap, source fingerprint, duplicate policy, total ordering, or canonical remap manifest is separate future architecture work and is not an acceptance criterion, fixture, or partially specified protocol in this ticket.

## RED to GREEN Implementation Sequence

Each implementation task begins with a failing focused test, demonstrates the expected failure, adds the smallest production change, reruns the focused test, and commits independently. No task begins before architecture approval.

### Task 0: Record operator decisions and independent architecture approval

**Files:** Review this plan; no production files.

- Operator records explicit acceptance or rejection for each of the five rows in “Operator Decision Gate”; the plan recommends `YES` for all five.
- A fresh reviewer who did not author this revision verifies every graph class and technical risk against the repository.
- Gate remains closed if an operator answer is absent/conditional, any recommended policy is rejected without replacement architecture, or independent review does not approve the revised map.

### Task 1: Canonical parser and transactional allocator

**Files:**

- Add `packages/jinn/src/work-items/id.ts`
- Add `packages/jinn/src/work-items/allocator.ts`
- Modify `packages/jinn/src/work-items/migrate.ts`
- Modify `packages/jinn/src/work-items/store.ts`
- Add `packages/jinn/src/work-items/__tests__/id.test.ts`
- Add `packages/jinn/src/work-items/__tests__/allocator.test.ts`
- Modify `packages/jinn/src/work-items/__tests__/store.test.ts`

RED cases: grammar edges, safe-integer overflow, empty/one/many allocations, allocator singleton DELETE/REPLACE rejection, equal/decreasing/skipped high-water update rejection, ledger UPDATE/DELETE rejection, archive/raw-delete nonreuse, failed Todo/event transaction after a committed burn, crash after burn before create, racing duplicate sourceRefs with permitted gaps, and numeric tie-break ordering.

GREEN: central parser/formatter, guarded high-water/ledger, committed allocation primitive, and separate atomic Todo/event creation transaction. Assert every returned ordinal has a durable ledger row before creation begins; never assert contiguous live Todo IDs.

### Task 2: Migration state, deterministic map, backup, and fault recovery

**Files:**

- Add `packages/jinn/src/work-items/identity-migration.ts`
- Add `packages/jinn/src/work-items/identity-manifest.ts`
- Add `packages/jinn/src/work-items/identity-cutover.ts`
- Add `packages/jinn/src/work-items/identity-forward-repair.ts`
- Modify `packages/jinn/src/sessions/registry.ts`
- Modify `packages/jinn/src/gateway/server.ts`
- Add `packages/jinn/src/cli/todo-identity.ts`
- Modify `packages/jinn/bin/jinn.ts`
- Add `packages/jinn/src/work-items/__tests__/identity-migration.test.ts`
- Add `packages/jinn/src/work-items/__tests__/identity-migration-worker.mjs`

RED fixtures: empty/current databases, equal creation timestamps, malformed IDs/timestamps, mixed/newer schemas, deterministic rerun, exclusive-lock races, fault injection at every state boundary, pre-serving restore, external-seal/DB-marker crash windows, post-serving restore refusal before filesystem replacement, and forward-repair rollback against the current migrated state.

GREEN: state machine through `complete-unserved` and irreversible `served`, backup verification, manifest staging, exact map, single swap transaction, postvalidation, pre-listen external seal, idempotent completion, pre-serving-only restore, forward-only post-serving repair, and hard startup refusal.

### Task 3: Relational references and receipt epoch

**Files:**

- Modify `packages/jinn/src/work-items/identity-migration.ts`
- Modify `packages/jinn/src/work-items/store.ts`
- Modify `packages/jinn/src/work-items/workflow-event-feed.ts`
- Modify `packages/jinn/src/sessions/registry.ts`
- Modify `packages/jinn/src/sessions/delegation-completion-contract.ts`
- Modify `packages/jinn/src/work-items/__tests__/identity-migration.test.ts` and `store.test.ts`
- Add `packages/jinn/src/sessions/__tests__/todo-identity-migration.test.ts`
- Modify `packages/jinn/src/sessions/__tests__/delegation-completion-contract.test.ts`

RED: dangling event/session references, event byte-preservation, linked spend/attempt lookup, delegation key plus queue rewrite, completion-contract match/mismatch, epoch-1 edit retry, and epoch-2 CAS replay.

GREEN: approved event-envelope rekey, live session/key rewrites, strict structured JSON handling, and receipt epoch boundary without version bumps.

### Task 4: Workflow and immutable-evidence barriers

**Files:**

- Modify `packages/jinn/src/workflows/run-store.ts` only where needed to prohibit lookup/navigation
- Add `packages/jinn/src/workflows/todo-identity-preflight.ts`
- Add `packages/jinn/src/workflows/presentation.ts`
- Modify `packages/jinn/src/workflows/todo-status-trigger.ts`
- Modify `packages/jinn/src/work-items/reconcile.ts` only if a guard is missing
- Modify `packages/jinn/src/sessions/registry.ts` for legacy-session guards
- Modify `packages/jinn/src/gateway/api.ts` and `packages/jinn/src/mcp/workflow-tools.ts` to use the terminal-run presentation serializer
- Add `packages/jinn/src/workflows/__tests__/todo-identifier-migration-preflight.test.ts`
- Modify `packages/jinn/src/workflows/__tests__/active-run-index.test.ts` and `run-reconciler.test.ts`
- Modify `packages/jinn/src/sessions/__tests__/legacy-workflow-session-compat.test.ts`
- Add `packages/jinn/src/gateway/__tests__/workflow-run-presentation.test.ts`
- Modify `packages/jinn/src/mcp/__tests__/workflow-tools.test.ts`

RED: full run-directory scan with modern trigger payload, read-time-only `triggerTodoId`, ID only in frozen condition/prompt/parameter/receipt prose, quiet parked run, parked run with in-flight sibling, running/stopping drain, dispatched run, missing/corrupt/stale-positive/stale-negative active index, parked resume attempt, startup/interval sweep, terminal file checksums, terminal list/detail/MCP serialization, `source=workflow` negative capability, and legacy Workflow session byte checksums.

GREEN: any nonterminal legacy-bearing run blocks before cutover regardless of index/engine/queue state; no execution projection exists; after every blocker terminalizes under the legacy epoch, migration succeeds deterministically. New runs emit JIN, terminal evidence stays byte-identical, and public Workflow serializers neutralize old identity.

### Task 5: Blocks, receipts, callbacks, and full-transcript privacy

**Files:**

- Modify `packages/jinn/src/gateway/chat-activity.ts`
- Modify `packages/jinn/src/shared/blocks.ts`
- Modify `packages/jinn/src/sessions/registry.ts`
- Modify `packages/jinn/src/sessions/callbacks.ts`
- Modify `packages/web/src/components/chat/chat-messages.tsx`
- Modify `packages/web/src/lib/blocks.ts`
- Modify `packages/jinn/src/gateway/__tests__/manager-visibility.test.ts` and `callback-reliability.test.ts`
- Modify `packages/jinn/src/sessions/__tests__/callback-deliveries.test.ts`
- Modify `packages/web/src/components/chat/__tests__/company-activity-card.test.tsx`, `chat-messages-tool-group.test.tsx`, and `chat-messages-jump.test.tsx`

RED: coupled Todo/delegation block migration, duplicate/malformed blocks, tool suppression, pending/dead manager-visibility callback's three coupled references, and an accepted-and-consumed manager-visibility fixture. Snapshot the accepted callback row; migrate; prove its bytes unchanged while the completed queue prompt and notification `meta.workItemId` are current, message/session/queue/dead-letter APIs and WebSocket output contain no old ID, restart does not consume twice, and duplicate callback response emits receipt IDs only. Also cover future domain-independent synthetic message IDs and full rendered transcript privacy.

GREEN: structural rewrite for approved live callback/queue/message copies, byte-frozen accepted evidence, serializer defense-in-depth, stale callback barriers, private DOM message anchors, and zero system-generated canonical IDs in browser persistence/DOM.

### Task 6: Epoch-aware Activity presentation and search

**Files:**

- Add `packages/jinn/src/activity/presentation.ts`
- Modify `packages/jinn/src/activity/types.ts`
- Modify `packages/jinn/src/activity/migrate.ts`
- Modify `packages/jinn/src/activity/projection.ts`
- Modify `packages/jinn/src/activity/query.ts`
- Modify `packages/jinn/src/gateway/api.ts`
- Modify `packages/jinn/src/activity/__tests__/migration.test.ts`, `query.test.ts`, `store.test.ts`, and gateway Activity endpoint tests

RED: immutable event with a legacy token in object ID/href/label, summary, actor/outcome text, correlation/idempotency/detailRef, nested detail, and links. Snapshot raw rows/hashes; assert list preview, story detail/events/aggregate links, search by full token or suffix, repeated rebuild, and API JSON expose no old token/link. Stale projection epoch, corrupt presentation input, and pre-cutover cursor must fail closed.

GREEN: one deterministic epoch-aware presentation function neutralizes public values and FTS input without a map; exact historical Todo objects become noncanonical non-navigable markers; unsafe links drop; projection metadata matches Todo epoch; raw event bytes/hashes remain identical through repeated rebuilds.

### Task 7: REST, MCP, search, cron, and delegation producers

**Files:**

- Modify `packages/jinn/src/gateway/api.ts`
- Modify `packages/jinn/src/mcp/work-item-tools.ts`
- Modify `packages/jinn/src/mcp/approval-tools.ts`
- Modify `packages/jinn/src/mcp/delegation-tools.ts`
- Modify `packages/jinn/src/cron/runner.ts` only where it consumes/returns Todo identity
- Modify `packages/jinn/src/gateway/__tests__/work-items-route.test.ts`, `work-item-approval-route.test.ts`, and `delegations-route.test.ts`
- Modify `packages/jinn/src/mcp/__tests__/work-item-tools.test.ts` and `delegation-tools.test.ts`
- Modify `packages/jinn/src/cron/__tests__/runner.test.ts`

RED: every route/tool accepts JIN, rejects legacy/malformed/case variants, never returns a remap, exact-ID search, duplicate sourceRef, cron reuse, delegation mint/existing-ID paths, and activity receipt outputs.

GREEN: all boundaries share the parser; all producers use allocator; old strings can only match user text, never identity.

### Task 8: Web epoch, private references, React Query, and CAS

**Files:**

- Modify `packages/web/src/routes/todos/todo-private-state.ts`
- Modify `packages/web/src/lib/todos.ts`
- Modify `packages/web/src/routes/todos/use-todos.ts`
- Modify `packages/web/src/routes/todos/page.tsx`, `group.tsx`, `row.tsx`, `detail-sheet.tsx`, `use-todo-draft.ts`, and `use-todo-quick-edit.ts`
- Modify `packages/web/src/routes/todos/__tests__/todo-private-state.test.ts`, `page-history.test.tsx`, `todo-quick-edit.test.tsx`, `todo-edit-request.test.ts`, and `quick-edit-retry-actions.test.tsx`
- Modify gateway bootstrap/status typing and web query client handling

RED: stale `td_*` selection, stale edit journal, dirty-draft cutover, epoch mismatch, technical source/approval labels containing JIN, query invalidation, reload behavior, Activity card click, and full ChatMessages wrapper. With canonical `JIN-42`, assert pathname/search, `history.state`, all browser storage, outerHTML/text/attributes/hrefs exclude it while the authenticated network call carries it.

GREEN: versioned private namespace, fail-closed journal invalidation, neutral reload message, full query reset, epoch handshake, and private-only navigation state.

### Task 9: Current fixtures, templates, and active documentation

**Files:**

- Update current-behavior ID fixtures across work-item, gateway, MCP, session, engine/shared, Workflow, and web tests
- Keep explicit legacy/corrupt fixtures named as migration evidence
- Modify `packages/jinn/template/skills/todo-handling/SKILL.md`
- Modify `packages/jinn/template/skills/delegation/SKILL.md` and `packages/jinn/template/skills/management/SKILL.md` where the classified sweep finds current Todo-ID examples
- Add a new versioned template migration note; do not edit historical migration prompts

RED: repository classification test/lint that flags unexplained legacy literals in active code/templates while allowlisting named historical fixtures, schema object names, `wie_*`, and `wi-job`.

GREEN: current examples use JIN; historical artifacts retain documented purpose; public templates remain generic.

### Task 10: Full rehearsal, verification, and independent implementation review

**Files:** Test artifacts only until reviewer approves deployment; no production instance data.

1. Build a disposable instance fixture containing every reference class.
2. Run preflight, backup, migration, pre-serving restore, remigration, served-seal transition, idempotent rerun, and post-serving restore refusal.
3. After serving is sealed, create `JIN-(N+1)`, inject a forward-repair failure, and prove the failed repair preserves that Todo and high-water; complete forward repair and prove the next creation is greater.
4. Burn an ordinal, fail its Todo transaction, attempt forbidden legacy restore, run forward repair, and prove the next Todo skips the burned ordinal.
5. Run concurrent allocator/boot workers with duplicate-sourceRef gaps allowed.
6. Run parked resume/sweep, accepted-and-consumed manager visibility, Activity list/story/search/rebuild, refusal-only cross-instance, and browser privacy fixtures.
7. Run browser QA against the disposable gateway.
8. Run privacy and repository leak sweeps.
9. Have a reviewer who did not implement the migration compare manifest, seals, pre/post invariants, and acceptance criteria.
10. Keep production closed until that reviewer gives an explicit go.

## Verification Matrix

| Scenario | Required fixture/evidence | Pass condition |
|---|---|---|
| Empty instance | No Todos, allocator/ledger absent | Complete-unserved epoch seeds `last_value=0`, empty ledger/manifest rows; first served allocation burns 1 and creates JIN-1 |
| Current linked data | Todos/events/sessions/delegation/blocks/pending callback | Deterministic map; every live relation resolves; semantic bytes/versions preserved |
| Equal timestamps | Multiple legacy IDs with identical `created_at` | Binary old-ID tie-break gives identical manifest on rerun |
| Corrupt canonical row | Malformed old ID/null or wrong timestamp type | Preflight refusal; no DB or manifest publication change |
| Dangling direct reference | Event/session/block points to missing Todo | Preflight refusal with exact class/locator digest |
| Corrupt structured JSON | Completion contract/block/callback cannot parse or mismatches pair | Preflight refusal; no recursive best-effort rewrite |
| Nonterminal Workflow blocker | Quiet parked, parked/in-flight, running/stopping, dispatched, stale index | Full file scan refuses every legacy-bearing run; resume/sweep cannot cross gate; terminalizing all blockers permits deterministic retry |
| Terminal Workflow evidence | Completed/failed/cancelled run plus legacy run Session | File/session checksum unchanged; list/detail/MCP serializers expose no old identity/link |
| Activity audit evidence | Immutable event contains old IDs/links in every public field | Raw bytes/hash unchanged; epoch-safe list/story/search/rebuild/API exposes no old token/link; epoch mismatch fails closed |
| Callback lifecycle | Pending, dead-letter, accepted-and-consumed, poison, legacy | Pending/dead coupled references rekey or refuse; accepted row checksum unchanged; linked queue/message/API copies safe; no double consume |
| CAS boundary | Pre-cutover receipt plus post-cutover edit | Old key requests reload/fresh key; JIN retry is idempotent; Todo version unchanged by migration |
| Interrupted transaction | Fault before/inside commit | SQLite rollback returns exact legacy invariant; rerun maps identically |
| Commit/manifest interruption | Fault after commit before rename | Boot refuses serving, verifies digest, completes rename only |
| Burned failed allocation | Commit allocation N, fail Todo/event insert, restart | Ledger/high-water retain N, no JIN-N row exists, next successful create is greater than N |
| Allocator guards | DELETE/REPLACE singleton, equal/decreasing/skipped update, ledger UPDATE/DELETE | Every forbidden SQL statement aborts; high-water and ledger remain unchanged |
| Concurrent allocation | 16 and 32 workers, duplicate/nonduplicate sourceRefs | Unique strictly increasing burns; one Todo per idempotency key; permanent gaps allowed; no ordinal handed to creation is reused |
| Concurrent boot | Multiple migration-capable processes | One owner migrates; others wait/refuse; no partial schema |
| Mixed/newer binary | Legacy, guard-only, migrated, and unsupported epoch combinations | Matrix matches documented refusal; no old writer can commit |
| Browser privacy | Todos, chat activity, search jump, reload, private selection/edit | No system-generated JIN in URL/history/storage/DOM; network/in-memory remains functional |
| Same-instance duplicate | Duplicated sessions with block/contract refs | All nonlegacy live copies rekey consistently; frozen copies remain inert |
| Cross-instance refusal | Two isolated homes each own JIN-1; probe route/tool/CLI/instance listing | IDs remain local; no rows move; import route is 404, tool is absent/unknown, CLI has no import command |
| Idempotent rerun | Completed migration invoked again | No bytes/counters/manifest rows change |
| Pre-serving restore | `complete-unserved`, no external seal, no postmigration write | Verified whole legacy backup may restore offline; exact legacy state returns |
| Post-serving rollback refusal | Seal served, create JIN-(N+1), request legacy restore | Refusal occurs before file replacement; new Todo and ledger/high-water remain intact |
| Failed forward repair | Seal served, snapshot current migrated state, inject repair failure | Repair transaction rolls back to current JIN state; all post-cutover writes/high-water survive; instance stays closed until safe repair |
| Successful forward repair | Same fixture after correcting fault | Current rows/versions/evidence survive, `H_after >= H_before`, next create exceeds every prior burn |

### Required command gates during implementation

Run focused RED/GREEN commands specified by each test file, then at minimum:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Also run backend and web package-specific suites where the monorepo scripts permit, the concurrent worker harness, the disposable migration rehearsal, and browser QA. Production port/process state is checked before and after rehearsal to prove it was untouched.

## Risks and Independent Review Decisions

The operator table fixes the recommended product policy; these technical consequences still require fresh independent verification of the revised map.

1. **Append-only Todo events:** Approve rekeying only `work_item_events.work_item_id`; preserve all other event bytes and record relationship hashes. Rejecting this makes the migration impossible without a runtime alias.
2. **Permanent burns:** Verify the two-transaction create protocol, allocator/ledger guards, duplicate-sourceRef gaps, and forward-repair invariants. No returned allocation may ever roll back.
3. **Workflow cutover availability:** The safe policy blocks on every nonterminal legacy-bearing run. If the operator cannot terminalize those runs before the maintenance window, migration remains blocked; no execution projection is added as a shortcut.
4. **Legacy Workflow Sessions:** Preserve Task 4 bytes and refuse migration if any row remains operationally actionable. A blanket `sessions.work_item_id` rewrite is not acceptable without amending Task 4.
5. **Callback fan-out:** Verify pending/dead coupled rewrites and accepted-callback byte preservation independently from linked queue/message/API projections. A missing linked row, malformed template, or collision is fail-closed.
6. **Activity presentation:** Verify every public field and FTS input passes through one epoch-aware neutralizer while immutable bytes/hashes remain stable. Any bypass or unsafe parse is a migration blocker.
7. **Live transcript blocks:** Approve narrow structural rewrites for nonlegacy machine-authored blocks only. Preserve prose and opaque message IDs. Abort on ambiguity.
8. **Edit receipts:** Preserve epoch-1 receipt bytes but invalidate operational replay across cutover; require reload/fresh key. Recalculation is impossible because the original request is absent.
9. **Mixed-version boundary:** Approve a guard release before the migration release and name the minimum compatible version. A single-release cutover cannot protect against arbitrary old binaries.
10. **Browser state:** Private-ref privacy is locked. Stale private refs/edit journals fail closed at the epoch boundary; migration waits for no dirty drafts/tabs or accepts documented draft loss, never stores a canonical ID.
11. **Migration orchestration:** Use an explicit offline command/maintenance gate rather than implicit ordinary startup migration. Do not overload the template-oriented `jinn migrate` command ambiguously.
12. **Post-serving recovery:** Verify the external seal cannot disappear through supported restore tooling and that forward repair preserves all post-cutover writes plus allocation ledger/high-water. If proof fails, the instance stays offline.

## Exact Go/No-Go Criteria

### Architecture GO

Implementation may begin only when the operator explicitly accepts all five recommended decisions in the operator table and a fresh independent reviewer approves this revised map and confirms:

- every field in the producer/consumer graph was checked against current source;
- immutable evidence is separated from live resolvable state without a hidden alias;
- the deterministic ordering and fixed prefix are accepted;
- the backup/manifest/state-machine design is recoverable and idempotent;
- full backup restoration is impossible after the served seal and forward repair preserves post-cutover writes/high-water;
- the two-stage mixed-version boundary is operationally acceptable;
- the locked private-reference browser contract is preserved;
- the implementation sequence and fixture matrix cover the contract.

### Architecture NO-GO

Do not implement if any of the following remains true:

- any nonterminal Workflow run contains a mapped legacy ID, regardless of parked/stopping/index state;
- a legacy Workflow session or accepted/dead callback still uses an old ID for a live action;
- manager-visibility queue/message/API copies or Activity list/story/search serializers can emit an old ID;
- full legacy restore remains callable after the served seal or forward repair can lose a post-cutover write/high-water;
- allocator deletion, replacement, decrease, or reuse of a burned ordinal remains possible;
- epoch-1 edit-receipt behavior is unspecified;
- old binaries may open the migrated database;
- dirty browser drafts must survive without a permitted old-ID map;
- a cross-instance import/remap is expected in this refusal-only ticket;
- the operator has not accepted every decision-table row;
- the independent reviewer is also the migration-map author.

### Deployment GO

Production cutover is a later gate. It additionally requires:

- all RED-to-GREEN tasks complete;
- full test/typecheck/lint/build gates green;
- current, corrupt, interrupted, concurrent, and cross-instance fixture evidence attached;
- disposable migration, pre-serving restore, post-serving refusal, and forward-repair rehearsals pass with matching digests;
- browser QA and privacy scans pass;
- leak scan finds no personal data in shipped changes;
- a fresh independent implementation reviewer signs off;
- an explicit maintenance window, pre-serving restore owner, and post-serving forward-repair owner are named.

Until then, do not restart, deploy, release, publish, or migrate a production instance.

## V2 Re-Audit Evidence

The rejection was re-audited against the current source before this revision. These are the load-bearing paths:

- Allocation/create boundary: `packages/jinn/src/work-items/store.ts:216-219,345-404` currently generates before a deferred Todo/event transaction and rechecks sourceRef inside it; `packages/jinn/src/work-items/migrate.ts:32-60,150-185` has no allocator and demonstrates the current immediate table-swap primitive.
- Boot/serve boundary: `packages/jinn/src/sessions/registry.ts:421-490,721-733` opens and migrates the instance DB; `packages/jinn/src/gateway/server.ts:307-309` initializes it and `:1339-1348` begins listening; `packages/jinn/src/cli/start.ts:53-60` currently warns rather than refuses version drift.
- Workflow executability: `packages/jinn/src/workflows/run-store.ts:342-348` defines statuses and `:800-879` makes only completed/failed/cancelled terminal while indexing every other status. `run-reconciler.ts:426-436` passes trigger data to step prompts, `:1143-1200` resumes parked gates, and `:1207-1275` rebuilds/sweeps the active index. `handoff.ts:434-458` serializes trigger payloads; `condition.ts:176-190` reads scalar trigger payload values; `advance.ts:1010-1016,1674-1694` feeds conditions and drains stopping runs.
- Manager visibility: `packages/jinn/src/sessions/callbacks.ts:50-80` writes Todo prose, `meta.workItemId`, and source attempt. `sessions/registry.ts:3335-3383` copies prompt/meta into queue/message rows and links their IDs to the accepted callback. `gateway/api.ts:473-525` replays pending callback queues, `:2828-2850` serializes dead letters, `:3263-3310` serializes messages/session detail, `:3553-3561` serializes queue prompts, and `:5645-5673` reloads authoritative callback payload.
- Activity exposure: `packages/jinn/src/activity/migrate.ts:31-78,115-139` defines immutable hashed rows. `projection.ts:75-84,134-163` indexes raw object IDs and rebuilds from raw rows. `store.ts:183-223` reconstructs all raw fields. `query.ts:187-221,323-365` returns raw list/story events and links. `gateway/api.ts:6663-6691` serializes those results directly.
- Cross-instance absence: `packages/jinn/bin/jinn.ts`, `packages/jinn/src/cli/create.ts:21-88`, `cli/instances.ts:6-24`, `gateway/api.ts:3024-3036`, and `mcp/server.ts:115-129,224-245` expose no Todo import/export/merge surface and reject unknown routes/tools.
- Locked privacy: `packages/web/src/main.tsx:70-80` has only `/todos`; `routes/todos/todo-private-state.ts:63-90,344-435` uses salted private refs/journal keys; `page.tsx:141-175,578-608` sanitizes history and stores private refs; `group.tsx:213-217` uses private DOM anchors; `use-todos.ts:312-388` resolves in memory. `components/chat/chat-messages.tsx:1268-1270` is the known raw message-ID DOM leak covered by the RED privacy canary.

## Audited File Inventory

This is the concrete repository reference graph used to produce the classifications above. Implementation must repeat the literal/structural sweep because the repository may change after approval.

### Production and schema files

- Canonical Todo schema/store/transitions/approvals: `packages/jinn/src/work-items/migrate.ts`, `store.ts`, `transitions.ts`, `approvals.ts`, `reconcile.ts`, and `workflow-event-feed.ts`.
- Session schema and durable state: `packages/jinn/src/sessions/registry.ts`, `callbacks.ts`, and `delegation-completion-contract.ts`.
- Gateway producers/consumers: `packages/jinn/src/gateway/api.ts`, `chat-activity.ts`, and `manager-visibility.ts`.
- Workflow evidence and triggers: `packages/jinn/src/workflows/run-store.ts`, `run-reconciler.ts`, `handoff.ts`, `todo-status-trigger.ts`, `custom-triggers.ts`, `condition.ts`, and `advance.ts`.
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
- [x] Events, sourceRef/idempotency, approvals, sessions, delegations, manager-visibility callback fan-out, queues, messages, APIs, and receipts are classified.
- [x] Workflow Todo-status triggers, every nonterminal run state/index/resume/sweep path, legacy compatibility, `source=workflow`, and one-way capability boundaries are preserved.
- [x] Chat activity blocks, receipts, synthetic message IDs, CAS, React Query, private refs, and DOM privacy are reconciled.
- [x] REST, MCP, CLI absence, search, shared types, cron, and WebSocket activity are covered.
- [x] Activity immutable bytes/hashes, epoch presentation, list/story/search/rebuild/API, projections/FTS, backups, instances, tests, templates, docs, and migrations are covered.
- [x] Deterministic map, permanent-burn allocator, staging, atomic swap, invariant validation, idempotence, crash recovery, pre-serving restore, post-serving forward repair, and mixed-version refusal are specified.
- [x] Cross-instance behavior is grounded in current surfaces and scoped to explicit refusal; no remap protocol is invented.
- [x] RED-to-GREEN tasks and verification fixtures cover current, corrupt, interrupted, concurrent, and collision cases.
- [x] Risks, unresolved decisions, and exact architecture/deployment gates are explicit.
- [x] The five operator decisions have recommended defaults and implementation remains forbidden until operator acceptance plus independent approval.
- [x] Canonical-ID browser privacy is locked, not presented as an open decision.
- [x] No production implementation or runtime mutation is authorized by this document.
