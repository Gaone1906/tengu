# JIN-N Sole Todo Identifier — v6 Simplified First-Release Plan

> **Status:** Architecture only. This document does not authorize implementation, release, gateway restart, or conversion of any installed instance.

**Goal:** Ship Todos for the first time with `JIN-1`, `JIN-2`, and so on as their sole identifier, then convert the operator's one private prerelease database with a separately reviewed, offline, one-off tool.

**Architecture:** Public installations get the clean `JIN-N` schema directly. Normal startup contains no legacy migration or alias logic and rejects unexpected nonempty prerelease Todo state. A generic tool outside the shipped package converts the one known private prerelease instance under full downtime, with a verified external backup and no runtime resolver left behind.

## Locked Contract and Accepted Decisions

Operator decision A is accepted and supersedes the earlier browser-hiding and customer-migration designs:

- The fixed v1 grammar is `^JIN-[1-9][0-9]*$`; values above `Number.MAX_SAFE_INTEGER` are invalid.
- `work_items.id` is the actual primary key and the identifier used by REST, MCP, UI, URLs, search, logs, accessibility, copy/share, React/DOM state, and normal browser storage.
- `JIN-N` is predictable and visible. It is never a secret, bearer token, capability, or substitute for authentication or authorization.
- The exact prerelease grammar is `^wi_[0-9a-f]{12}$`.
- No opaque Todo ID, salted/private Todo reference, compatibility alias, redirect, secondary lookup key, or old-to-new runtime map exists after conversion.
- Historical literals may remain in ordinary prose and immutable evidence. A literal is inert when no parser, resolver, route, link, callback, condition, or mutation treats it as a Todo identity. Its spelling alone does not create a hidden second identity.
- Structured Todo references are produced and accepted only as canonical `JIN-N`. Exact legacy IDs at a Todo identity ingress are rejected, not normalized or looked up.
- Allocation is transactional across processes, strictly increasing, and permanently burned before Todo creation. Gaps are expected; ordinals are never reused.
- Cross-instance import remains refusal-only until a real import surface receives separate architecture.
- There is one first Todo release, not a guard/migration release pair. The private conversion is an operational prerequisite for the one prerelease instance, not a customer upgrade feature.

No product/privacy choice remains open. The only later irreversible operator action is authorizing the private offline conversion and subsequent first start of the new binary.

## Evidence That Todos Were Not Publicly Shipped

This premise was independently checked against npm, Git history, changelog history, packaged migrations, and published tarballs on 2026-07-14:

- npm reports `jinn-cli@0.25.0` as `latest`, published at `2026-07-07T15:28:02.191Z`; no version newer than `0.25.0` is present.
- Git tag `v0.25.0` points to `16bce2738317311482a44ec3807eca7cc3ce5de4` (`2026-07-07T18:27:29+03:00`). Its tree contains no `src/work-items`, Todo route, Todo skill, `/api/work-items`, or `work_items` schema.
- The tagged `0.25.0` changelog lists engine switching and restart/UI hardening only; its release notes do not introduce Todos or a Todo data migration.
- The `0.25.0` npm tarball contains 613 files and no Todo/work-item path, API, or schema hit. Its registry integrity is `sha512-49mgCQfKUppNwx8boUjN/MKykJ4r2NFbRL6YdLuQxv7bN9QgqcYHU9Q+r4L2QsICvs6LxgO06w67b1ErEUgnHA==`.
- An independent streaming scan of all 57 registry versions from `0.1.0` through `0.25.0` found no Todo/work-item schema literal, route, skill, or source path.
- The packaged workspace migrations in `v0.25.0` end at `0.9.0` and contain no Todo database migration. `jinn migrate` at those versions updates workspace/template files; it does not create `work_items`.
- The first commit introducing `work_items` plus Todo source/UI is `2478ab832fecaef46f67bbcf37229d2b5bf4af2c`, dated `2026-07-08T06:44:36+03:00`, after `0.25.0`. No release tag contains that commit.
- The current `0.26.0` changelog/source advertises Todos, but it is untagged and npm still reports `0.25.0`. It is unreleased source state.

**Evidence limit:** this proves the current public npm registry and repository release history. It cannot rule out manually installed untagged builds. Such a database is deliberately classified as unsupported prerelease state and is never silently migrated by public startup. Recheck npm and the release tag immediately before publication; a contradiction is a release blocker.

## Public First-Release Design

### 1. One identity module

Add `packages/jinn/src/work-items/id.ts` as the only parser/formatter:

```ts
parseTodoId(value: unknown): { id: string; ordinal: number } | null
formatTodoId(ordinal: number): string
isExactLegacyTodoId(value: unknown): boolean
```

`parseTodoId` rejects zero, leading zeroes, signs, whitespace, case variants, numeric suffixes without `JIN-`, and unsafe integers. Store functions, REST route/body fields, MCP Todo/approval/delegation inputs, and the typed Workflow Todo-status envelope call it before lookup or mutation. There is no legacy parse-to-current function.

### 2. Clean startup boundary

Replace the compatibility rebuild in `packages/jinn/src/work-items/migrate.ts`. Before changing journal mode or schema, startup performs a read-only inventory:

1. **No Todo tables and no non-null Todo session edge:** this is the normal upgrade from every public release; create the clean JIN schema.
2. **Exact current JIN schema:** verify table/index/trigger/allocator invariants and continue.
3. **Empty, recognized prerelease Todo schema with empty companions and no structured edge:** replace it transactionally with the clean schema.
4. **Any nonempty legacy/noncanonical `work_items`, nonempty prerelease companion, mixed IDs, non-null orphan session edge, or unknown Todo schema:** close the database and abort before serving.

The diagnostic is generic and actionable without echoing data:

```text
Unsupported prerelease Todo data detected. This release cannot start or migrate it.
Restore a supported public-version backup, or use a separately reviewed offline converter.
```

Public startup never maps, deletes, aliases, or partially upgrades nonempty prerelease data.

### 3. Primary key and permanent-burn allocator

The schema enforces canonical `JIN-N` directly on `work_items.id` and forbids primary-key updates. Add:

- a singleton high-water row capped at `Number.MAX_SAFE_INTEGER`;
- an append-only burn ledger keyed by ordinal;
- triggers rejecting allocator delete/replace/decrease/skip and burn update/delete;
- an allocator advance trigger that records the newly committed burn in the same transaction.

`createWorkItem` first checks an existing `(source, source_ref)` replay. If none exists, a short `BEGIN IMMEDIATE` transaction advances and commits the allocator. Todo plus `created` event are inserted in a second transaction. Creation failure or a lost idempotency race leaves a permanent gap. Fresh public databases begin at `JIN-1`; the private converter seeds `1..N` and high-water `N`.

The numeric allocator is allocation evidence, not a second Todo identity: no API accepts an ordinal and no resolver queries the ledger as a Todo.

### 4. Intentional product surfaces

- REST continues at `/api/work-items/JIN-42`; every `:id` and `workItemId` body field uses the shared parser.
- MCP Todo, approval, delegation, and session-link tools accept and emit `JIN-N` in their existing fields.
- Todo search recognizes an exact canonical ID by equality and otherwise searches normal title/body prose. Historical legacy text may appear only as a free-text result and is never linked as a Todo.
- Add the canonical browser route `/todos/:todoId`; rows, activity cards, back/forward, reload, and share navigate directly to `/todos/JIN-42`.
- Show the ID near the Todo title, include it in accessible names, and provide Copy ID and Copy Link. Logs and activity receipts use it normally.
- Delete `todoPrivateRef`, per-tab salts, `td_*` history resolution, exhaustive private-ref lookup, DOM masking, and privacy-only tests/comments. Draft/recovery state is keyed directly by canonical ID.
- The current CLI has no Todo CRUD command. Do not invent an import, alias, or migration CLI for parity. Any future Todo CLI must use the shared parser; current CLI-visible startup diagnostics remain generic.

Predictability does not alter authority. Gateway authentication runs before Todo existence checks; MCP keeps verified caller binding; mutation routes keep owner/manager/root/reviewer/approval checks. Anonymous known and unknown IDs receive the same authentication failure. A bound caller cannot mutate a guessed adjacent Todo without the same authorization required for any other ID.

An authenticated caller with the existing ledger-read grant may distinguish a present Todo from a missing one; that is authorized enumeration of the selected instance, not knowledge-of-ID authority. Mutation tests must separately prove that read visibility never grants write/approval/delegation authority.

### 5. Minimal Workflow boundary

The only typed Workflow Todo relationship is:

```text
work_item_events.work_item_id
  -> WorkflowTodoStatusEvent.workItemId
  -> trigger { source: "todo-status-change", event: "todo.status_changed",
               payload: { todoId: "JIN-N" } }
```

Validate that envelope at the event-feed producer and again before Workflow claim/run persistence, condition evaluation, or session creation. Delete the unshipped `triggerTodoId` compatibility field/normalization and convert positive fixtures to `JIN-N`.

Webhook payloads, poll payloads, manual inputs, `fireRef`, titles, prompts, errors, and native transcripts are generic data/prose; current code never passes them to a Todo resolver. Do not add a recursive legacy scanner, transcript sanitizer, identity epoch, or native transcript descriptor system. A `wi_*` literal there remains inert because every actual Todo ingress rejects it.

Likewise remove the unshipped poll `approvalWorkItemId` compatibility adapter. Poll approval is its own native Workflow approval and has no Todo identity.

## Private One-Off Offline Conversion

### Tool boundary

Implement the converter only after this plan is approved, under a repository-root location such as `tools/prerelease-todo-converter/`, outside `packages/jinn`. The npm package's `files` list already excludes it; `npm pack --dry-run` must prove that no converter source, fixture, manifest, or native helper ships.

The tool is generic and contains no installed-instance path, name, project, email, key, ID, or fixture data. It:

- defaults to `--dry-run`;
- has no HTTP/network/listen code and never connects to or starts the gateway;
- requires full gateway downtime, closed Todo tabs, no unresolved draft journal, and an exclusive offline lock;
- requires an external backup outside the installation root, independently reopened and verified with SQLite integrity plus cryptographic digests;
- accepts `--apply` only with the exact dry-run inventory digest and a separately recorded authorization;
- refuses malformed IDs, mixed identity sets, unknown schemas/JSON, unrecognized structured references, unsafe files, nonterminal executable ambiguity, or a changed inventory;
- writes counts and SHA-256 digests only. The old-to-new map exists only in memory/temporary tables and is dropped before completion.

No conversion is run as part of implementation or review. Applying it to the private instance is a later operator decision.

### Deterministic map

Require every source key to match `^wi_[0-9a-f]{12}$`, reject any existing `JIN-N`, then sort by:

```sql
ORDER BY created_at COLLATE BINARY, id COLLATE BINARY
```

Assign `JIN-1..JIN-N`. The unique old keys make this a total order even when timestamps tie. Preserve every Todo version, status, timestamp, approval, source, source reference, and non-identity byte.

### Authoritative structured graph

The converter full-scans and schema-validates this closed graph:

In a recognized structured Todo field, a source ID present in the deterministic map is rekeyed; an exact legacy ID absent from the map is an orphan and aborts. No structured source value is preserved merely because its Todo row is missing.

| Location | Treatment |
|---|---|
| `work_items.id` | Rekey to the actual checked primary key |
| `work_item_events.work_item_id` | Rekey; preserve event ID/order/detail bytes |
| `sessions.work_item_id` | Rekey every non-null edge |
| `sessions.source_ref` and `session_key` exactly `delegation:<old>` | Rekey, including matching `queue_items.session_key` |
| `sessions.transport_meta.delegationCompletionContract.workItemId` | Rekey linked, detached, and duplicated contracts |
| Manager-visibility callbacks | Rekey `source_attempt=manager-visibility:<old>`, `payload.meta.workItemId`, the proven server-authored Todo line, and live queue/message copies |
| Todo chat block | Rekey coupled `id=todo:<old>`, `payload.todoId`, receipt ID, and recognized message meta |
| Delegation chat block | Rekey coupled `id=dg-<old>`, `payload.workItemId`, receipt ID, and every duplicate copy |
| Synthetic `messages.id=block-${block.id}-${uuid}` | Directly rekey the recognized prefix, preserve UUID, preflight collisions, and update `callback_deliveries.message_id` or any other exact mutable reference in the same SQLite transaction |
| `work_item_edit_receipts` | Clear this prerelease replay cache after proving downtime/no pending draft; record count/digest only |
| Todo `activity_events`, if present | Under the one-off migration exception, rekey recognized object/href/link/detail/detail-ref/correlation/root/idempotency identity fields, recompute payload/story hashes where inputs changed, rebuild projections, and reinstall immutability triggers; preserve event IDs, sequence, timestamps, labels, summaries, and prose; refuse any exact legacy literal in an unrecognized structured shape |

Accepted callbacks must be either fully projected to the correct target message and queue row or an accepted all-absent tombstone after supported session deletion. Every partial-presence or cross-owned permutation aborts. Accepted rows are rekeyed as part of the explicit prerelease conversion; no presentation alias is added.

For pending/running arbitrary queue prompts, any exact legacy literal outside the recognized server-owned manager-visibility shape blocks conversion until the operator settles, cancels, or reviews it. Completed/cancelled prompt text is inert history. Duplicated sessions are scanned independently because they can contain detached contracts, blocks, or metadata without `sessions.work_item_id`.

### Session field classification

- **Todo identity:** `work_item_id`; exact delegation routing keys; the completion contract; enumerated block/meta/callback fields above.
- **Prose:** `title`, `prompt_excerpt`, `last_error`, ordinary message content, terminal queue content, callback display/error text, event detail prose, tool output, labels, and summaries. Preserve them exactly; do not sanitize literals.
- **Other namespaces:** connector, `reply_context`, connector `message_id`, engine/native session IDs, callback session/queue IDs, parent/workflow/run IDs, nonmatching `source_ref`, and approval references. Preserve them even if their spelling coincidentally resembles a legacy Todo ID.

### Workflow artifacts and descriptor-safe inventory

Do not trust `_active-index.json` as status authority. From the explicit evidence root, inventory bounded expected files and handle recognized Todo structure as follows:

- `reports/runs/<workflow>/<run>.json`: `running` (including `stopping`), `parked`, and `dispatched` are nonterminal. Any exact legacy literal in their executable bytes blocks conversion. In terminal `completed`/`failed`/`cancelled` files, rekey only recognized `triggerTodoId` and typed Todo-status `trigger.payload.todoId`; preserve prose.
- `reports/run-idempotency/*.json`: an exclusive claim with no corresponding run, corrupt linkage, or a linked nonterminal run is nonterminal executable state; any exact legacy literal blocks conversion. Only a claim linked to a recognized terminal run may have its typed Todo-status payload rekeyed and request fingerprint recomputed. The filename remains keyed by Workflow/principal/idempotency identity.
- `workflow-triggers/triggers.json`: remove obsolete `approvalWorkItemId`, reset affected prerelease poll approval to native pending approval, and rekey a custom-trigger filter only when its schema explicitly compares `payload.todoId` to a mapped Todo.
- `workflows/*.definition.json`: rekey a Workflow condition only when its schema explicitly compares `trigger.payload.todoId` to a mapped Todo. Any exact legacy literal in active prompt/instructions blocks for operator editing; retired prose stays inert.
- Legacy Workflow `state.json`, `.workflow.yaml`, and wave `currentItem` fields use Workflow item terminology, not Todo identity; do not rewrite them without a recognized typed Todo field.
- `workflow_todo_event_claims` references event IDs, not Todo IDs; rekeying `work_item_events.work_item_id` is sufficient.

Referenced and orphaned staged poll scripts under the explicit poll-artifact root are inventoried but never executed or auto-rewritten. Verify the stored digest and parse the allowlisted static output. Any exact legacy literal in executable output blocks until the source is edited and the poll is authenticated/reapproved.

For Workflow and staged poll reads, use descriptor-relative no-follow traversal from retained descriptors for each configured root and every parent component. Open each component with directory-only/no-follow semantics, then open/fstat/bounded-read the leaf relative to the pinned parent. Reject symlinks, special files, unexpected names/suffixes/temp/orphans, oversize files, identity drift, and parent ABA swaps. Node lacks portable `openat`; the non-shipped converter may use a tiny reviewed POSIX helper and must refuse unsupported platforms. There is no path-based fallback and no native-transcript traversal work.

### Apply, validation, seal, and recovery

1. Stop the gateway; verify no live gateway PID/listener without making an HTTP request; close Todo tabs and prove no unresolved draft/edit operation.
2. Capture and independently verify an external backup of the database, WAL state, Workflow evidence root, and referenced poll metadata/artifacts. Rehearse restore into a disposable location.
3. Run dry-run twice; require identical inventory/map/file digests and counts.
4. Prestage the rewritten Workflow evidence tree in a same-filesystem sibling, fsync it, and write a digest-only crash journal.
5. Under one exclusive SQLite transaction, build the temporary map, rewrite the complete DB graph, install/seed the JIN allocator and burns, clear derived edit receipts, validate hashes/references/counts, drop the map, and commit once.
6. Atomically swap the prestaged Workflow evidence root, leave poll scripts unchanged/disabled as required, then run the closed scan and SQLite validation again. A crash before completion remains offline and is resumed from the staged journal or restored from the external backup; it is never served mixed.
7. Validate zero unresolved structured source IDs, exact JIN grammar, referential consistency, Todo/event invariants, Activity hashes/projections, accepted callback states, direct message-PK references, allocator high-water/burns, and `PRAGMA integrity_check`.
8. Write and fsync a digest-only `conversion-complete` record outside the database. A separate offline `seal-before-start` operation writes an external durable served seal immediately before the first new-binary start; neither operation contacts the gateway.
9. Before the served seal, failure may restore the verified legacy backup. After the seal, reverse rekey, legacy restore, and allocator reseed are forbidden; repair starts from the current JIN database/files and preserves every post-start write and burn.
10. Start the new binary only after independent review of the evidence and separate operator authorization. The converter itself never starts it.

## RED → GREEN Implementation Sequence

Each task begins with a focused failing test, proves the intended failure, makes the smallest change, reruns focused tests, and then runs proportionate package verification. Implementation remains unauthorized in this architecture commit.

### Task 1 — Clean identity, schema, allocator, and startup refusal

**Files:** add `work-items/id.ts` and `work-items/allocator.ts`; modify `work-items/migrate.ts`, `work-items/store.ts`, `sessions/registry.ts`; add focused work-item/storage tests.

**RED:** canonical/legacy/near-match/overflow grammar; public `0.25.0`-shape DB creates fresh JIN tables; exact current schema restarts; empty recognized prerelease schema replaces; every nonempty/mixed/unknown prerelease combination aborts before WAL/schema mutation; 16/32-process allocation uniqueness; failure/race burn; restart/delete/archive nonreuse; direct SQL allocator/ledger attacks.

**GREEN:** strict primary key, one parser, pre-mutation startup inventory, unsupported-prerelease diagnostic, and permanent-burn multi-process allocation.

### Task 2 — API, MCP, web, search, Workflow edge, and authorization

**Files:** modify Todo REST/MCP/delegation tools, auth tests, `work-items/workflow-event-feed.ts`, `workflows/todo-status-trigger.ts`, `workflows/run-store.ts`, poll compatibility code, `web/src/main.tsx`, `web/src/lib/todos.ts`, Todo page/hooks/rows/detail/draft state, and company activity cards; delete private-ref machinery/tests.

**RED:** every Todo ingress rejects exact legacy/malformed identity with no side effect; typed Workflow Todo-status rejects before claim/run/file/session work; generic webhook/poll/manual prose remains inert and cannot resolve a Todo; deep-link/reload/back/forward/search/copy/share/a11y/DOM/storage all use JIN; private resolver/salt absent; anonymous known/unknown IDs fail identically; unauthorized adjacent mutation/delegation/approval fails while authorized roles succeed.

**GREEN:** direct canonical surfaces, no compatibility adapters, and auth/authz independent of predictability.

### Task 3 — Generic non-shipped converter

**Files:** add only root `tools/prerelease-todo-converter/` sources, native descriptor helper, fixtures, and tests; do not add imports from `packages/jinn` runtime or package files.

**RED:** shuffled/tied deterministic maps; malformed/mixed/unknown schemas and orphan structured IDs; linked plus duplicated/detached session graph; pending/dead/accepted/tombstone callbacks; every partial corruption; Todo/delegation blocks and direct message-PK rekey; edit-receipt clearing; Activity rewrite/hash/projection; exact-legacy-bearing nonterminal Workflow omitted from active index; terminal structured rekey with byte-identical prose; terminal claim fingerprint plus orphan/unpublished claim refusal; poll approval reset; referenced/orphan staged scripts; symlink leaf, parent ABA, special/oversize files; changed dry-run digest; non-dry-run default refusal.

**GREEN:** default-dry-run, digest-only, offline converter with one SQLite transaction, staged root swap, closed schema graph, descriptor-relative reads, and no runtime alias.

### Task 4 — Disposable rehearsal and independent review

**Files:** converter/rehearsal tests and this plan only if audit findings require an amendment.

**RED/GREEN evidence:** build a generic prerelease fixture from current schemas; run dry-run twice; verified external backup/restore rehearsal; fault injection before/after DB commit and evidence-root swap; pre-seal restore; post-seal restore refusal; forward repair preserving a newly allocated ordinal; second conversion refusal/no-op; `npm pack --dry-run` proves converter absence; repo privacy scan passes.

The real private database is not opened or converted during this task. A reviewer who did not implement the converter must approve its code, graph, fixture evidence, and runbook before the operator is asked for conversion authorization.

### Task 5 — Full first-release verification

Run focused suites first, then:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Also verify npm registry/tag history again, inspect the packed tarball, scan source/tests/templates for legacy producers or private Todo refs, test cross-instance import refusal, and run browser coverage for canonical route/search/copy/a11y plus auth enumeration. Publication remains a separate action.

## Implementation and Release Gates

Stop implementation/release if:

- public history contradicts the not-shipped premise;
- public startup needs to understand nonempty legacy data;
- any runtime alias, private Todo ref, or secondary Todo identity is proposed;
- a structured reference in the private converter is unclassified or cannot be updated/refused safely;
- a nonterminal Workflow can execute any exact prerelease Todo reference after conversion;
- the converter cannot pin filesystem ancestry or produce a stable digest-only inventory;
- allocation can decrease, skip its burn evidence, or reuse a committed ordinal;
- predictable IDs change authentication/authorization behavior;
- draft/edit state could be silently lost;
- the converter enters the npm tarball;
- conversion of the real private instance lacks a fresh explicit operator authorization.

## Current-Code Audit Scope

The simplified boundary was checked against current:

- storage/allocation/startup: `work-items/migrate.ts`, `store.ts`, `workflow-event-feed.ts`, `sessions/registry.ts`;
- API/MCP/auth/delegation/activity blocks: `gateway/api.ts`, `gateway/server.ts`, `gateway/manager-visibility.ts`, `gateway/chat-activity.ts`, MCP Todo/delegation/session tools;
- sessions/callbacks/messages/duplication: `sessions/registry.ts`, `sessions/callbacks.ts`, `sessions/delegation-completion-contract.ts`;
- Workflow typed Todo edge and prerelease fields: `workflows/todo-status-trigger.ts`, `run-store.ts`, `run-reconciler.ts`, `condition.ts`, `custom-triggers.ts`, `poll-trigger.ts`, `poll-artifacts.ts`;
- Activity integrity: `activity/migrate.ts`, `store.ts`, `payload.ts`, `identity.ts`, `projection.ts`, `query.ts`;
- web route/private-state/search/copy surfaces: `web/src/main.tsx`, `web/src/lib/todos.ts`, Todo route modules, and company activity cards;
- release proof: npm registry metadata/tarballs, Git tags/history, `CHANGELOG.md`, and packaged workspace migrations.

This v6 intentionally removes customer migration states, release epochs, mixed-version protocols, transcript/content sanitizers, permanent Activity presentation tables, opaque message refs, DOM masking, import remapping, and normal-runtime descriptor scanners. What remains is the clean first release plus one bounded private conversion runbook.
