# JIN-N Sole Todo Identifier Implementation Plan — v4 Conditional Architecture

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` or `executing-plans` with `dev-workflow` and `test-driven-development` to implement this plan task by task. This document is an architecture gate, not implementation authorization.

**Goal:** Replace every live canonical Todo identifier with one immutable, instance-local `JIN-N` identifier, with no runtime `wi_*` alias and no observable mixed identity.

**Architecture:** A fixed-format text primary key remains the sole Todo identity. A guarded SQLite high-water plus append-only burn ledger permanently allocates each ordinal in a committed immediate transaction before a separate atomic Todo/event insert, so failed creates leave intentional gaps but can never reuse an issued number. A one-time, offline, manifest-backed migration deterministically rekeys authoritative references while preserving approved immutable evidence behind epoch-aware, non-resolving presentation boundaries. The gateway refuses incomplete, corrupt, newer, or mixed identity epochs.

**Tech Stack:** TypeScript, SQLite through `better-sqlite3`, Vitest, Commander, MCP tools, React 19, React Router 7, TanStack Query, Playwright/browser QA.

## Global Constraints

- This phase may change and commit this plan only. No production code, tests, schemas, fixtures, runtime data, or live instance state may change.
- Implementation is forbidden until the operator accepts every decision in the operator table, selects browser policy A or B, and a fresh independent reviewer approves the revised migration map.
- The canonical prefix is fixed as `JIN-` for v1; no runtime alias or old-to-new resolver may survive migration.
- The common browser privacy floor is locked: canonical `JIN-N` never enters browser-visible/navigation URL or history, `sessionStorage`, `localStorage`, hidden/data attributes, technical message/block anchors, raw cursors, or unrelated metadata. Salted private references remain mandatory. Whether an intentional visible Todo identity may render `JIN-N` is the unresolved policy A/B decision below.
- Workflows never create or mutate Todos; Todo-status triggers remain one-way and `source=workflow` remains historical provenance only.
- Production request serving, restart, deployment, release, publish, and migration remain outside this architecture phase.

---

## Gate Status and Scope

This plan is the only artifact permitted by the architecture phase. Production code, tests, schemas, fixtures, runtime databases, instance files, and the running gateway remain unchanged.

Implementation is **blocked and this architecture remains conditional** until the operator explicitly accepts all recommended decisions below, selects browser policy A or B, and a fresh reviewer who did not author this revision approves the reference map, historical-evidence policy, migration state machine, and go/no-go criteria. All decisions and the independent approval must be recorded outside the repository plan before the first RED test is added.

The migration must eventually satisfy all of these invariants:

1. `JIN-1`, `JIN-2`, and so on are the only identifiers accepted or emitted by live Todo resolvers.
2. The canonical ID is the `work_items.id` primary key. There is no hidden numeric key, alias table, compatibility resolver, or runtime old-to-new map.
3. The allocator is transactional, concurrency-safe, immutable after its burn commit, strictly monotonic within one instance, and never reuses a number handed to Todo creation even when creation later fails or rolls back. Gaps are expected.
4. Existing Todos are mapped deterministically by creation order with a stable tie-breaker.
5. Every authoritative live reference changes atomically with the primary key.
6. Historical evidence that is contractually immutable stays byte-identical, is inventoried in the manifest, and becomes permanently non-resolving.
7. Workflows never create or mutate Todos. Todo-status events continue to trigger Workflows in one direction. `source=workflow` remains historical provenance only.
8. Todo versions do not change during identity migration. Existing optimistic-concurrency semantics remain intact.
9. Canonical Todo IDs may traverse explicit authenticated API/MCP identity fields. They never enter browser-visible/navigation URL/history, browser storage, hidden attributes, technical message/block anchors, or raw cursors. Browser rendering follows selected policy A or B and always uses salted private references for navigation/focus.
10. The production gateway is not migrated until sandbox rehearsal, independent review, and an explicit deployment decision are complete.

## Operator Decision Gate

Every row requires an explicit operator answer. `YES` is recommended for the first nine; policy `A` is recommended for the tenth.

| Operator decision | Recommended | Consequence |
|---|---:|---|
| Permanently burn every rolled-back allocation handed to Todo creation | **YES** | Allocation commits before Todo/event insertion; failed creates and racing duplicate sourceRefs leave permanent gaps |
| Forbid full legacy-backup restoration after the migrated instance begins serving | **YES** | A pre-listen external seal makes recovery forward-only after service; post-cutover writes and allocator high-water are never discarded |
| Block migration on every nonterminal Workflow run containing a legacy Todo ID | **YES** | Full-scan `running`, `parked`, and `dispatched` runs, including stopping/indexed cases; no new execution projection |
| Keep immutable callback/Activity bytes frozen while live copies, projections, and serializers rekey or neutralize them | **YES** | Audit hashes remain stable; current APIs/search/engine input never expose or execute old identity |
| Make cross-instance import refusal-only in this ticket | **YES** | No remap protocol or import surface is invented; unsupported/unprovenanced imports fail closed |
| Require a clean-tab cutover with no draft loss | **YES** | Migration refuses dirty Todo journals/tabs; stale state is quarantined for explicit operator copy/recovery and is never silently cleared or mapped through a legacy alias |
| Require a two-stage guard release before the migration release | **YES** | Record concrete `G` (first guard-capable) and `M` (first migration-capable) semvers: legacy serving requires `>=G`, epoch-2 serving requires `>=M`, and the exact mixed-version matrix refuses every incompatible opener |
| Fix the prefix and deterministic migration order | **YES** | v1 uses `JIN-`; legacy rows sort by `created_at`, then bytewise legacy ID, with no configurable namespace |
| Enforce the mixed-version upgrade boundary | **YES** | Legacy binaries cannot open an epoch-2 database; guard-only binaries cannot serve a staged/migrated database; migration binaries refuse unguarded legacy state |
| Select the browser-visible canonical-ID policy | **A** | **A (recommended):** `JIN-N` may appear only as intentional visible Todo identity/copy/search/API/MCP output. **B:** suppress `JIN-N` from all DOM/rendered text and use title-only UI. Both forbid canonical IDs in browser navigation/history/storage/hidden attributes/technical anchors/cursors/unrelated metadata and forbid live legacy identity everywhere |

The common privacy floor is locked; only intentional visible identity is undecided. Task 0 cannot close until the operator records an answer for all ten rows, including concrete `G` and `M` semvers selected by the two-stage row and an explicit `A` or `B`, and an independent reviewer approves this revision. Until then this plan is **CONDITIONAL** and architecture GO is false.

### Conditional browser policy A/B

**A — intentional human-readable identity (recommended).** `JIN-N` is permitted only as an intentional visible Todo identity: an ID token adjacent to the Todo title in Todo rows/detail and Todo Activity/delegation cards; the matching accessible name; explicit Copy ID output; textual share output that is not a navigation URL; Todo identity search/result text; and explicit authenticated API/MCP identity fields. Canonical queries remain in ephemeral in-memory request state and never enter `location.search` or history. Machine transcript presentation may map a recognized historical Todo identity to `JIN-N`; unrelated metadata and technical identifiers may not contain it.

**B — strict inherited privacy.** No DOM/rendered text, form value, accessibility text, clipboard/share output, or transcript presentation contains `JIN-N`, including user-authored literals. Raw authored bytes remain preserved in storage/API evidence, but the browser display projection masks canonical tokens. Todo rows, detail, Activity, and delegation cards show title/state only; Copy ID is absent; share is title-only with no direct Todo deep link. Canonical search intercepts paste/typing before a canonical token is committed to the input value, holds it only in ephemeral JS request state, renders a neutral “Todo ID lookup”/“ID match,” then clears it. Explicit authenticated API/MCP identity fields still accept/emit `JIN-N`, because they are the canonical programmatic contract.

Both policies preserve user-authored `messages.content` source bytes byte-for-byte and treat authored literals as non-resolving text. Policy A also renders user prose byte-identically. Policy B keeps source/API evidence intact but masks canonical-token substrings in browser presentation to satisfy its absolute DOM rule. “Legacy never appears” means no machine-authored, structured, linked, or resolvable legacy identity is emitted; an operator-authored historical literal remains prose and never gains alias behavior. Policy A maps a known machine legacy identity to its `JIN-N` presentation; policy B neutralizes both known machine legacy identity and every rendered `JIN-N`. Unknown exact tokens in machine content are always neutralized, never resolved. The two policies differ downstream as follows:

| Surface | Policy A | Policy B |
|---|---|---|
| Transcript | Machine legacy identity maps to visible `JIN-N`; post-cutover machine `JIN-N` may render only as intentional Todo identity | Machine legacy and system-generated `JIN-N` render as neutral Todo/title text |
| Accessibility | Visible ID token may be included in the corresponding accessible name | `JIN-N` is absent from `aria-*`, title, alt, and live regions |
| Clipboard/share | Explicit Copy ID or textual share may contain `JIN-N`, never a browser navigation URL | No canonical-ID copy/share and no cross-tab private deep link; title-only share |
| Todo/Activity/delegation cards | Visible ID token is adjacent to the Todo title; never in attributes | Title/state only |
| Search | Ephemeral `JIN-N` query and visible identity result; query never reaches URL/history/storage | Intercept before input-value commit, keep query in JS memory, render neutral pending/result text, clear it; never reaches DOM/URL/history/storage |
| Browser tests | Assert `JIN-N` only in allowlisted text/accessibility/explicit clipboard and absent from attributes, links, history, storage, anchors, cursors | During typing/paste/pending/result/back/forward/reload, recursively assert no canonical token in outerHTML, text, input values, aria/title/alt/live regions, clipboard, history, or storage |

## Decisions Proposed for Approval

### Fixed identifier format

Use a fixed uppercase `JIN-` prefix for v1. The grammar is:

```text
^JIN-[1-9][0-9]*$
```

The number is a positive base-10 integer with no sign, whitespace, separators, zero, or leading zeroes. Prefix configurability is deliberately excluded from v1: it adds parser, migration, privacy, import, and support states without improving the required instance-local identity model.

The only accepted production source grammar is exact lowercase `^wi_[0-9a-f]{12}$`, matching the current generator. Add one shared identity module with `parseLegacyTodoId`, `findLegacyTodoIds`, `parseTodoId`, and `formatTodoId`. `parseLegacyTodoId` accepts the whole string only; `findLegacyTodoIds` finds the same token only when the preceding and following characters are absent or outside `[A-Za-z0-9_]`, then revalidates every candidate with `parseLegacyTodoId`, so longer hex/identifier runs cannot partially match. Mapping, Workflow, callback, Activity, session transport/message/block scanners, and migration validation all call these shared functions; ad-hoc legacy regexes are forbidden. Preflight rejects every `work_items.id` that does not match the exact legacy grammar—including arbitrary `wi_*`, uppercase hex, wrong length, whitespace, or already-current/mixed IDs—instead of silently mapping it. Noncanonical `wi_*` in arbitrary user prose remains a non-reference string unless a supported structured field claims it as a Todo ID, in which case the malformed structured value blocks migration.

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
| Linked `sessions.transport_meta.delegationCompletionContract.workItemId` | Delegation completion contract | Completion CAS and validation | Authoritatively rewritable | Full-scan every nonlegacy `transport_meta`; parse the exact guard shape, require equality with non-null `sessions.work_item_id`, and rekey both; malformed/mismatch aborts |
| Detached completion contract in a duplicated session | `duplicateSession()` copies `transport_meta` but omits `work_item_id` and parent linkage | Session detail/list serialization; completion contract is non-actionable because enforcement requires both parent and `work_item_id` | Supported derived live copy | Recognize exact `{workItemId,state}` under the tracked metadata shape, rekey through the migration map without requiring `sessions.work_item_id`, preserve all other metadata, and prove no completion CAS/recovery path can act on it; malformed/unknown legacy-bearing metadata aborts |
| `sessions.session_key` and/or `source_ref` exactly `delegation:<TodoID>` | Non-idempotent delegation and duplication | Session lookup/routing and provenance | Authoritatively rewritable structured reference | Rekey each recognized field independently and all matching `queue_items.session_key` joins. A duplicate may retain delegation `source_ref` while receiving `session_key=web:*` and no `work_item_id`; that is supported, not a mismatch |
| `queue_items.session_key` | Session enqueue | Queue dispatch | Authoritatively rewritable when it equals a rewritten delegation key | Rekey exact join; no partial/running queue may exist at cutover |
| Manager-visibility callback `payload.message` Todo prose, `payload.meta.workItemId`, and `source_attempt=manager-visibility:<TodoID>` | `notifyManagerVisibility` | Retry/requeue, callback recovery API, acceptance | Live/retryable while pending/dead-letter | Structurally rekey all three as one coupled value; template mismatch, malformed JSON, or identity collision aborts |
| Accepted manager-visibility callback row | `acceptSessionDelivery` | Exactly-once evidence and duplicate receipt | Immutable historical evidence | Preserve every callback row byte, including old prose/meta/source attempt; never requeue, resolve, or return its raw payload from a current API |
| Accepted callback's linked internal `queue_items.prompt` | Callback acceptance copies `payload.message` | Restart replay and engine input; ordinary public queue listing excludes internal rows | Authoritatively rewritable machine copy | Follow accepted callback `queue_item_id`; rekey the exact manager-visibility Todo line for pending, running, completed, and cancelled rows while preserving row identity/status/timestamps; arbitrary prompts are untouched |
| Accepted callback's linked notification `messages.meta.workItemId` | Callback acceptance copies `payload.meta` | Message page/detail APIs and live WebSocket | Authoritatively rewritable transcript projection | Follow accepted callback `message_id`; rewrite only `workItemId` and any exact structured `sourceAttempt` if present; preserve unrelated meta, message ID, content, timestamp |
| Duplicated manager-visibility `messages.meta` | `duplicateSession()` copies every message `meta` byte-for-byte under fresh message/session IDs | `rowToMessage`, raw message page/detail APIs, WebSocket transcript | Supported authoritatively rewritable copy | Full-scan every nonlegacy `messages.meta`, recognize the exact manager-visibility metadata shape independently of callback/message linkage, rekey `workItemId`/`sourceAttempt`, and preserve unrelated fields. A clone with no `work_item_id` is valid supported state, not corruption |
| Other `sessions.transport_meta` and `messages.meta` objects | Session/message producers and same-instance duplication | Raw session/message serialization and engine/UI behavior | Structured scan boundary | Parse every nonlegacy row, classify each exact Todo-bearing field with the shared legacy scanner, and rekey or neutralize only an enumerated schema. Any unclassified structured legacy Todo reference blocks migration; arbitrary values without an exact legacy token remain byte-identical |
| Ordinary `messages.content`, including user/assistant/notification prose, tool input/result, partial/fallback text | Turns, callbacks, blocks, connectors, native transcript sync | DB reads, FTS, REST/MCP list/search/context/read-session, WebSocket, connectors, engine switch/re-prompt | Immutable authored/evidence bytes plus derived live presentation | Preserve raw bytes. Build one epoch-scoped presentation per row. Proven human text is non-resolving and renders byte-identically under A; B masks canonical tokens only in browser display. Proven machine text maps or neutralizes under A/B. `role` alone never proves authorship |
| `messages.content_origin` (`human-authored`, `machine-authored`, `external-native`, `unknown-historical`) | Guard-release message producer boundary | Presentation, FTS, engine prompt, migration preflight | Authoritative provenance | Guard release requires every new insert/update path to stamp origin. Historical rows use an enumerated producer/correlation classifier; any identity-token-bearing ambiguous row blocks migration. Unknown rows without identity tokens use conservative machine presentation while raw bytes remain frozen |
| Session message/queue and dead-letter API serialization | `rowToMessage`, `getMessagePage`, `getQueueItems`, callback recovery list | Browser/MCP/operator clients | Live presentation boundary | Require current-epoch JIN in structured metadata, return rekeyed queue prompts, and neutralize/refuse frozen legacy callback payloads; never emit accepted callback raw evidence |
| Delegation chat block `id=dg-<TodoID>` and `payload.workItemId` | Delegation route/callback | Chat activity card patch/open behavior | Authoritatively rewritable for nonlegacy rows | Rewrite coupled block ID and payload together; validate exact structure/version |
| Todo activity block `id=todo:<TodoID>` and `payload.todoId` | `gateway/chat-activity.ts` | Chat rendering, replay, patch | Authoritatively rewritable for nonlegacy rows | Rewrite coupled block/payload; malformed or duplicate identity aborts |
| `payload.activityReceipt.id` | Activity envelope | Block validator and replay | Authoritatively rewritable | Must remain equal to rewritten block ID |
| Tool `messages.meta.activityReceiptId` | Stream/tool settlement | Web tool-row suppression | Authoritatively rewritable when it exactly matches a rewritten block | Rewrite the full receipt token; missing/ambiguous correlations abort or are explicitly inert evidence |
| Synthetic message PK `block-${block.id}-${uuid}`, including `block-todo:wi_...-*` and `block-dg-wi_...-*` | `applyBlockEnvelope` | Message list/page cursor, search hit, context anchor, reload/jump, MCP, WebSocket | Immutable internal message identity with unsafe embedded historical text | Preserve raw PK and frozen references, but never serialize or accept it publicly. Resolve only through a current message-ref-epoch opaque reference with no Todo semantics |
| `message_ref_meta(current_epoch)` plus `message_public_refs(message_id, ref_epoch, public_ref)` | DB message insert trigger and offline cutover/forward repair | REST/MCP list, pagination, search, context, callback/attachment responses, WebSocket, web dedupe/reload | Authoritative opaque capability state | Exactly one current `mr<refEpoch>_<32 lowercase hex>` random ref per message. Epoch is DB-guarded strictly increasing; refs are stable and non-rebuildable within it. Any regeneration atomically bumps the separate ref epoch, making all older refs return 410. Resolves a message only, never a Todo/block |
| `message_presentations(message_id, identity_epoch, api_content, browser_content, engine_content, projected blocks/meta)` | Offline cutover and every current-epoch message insert/update | Safe FTS, REST/MCP/web/connector output, engine switch/re-prompt | Derived/rebuildable live projection | Preserve raw source. `api_content` preserves proven authored prose and removes machine legacy identity; `browser_content` additionally applies selected A/B; `engine_content` supplies current safe context. Exactly one current-epoch row per message; no live reader falls back to raw content |
| `messages_fts`, triggers, backfill watermark, snippets | Registry insert/update and lazy historical backfill | REST/MCP search and context entry | Derived/rebuildable index | Drop raw-content index/triggers/watermarks; rebuild before listen from current `api_content`; stamp epoch; mismatch/corruption refuses and no post-listen raw-source backfill runs. Browser result rendering passes snippets through `browser_content` policy |
| `sessions.engine_session_id`, `sessions.engine_sessions[*].id`, transcript paths/sync offsets, and engine sync metadata | Engine hooks, engine switching, native transcript adoption/backfill/tail sync | Resume, retry, switch, copyable resume command, transcript reader | Authoritative capability-bearing pointers, though not Todo IDs | Stamp with identity epoch. Sever pre-cutover resumable pointers/watermarks from live use while retaining inventoried frozen evidence; old refs never serialize, resume, backfill, tail-sync, or transfer to duplicates |
| Native Claude/Codex/Grok/Antigravity JSONL/transcript bytes | External engines and transcript tailers | Raw transcript route, backfill/tail sync, late recovery, native resume | External/frozen evidence | Never rewrite. Pre-cutover files/refs become non-readable and non-resumable live evidence; a current file is epoch-bound at an explicit offset/time and normalized before any output, DB insertion, FTS, connector, or prompt use |
| Pending queue prompts, active/partial turn state, native hook payloads | Queue/retry and engine adapters | Restart replay, late recovery, resume/re-prompt | Live transient/capability ingress | Require zero old-epoch in-flight/pending/partial work at cutover. Stamp live rows and refuse old replay/recovery rather than importing bytes after validation |
| Accepted callback identity, payload, `message_id`, `queue_item_id` | `acceptSessionDelivery` | Exactly-once delivery evidence | Immutable historical evidence | Preserve bytes. Old IDs are inert; accepted deliveries cannot be requeued or used to resolve a Todo |
| Accepted callback tombstone after supported manager-session deletion | `deleteSession(s)` atomically removes an unlinked target session plus its messages/queue but leaves accepted callback evidence | Direct evidence lookup only; excluded from pending/dead recovery and requeue | Immutable historical evidence in a supported all-absent state | Preserve and manifest-hash the callback row byte-for-byte when `status='accepted'` and target session, linked message, and linked queue row are all absent. The old payload remains non-actionable and is never included by live/recovery serializers |
| Partial accepted-callback dangling state | Corrupt/manual deletion or interrupted unsupported mutation | Ambiguous evidence/projection ownership | Corruption | Abort when only some of target session, linked message, and linked queue row exist, when an existing projection belongs to another session, or when an accepted target exists while either projection is missing; do not repair frozen evidence by guessing |
| Legacy Workflow callback/message/queue rows | Historical Workflow session bridge | Legacy transcript/diagnostics | Immutable historical evidence | Preserve Task 4/5 byte checksums and keep the session unreachable through current mutation/navigation surfaces |
| Pending partial messages/active sessions | Live engine turn | Stream settlement | Live transient state | Must be zero. Migration is offline and refuses active/partial work rather than guessing ownership |

`callback_deliveries.message_id` points to the notification message inserted during acceptance, not the synthetic block row inserted by `applyBlockEnvelope`. Acceptance separately copies callback data into the internal queue and notification message, so freezing the accepted callback does not freeze those copies. Migration follows linked projections when present **and** independently full-scans every nonlegacy `sessions.transport_meta`, `messages.meta`, `messages.blocks`, and raw `messages.content`, because supported duplication severs callback and `work_item_id` correlations while copying identity-bearing state. It rewrites recognized live structural copies, derives safe content, and verifies message pages, session list/detail/duplicate responses, callback duplicate/accept responses, dead-letter APIs, restart/engine replay, WebSocket output, and duplicated transcripts cannot expose old machine identity or internal message PKs. The ordinary queue list excludes internal callback rows, so their safety proof is direct database validation plus replay behavior, not a claim that the public queue endpoint returns them.

All client-visible message identity is scoped to a dedicated monotonic **message-reference epoch**, separate from the Todo identity epoch, raw PK, and per-tab DOM anchors. A current reference remains stable until that ref epoch is explicitly bumped and resolves only within its owning session. Prior-epoch references return generic `410 reference expired`; malformed/future refs return a non-echoing `400/426`; unknown/cross-session current refs return `404`. Raw internal IDs are categorically rejected without fallback, and there is no old-reference map. Callback duplicate/accept/queued responses project a linked durable `message_id`/`incomingMessageId` to the current public ref while preserving accepted callback bytes; an all-absent accepted tombstone has no live route projection.

Because the registry does not currently enable SQLite foreign keys, triggers enforce 1:1 state rather than `ON DELETE CASCADE`. Guard release creates `message_ref_meta`, seeds every existing message in one transaction, and requires `AFTER INSERT messages` to create `printf('mr%d_%s', current_ref_epoch, lower(hex(randomblob(16))))`; `AFTER DELETE messages` removes its ref. Guards forbid ref UPDATE/DELETE outside backing-message cleanup or explicit offline migration/forward-repair state and forbid ref-epoch DELETE/REPLACE/equal/decreasing updates. A uniqueness collision aborts the parent insert/cutover transaction. Random refs are authoritative and non-rebuildable within an epoch: missing/corrupt rows fail closed. Todo cutover atomically increments the ref epoch and replaces all refs. A later forward repair may regenerate only by atomically incrementing the ref epoch first, so every displaced ref reliably expires with 410 while the Todo identity epoch and allocator high-water remain unchanged.

For each accepted callback, preflight permits exactly two states. **Fully projected:** target session, linked notification message, and linked internal queue row all exist; both projections belong to `target_session_id`, the message role is `notification`, and the queue row is internal (its lifecycle may be pending/running/completed/cancelled). **Tombstone:** all three are absent while the accepted callback retains its non-null recorded IDs and otherwise valid lifecycle. Source-session absence is independent historical provenance and does not change this target predicate. Current deletion removes target messages, queue rows, and the unlinked session in one transaction; accepted rows are not selected by pending recovery or dead-letter listing, accepted rows fail the dead-letter requeue status check, and a callback POST must resolve the now-absent target session before it can reach duplicate acceptance. The migration inventories the frozen row and a guard-capable release codifies these reader/recovery exclusions. Any other presence tuple, ownership/role/internal mismatch, or partial combination is a deterministic preflight no-go; if the guard release cannot prove atomic all-absent deletion and non-actionability against then-current code, it must first prevent deletion of such targets and ship a reviewed deterministic existing-row classifier before migration release.

For edit receipts, rebuild the table so its durable key is `(schema_epoch, key_digest)` while preserving every existing row as epoch 1. Epoch-2 lookup first checks whether the same digest exists in epoch 1; if so, it returns the cutover reload/fresh-key result rather than applying a request. It then performs normal epoch-2 fingerprint matching. This preserves old receipt bytes, prevents cross-identity replay, and does not create an old-ID resolver.

### Workflows and historical compatibility

| Reference | Producer | Consumers | Class | Migration action and invariant |
|---|---|---|---|---|
| New `trigger.payload.todoId` | `workflows/todo-status-trigger.ts` from `event.workItemId` | Conditions, run details/UI | New authoritative output | After cutover newly published runs contain JIN IDs only |
| Nonterminal run containing any shared-parser exact legacy token, mapped or unknown, in raw bytes or any recursively decoded JSON string key/value | Frozen Workflow run JSON | Step prompt, condition evaluation, resume, reconcile sweep | Executable frozen evidence | Hard preflight blocker for `running`, `parked`, and `dispatched`, including `running` with `stopping`; terminalize before cutover or do not migrate |
| Terminal run `trigger.payload.todoId`, legacy `triggerTodoId`, or other old literal | Frozen Workflow run JSON | Historical list/detail/MCP | Immutable historical evidence | Preserve file bytes; central read serializer neutralizes old identity/links before REST/MCP/UI output |
| Legacy trigger-store `approvalWorkItemId` | Schema-1 custom trigger | Existing v1-to-v2 trigger migration | Authoritative legacy data already retired by its own migration | Preserve existing migration ordering; verify it is removed before Todo-ID rekey or refuse |
| `source=workflow` and `workflow:<definition>:<run>` source refs | Historical Todo bridge | Reconciliation/read provenance | Historical provenance/non-reference | Preserve. Workflows never create or mutate Todos; automatic reconciliation remains disabled |
| Workflow run/definition IDs | Workflow runtime | Workflow routes/UI | Non-reference strings | Preserve; distinct namespaces |
| `_active-index.json` | Run store save/rebuild | Startup and periodic sweep | Derived/rebuildable | Never trust for preflight. Full-scan every run file; stale/missing/corrupt positive or negative index entries cannot change the decision |

Task 4 requires legacy synthetic Workflow Session rows, messages, queue entries, and callbacks to remain byte-identical. Task 5 gives accepted callback deliveries immutable evidence semantics. Therefore a blanket historical rewrite is forbidden. The smallest safe rule is unconditional: `scanWorkflowJsonArtifact(path, raw)` scans raw bytes with shared `findLegacyTodoIds`, parses JSON exactly once, then walks the complete decoded tree and applies the same finder/revalidator to every string value and every decoded own-property key. It records artifact class, provable run status, raw-versus-decoded source, RFC 6901 pointer, key/value marker, and exact match. Invalid JSON, unsupported depth/size, traversal truncation, or inability to prove status fails closed; it never silently skips. It does not recursively parse strings as JSON—the initial parse already decodes escapes and the recursive walk covers the complete parsed tree.

Preflight refuses migration when any nonterminal `running`, `parked`, or `dispatched` run contains any shared-parser exact legacy token—mapped or unknown—in either representation. This includes quiet parked runs, parked runs with in-flight siblings, stopping drains, trigger payload object keys/values, normalized `triggerTodoId`, frozen condition paths/values, prompts, parameters, overrides/edits, receipt outcomes/field keys/values, parked/errors/report text, and runs omitted from or wrongly present in the active index. Mutable definitions, custom-trigger stores, invocation claims, and every other Workflow JSON artifact receive the same scan: typed live Todo fields are rekeyed only when separately classified, user strings remain bytes, and any unclassified decoded/raw exact match blocks. `_active-index.json` is derived and rebuilt only from clean parsed runs, never trusted as the scan source.

There is no new execution projection. Blocking runs must reach a terminal state before cutover under the legacy epoch. Terminal files remain byte-identical; an epoch-aware Workflow presentation recursively sanitizes decoded keys/values and feeds list/detail/MCP, reporting Activity, recovery-rebuilt blocks, and session delivery without changing execution evidence. Parked resume and startup/interval sweep cannot run while the migration gate owns the instance.

### Activity and audit projections

| Reference | Producer | Consumers | Class | Migration action and invariant |
|---|---|---|---|---|
| `activity_events.object_id`, href, summary, actor/outcome text, correlation/idempotency fields, detail, links | Generic activity append API | Activity story/search projection and raw row converter | Immutable historical evidence | SQL triggers reject update/delete and payload hash covers fields. Preserve every row byte/hash; never serialize the raw event directly after epoch 2 |
| Epoch-aware Activity presentation | New `activity/presentation.ts` | List stories, preview events, story events/links, REST JSON | Derived live serializer | At epoch 2 recursively neutralize strict legacy Todo tokens, represent an exact legacy Todo object as a noncanonical historical object with no href, and drop any link whose decoded href contains a legacy token; no old-to-new lookup |
| `activity_stories`, versions, `activity_event_search`, projection metadata | Projection builder | Activity page filtering/search | Derived/rebuildable | Record Todo identity epoch and sanitizer version; index presentation-safe values only; rebuild at cutover and fail closed when projection epoch mismatches |
| Company changed event `{entity:'todo', id}` | Todo mutation | WebSocket query invalidation | Derived/transient | Post-cutover emit JIN in memory; not persisted as identity |
| Chat activity receipt IDs | Todo mutation activity | MCP/REST result, session blocks, web suppression | Live structured reference or external receipt | Rekey stored live coupled structures; old external receipts expire at epoch and cannot replay |

There is currently no production caller of the normalized activity append API outside the activity module, but existing instance data cannot be assumed empty. Projection rebuild alone is unsafe because current search indexes raw `object_id` and list/story queries reconstruct raw events and links. Add `activity_projection_meta(singleton, todo_identity_epoch, sanitizer_version)`, make rebuild take the identity epoch, and make list/story queries fail closed unless projection and Todo epochs match.

At epoch 2, the presentation function calls the shared `findLegacyTodoIds` scanner for exact boundary-delimited `^wi_[0-9a-f]{12}$` tokens, sanitizes every public string/nested detail value containing one, replaces an exact legacy Todo object ID with a stable noncanonical `historical-todo:<activity-event-id>` marker plus `historical: true`, omits its href, and drops links whose safely decoded href contains a legacy token. It does not know the migration map and cannot resolve the marker. Activity cursor payloads include the identity epoch so old cursors fail. List, preview, story detail, aggregate links, FTS input, repeated rebuilds, and API JSON all use the same deterministic presentation function. Invalid encoding, unsafe JSON, or any value that cannot be safely neutralized makes Activity queries and migration fail closed rather than emit raw evidence.

### REST, MCP, CLI, search, and types

| Surface | Current behavior | Required behavior | Class/action |
|---|---|---|---|
| REST `/api/work-items` list/create | Emits random `wi_*`; create does not accept an ID | Emit allocated JIN ID | Live producer/consumer |
| REST `/api/work-items/:id` and mutation/session/approval subroutes | Accept any path-safe string | Central parser accepts only `JIN-N`; old/malformed IDs return an explicit non-alias error | Live resolver |
| Delegation REST input/output | Accepts/emits `workItemId`; can mint | Accept/emit JIN only; mint through allocator transaction | Live producer/consumer |
| Search REST | Searches title/body and returns IDs | Exact valid JIN query may resolve ID; arbitrary old strings remain text search only | Live resolver plus non-reference prose |
| Session/message REST list/page/search/context/raw transcript | Emits raw `messages.id`, raw content/snippets, and native JSONL | Emit current opaque message refs and safe presentation only; current ref input resolves internally, raw/old refs and epoch-1 transcripts fail closed | Derived presentation and epoch resolver |
| MCP work-item, approval, and delegation tools | Schemas accept generic strings | Share canonical grammar/description; REST remains defense-in-depth | Live resolver |
| MCP `read_session`, message search/context, and attachment publish | Forwards raw message content/IDs returned by registry/API | Return safe presentation and current opaque message refs; never forward raw internal PK/native transcript | Derived presentation and epoch resolver |
| WebSocket/stream/session callback and attachment payloads | Central broadcaster JSON-stringifies producer payloads; some carry raw prose or message IDs | Normalize machine content before first frame; persisted message events/completion/callback/attachment carry `messageRef`; ephemeral deltas omit identity rather than fabricate one | Derived transient output |
| Shared TypeScript `WorkItem.id`, events, blocks, company change | Plain `string` | Keep wire type string but validate at construction/boundaries; do not create a second ID type/value | Live type surface |
| CLI | No Todo CRUD command exists | Do not invent Todo CRUD for parity. Add only the reviewed offline migration/inspection entrypoint if operationally required | Current absence / future command |

All handlers call one parser. No route-specific fallback, case folding, whitespace trimming, numeric-only lookup, or `wi_*` redirect is allowed. Error responses may quote the rejected caller input only when necessary; they must never return an old-to-new value.

### Message presentation, FTS, native transcripts, and message references

Raw `messages.content`, historical synthetic message PKs, and external native transcript files remain frozen evidence; none is a post-cutover public source. Add focused `sessions/message-presentations.ts` and `sessions/message-refs.ts`. Every current Todo-epoch insert/update/duplicate/backfill writes presentation, content origin, and a current message-ref-epoch capability in the same transaction. Public-boundary methods—`projectMessage`, `getPublicMessagePage`, `searchPublicMessages`, and `getPublicMessageContext`—join both current epochs and never fall back to `rowToMessage` raw fields. The REST detail/page/search/context/transcript APIs, MCP `read_session`/search/context/file publish, connector replies, and WebSocket serializers use only those methods. Callback duplicate/accept and attachment routes project linked message IDs before serialization. Final assistant insertion captures its public ref and `session:completed` emits it, allowing stable dedupe/reload; block, notification, and attachment messages do the same. Ephemeral text/tool deltas may omit a ref but never emit or invent an internal PK.

Guard release adds mandatory origin at every message producer; `role='user'` is not proof. The producer manifest marks authenticated human/connector ingress as human only when its call path carries explicit authorship, and marks Workflow spawn/follow-up, delegation/agent-created prompts, callback/queue replay, platform context, block fallback, notifications, assistant/tool output, and native backfill/tail/recovery as machine or external-native. Historical classification uses persisted session kind/source, callback/queue/block correlation, native sync anchors, and producer-specific metadata only when the exact shape proves origin. A legacy/current identity-token-bearing historical row that remains ambiguous blocks migration; it is never silently labeled human. An unknown row without such tokens may use conservative machine presentation while its raw bytes remain frozen. Tests include genuine human prose and role-`user` Workflow, delegation, agent-session, queue, and native-derived machine rows.

`message_public_refs` is not a second Todo identity. It is an epoch-scoped opaque message capability whose random body reveals neither raw message PK nor embedded Todo/block ID. Public message JSON may retain the field name `id` for compatibility only if its value is the public ref; search/context use `messageRef`/`anchorMessageRef`, and pagination `before` accepts only a current ref. Search joins the projection; context resolves a ref scoped to its session and projects every neighbor. Ordering continues to use internal timestamp/sequence/rowid. A `410` makes web clients discard only derived message-page/search caches and cold-refetch; they never retry a raw cursor. Direct recursive scans of every REST/MCP/WebSocket payload must prove no raw internal message PK or synthetic block-derived message ID escapes; unrelated public session/connector UUIDs are not part of this assertion.

Replace raw-content `messages_fts` with an epoch-scoped FTS over `message_presentations.api_content`. Cutover drops old triggers/watermarks, fully rebuilds before listen, and validates its epoch and zero machine-presentation legacy identities; explicitly authored user literals may remain non-resolving API/MCP search text. Snippets come only from the projection, and the web applies `browser_content` policy before rendering them. No lazy/post-listen legacy backfill may re-index raw source directly; corrupt/missing/mismatched FTS epoch refuses search and serving until an offline safe rebuild completes.

Native histories are external frozen bytes and capability-bearing ingress. Stamp scalar `engine_session_id`, every `engine_sessions[engine]` entry, transcript path/start offset, sync watermarks, hook adoption, queue/retry context, and tailer state with the Todo identity epoch. At cutover, inventory but sever every epoch-1 native ref and clear its live sync/resume authority; do not serialize old refs or the copyable native `--resume` command. `/api/sessions/:id/transcript` becomes a safe current-epoch presentation or returns `410`; no raw JSONL endpoint remains. Empty-session backfill, on-load tail sync, hook adoption, late recovery, engine switching, rate-limit retry, pending replay, and normal resume all require a current-epoch ref. First post-cutover use of an old session starts a fresh native engine session. A new native file binds epoch plus start offset/time at adoption, reads only post-bind bytes, and normalizes content before DB insert, FTS, WebSocket, connector, or engine reuse.

Engine switching and re-prompt use `engine_content`, never raw `getMessages`; pending prompts carry the epoch. Migration requires no active/waiting/partial/pending old-epoch turn. A stateful machine-content normalizer buffers across streamed delta boundaries so split exact tokens cannot leak before detection; it feeds both emitted frames and persisted presentation. Unknown legacy tokens neutralize without lookup. The selected A/B policy changes only intentional canonical presentation, not the raw-byte, old-ref refusal, or no-legacy-live-output rules.

The normalizer has a recursive companion, `projectMachineValue`, for decoded tool/native/notification/callback/attachment objects and machine-content fields in REST/MCP/WebSocket payloads. Explicit authenticated Todo identity fields remain governed by the canonical parser/API contract, not this neutralizer. The walker visits every array element, own string key, and string value; it does not trust role or content field names. It preserves raw evidence, applies a bounded depth/node/byte budget, and fails closed on unsupported values, invalid shapes, or truncation. If two projected keys collide after mapping/neutralization, the entire value is rejected—never overwritten, dropped, or merged. Native `tool_use.input`, tool-result content, live `delta.input`, nested notification/callback metadata, and escaped key/value fixtures all use this path; plain streamed text uses the boundary-buffering normalizer.

### Web UI, privacy, React Query, and CAS

| Surface | Current behavior | Required behavior | Class/action |
|---|---|---|---|
| Todo navigation | Single `/todos` route; selected Todo represented by salted per-tab `td_*` private ref | Preserve. No `/todos/JIN-N` route and no canonical ID in history state | Privacy boundary |
| `todo-private-state.ts` | Maps private refs in memory and browser state | Version namespace at epoch; invalidate old refs/journals without an old-ID map | Derived/rebuildable |
| React Query keys/cache | Raw IDs can exist in memory; no persistence provider | In-memory JIN is allowed; invalidate all Todo/session queries at epoch | Derived/rebuildable |
| Quick-edit/CAS journals | Persist private `td_*`, expected version, and patch intent | Bump journal schema/epoch; stale pre-cutover entries fail closed and request reload/fresh edit | Derived operational state |
| Network fetch paths | Authenticated requests may include canonical ID | JIN is allowed on the network path, but not copied into browser location/history/storage/DOM | External transport |
| Todo cards and technical refs | Card uses private refs; `publicWorkItemReference` suppresses old scheme | Common floor suppresses canonical IDs from unrelated source/approval labels; policy A adds only intentional visible identity, policy B renders title/state only | Conditional privacy boundary |
| Chat message/tool-group wrappers | `chat-messages.tsx` renders raw backend IDs in `data-message-id`; capture/restore queries those attributes | Render domain-separated salted `cm_*` anchors and query `data-message-ref`; neither raw PK, public `mr*`, block ID, nor canonical Todo ID enters the DOM | Privacy defect to fix RED-first |
| Delegation/handoff, generic block, and comms wrappers | `handoff-card.tsx`, `dispatch-row.tsx`, `chat-blocks.tsx`, and `comms-callout.tsx` render raw `block.id`/source IDs; migrated delegation IDs are `dg-JIN-N` | Render salted `cb_*` block anchors in `data-block-ref`/`data-source-message-ref`; never render the raw block/message ID | Privacy defect to fix RED-first |
| Thread preview/history/focus restoration | `CommsPeekData.messageId` receives raw block/message ID, and the entire preview is copied into `history.state.threadPreview`; `routes/chat/page.tsx` queries raw attributes on return | Keep the full preview only in a per-tab in-memory map keyed by a validated private `sourceAnchor`; history stores only that private preview ref. Use private refs for focus lookup and reject/strip old raw preview state without deleting drafts | Derived private state |
| Activity cards/inline cards | Card omits block ID and uses private open action | Preserve; full-transcript privacy test must include parent wrappers, attributes, links, storage, and location | Privacy boundary |

The contract phrase “routes/UI accept and emit JIN-N” is conditional only at the intentional rendering boundary. Authenticated REST transport routes and explicit API/MCP identity fields accept/emit JIN under both policies; “forbidden in URLs” means browser-visible/navigation URL and history, not authenticated REST paths. Policy A gives the identifier human-readable UI utility in allowlisted text/copy/search; policy B suppresses it from machine-rendered browser output. Under both, canonical Todo search is special-cased out of history-shareable `location.search`, a user-authored literal remains authored text, and technical anchors remain private.

Add one browser-only `chat-private-anchors.ts` utility that reuses the per-tab random salt pattern but domain-separates inputs: `messagePrivateAnchor(raw) = cm_<digest(salt, "message", raw)>` and `blockPrivateAnchor(raw) = cb_<digest(salt, "block", raw)>`. Only the random salt is stored in `sessionStorage`; no raw ID-to-anchor map or canonical ID is persisted. The functions are synchronous and deterministic for a tab, so anchors survive rerender/history navigation and focus restoration. A different tab gets unrelated anchors. Collision detection is maintained in memory and fails closed instead of rendering an ambiguous anchor. Full `CommsPeekData` stays in an in-memory map keyed by the private ref; `history.state` stores only that ref. If a reload loses the map, the preview closes safely instead of reconstructing a raw identifier.

The current full chat transcript leaks block-derived message primary keys through `data-message-id`, raw delegation/generic block IDs through `data-block-id`, comms source IDs through `data-source-message-id`, and the same raw preview ID through `history.state`. The implementation must first add failing full-transcript/history privacy canaries, then convert `handoff-card.tsx`, `dispatch-row.tsx`, `chat-blocks.tsx`, `comms-callout.tsx`, `chat-messages.tsx`, `thread-peek.tsx`, and `routes/chat/page.tsx` to private anchors. React keys and authenticated network/in-memory records may use current `mr*`/block values; DOM attributes, History API state, storage, links, location, focus selectors, and serialized preview/cache keys may not. Historical PKs remain internal evidence and never Todo aliases. Interactive and noninteractive `dg-JIN-42` handoff cards must restore focus through the same stable per-tab private anchor while satisfying selected A/B visible-text rules.

### Import, export, backups, templates, tests, and docs

| Surface | Current fact | Required treatment |
|---|---|---|
| Instance storage | Each selected instance home owns one `sessions/registry.db` | Allocator and namespace are instance-local |
| Instance creation/listing | `jinn create` seeds a fresh home; instance listing reports metadata | Fresh DB starts `last_value` at 0; first allocation returns 1; no data merge occurs |
| Todo/session DB import/export/merge/restore | No supported CLI, API, or MCP surface exists | Refusal-only: do not add or imply import/remap behavior in this ticket |
| Same-instance session duplication | Copies `source_ref`, `transport_meta`, and every message `blocks`/`meta` while detaching relational Todo/parent/callback links | Full-scan and rekey/neutralize every recognized structured copy; supported duplication is not corruption or cross-instance import |
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
  "legacyGrammar": "^wi_[0-9a-f]{12}$",
  "minimumLegacyGuardVersion": "<concrete G semver>",
  "minimumServedVersion": "<concrete M semver>",
  "browserIdentityPolicy": "<A-or-B>",
  "messageReferenceEpoch": 2,
  "createdAt": "<ISO-8601>",
  "sourceDatabaseSha256": "<digest>",
  "backupSha256": "<digest>",
  "rows": [
    { "ordinal": 1, "oldId": "wi_00000000000a", "newId": "JIN-1", "createdAt": "<stored value>" }
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
5. Validate every `work_items.id` with shared `parseLegacyTodoId`; any nonmatching, current, arbitrary `wi_*`, or mixed ID aborts. Inventory every class in the graph. Direct references must resolve. Full-scan all nonlegacy `sessions.transport_meta`, `messages.meta`, `messages.blocks`, raw `messages.content` plus content-origin provenance, callback/queue structured fields, message PKs/refs, FTS rows, engine-session refs, and sync watermarks rather than following only relational links. Recognized duplicate-session shapes are supported; unknown reference-bearing shapes and identity-token-bearing ambiguous authorship abort.
6. Run `scanWorkflowJsonArtifact` on every run, definition, custom-trigger, invocation-claim, and index JSON artifact. Scan both raw bytes and every recursively decoded string key/value with the shared exact finder. Any exact token, mapped or unknown, in a nonterminal `running`, `parked`, or `dispatched` run—including running/stopping—aborts. Invalid/corrupt/unreadable/over-limit artifacts or unclassified decoded matches fail closed; ignore active index claims when deciding status.
7. Inventory terminal Workflow and other immutable evidence without altering it. Prove each old literal is behind an epoch-aware serializer and unreachable from live Todo lookup, mutation, navigation, callback requeue, Workflow execution, or engine prompt behavior.
8. Refuse a schema-1 trigger store until its existing `approvalWorkItemId` retirement migration is complete.
9. Classify every accepted callback as fully projected or a legitimate all-absent tombstone; any partial dangling combination aborts. Inventory hashes for both accepted forms before changing live projections.
10. Require the operator's recorded clean-tab/no-dirty-draft attestation. The guard-release web client preserves any unexpectedly stale journal read-only and presents explicit copy/recovery; it never silently deletes or submits it across the epoch.
11. Require no active/waiting/partial turn, pending old-epoch queue replay, or dirty transcript sync. Inventory every native engine ref/transcript path and prove epoch-1 backfill, tail-sync, late recovery, switch, retry, and resume can be severed before validation.
12. Build the deterministic map, invariant snapshot, and temporary manifest, including concrete `G` and `M` minimum-compatible semvers and selected A/B browser policy; fsync before destructive SQL.

### Atomic SQLite swap

Inside one exclusive/immediate transaction:

1. Create a temporary mapping table keyed both ways and verify one-to-one cardinality.
2. Rebuild `work_items` with the strict ID check and mapped primary keys.
3. Rekey `work_item_events.work_item_id` under the approved audit exception.
4. Rekey ordinary live `sessions.work_item_id`.
5. Rekey exact nonlegacy delegation session keys/source refs and matching queue keys.
6. Structurally rekey supported completion-contract JSON, Todo/delegation blocks, receipts, tool metadata, and pending/dead-letter callback state. The full-table scan rekeys detached duplicated completion guards and every recognized duplicate `messages.meta`/`messages.blocks` copy even when no callback, `work_item_id`, or original message ID links it. Do not recursive-search arbitrary JSON or prose.
7. For every fully projected accepted manager-visibility callback, preserve the callback row bytes but follow its linked queue/message IDs: rekey the exact queue prompt Todo line and notification metadata while preserving their identity/status/timestamps/content. Preserve legitimate all-absent accepted tombstones without fabricating projections.
8. Preserve legacy Workflow session/callback/transcript bytes, accepted callback bytes, raw message content, raw message PKs, and native JSONL bytes. Install presentation/resume/requeue guards so frozen evidence is neither actionable nor emitted raw.
9. Add receipt epoch 2 while retaining epoch-1 receipt bytes. Pre-cutover retries receive a reload/fresh-key outcome.
10. Rebuild Activity projections through the epoch-2 presentation sanitizer, write projection epoch/sanitizer metadata, and invalidate old Activity cursors. Immutable events/hashes remain untouched.
11. Seed `todo_id_allocations` with ordinals `1..N` and `todo_id_allocator.last_value = N`, where `N` is the deterministic migration row count; then install no-delete/strict-increase/append-only guards. Live Todo suffixes may be sparse only after serving begins.
12. Bump the Todo identity epoch and the separate strictly monotonic message-ref epoch; classify content origin, create a safe presentation, and generate one fresh opaque ref for every message, including duplicated and historical synthetic rows. Replace FTS with the epoch-scoped presentation index and remove raw-content triggers/watermarks.
13. Sever epoch-1 engine-session resume/backfill/tail-sync authority, stamp all current engine/queue/sync state, and require future native adoption to bind the new epoch plus start offset.
14. Rebuild other derived indexes/projections as required.
15. Record identity epoch, selected A/B policy, and manifest digest, then drop the temporary live map so no Todo alias survives.
16. Run transaction-local invariants and commit once.

Structured transcript rewrites are allowed only for nonlegacy machine-authored live blocks whose coupled fields can be proven exact. Raw message prose, tool-result text, native transcript bytes, and internal message primary keys remain unchanged; only their epoch presentation/public reference changes. If changing a live block would violate a frozen-row checksum or leave mismatched receipt correlation, the migration aborts.

### Post-commit validation

Before serving requests, prove:

- every `work_items.id` matches the strict grammar and maps to one ordinal;
- every live relational Todo reference resolves to exactly one row;
- no live structured resolver input contains a legacy ID;
- counts, statuses, versions, source/sourceRef, approvals, timestamps, event IDs/order, and event `detail` bytes match the pre-snapshot;
- every coupled block ID/payload/receipt/tool-meta set is internally consistent;
- pending/dead callbacks contain only current identities; accepted/legacy callback evidence hashes are unchanged; fully projected accepted rows have safe linked copies; all-absent tombstones remain absent and inert; partial dangling states are zero;
- every nonlegacy session/message structured column and raw content/PK was scanned; duplicate copies were rekeyed or presented safely; public APIs expose neither old machine identity nor internal PK; no unclassified exact legacy reference remains;
- every message has proven/conservative content origin, one current Todo-epoch presentation, and one current message-ref-epoch opaque ref; FTS is rebuilt from safe presentation; nested keys/values pass bounded collision-safe projection; list/page/search/context/read-session/MCP/WebSocket/callback/attachment serializers expose only safe content and public refs; raw/prior/cross-session cursors refuse without fallback;
- no epoch-1 native engine ref can serialize, resume, backfill, tail-sync, switch, retry, or re-prompt; current native ingress is epoch-bound and normalized before emit/store;
- no nonterminal Workflow run contains any exact legacy token in raw bytes or decoded keys/values; all terminal run and legacy session evidence hashes are unchanged; Workflow list/detail/report/Activity/recovery/session serializers contain no old machine identity;
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
- Post-serving recovery is forward-only: quiesce request/background intake, snapshot the current migrated DB/WAL, record the current high-water/allocation-ledger digest and message-ref epoch, and apply the smallest epoch-2 repair transaction or repaired clone against that current state. Preserve every post-cutover Todo/event/session/queue/message/callback write and every burn ledger row. If opaque refs must be regenerated, atomically increment the ref epoch first; never replace random refs inside the same epoch.
- A failed forward-repair transaction rolls back to the current migrated state, not the legacy backup. Before reopen, prove `H_after >= H_before`, `H_after = MAX(ledger)`, every pre-repair live JIN row still exists with the same version/evidence, and all new invariants pass. If preservation cannot be proven, remain offline and escalate; data loss is not a rollback strategy.
- External frozen Workflow files are not mutated, so forward repair verifies their hashes rather than restoring them.

## Mixed-Version Refusal and Deployment Boundary

The current CLI merely warns about an old instance/template version and current binaries do not understand a future Todo identity epoch. A database CHECK prevents old writers from inserting `wi_*` but cannot force an arbitrary old process to refuse reads.

The safe rollout is two-stage:

1. Ship a guard-capable release `G` that understands the legacy epoch, exact source grammar, callback tombstone rules, browser clean-tab behavior, and refusal of unknown/newer/incomplete epochs while still using the old identity scheme.
2. Record concrete `G` and first migration-capable release `M` semvers in the operator decision, release constants, persisted guard marker, and migration manifest. These exact values—not ranges chosen at runtime—define the boundary: supported legacy serving requires a binary `>= G`; served epoch 2 requires a binary `>= M`.
3. After `G` is deployed everywhere that may open the database, ship `M` and run the reviewed offline cutover. Guard-only binaries `[G,M)` may open only the exact guarded legacy epoch and must refuse `staged` or later. Binaries `>=M` may perform migration only through the explicit offline command against an exact guarded legacy epoch; ordinary startup refuses unguarded legacy, mixed, incomplete, or newer state. Every binary `<G` is unsupported and must be proven stopped.

The migration-capable gateway publishes an identity epoch in bootstrap/status responses. Mutations carry the epoch; mismatched clients receive upgrade/reload-required (`409` or `426`, selected consistently) before any write. Request serving never starts in `staged`, `swapping`, `validated`, `complete-unserved` without completing the served seal, `failed`, corrupt, or mixed states.

An unsupported old binary remains outside the supported downgrade boundary, but cutover cannot rely on that label alone: process/lock inspection and the persisted guard-version marker must prove none can open the database. Migration is no-go until the operator records both `G` and `M`, an independent reviewer accepts the exact matrix, and the migration command verifies the marker and exclusive ownership. Downgrade below `G` is refused before database open; after `served`, every binary below `M` is refused permanently.

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

- Operator records all ten choices: permanent burns; forward-only after serving seal; all-nonterminal Workflow block; frozen evidence plus safe live projection; refusal-only import; fail-closed no-draft-loss clean tabs; two-stage `G` then `M`; fixed `JIN-` plus `created_at`/bytewise-legacy-ID ordering; exact mixed-version refusal; and browser policy `A` or `B`. Recommended defaults are `YES` for the first nine and `A` for the tenth.
- The record names concrete `G` and `M` semvers that become the legacy and served minimum compatible versions and records the selected A/B serializer/UI test contract.
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

RED cases: current grammar edges, exact legacy `^wi_[0-9a-f]{12}$` acceptance, uppercase/short/long/nonhex/arbitrary-`wi_*` rejection, boundary-delimited frozen-text scanning, shared-parser parity across mapping/Workflow/callback/Activity/session callers, safe-integer overflow, empty/one/many allocations, allocator singleton DELETE/REPLACE rejection, equal/decreasing/skipped high-water update rejection, ledger UPDATE/DELETE rejection, archive/raw-delete nonreuse, failed Todo/event transaction after a committed burn, crash after burn before create, racing duplicate sourceRefs with permitted gaps, and numeric tie-break ordering.

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

RED fixtures: empty/current databases, equal creation timestamps, malformed/nonexact legacy IDs and timestamps, mixed/newer schemas, binaries below/equal/above recorded `G` and `M`, unguarded legacy state, deterministic rerun, exclusive-lock races, fault injection at every state boundary, pre-serving restore, external-seal/DB-marker crash windows, post-serving restore refusal before filesystem replacement, create-after-cutover then failed restore, and forward-repair rollback against the current migrated state.

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

RED: dangling event/session references, event byte-preservation, linked spend/attempt lookup, delegation key plus queue rewrite, linked completion-contract match/mismatch, a duplicated detached completion contract with no `work_item_id`, full nonlegacy `transport_meta` scan, unknown structured legacy-bearing metadata, epoch-1 edit retry, and epoch-2 CAS replay.

GREEN: approved event-envelope rekey, live session/key rewrites, strict structured JSON handling, and receipt epoch boundary without version bumps.

### Task 4: Workflow and immutable-evidence barriers

**Files:**

- Modify `packages/jinn/src/workflows/run-store.ts` only where needed to prohibit lookup/navigation
- Add `packages/jinn/src/workflows/todo-identity-preflight.ts`
- Add `packages/jinn/src/workflows/presentation.ts`
- Modify `packages/jinn/src/workflows/definition-store.ts`, `custom-triggers.ts`, and invocation-claim handling in `run-store.ts` to classify every JSON artifact
- Modify `packages/jinn/src/workflows/reporting.ts` and recovery/session delivery to use terminal presentation
- Modify `packages/jinn/src/workflows/todo-status-trigger.ts`
- Modify `packages/jinn/src/work-items/reconcile.ts` only if a guard is missing
- Modify `packages/jinn/src/sessions/registry.ts` for legacy-session guards
- Modify `packages/jinn/src/gateway/api.ts` and `packages/jinn/src/mcp/workflow-tools.ts` to use the terminal-run presentation serializer
- Add `packages/jinn/src/workflows/__tests__/todo-identifier-migration-preflight.test.ts`
- Modify `packages/jinn/src/workflows/__tests__/active-run-index.test.ts` and `run-reconciler.test.ts`
- Modify `packages/jinn/src/sessions/__tests__/legacy-workflow-session-compat.test.ts`
- Add `packages/jinn/src/gateway/__tests__/workflow-run-presentation.test.ts`
- Modify `packages/jinn/src/mcp/__tests__/workflow-tools.test.ts`

RED: raw and decoded parity with `wi_00000000000\\u0061`, `\\u0077i_00000000000a`, and escaped object keys; matches in nonterminal trigger payload keys/values, condition paths/values, node instructions, nested parameters, step override/edit prompts, receipt outcome/artifact/field keys/values, parked/error/detail/report text; running, parked, stopping, dispatched, active-index omitted/extra cases; invalid JSON and scan depth/size limit; parked resume and startup/interval sweep; terminal completed/failed/cancelled raw hash plus sanitized list/detail/MCP/reporting Activity/recovery/session delivery; mutable definition/custom-trigger/invocation-claim classification; `source=workflow` negative capability; and legacy Workflow session byte checksums.

GREEN: one shared raw-plus-recursively-decoded scanner provides structural diagnostics and fails closed; any nonterminal legacy-bearing run blocks regardless of index/engine/queue state; no execution projection exists. After blockers terminalize under the legacy epoch, migration succeeds deterministically. New runs emit JIN, terminal evidence stays byte-identical, and every public/reporting/recovery serializer uses safe presentation.

### Task 5: Blocks, receipts, callbacks, and full-transcript privacy

**Files:**

- Modify `packages/jinn/src/gateway/chat-activity.ts`
- Modify `packages/jinn/src/shared/blocks.ts`
- Modify `packages/jinn/src/sessions/registry.ts`
- Modify `packages/jinn/src/sessions/callbacks.ts`
- Add `packages/web/src/lib/chat-private-anchors.ts`
- Modify `packages/web/src/components/chat/handoff-card.tsx`
- Modify `packages/web/src/components/chat/dispatch-row.tsx`
- Modify `packages/web/src/components/chat/chat-blocks.tsx`
- Modify `packages/web/src/components/chat/comms-callout.tsx`
- Modify `packages/web/src/components/chat/thread-peek.tsx`
- Modify `packages/web/src/components/chat/chat-messages.tsx`
- Modify `packages/web/src/routes/chat/page.tsx`
- Modify `packages/web/src/lib/blocks.ts`
- Modify `packages/jinn/src/gateway/__tests__/manager-visibility.test.ts` and `callback-reliability.test.ts`
- Modify `packages/jinn/src/sessions/__tests__/callback-deliveries.test.ts`, `delegation-completion-contract.test.ts`, and session duplication tests
- Modify `packages/web/src/components/chat/__tests__/chat-blocks.test.tsx`, `company-activity-card.test.tsx`, `chat-messages-tool-group.test.tsx`, `chat-messages-jump.test.tsx`, and `comms-v2.test.tsx`
- Add/modify route-level chat preview/history/focus tests and add `packages/web/src/lib/__tests__/chat-private-anchors.test.ts`

RED: coupled Todo/delegation block migration, duplicate/malformed blocks, tool suppression, pending/dead manager-visibility callback's three coupled references, and an accepted-and-consumed manager-visibility fixture. Snapshot the accepted callback row; migrate; prove its bytes unchanged while the completed queue prompt and notification `meta.workItemId` are current, public `/api/sessions/:id/messages` and session detail, queue/dead-letter APIs, search/context output, and WebSocket output contain no old machine identity, restart does not consume twice, and duplicate/accept/queued callback responses emit only current opaque message refs plus non-message receipt data.

Add exact supported-duplication fixtures: duplicate a session containing a manager-visibility notification, confirm the fresh internal message ID and null `work_item_id` clone still carry copied metadata before migration, then prove the clone's public messages API returns safe content and a current opaque ref; duplicate a session containing a completion guard and prove the detached contract is rekeyed without relational mismatch or actionability. Add accepted-callback fixtures for (a) target/message/queue present and consumed, (b) supported deletion leaving all three absent, and (c) every partial dangling permutation. The all-absent tombstone preserves callback bytes and is absent from pending/dead readers, requeue, recovery, duplicate POST, engine replay, and live API serialization; partial states block.

Browser RED fixtures use interactive and noninteractive delegation block `dg-JIN-42`. Common assertions: `dg-JIN-42`, raw message/block IDs, and `mr*` are absent from serialized attributes, URL, `history.state`, storage, and technical anchors; only `cb_*`/`cm_*` anchors appear. Under A, `JIN-42` appears only in the allowlisted visible identity/accessibility/copy node; under B it is absent from machine-rendered outerHTML/accessibility/clipboard. Disconnect/remount, navigate back, and prove focus returns through the same private anchor; prepend messages and prove scroll restoration. Reject old raw history IDs and cover teammate/relay/dispatch/generic wrappers, same-tab stability, cross-tab salt separation, storage salt only, and future domain-independent synthetic IDs.

GREEN: full-table structural rewrite for approved live callback/queue/message/session duplicate copies, byte-frozen accepted evidence and tombstones, callback duplicate/accept APIs returning opaque refs, serializer/recovery defense-in-depth, stale callback barriers, domain-separated private DOM anchors with stable focus/scroll restoration, and exact selected A/B visible identity behavior.

### Task 6: Epoch-safe messages, FTS, native histories, and opaque message references

**Files:**

- Add `packages/jinn/src/sessions/message-presentations.ts` and `packages/jinn/src/sessions/message-refs.ts`
- Modify `packages/jinn/src/sessions/registry.ts`, `manager.ts`, and `rate-limit-handler.ts`
- Modify `packages/jinn/src/gateway/api.ts`, `external-turns.ts`, `files.ts`, `chat-activity.ts`, and `server.ts`
- Modify `packages/jinn/src/engines/platform-context.ts`, `claude-interactive.ts`, `codex-interactive.ts`, `grok.ts`, `grok-interactive.ts`, `antigravity.ts`, and `transcript-tailer.ts`
- Modify `packages/jinn/src/mcp/search-tools.ts`, `session-tools.ts`, and `file-tools.ts`
- Modify `packages/jinn/src/shared/types.ts`
- Modify `packages/web/src/lib/api.ts`, `blocks.ts`, `packages/web/src/hooks/use-live-session.ts`, Chat message/anchor consumers, and their tests
- Add focused registry/gateway/MCP/native-transcript/message-reference/FTS fixtures

RED content fixtures: raw proven-human prose with an exact legacy/current literal remains byte-identical and non-resolving; A renders it byte-identically, while B masks current canonical tokens only at browser display. Prove `role='user'` machine rows for Workflow spawn/follow-up, delegation, agent-created session, callback/queue replay, and native backfill are not classified human. An identity-bearing ambiguous historical row blocks; an unknown non-bearing row receives conservative presentation without raw rewrite. Persisted assistant, notification, partial, synthetic fallback, tool input/result, thinking, connector output, and split-across-delta tokens expose no machine legacy identity. REST detail/page/older-page/search/context/transcript, MCP `read_session`/search/context, connector replies, WebSocket text/tool-result/notification/block/completion, and FTS snippets use the presentation boundary. A post-cutover assistant “Created JIN-42” follows A/B exactly. Old raw FTS does not survive rebuild/restart; stale/corrupt projection or FTS epoch fails closed and no post-listen raw-source backfill runs.

RED recursive-value fixtures: escaped exact IDs in native `tool_use.input` object keys/values, nested arrays, tool-result objects, live `delta.input`, notification/callback/attachment metadata, and REST/MCP/WS payloads. Split text tokens are buffered; decoded keys/values are mapped/neutralized; depth/node/byte overflow and unsupported/invalid shapes fail closed; two keys that collide after projection reject the whole value. Raw evidence hashes remain unchanged.

RED message-reference fixtures: historical `block-todo:wi_00000000000a-uuid` and `block-dg-wi_00000000000b-uuid`; duplicated Todo/delegation/manager sessions; search hit to context; page cursor across reload; callback duplicate/accept/queued response; attachment REST/WebSocket/MCP; final assistant completion; block/notification flows; direct API/MCP/WS recursive scans. Every public ID has the current `mr<refEpoch>_*` grammar; current ref remains stable within its ref epoch. Missing/corrupt refs fail closed. Forward-repair regeneration first increments the ref epoch, then old refs return generic `410`; pre-guard raw cursors reject without echo/fallback; malformed/future, unknown, and cross-session refs follow specified errors. Search/context neighbors and anchors are opaque. Web 410 handling cold-refetches without raw retry. Insert/delete/duplicate/callback/backfill trigger coverage proves exactly one ref, guarded monotonic epoch, and atomic interruption behavior.

RED native fixtures: epoch-1 JSONL contains text, nested/escaped tool input/result, and thinking with legacy IDs. Raw transcript endpoint, empty-session detail backfill, on-load tail sync, hook adoption, missed-stop recovery, old scalar/every-engine session ref, native resume command, engine switch both directions, rate-limit retry, pending queue replay, and late recovery all refuse epoch-1 authority and insert/emit nothing. A current-epoch file reads only post-bind bytes and normalizes before output/store. A duplicated session cannot inherit resume authority. Engine switch/re-prompt uses only safe projected context.

GREEN: frozen raw authored/native bytes and internal PKs remain unchanged; every live reader and engine ingress uses current-epoch API/browser/engine projections; FTS is rebuilt only from safe API content; every public message identity is opaque/current/scoped; old native refs are severed; current native adoption is bounded; machine content is normalized before both first frame and persistence.

### Task 7: Epoch-aware Activity presentation and search

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

### Task 8: REST, MCP, search, cron, and delegation producers

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

### Task 9: Web epoch, private references, React Query, and CAS

**Files:**

- Modify `packages/web/src/routes/todos/todo-private-state.ts`
- Modify `packages/web/src/lib/todos.ts`
- Modify `packages/web/src/routes/todos/use-todos.ts`
- Modify `packages/web/src/routes/todos/page.tsx`, `group.tsx`, `row.tsx`, `detail-sheet.tsx`, `use-todo-draft.ts`, and `use-todo-quick-edit.ts`
- Modify `packages/web/src/routes/todos/__tests__/todo-private-state.test.ts`, `page-history.test.tsx`, `todo-quick-edit.test.tsx`, `todo-edit-request.test.ts`, and `quick-edit-retry-actions.test.tsx`
- Modify gateway bootstrap/status typing and web query client handling

RED: stale `td_*` selection, stale edit journal, dirty-draft cutover refusal, read-only quarantine/copy recovery with no silent loss, epoch mismatch, technical source/approval labels, query invalidation, reload, Activity card click, full ChatMessages wrapper, and canonical search excluded from `location.search`. With `JIN-42`, both policies assert pathname/search/history/storage/attributes/hrefs/technical anchors/cursors exclude it while authenticated REST carries it. A asserts only intentional Todo text/accessibility/Copy ID/search result contains it. B includes user and machine transcript literals and inspects search input during typing, paste, pending, result, back/forward, and reload; no canonical token may reach DOM text/value/a11y, clipboard/share, history, or storage.

GREEN: versioned private namespace, clean-tab gate, fail-closed stale-journal copy recovery, neutral reload, full query reset, epoch handshake, private-only navigation state, nonpersisted canonical search, and selected A/B UI contract.

### Task 10: Current fixtures, templates, and active documentation

**Files:**

- Update current-behavior ID fixtures across work-item, gateway, MCP, session, engine/shared, Workflow, and web tests
- Keep explicit legacy/corrupt fixtures named as migration evidence
- Modify `packages/jinn/template/skills/todo-handling/SKILL.md`
- Modify `packages/jinn/template/skills/delegation/SKILL.md` and `packages/jinn/template/skills/management/SKILL.md` where the classified sweep finds current Todo-ID examples
- Add a new versioned template migration note; do not edit historical migration prompts

RED: repository classification test/lint that flags unexplained legacy literals and any ad-hoc legacy Todo regex/parser outside `work-items/id.ts` in active code/templates while allowlisting named historical fixtures, schema object names, `wie_*`, and `wi-job`.

GREEN: current examples use JIN; historical artifacts retain documented purpose; public templates remain generic.

### Task 11: Full rehearsal, verification, and independent implementation review

**Files:** Test artifacts only until reviewer approves deployment; no production instance data.

1. Build a disposable instance fixture containing every reference class.
2. Run preflight, backup, migration, pre-serving restore, remigration, served-seal transition, idempotent rerun, and post-serving restore refusal.
3. After serving is sealed, create `JIN-(N+1)`, inject a forward-repair failure, and prove the failed repair preserves that Todo and high-water; complete forward repair and prove the next creation is greater.
4. Burn an ordinal, fail its Todo transaction, attempt forbidden legacy restore, run forward repair, and prove the next Todo skips the burned ordinal.
5. Run concurrent allocator/boot workers with duplicate-sourceRef gaps allowed.
6. Run raw-plus-decoded escaped Workflow fixtures; parked resume/sweep; accepted-and-consumed and all-absent callback tombstones; duplicated manager message/completion contract/synthetic Todo and delegation rows; safe raw-content/FTS/list/search/context/MCP/WebSocket projections; old/current native resume/backfill/tail-sync/engine-switch fixtures; Activity list/story/search/rebuild; refusal-only cross-instance; exact legacy-grammar mismatch; opaque-message cursor expiry/reload; and both conditional browser policy fixture branches.
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
| Corrupt canonical row | `wi_00000000000a` valid control plus uppercase, short, long, nonhex, arbitrary `wi_*`, null, or wrong timestamp type | Only the exact lowercase 12-hex control maps; every mismatch refuses with no DB/manifest publication change |
| Dangling direct reference | Event/session/block points to missing Todo | Preflight refusal with exact class/locator digest |
| Corrupt structured JSON | Completion contract/block/callback cannot parse or mismatches pair | Preflight refusal; no recursive best-effort rewrite |
| Nonterminal Workflow blocker | Quiet parked, parked/in-flight, running/stopping, dispatched, stale index | Full file scan refuses every legacy-bearing run; resume/sweep cannot cross gate; terminalizing all blockers permits deterministic retry |
| Workflow encoding boundary | Escaped tokens in raw/decoded trigger, condition, prompt, params, receipts, keys; invalid/over-limit JSON | Shared scanner diagnoses raw/decoded RFC 6901 location; every nonterminal match blocks; invalid/limit fails closed |
| Terminal Workflow evidence | Completed/failed/cancelled run plus legacy run Session | File/session checksum unchanged; list/detail/MCP/reporting/Activity/recovery/session presentation exposes no old machine identity/link |
| Message content presentation | User, assistant, notification, partial, tool result/input, fallback, duplicate, split stream | User prose is byte-identical/non-resolving; raw evidence unchanged; every machine REST/MCP/connector/WS/engine presentation excludes legacy identity and follows A/B |
| Content-origin provenance | Genuine human plus role-user Workflow/delegation/agent/queue/native rows and ambiguous historical identity text | Guard stamps every new producer; structural history proof never relies on role; ambiguous identity-bearing row blocks; raw bytes remain frozen |
| Recursive machine values | Escaped IDs in nested tool/native/delta/notification/callback/attachment keys/values, collision and limit cases | Complete bounded walk projects all strings; collision/invalid/limit fails closed; no raw nested bypass |
| FTS rebuild and restart | Raw legacy FTS rows, stale/corrupt epoch, suffix/full search | Only current presentation is indexed/snippeted before listen; machine rows are safe, authored literals remain text; stale epoch refuses; no lazy raw-source backfill |
| Opaque message references | Todo/delegation synthetic PKs, duplicates, search→context, callback/attachment/completion, current/old/raw/cross-session cursors, corrupt projection/forward repair | Public payloads contain only current scoped `mr*`; stable within ref epoch; regeneration bumps ref epoch; old/raw reject without echo/fallback; no Todo alias |
| Native history epoch | Old engine refs/JSONL/hook/tailer/switch/retry/replay and current bounded file | Old authority returns 410 or starts fresh and imports/emits nothing; current reads post-bind only and normalizes before use |
| Browser policy A | Todo/detail/Activity/delegation/search/copy plus transcript `JIN-42` | JIN appears only in allowlisted visible/a11y/copy/search text; absent from navigation/history/storage/attributes/anchors/cursors |
| Browser policy B | Same corpus plus user-authored `JIN-42` and search-input lifecycle | JIN absent from all DOM/text/values/a11y/clipboard/share/history/storage; title-only UI works; API/MCP remains canonical |
| Activity audit evidence | Immutable event contains old IDs/links in every public field | Raw bytes/hash unchanged; epoch-safe list/story/search/rebuild/API exposes no old token/link; epoch mismatch fails closed |
| Callback lifecycle | Pending, dead-letter, accepted-and-consumed, poison, legacy | Pending/dead coupled references rekey or refuse; accepted row checksum unchanged; linked queue/message/API copies safe; no double consume |
| Accepted callback tombstone | Supported manager-session deletion leaves accepted target/message/queue all absent; corrupt fixtures leave each partial permutation | All-absent row bytes/hash remain identical and no live reader/recovery/requeue can act or emit payload; every partial state refuses migration |
| CAS boundary | Pre-cutover receipt plus post-cutover edit | Old key requests reload/fresh key; JIN retry is idempotent; Todo version unchanged by migration |
| Interrupted transaction | Fault before/inside commit | SQLite rollback returns exact legacy invariant; rerun maps identically |
| Commit/manifest interruption | Fault after commit before rename | Boot refuses serving, verifies digest, completes rename only |
| Burned failed allocation | Commit allocation N, fail Todo/event insert, restart | Ledger/high-water retain N, no JIN-N row exists, next successful create is greater than N |
| Allocator guards | DELETE/REPLACE singleton, equal/decreasing/skipped update, ledger UPDATE/DELETE | Every forbidden SQL statement aborts; high-water and ledger remain unchanged |
| Concurrent allocation | 16 and 32 workers, duplicate/nonduplicate sourceRefs | Unique strictly increasing burns; one Todo per idempotency key; permanent gaps allowed; no ordinal handed to creation is reused |
| Concurrent boot | Multiple migration-capable processes | One owner migrates; others wait/refuse; no partial schema |
| Mixed/newer binary | Legacy, guard-only, migrated, and unsupported epoch combinations | Matrix matches documented refusal; no old writer can commit |
| Browser privacy floor | Todos, chat activity, search jump, reload, private selection/edit, interactive/noninteractive `dg-JIN-42` handoff | No JIN in navigation/history/storage/attributes/technical anchors/cursors; `cm_*`/`cb_*` preserve focus/scroll; selected A/B visible-text rule passes |
| Same-instance duplicated manager message | Duplicate accepted manager transcript, fresh message/session IDs, clone has no `work_item_id`/callback link | Full metadata/presentation scan rekeys the clone; public messages/session/search APIs emit safe content plus opaque refs; duplication is not corruption |
| Same-instance detached completion contract | Duplicate tracked session with `transport_meta` guard but no cloned `work_item_id` | Full transport scan rekeys exact guard, preserves other metadata, and proves completion CAS/recovery cannot act on clone |
| Cross-instance refusal | Two isolated homes each own JIN-1; probe route/tool/CLI/instance listing | IDs remain local; no rows move; import route is 404, tool is absent/unknown, CLI has no import command |
| Idempotent rerun | Completed migration invoked again | No bytes/counters/manifest rows change |
| Pre-serving restore | `complete-unserved`, no external seal, no postmigration write | Verified whole legacy backup may restore offline; exact legacy state returns |
| Post-serving rollback refusal | Seal served, create JIN-(N+1), request legacy restore | Refusal occurs before file replacement; new Todo and ledger/high-water remain intact |
| Guard/migration release boundary | Binary below `G`, exact `G`, `[G,M)`, and `>=M`; legacy/unguarded/staged/served DB | Only the documented matrix opens; manifest records concrete `G` and `M`; older/mixed binaries refuse before mutation or serving |
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
5. **Callback fan-out:** Verify pending/dead coupled rewrites, full-table duplicated metadata scans, and accepted-callback byte preservation independently from linked queue/message/API projections. A legitimate accepted all-absent tombstone is inventoried and inert; every partial dangling combination, malformed template, or collision is fail-closed.
6. **Activity presentation:** Verify every public field and FTS input passes through one epoch-aware neutralizer while immutable bytes/hashes remain stable. Any bypass or unsafe parse is a migration blocker.
7. **Message/native evidence boundary:** Preserve raw authored/machine/native bytes and internal PKs while proving durable origin without trusting role, recursively projecting nested machine values, and routing every serializer, FTS input, stream, connector, engine resume/switch/re-prompt, backfill, and tail-sync through current safe projections. Any ambiguous identity-bearing origin, raw/nested fallback, or epoch-1 re-entry keeps the instance offline.
8. **Edit receipts:** Preserve epoch-1 receipt bytes but invalidate operational replay across cutover; require reload/fresh key. Recalculation is impossible because the original request is absent.
9. **Mixed-version boundary:** Approve a guard release before the migration release and name concrete `G`/`M` minimum versions for legacy/served epochs. A single-release cutover cannot protect against arbitrary old binaries.
10. **Browser state:** The common private-ref floor is locked and migration requires clean tabs/no dirty journals. Policy A/B intentional rendering remains an operator choice. Stale state is quarantined for explicit copy/recovery; it is never silently discarded and never stores or reconstructs a canonical ID.
11. **Migration orchestration:** Use an explicit offline command/maintenance gate rather than implicit ordinary startup migration. Do not overload the template-oriented `jinn migrate` command ambiguously.
12. **Post-serving recovery:** Verify the external seal cannot disappear through supported restore tooling and that forward repair preserves all post-cutover writes plus allocation ledger/high-water. If proof fails, the instance stays offline.

## Exact Go/No-Go Criteria

### Architecture GO

Implementation may begin only when the operator explicitly records all ten decisions, including concrete minimum-compatible `G` and `M` versions and policy `A` or `B`, and a fresh independent reviewer approves this revised map and confirms:

- every field in the producer/consumer graph was checked against current source;
- immutable evidence is separated from live resolvable state without a hidden alias;
- the deterministic ordering and fixed prefix are accepted;
- the backup/manifest/state-machine design is recoverable and idempotent;
- full backup restoration is impossible after the served seal and forward repair preserves post-cutover writes/high-water;
- the exact guard-release semver and two-stage mixed-version matrix are recorded and operationally acceptable;
- the clean-tab/no-draft-loss procedure, common private-reference floor, and selected A/B browser behavior are preserved;
- full session/message structured scans cover supported clones without relational links, and accepted all-absent tombstones are proven inert;
- private message/block anchors preserve transcript scroll and return focus without canonical values in history/DOM/storage;
- raw message content/internal PKs/native histories are frozen while safe presentation, FTS, opaque refs, REST/MCP/WebSocket serializers, and engine ingress enforce the epoch boundary;
- content origin is durable for new producers, historical role-user machine rows cannot be mistaken for humans, nested decoded values are bounded/collision-safe, and message refs remain stable within a separately guarded ref epoch;
- Workflow raw and recursively decoded JSON keys/values share one exact parser and fail closed;
- the implementation sequence and fixture matrix cover the contract.

### Architecture NO-GO

Do not implement if any of the following remains true:

- any nonterminal Workflow run contains an exact legacy token, mapped or unknown, regardless of parked/stopping/index state;
- any Workflow JSON artifact was not scanned in both raw and fully decoded string-key/value form, or invalid/over-limit JSON can pass;
- any `work_items.id` is outside exact `^wi_[0-9a-f]{12}$` in the legacy epoch, or mapping/Workflow/callback/Activity/session scanners disagree on the shared valid/mismatch corpus;
- a legacy Workflow session or accepted/dead callback still uses an old ID for a live action;
- manager-visibility queue/message/API copies, duplicated session metadata, or Activity list/story/search serializers can emit an old structured Todo identity;
- a partial accepted-callback dangling state exists, or an all-absent tombstone is reachable by pending/dead recovery, requeue, engine replay, duplicate callback delivery, or live evidence serialization;
- any nonlegacy `transport_meta`, `messages.meta`, or `messages.blocks` row with an exact legacy Todo reference is unclassified or missed by the full scan;
- raw message/block IDs enter browser URL/history/storage/DOM, or private anchors fail stable scroll/focus restoration;
- a raw/internal message PK, old public cursor, unsafe raw content/FTS snippet, or epoch-1 native transcript/ref can escape through REST, MCP, WebSocket, connector, backfill/tail-sync, resume, retry, engine switch, or re-prompt;
- an identity-bearing historical message has ambiguous authorship, any new producer can omit content origin, nested machine values bypass the recursive projector, or random message refs can be replaced without incrementing the message-ref epoch;
- full legacy restore remains callable after the served seal or forward repair can lose a post-cutover write/high-water;
- allocator deletion, replacement, decrease, or reuse of a burned ordinal remains possible;
- epoch-1 edit-receipt behavior is unspecified;
- concrete `G` and `M` are not recorded, a binary older than `G` may open the database, an epoch-2 binary older than `M` may serve, or a guard-only/migration binary opens a disallowed epoch;
- dirty Todo drafts/tabs exist at the cutover gate or any client path silently clears/quarantines state without a visible recovery action;
- a cross-instance import/remap is expected in this refusal-only ticket;
- the operator has not recorded every decision-table row or has not selected A/B;
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

## V4 Re-Audit Evidence

The v3 rejection was re-audited against the current source before this revision. These are the load-bearing paths:

- Exact legacy grammar: `packages/jinn/src/work-items/store.ts:216-219` generates lowercase 12-hex IDs and `work-items/__tests__/store.test.ts:44` asserts the same grammar, while `work-items/migrate.ts:32-60` has no source-ID CHECK. Migration therefore owns exact shared validation and rejects all other row IDs.
- Allocation/create boundary: `packages/jinn/src/work-items/store.ts:216-219,345-404` currently generates before a deferred Todo/event transaction and rechecks sourceRef inside it; `packages/jinn/src/work-items/migrate.ts:32-60,150-185` has no allocator and demonstrates the current immediate table-swap primitive.
- Boot/serve boundary: `packages/jinn/src/sessions/registry.ts:421-490,721-733` opens and migrates the instance DB; `packages/jinn/src/gateway/server.ts:307-309` initializes it and `:1339-1348` begins listening; `packages/jinn/src/cli/start.ts:53-60` currently warns rather than refuses version drift.
- Workflow executability: `packages/jinn/src/workflows/run-store.ts:342-348` defines statuses and `:800-879` makes only completed/failed/cancelled terminal while indexing every other status. `run-reconciler.ts:426-436` passes trigger data to step prompts, `:1143-1200` resumes parked gates, and `:1207-1275` rebuilds/sweeps the active index. `handoff.ts:434-458` serializes trigger payloads; `condition.ts:176-190` reads scalar trigger payload values; `advance.ts:1010-1016,1674-1694` feeds conditions and drains stopping runs.
- Workflow decoded JSON exposure: `workflows/run-store.ts:350-449,640-730,948-962` persists/parses executable trigger, parameters, overrides/edits, receipts/outcomes, parked/errors, and snapshots; `condition.ts:176-212` reads decoded values; `handoff.ts:429-526` feeds decoded keys/values into prompts; `reporting.ts:45-56,108-243` publishes terminal presentation into Activity/session delivery. Raw-only scanning is therefore insufficient.
- Manager visibility: `packages/jinn/src/sessions/callbacks.ts:50-80` writes Todo prose, `meta.workItemId`, and source attempt. `sessions/registry.ts:3335-3383` copies prompt/meta into queue/message rows and links their IDs to the accepted callback. `gateway/api.ts:473-525` replays pending callback queues, `:2828-2850` serializes dead letters, `:3263-3310` serializes messages/session detail, `:3553-3561` serializes queue prompts, and `:5645-5673` reloads authoritative callback payload.
- Supported duplication: `packages/jinn/src/sessions/registry.ts:2283-2340` copies `transport_meta`, every message `blocks`/`meta`, and delegation `source_ref` under a fresh session/message identity while omitting `work_item_id` and parent linkage. `registry.ts:363-382,2457-2478,2554-2625` and `gateway/api.ts:2737-2751,3323-3406` return those copies through session list/detail and raw message APIs. Detached completion guards and cloned manager metadata are therefore full-scan inputs, not corruption.
- Raw message and synthetic-ID exposure: `sessions/registry.ts:2467-2478,2554-2625,2658-2713` emits raw content/IDs for read/page/context; `:2780-2803` embeds block IDs in historical message PKs; `:220-262,918-1043,1126-1181` indexes raw content and returns raw FTS snippets/IDs. REST search/detail/page/context at `gateway/api.ts:3068-3107,3359-3406,3754-3778`, MCP `search-tools.ts:146-208,270-300`, and `session-tools.ts:225-258` forward them. Callback duplicate/accept/queued responses at `gateway/api.ts:5754-5761,5990-5998,6144-6151` also expose durable internal message IDs.
- Native history and streaming re-entry: `gateway/api.ts:5167-5176,7099-7263` serves raw JSONL and imports flattened transcript bytes; `external-turns.ts:90-132,233-369` inserts/overwrites during backfill/tail sync; `api.ts:7620-7669,8011-8028` broadcasts and persists machine output; `gateway/server.ts:899-907` serializes producer payload unchanged. `sessions/registry.ts:25-69,1722-1823`, `sessions/manager.ts:379-474`, and `gateway/api.ts:7561-7608` preserve native refs and use raw recent content for resume/engine switch. Epoch gating is required to stop post-validation re-entry.
- Accepted tombstones: `packages/jinn/src/sessions/registry.ts:149-177` gives callbacks no cascading FK, while `:2343-2374` atomically deletes an unlinked target's messages, queue, and session without deleting accepted evidence. `:3120-3218`, `sessions/callbacks.ts:159-176,611-663`, and `gateway/api.ts:481-529,2857-2879,5729-5748` exclude all-absent accepted rows from pending/dead recovery, requeue, engine replay, and target delivery. Partial presence remains corruption.
- Activity exposure: `packages/jinn/src/activity/migrate.ts:31-78,115-139` defines immutable hashed rows. `projection.ts:75-84,134-163` indexes raw object IDs and rebuilds from raw rows. `store.ts:183-223` reconstructs all raw fields. `query.ts:187-221,323-365` returns raw list/story events and links. `gateway/api.ts:6663-6691` serializes those results directly.
- Cross-instance absence: `packages/jinn/bin/jinn.ts`, `packages/jinn/src/cli/create.ts:21-88`, `cli/instances.ts:6-24`, `gateway/api.ts:3024-3036`, and `mcp/server.ts:115-129,224-245` expose no Todo import/export/merge surface and reject unknown routes/tools.
- Browser privacy boundary: `packages/web/src/main.tsx:70-80` has only `/todos`; `routes/todos/todo-private-state.ts:63-90,344-435` uses salted private refs/journal keys; Todo `page.tsx:141-175,578-608` sanitizes history. `lib/todos.ts:454-486` currently serializes search to browser URL and must special-case canonical lookup. Chat leaks raw IDs through `handoff-card.tsx:68-95`, `dispatch-row.tsx:67-114`, `chat-blocks.tsx:36-81`, `comms-callout.tsx:88-109`, and `chat-messages.tsx:1268-1270,1506-1542,1715-1724`; `routes/chat/page.tsx:72-85,610-628,691-703` stores/queries the raw preview ID. All technical identity moves to per-tab `cm_*`/`cb_*`; policy A/B controls only intentional visible text.

## Audited File Inventory

This is the concrete repository reference graph used to produce the classifications above. Implementation must repeat the literal/structural sweep because the repository may change after approval.

### Production and schema files

- Canonical Todo schema/store/transitions/approvals: `packages/jinn/src/work-items/migrate.ts`, `store.ts`, `transitions.ts`, `approvals.ts`, `reconcile.ts`, and `workflow-event-feed.ts`.
- Session schema and durable state: `packages/jinn/src/sessions/registry.ts`, `callbacks.ts`, `delegation-completion-contract.ts`, `manager.ts`, `rate-limit-handler.ts`, planned `message-presentations.ts`, and planned `message-refs.ts`.
- Gateway producers/consumers: `packages/jinn/src/gateway/api.ts`, `external-turns.ts`, `files.ts`, `server.ts`, `chat-activity.ts`, and `manager-visibility.ts`.
- Workflow evidence and triggers: `packages/jinn/src/workflows/run-store.ts`, `definition-store.ts`, `run-reconciler.ts`, `reporting.ts`, `handoff.ts`, `todo-status-trigger.ts`, `custom-triggers.ts`, `condition.ts`, and `advance.ts`.
- Activity audit/projection: `packages/jinn/src/activity/migrate.ts`, `payload.ts`, `store.ts`, `projection.ts`, and `query.ts`.
- MCP: `packages/jinn/src/mcp/work-item-tools.ts`, `approval-tools.ts`, `delegation-tools.ts`, `workflow-tools.ts`, `search-tools.ts`, `session-tools.ts`, `file-tools.ts`, `server.ts`, and shared toolkit/error handling.
- Engine/native history: `packages/jinn/src/engines/platform-context.ts`, `claude-interactive.ts`, `codex-interactive.ts`, `grok.ts`, `grok-interactive.ts`, `antigravity.ts`, and `transcript-tailer.ts`.
- Other producers and shared contracts: `packages/jinn/src/cron/runner.ts`, `packages/jinn/src/shared/types.ts`, `blocks.ts`, and `activity-receipts.ts`.
- Startup/instances/migration boundary: `packages/jinn/src/sessions/registry.ts`, `packages/jinn/src/gateway/server.ts`, `packages/jinn/src/cli/start.ts`, `migrate.ts`, `create.ts`, `instances.ts`, `packages/jinn/bin/jinn.ts`, and `packages/jinn/src/shared/paths.ts`.
- Web privacy/data/CAS: `packages/web/src/lib/todos.ts`, `query-client.ts`, planned `chat-private-anchors.ts`, `packages/web/src/routes/todos/todo-private-state.ts`, `todo-edit-request.ts`, `use-todo-quick-edit.ts`, `use-todo-draft.ts`, `use-todos.ts`, Todo `page.tsx`, `group.tsx`, `row.tsx`, `detail-sheet.tsx`, Chat `routes/chat/page.tsx`, and `packages/web/src/components/chat/chat-messages.tsx`, `handoff-card.tsx`, `dispatch-row.tsx`, `chat-blocks.tsx`, `comms-callout.tsx`, `thread-peek.tsx`, plus `company-activity-card.tsx`.

### Existing tests and fixtures with current or legacy ID literals

- Work items: `packages/jinn/src/work-items/__tests__/store.test.ts`, `migrate.test.ts`, `fixtures/migration-worker.mjs`, `approvals.test.ts`, `approvals-atomicity.test.ts`, `transitions.test.ts`, `reconcile.test.ts`, `optimistic-concurrency.test.ts`, `version-mutations.test.ts`, and `list-limit.test.ts`.
- Gateway: `packages/jinn/src/gateway/__tests__/work-items-route.test.ts`, `work-item-approval-route.test.ts`, `delegations-route.test.ts`, `manager-visibility.test.ts`, `callback-reliability.test.ts`, `chat-activity-route.test.ts`, `streamed-turn-settlement.test.ts`, `legacy-workflow-mutation-boundaries.test.ts`, and `workflow-session-grouping.test.ts`.
- Sessions: `packages/jinn/src/sessions/registry.test.ts`, `__tests__/registry-delete-queue-items.test.ts`, `callback-deliveries.test.ts`, `callback-concurrent-init.test.ts`, `delegation-completion-contract.test.ts`, `legacy-workflow-session-compat.test.ts`, `messages-partial.test.ts`, duplication tests, and message-search/context tests.
- Workflows: `packages/jinn/src/workflows/__tests__/run-store.test.ts`, `todo-status-trigger.test.ts`, `todo-replay-watermark.test.ts`, `todo-capability-boundary.test.ts`, `condition.test.ts`, and `poll-trigger.test.ts`.
- MCP: `packages/jinn/src/mcp/__tests__/work-item-tools.test.ts`, `delegation-tools.test.ts`, `server.test.ts`, `toolkit.test.ts`, and read-capability tests.
- Engine/shared receipt propagation: Claude, Codex, Grok, Hermes, and Pi interactive/protocol tests; `packages/jinn/src/shared/__tests__/activity-receipts.test.ts`, `blocks.test.ts`, `company-activity-blocks.test.ts`, and `fixtures/company-activity-blocks.json`.
- Web: Todo route detail/page/history/private-state/edit/draft/quick-edit/CAS/pagination tests; `packages/web/src/lib/__tests__/todos.test.ts`, `company-activity-blocks.test.ts`, planned private-anchor tests; `chat-blocks.test.tsx`, `chat-messages-jump.test.tsx`, `chat-messages-tool-group.test.tsx`, `comms-v2.test.tsx`, activity-card/parity tests, route-level preview/history/focus tests, and live-session/query-invalidation tests.
- Activity: `packages/jinn/src/activity/__tests__/migration.test.ts`, `store.test.ts`, `query.test.ts`, and `performance.test.ts`.

### Templates and historical documentation

- Active public examples: `packages/jinn/template/skills/todo-handling/SKILL.md`, `delegation/SKILL.md`, and `management/SKILL.md`.
- Historical template migrations: `packages/jinn/template/migrations/0.26.0/MIGRATION.md` and `0.27.0/MIGRATION.md` remain immutable; implementation adds a new version rather than editing them.
- Historical architecture plans under `docs/superpowers/plans/` are evidence, not active examples, and are not mass-rewritten.
- `idx_wi_events_item`, `wie_*`, cron `wi-job` values, and explicitly labeled legacy fixtures are not canonical Todo references.

## Self-Audit Checklist

- [x] Canonical store, allocator, schema constraints, indexes, and ordering are covered.
- [x] Events, sourceRef/idempotency, approvals, sessions, delegations, manager-visibility callback fan-out, supported duplicated transport/message copies, accepted all-absent tombstones, queues, raw APIs, and receipts are classified.
- [x] Workflow Todo-status triggers, every nonterminal run state/index/resume/sweep path, legacy compatibility, `source=workflow`, and one-way capability boundaries are preserved.
- [x] Chat activity blocks, receipts, synthetic message IDs, raw message/block DOM/history/focus consumers, CAS, React Query, private refs, and DOM privacy are reconciled.
- [x] REST, MCP, CLI absence, search, shared types, cron, and WebSocket activity are covered.
- [x] Ordinary message content, tool/notification prose, safe FTS, list/page/search/context/read-session, WebSocket/connector output, native JSONL, engine refs, backfill/tail-sync, engine switching, retry, and resume/re-prompt are explicit epoch channels.
- [x] Durable content origin distinguishes proven human prose from role-user machine prompts; ambiguous identity-bearing history blocks, and nested decoded machine values are recursively bounded with collision failure.
- [x] Historical synthetic message PKs stay frozen internally while every public list/page/search/context/MCP/WebSocket/callback/attachment surface uses scoped opaque message refs and expires raw/old cursors.
- [x] Activity immutable bytes/hashes, epoch presentation, list/story/search/rebuild/API, projections/FTS, backups, instances, tests, templates, docs, and migrations are covered.
- [x] Deterministic map, permanent-burn allocator, staging, atomic swap, invariant validation, idempotence, crash recovery, pre-serving restore, post-serving forward repair, and mixed-version refusal are specified.
- [x] Cross-instance behavior is grounded in current surfaces and scoped to explicit refusal; no remap protocol is invented.
- [x] RED-to-GREEN tasks and verification fixtures cover current, corrupt, interrupted, concurrent, and collision cases.
- [x] Risks, unresolved decisions, and exact architecture/deployment gates are explicit.
- [x] All ten operator choices have recommended defaults and implementation remains forbidden until every answer, concrete `G`/`M`, selected A/B policy, and independent approval are recorded.
- [x] Browser technical privacy is locked; the intentional visible-identity A/B choice is explicitly conditional with downstream tests.
- [x] No production implementation or runtime mutation is authorized by this document.
