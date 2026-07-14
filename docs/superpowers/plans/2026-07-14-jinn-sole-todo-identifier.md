# Company-Prefixed Sole Todo Identifier — Final Architecture

> **Status:** Architecture only. Implementation requires a fresh independent review. This document does not authorize conversion, restart, release, deployment, or publication.

**Goal:** Ship Todos with a stable three-letter company prefix (`IC-IDEV` → `ICI-1`, `ICI-2`) as the sole identifier, while converting the operator's one private prerelease instance with a disposable offline tool that never enters the installed product.

## Locked Product Boundary

Operator decision A is accepted:

- `^[A-Z]{3}-[1-9][0-9]*$` is the only Todo grammar; suffixes above `Number.MAX_SAFE_INTEGER` are invalid. Normalize the configured company name with NFKD, discard non-`A-Z` characters after uppercasing, and take the first three letters (`IC-IDEV` → `ICI`). Names yielding fewer than three letters are invalid.
- The first committed allocation freezes the prefix in the singleton allocator. Later company-name changes never rewrite IDs or change that instance's prefix.
- `work_items.id` is the database primary key and the visible/internal ID in REST, MCP, UI, URLs, search, logs, accessibility, copy/share, DOM state, and browser storage.
- `JIN-N` is predictable, visible, and never authorization. Authentication and authorization protect every read and write.
- The prerelease grammar is exactly `^wi_[0-9a-f]{12}$`. Public ingress rejects it; no alias, redirect, private reference, secondary identity, or runtime map remains.
- A legacy literal in immutable or free-form prose is inert when no route, parser, resolver, condition, callback, or action treats it as an identity. It is not a hidden second identifier.
- Allocation is transactional across processes, monotonically burned before creation, and never reused. Permanent gaps are valid.

The next public release is the first Todo release and creates the clean model directly. Historical-text sanitizing and legacy import/remapping are out of scope.

## Proven Release-History Boundary

**npm/Git latest is `0.25.0` at `16bce273`/`v0.25.0`; no work-items schema exists there; `wi_*` schema first appeared in unpublished `2478ab83`; no `v0.26.0` tag.**

Verified on 2026-07-14:

- `npm view jinn-cli version dist-tags` returns `0.25.0`/`latest`; `jinn-cli@0.25.0` reports Git head `16bce2738317311482a44ec3807eca7cc3ce5de4`, equal to local `v0.25.0`.
- That tag has no `packages/jinn/src/work-items/`, `work_items` schema, Todo API/skill, or Todo workspace migration. Its npm tarball has no Todo implementation, and a scan of all 57 published versions through `0.25.0` found none.
- Commit `2478ab832fecaef46f67bbcf37229d2b5bf4af2c` first adds the `work_items` schema on 2026-07-08. It is not an ancestor of `v0.25.0`; the tag is its ancestor.
- The repository's staged `0.26.0` package/changelog state is unpublished and untagged.

This proves the public registry/tag boundary, not manually installed untagged builds. Recheck it immediately before publication. A contradiction blocks release; an unexpected nonempty Todo store is unsupported prerelease data, not a customer migration case.

## Two Physical Artifacts

| Boundary | Location | Contents |
|---|---|---|
| **Public, shipped** | `packages/jinn/src/**`, `packages/web/src/**`, compiled `dist/` | Clean company-prefix schema, parser, allocator, routes/surfaces, authorization, legacy-input rejection, and read-only startup refusal for nonempty prerelease data |
| **Private, disposable** | repository root `tools/prerelease-todo-converter/**` only | Generic offline inventory/conversion/rehearsal tool; excluded from package `files`, bins, templates, migrations, startup, and installed assets |

No public module imports the converter. It has no `jinn` command, runtime hook, network/listen code, or installed migration. `npm pack --dry-run` must prove it is absent. After the separately authorized private conversion, remove it from the release branch or archive it outside the shipped repository artifact.

## Public First Todo Release

### Identity, schema, and startup

Add `packages/jinn/src/work-items/id.ts` as the sole strict parser/formatter. Todo store, REST, MCP, delegation/approval/session tools, search-by-ID, and typed Workflow Todo fields call it before lookup or mutation. There is no legacy-to-current parser.

Before WAL mode or any schema write, startup opens the database read-only and classifies it:

1. Todo tables absent, as in every public `0.25.0` home: create the clean company-prefix schema and allocator.
2. Recognized prerelease Todo tables and every companion/reference are empty: transactionally replace them with the clean schema.
3. Exact current company-prefix schema: verify schema, the exact `work_items_id_immutable` trigger SQL, allocator prefix, burn ledger, and reference invariants, then continue.
4. Any nonempty legacy/mixed/noncanonical table or edge, malformed/unknown Todo schema, or allocator mismatch: close and abort before writes or serving.

The refusal does not echo data:

```text
Unsupported prerelease Todo data detected. This release cannot start or migrate it.
Use the separately reviewed offline converter, or restore a supported public-version backup.
```

Fresh creation installs:

- canonical-ID `CHECK` constraints and a singleton allocator containing the frozen nullable prefix plus high water;
- an append-only burn ledger containing ordinal plus a digest of a one-time random allocation claim, and a separate append-only issuance ledger;
- transactional `BEGIN IMMEDIATE` allocation that commits the burn and returns the raw claim only to that caller before Todo creation;
- an insert trigger that requires the ID prefix to match the frozen allocator prefix, the suffix to match its burn, no issuance marker to exist, and the connection-local raw claim digest to match; an after-insert trigger atomically appends the issuance marker;
- the exact `work_items_id_immutable BEFORE UPDATE OF id ON work_items` trigger, whose body unconditionally raises `ABORT`; there is no `WHEN` clause, so `SET id = id` also fails;
- immutable/decreasing/deleting allocator, burn, and issuance guards.

The raw claim is held only in memory for one create transaction and exposed to SQLite through a scoped registered function; ordinary/direct SQL sees no claim. Failure, crash, or lost idempotency race discards it, making the burn a permanent gap. Deleting a Todo leaves its issuance marker, so even a retained claim cannot recreate it. Burns, claims, and issuance markers are allocation evidence, not accepted or resolvable Todo identities. The private converter installs the same schema/triggers only after its rekey transaction.

### Product surfaces and authority

- REST may use `/api/work-items/ICI-42`; the browser route is `/todos/ICI-42`. MCP fields, search, logs, activity blocks, accessible names, Copy ID, and Copy Link emit the same value.
- Delete `todoPrivateRef`, salts, `td_*` history state, private lookup, DOM masking, and privacy-only fixtures. Draft/recovery state keys directly by canonical Todo ID, with clean-tab and no-draft-loss tests.
- The current CLI has no Todo CRUD surface; do not add one. A future CLI must use the same parser.
- Authentication precedes existence checks. Anonymous known/unknown IDs fail identically. Authenticated adjacent-ID reads and every mutation/delegation/approval are allowed only by existing explicit grants; predictability grants nothing.
- Cross-instance import remains refusal-only until a real import design exists.

### Workflow clean-model ingress

The typed relationship is only:

```text
work_item_events.work_item_id
  -> WorkflowTodoStatusEvent.workItemId
  -> todo-status trigger.payload.todoId
```

Validate the canonical company-prefixed ID at the event producer and before claim/run persistence, condition evaluation, or session creation. Remove unshipped `triggerTodoId` and poll `approvalWorkItemId` compatibility fields.

Webhook and poll ingress treat only an own top-level `payload.todoId` as recognized Todo structure. Check prototype safety before reading it: an inherited/prototype `todoId` is invalid; an own value must be a string accepted by `parseTodoId`. Perform this validation before custom-trigger filtering, `fireRef` or hash derivation, claims, run/file persistence, Workflow conditions, callbacks, queues, or sessions. Exact legacy IDs, malformed company-prefixed IDs such as `ICI-0`, garbage, non-strings, and inherited values fail closed with zero side effects.

An authored filter targeting `payload.todoId` may use only `equals` or `notEquals` with an own data-property `value` that is a string accepted by `parseTodoId`; valueless `exists` is also allowed. Reject `matches`, missing/inherited/accessor operands, and legacy, malformed, or non-string values. A condition targeting `trigger.payload.todoId` follows the same rule: only `eq` or `ne` may carry an own canonical string operand; valueless `exists` and `absent` are allowed; reject `gt`, `gte`, `lt`, `lte`, `contains`, `startsWith`, and every invalid operand shape/value. Enforce these restrictions when authoring/persisting the filter or definition and revalidate fail-closed immediately before execution, so malformed persisted artifacts cannot run. Unrelated payload fields—including free-form prose containing an exact `wi_*` literal—are untouched inert data.

## Private Disposable Converter

### One complete fail-closed slice

No apply entry point may exist until one complete vertical slice has landed and passed tests: read-only inventory, deterministic mapping, every permitted structured rewrite, the Activity refusal gate, invariants, external backup verification, dry run, apply engine kept unreachable, and restore rehearsal. Partial table/file rekey functions are testable internally but cannot be invoked destructively.

The tool defaults to dry run, requires full gateway downtime and an exclusive lock, refuses any changed inventory or unknown shape, and emits counts plus SHA-256 digests only. It contains no personal data or installed-instance default path. Apply is added last and requires the exact repeated dry-run digest plus a separately recorded operator authorization. Implementation/review never opens the real private database.

Map exact source IDs by `created_at COLLATE BINARY, id COLLATE BINARY` to `<frozen-prefix>-1..<frozen-prefix>-N`; tied timestamps are resolved by unique legacy ID. The dry-run requires that explicit three-letter prefix. Reject malformed/mixed IDs, collisions, or structured orphan IDs. The map exists only in memory/temporary tables and is destroyed before completion.

### Closed structured graph

The inventory schema-validates and transactionally rekeys:

- `work_items.id`, `work_item_events.work_item_id`, and `sessions.work_item_id`;
- exact `delegation:<id>` session/source/queue routing keys;
- `transport_meta.delegationCompletionContract.workItemId`, including duplicated/detached sessions;
- manager-visibility callback attempt/meta/server-authored Todo fields and all live queue/message copies;
- Todo/delegation block IDs and payloads, activity receipt IDs/meta, synthetic `block-${block.id}-${uuid}` message primary keys, and exact callback/message references;
- accepted callbacks only when the complete projected tuple exists or every projected member is an accepted all-absent tombstone; partial/cross-owned states abort;
- `work_item_edit_receipts`, cleared as prerelease derived replay state only after downtime/draft checks;
- recognized terminal Workflow Todo-status fields and claims; every nonterminal run/claim containing an exact legacy literal aborts;
- active Workflow condition/filter Todo fields, while active prompt literals block for review and retired/terminal prose remains inert;
- referenced and orphan staged poll artifacts, which are never executed or auto-rewritten; any executable exact legacy literal blocks until edited, authenticated, and reapproved.

Session titles, prompt excerpts, errors, ordinary message/tool text, terminal queue text, callback display text, labels, and summaries are prose. Connector/reply IDs, engine/native session IDs, callback/queue/session IDs, parent/workflow/run IDs, and nonmatching source/approval references are other namespaces. Preserve both classes byte-for-byte even when they contain an inert literal.

Workflow and poll evidence traversal is converter-only: retain descriptors for each configured root; open every parent and leaf descriptor-relative with directory/no-follow checks; `fstat` bounded regular files; reject symlinks, special files, unexpected names, oversize data, or identity/parent swaps. A small reviewed POSIX helper may supply `openat`; there is no path-based fallback and no shipped scanner.

### Private Activity refusal gate

Current production code exposes Activity through `GET /api/activity` and `GET /api/activity/:storyId`; both reconstruct raw event fields. Current source has no production caller of `appendActivityEvent`, so the smallest contract is to require **zero affected Activity rows** in the private instance. The converter never rewrites Activity and product reads have no translation or legacy branch.

Dry run first asserts the exact expected Activity schema, selects every physical column, validates every scalar, decodes `detail_json` and `links_json`, and recursively inventories every nested key/value/link member. The exhaustive scan covers:

- event/derivation identity: `seq`, `id`, `story_id`, `correlation_id`, `causation_id`, `root_event_id`, `idempotency_key`, `payload_hash`;
- typed actors/objects/actions: `kind`, `action`, `actor_type`, `actor_id`, `object_type`, `object_id`, `object_href`, `detail_ref`, and every decoded structured `todoId`, `workItemId`, reference, and `href` in detail/link JSON;
- remaining scalar/prose fields: timestamps, display names, labels, outcomes, summaries, attempts, and decoded free-form values;
- derived `activity_stories`, `activity_story_versions`, and `activity_event_search` rows plus both REST list/story/search outputs.

An exact or recognized embedded prerelease Todo reference in any structured/actionable position is an affected row and blocks apply. Unknown schema, malformed JSON, an unclassifiable legacy-bearing field, projection mismatch, or API output containing a structured legacy Todo reference also blocks. The report contains only safe row locators, JSON paths, counts, and SHA-256 digests—never the value or a replacement map.

Exact legacy text in a field proven to be free-form prose is recorded only in aggregate/digest evidence and remains inert. With zero affected structured rows, require byte-identical digests for `activity_events`, every projection/search table, and all Activity immutability triggers before and after the disposable conversion. Add no Activity mutation code and never drop its triggers.

### Offline runbook

1. Stop the gateway without contacting port 7777; prove no process/listener, close Todo tabs, and prove no unresolved draft/edit operation.
2. Copy the database/WAL and bounded Workflow/poll roots to external storage; verify digests plus SQLite integrity and rehearse restoration into a disposable location.
3. Run dry run twice against the unchanged source; require identical inventory, map, file, and output digests.
4. After the Activity gate proves zero affected rows, stage rewritten Workflow evidence in a same-filesystem sibling. In one exclusive SQLite transaction, rekey the remaining complete DB graph, seed burns/high-water, install the final schema including `work_items_id_immutable`, validate, destroy the map, and commit. Activity tables and triggers are untouched. Atomically replace the staged evidence root only after DB validation.
5. Re-run the complete closed scan, exact ID-trigger schema audit, referential/callback/message/Workflow/allocator invariants, byte-identical Activity digests, and `PRAGMA integrity_check`. On any pre-start failure, remain offline and restore the verified backup.
6. Independent review approves digest-only evidence. The operator separately authorizes conversion of the real instance and, later, starting the new binary. The converter never starts it.

## RED -> GREEN Delivery Order

Implementation is unauthorized until this plan receives fresh approval.

### A. Public clean model complete and tested

**Shipped files:** `work-items/id.ts`, allocator/schema/store and focused tests; session startup preflight; REST/MCP/Workflow/auth modules; web Todo routes/components/state; deletion of private-ref code.

RED then GREEN: company normalization, strict grammar, prefix freeze across company rename, fresh and `0.25.0`-shaped homes; empty prerelease replacement; no-write refusal for every nonempty/mixed/unknown shape; startup refusal when the exact ID trigger is absent/altered; 16/32-process allocation; crash/race gaps; direct SQL valid-to-valid, same-value, prefix, and high-water/orphaning updates; mismatched-prefix/unclaimed/unburned/high-water inserts; reinsertion of a deleted ID; attempted insertion of an abandoned burn; allocator/burn/issuance mutation; archive/delete/nonreuse; every product surface; legacy ingress; webhook and poll cases for a valid company-prefixed ID, exact legacy, malformed prefix/suffix, garbage, non-string, inherited/prototype, absent, and prose-only values. Filter tests enumerate valid `equals`/`notEquals`, valueless `exists`, `matches`, and every missing/inherited/accessor/legacy/malformed/non-string operand; condition tests enumerate valid `eq`/`ne`, valueless `exists`/`absent`, every rejected `gt`/`gte`/`lt`/`lte`/`contains`/`startsWith`, and the same invalid operands. Valid controls proceed once; authoring rejection creates no persisted artifact, pre-execution rejection creates no run or downstream effect, and unrelated prose remains byte-identical and inert. Also verify authz/enumeration and browser route/copy/a11y/clean-tab/no-draft-loss.

### B. Disposable converter complete, dry-run only

**Private files:** only `tools/prerelease-todo-converter/**`; no bin/package/template/startup change.

Land the complete inventory/map/DB/file/Activity-gate/invariant/backup/restore vertical slice in one reviewable commit, but physically omit the apply entry point. Tests cover the entire closed graph, unknown/orphan/partial states, nonterminal Workflow and staged poll refusal, descriptor attacks, deterministic digests, unchanged prose, an empty/zero-row Activity fixture, a populated zero-affected fixture, and one affected-row refusal fixture for every structured Activity field/path (including `causation_id`) without emitting raw values.

### C. Rehearsal, then gated apply as the last private artifact

Run two identical dry runs, external backup verification, restore rehearsal, and a disposable conversion through a test-only in-process harness; inject faults before commit and evidence swap, validate the result, and run `npm pack --dry-run`. Only after all are green, add the digest-bound explicit `--apply` entry as the final converter change. The real instance remains untouched.

### D. Independent review and release verification

A reviewer who did not implement A-C audits code, the closed reference graph, Activity refusal gate, package boundary, fixtures, and evidence. Run focused suites, then `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`; recheck registry/tag history; inspect the tarball; leak-scan source/tests/templates; and verify no legacy producer, converter artifact, alias, private ref, or secondary Todo identity ships.

Only an approved review may authorize implementation completion. Live conversion and first start require a later, explicit operator authorization; release/publication is a separate decision.
