# Migration: 0.27.0 — Separate Workflow Runs from Todos and Sessions

## Summary

This release makes the company model unambiguous: Todos are deliberately
authored, tracked work; Workflows are reusable procedures; and Workflow runs
are durable execution records of those procedures. A Workflow invocation never
creates, links, transitions, approves, or mutates a Todo. Workflow runs are not
Sessions.

You are updating a user-owned, personalized instance. Reconcile the semantics
in place. Preserve custom employee names, org structure, secrets, unrelated preferences,
project instructions, connector details, and any other unrelated
user-authored content. Do not replace a whole manual, doctrine file, org guide,
or skill with the stock template.

The fresh-install references are in the same read-only template tree:
`../../CLAUDE.md`, `../../docs/company-doctrine.md`, `../../docs/org.md`,
`../../skills/todo-handling/SKILL.md`, and
`../../skills/workflow/SKILL.md`. Use them for semantic comparison only.

## Reconcile the operating guidance

Update equivalent sections in the instance's `CLAUDE.md` and, only when it is
an independent regular file rather than the normal symlink, `AGENTS.md`.
Semantically merge the same contract into customized copies of
`docs/company-doctrine.md`, `docs/org.md`,
`skills/todo-handling/SKILL.md`, and `skills/workflow/SKILL.md`:

- Todos are deliberately authored work records. A Workflow invocation never
  creates, links, transitions, approves, or mutates a Todo.
- A Todo-status trigger is a one-way input; the resulting Workflow run is
  independent. The immutable event and Todo id are provenance, not ownership.
- Workflow runs are durable execution records, not Sessions.
- A verified MCP Session invocation persists exactly one
  `invocation: { sessionId, reportMode }` relation. That one relation means the
  run belongs to, reports to, and resumes the same Session unless `reportMode`
  is `silent`.
- `reportMode: "silent"` suppresses only Session resumption. It does not remove
  the invocation relation, run evidence, status, or activity receipt.
- Browser, CLI, cron, webhook, poll, and Todo-status starts are invocation-less
  unless a verified Session invokes them.
- Human gate decisions use the Workflow run approval surface, never Todo
  approval tools. `cancel_workflow_run` cancels a run and its run-owned phase
  sessions without touching a Todo.
- Mutating Workflow tools return bounded activity receipts for the invoking
  chat; use Preview/Open rather than inventing duplicate status prose.

Remove or rewrite stale stock guidance that describes a mirrored Workflow Todo,
an automatically minted run Todo, a Todo that owns or records each live run, a
run-owned Todo transition, or the removed `todoTransition` authoring field. Do
not remove unrelated, user-authored Todo procedures.

## Preserve historical evidence

The historical Workflow-source Todos remain ordinary audit records. Leave them
untouched: do not delete them, change their status, relink them, or reinterpret
them as live Workflow runs. New Workflow invocations do not continue that old
coupling.

The historical `engine: "workflow"` Sessions remain untouched, read-only historical evidence.
They are excluded from focused, status, and live-engine treatment and
redirect through their existing Workflow provenance. Do not delete, rewrite,
resume, or backfill them merely to make them look like current runs.

## Preserve delivery compatibility

`callback_deliveries` remains the sole generalized delivery store. Its current
operator requeue and dead-letter surfaces remain the supported recovery path.
Do not create a Workflow delivery store, add a parallel Workflow delivery
lifecycle, rename the table, or rewrite delivery history during this guidance
migration.

## Merge rules

- Preserve personalized wording when it already expresses the locked contract.
- Edit the smallest relevant section; never overwrite a personalized file with
  a template copy.
- Remove only contradictory Workflow–Todo coupling guidance. Preserve custom
  names, organization details, credentials references, preferences, and
  unrelated procedures.
- Do not mutate runtime Todos, Workflow runs, Sessions, delivery rows, secrets,
  connectors, cron jobs, or unrelated config values. The version marker below
  is the only config change in this semantic migration.
- Work only inside the instance folder and report every file changed.

## Version marker

After applying, the instance's `config.yaml` `jinn.version` should read
`"0.27.0"`. If launched by `jinn migrate --apply`, Jinn stamps this after the
migration succeeds; otherwise the user runs `jinn migrate --mark-done 0.27.0`.

## Report

Summarize which doctrine and skill sections were reconciled, which stale
Workflow–Todo coupling statements were removed, what personalized content was
preserved, and confirm that no runtime record or delivery lifecycle was
changed.
