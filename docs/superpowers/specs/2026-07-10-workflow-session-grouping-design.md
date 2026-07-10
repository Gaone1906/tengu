# Workflow Session Grouping Design

## Goal

Make every newly started workflow run visible as one top-level session-list parent, with each workflow-owned phase session attached as a child and carrying explicit workflow, run, trigger, and phase provenance. This change supplies backend data and grouping plumbing only; the chat-list visual treatment remains separate.

## Considered approaches

1. **First-class session provenance plus a synthetic run parent (selected).** Add additive session columns, hydrate them into one typed provenance object, and reuse `parentSessionId` plus the existing children endpoint. This is directly queryable, restart-safe, and gives the later UI work a stable contract.
2. **Parse `sourceRef` and create virtual groups in the client.** This avoids a database migration, but workflow names, phase labels, trigger sources, and phase indexes are absent. Parsing also makes the UI depend on an internal idempotency-key format.
3. **Create a separate workflow-session mapping table.** This is normalized and flexible, but duplicates session ownership/grouping data and requires new list joins and APIs where the existing parent/child model already fits.

## Data model

`Session.workflowProvenance` is a nullable typed object backed by additive columns on `sessions`:

- `kind`: `run` or `phase`
- `workflowId`: immutable definition id
- `workflowName`: canonical definition name, falling back to the id
- `runId`: durable workflow run id
- `triggerSource`: `manual`, `schedule`, or another typed trigger source
- phase-only fields: node id, label, one-based execution index, loop round, and attempt

The migration is nullable and does not rewrite legacy rows. An index on workflow run id supports direct provenance queries. Session search accepts workflow id, run id, and phase name filters.

## Parent lifecycle

The gateway wires the workflow driver's optional `syncRunSession` dependency. Every durable run save attempts to synchronize a deterministic parent session under `workflow-run:<runId>:parent`. Synchronization is best-effort and cannot fail workflow execution.

The parent title is `Workflow: <canonical-name> · run <run-id>`. Its session state mirrors the run:

- running/dispatched → `running`
- parked → `waiting`
- completed → `idle` with a succeeded attempt receipt
- failed → `error`
- cancelled → `interrupted`

The parent uses the existing web/list transport so it is discoverable by the current session list. It is an attribution/grouping record, not an engine conversation.

## Phase lifecycle

The workflow driver extends each fresh/shared-creation spawn context with canonical workflow name, trigger source, and one-based phase index. The gateway spawner ensures the parent exists, then creates the phase session with:

- `parentSessionId` set to the run parent
- phase provenance populated from the spawn context
- a deterministic title such as `[Workflow] daily-digest / REVIEW / r2`
- the unchanged deterministic phase `sessionKey`

Existing-session follow-up mode does not reparent a conversation the workflow does not own. Workflow-shared mode has one workflow-owned session created by its first phase; later phase turns remain attributable in the transcript through their existing turn markers.

## Recovery and consistency

Run evidence remains authoritative. The run file is saved before the synchronizer runs. A synchronizer failure is logged and retried on later run persistence or reconciliation. The phase spawner also ensures the parent as defense in depth, so a successfully spawned workflow-owned session cannot be parentless.

## API and list behavior

The ordinary session serialization includes provenance. `/api/sessions` continues to enumerate parent and phase records, while `/api/sessions/:id/children` enumerates all phase children for a run. The existing filtered session search can query `workflowId`, `workflowRunId`, or `workflowPhaseName` without parsing titles or keys.

## Testing

- Registry migration and round-trip tests prove provenance persistence, filterability, and child enumeration.
- Gateway grouping tests prove a manual by-name run and a cron/schedule run each create a visible parent and correctly attributed phase child.
- Driver tests prove spawn contexts carry canonical name, trigger source, and stable one-based phase index.
- Existing workflow/session suites, full tests, typecheck, lint, and build guard compatibility.

## Scope boundaries

- No chat-sidebar layout or interaction redesign.
- No changes to workflow execution order or phase prompting.
- No retroactive parsing/backfill of legacy phase sessions.
- No reparenting of `session.mode: existing` targets.
