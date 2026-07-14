# Instance migration bundle: 0.25.0 → 0.26.0

<!-- BEGIN RELEASE RATIONALE -->
# Migration: 0.26.0 — Company Autonomy Surface (Todos, Workflows, MCP-as-hands)

## Summary

This release reframes the instance around the **company metaphor as the API**:
Employees, Todos, Workflows, and Triggers are the public model, and the **Jinn
MCP is every employee's primary hands** for company state. Workflows are on by
default with a workflow evidence root, the MCP tool belt is the default
operating surface (shell/filesystem remains for implementation, diagnostics,
repository work, and maintenance gaps), and the
`CLAUDE.md`/`AGENTS.md` doctrine gains anti-bottleneck escalation, the Todo
ledger, Workflows-vs-Todos separation, persistent-delegation discipline, and
bounded autonomy.

You are updating a **user-owned, customized instance**. Merge these changes into
whatever the user already has: preserve every user-specific and operator-specific section,
append what is genuinely new, and never replace the whole manual with the template.

The canonical 0.26.0 reference files ship in the same read-only template tree.
Paths in this note beginning with `../../` are relative to the migration's
template source directory printed above. In particular, `../../CLAUDE.md` is the
fresh-install reference manual; use it for comparison, not as an overwrite.

## What changed on the instance surface

### `CLAUDE.md` and `AGENTS.md` (one canonical manual)

CLAUDE.md is canonical. `AGENTS.md` is normally a symlink to it, so edit only
`CLAUDE.md` when that link is intact. If `AGENTS.md` is an independent regular
file, apply the same doctrine reconciliation to both while preserving each
file's user customizations. Never replace either whole file with
`../../CLAUDE.md`.

The operating instructions gained new doctrine. For each item below, check
whether the user's file already has an equivalent section; if not, append it
(keep the user's existing section order, add new sections near the related org
content). If it exists but predates the autonomy surface, update the wording to
match while keeping any user-specific customizations.

- **Employees vs Sub-agents** — employees (via `spawn_session` / `delegate_task`)
  are org roles for cross-role, durable, reviewed work; sub-agents are the
  engine's ephemeral in-session parallel workers for your own legwork.
- **Selection/reuse doctrine** — apply the same "Select by fit" rule to both
  installed `CLAUDE.md` and `AGENTS.md`: pick by role/persona fit, reuse the
  relevant employee for parallel child sessions instead of spreading to
  unrelated employees, and propose a hire if none fits.
- **Manager-aware skip-level delegation** — prefer routing through managers.
  Direct skip-level delegation remains allowed when it is faster, but the IC's
  manager is notified so the manager retains visibility; hierarchy is advisory
  and does not block or reroute direct access.
- **Todos** — the company's task ledger. Delegations and employee-targeted cron
  fires enter it automatically; Workflow invocations do not. The COO creates
  one Todo per sub-task when decomposing a goal. Employees keep their own Todo current (`in_review` when
  finished, `blocked` with a reason, `escalated` only when a decision is needed)
  and never mark their own item `done` — the reviewer does.
- **Workflows** — reusable automations (the HOW). Todos and Workflows are
  separate: Todos record live work; Workflows define how recurring work runs.
- **Triggers** — durable bindings that wake Workflows. Keep the wake-up binding
  separate from the Workflow procedure and independently authored Todos. Inspect
  them with `list_triggers`; use `create_trigger` only for supported webhook or
  poll bindings. Configure schedule and `todo-status` wake-ups through the
  Workflow definition.
- **Anti-bottleneck escalation** — fresh work must NOT ping the operator by
  default. Employees handle their lane; questions and approvals route to a
  manager/COO; the operator is reserved for money, irreversible, public, or
  legal/security matters, or an explicit COO escalation.
- **Persistent Delegation / Drive to Completion**, **Refinement Loop**,
  **Orchestration Default**, **Bounded Autonomy** — the delegation discipline:
  outcome-first briefs, explicit `DONE`/`BLOCKED` self-reports, per-effort round
  caps (low 4 / medium 8 / high 12), reviewer-signs-off, and an explicit stop
  condition + budget for every autonomous or long-running run.
- **Company Operations Surface / Self-Modification via MCP** — the Jinn MCP
  tools are the default surface for company operations and company-state changes
  (org, sessions, delegation, Todos, Workflows, Triggers, cron reads, reference reads,
  approvals, managed files). Local shell/filesystem access remains for
  implementation, diagnostics, and repository edits, but is no longer the
  default way to operate the company.

### Replace stale stock doctrine without deleting custom content

Reconcile the old stock passages in place; do not append contradictory rules:

- **Boards → Todos:** replace legacy board-first tracking (`board.json`,
  `todo -> in_progress -> done`, or executive board visibility) with the Todo
  ledger rules above. Preserve unrelated project boards if the user explicitly
  uses them for a separate application; they are simply not Jinn's company work
  ledger.
- **Raw HTTP → MCP tools:** replace any raw-HTTP-first child-session protocol
  (`POST /api/sessions`, `GET /api/sessions/{id}`, message POSTs, or busy
  polling) with `spawn_session` / `delegate_task`, `read_session`, and
  `send_to_session`. Keep the callback-and-end-turn discipline and poll only as
  fallback after a missed callback.
- **Self-modification:** replace blanket "edit any workspace file" primacy with
  Jinn MCP tools and relevant skills for company-state changes. Retain local
  shell/filesystem access for implementation, diagnostics, repository work, and
  maintenance gaps where no MCP/company tool exists.
- **Gateway endpoint tables:** raw HTTP endpoints may remain only as a clearly
  labeled web-UI/platform-maintenance fallback. They must not be the normal
  employee operating surface.
- **Obsolete service menu:** remove the old stock `Cross-Department Services`
  claims about `org/service` tools, automatic request routing, or an injected
  service menu; that public MCP surface does not exist. Preserve any genuinely
  user-authored service procedures, but do not present them as built-in Jinn
  behavior.

> The template ships neutral placeholders (`{{portalName}}`, `{{portalSlug}}`).
> When merging into the user's file, use the names their instance already uses —
> do not replace their COO/persona names with the raw placeholders.

### `docs/`

The read-only 0.26.0 references are `../../docs/company-doctrine.md`,
`../../docs/mcp.md`, `../../docs/org.md`, `../../docs/overview.md`,
`../../docs/self-modification.md`, and `../../docs/cron.md`. Copy a missing file
or merge the relevant sections into an existing customized file; never assume a
user-owned doc is unmodified.

- **New file `docs/company-doctrine.md`** — the seven doctrine principles
  (KISS/Minecraft, the company metaphor is the API, anti-bottleneck, one
  interface (MCP), uniform contracts, lean identity context, progressive
  disclosure). Copy it in as-is if the user doesn't have it.
- **`docs/mcp.md`** — updated to describe the built-in Jinn company MCP belt
  (org, sessions, delegation, Todos, Workflows, Triggers, cron, reference, approvals,
  managed files) alongside the browser/search/fetch servers. Merge the new
  sections; keep any user-added server config.
- **`docs/org.md`**, **`docs/overview.md`**, **`docs/self-modification.md`**,
  **`docs/cron.md`** — reference-doc refreshes for the company metaphor. Merge
  the current sections while preserving any local additions.

### `skills/`

The read-only references are `../../skills/management/SKILL.md`,
`../../skills/self-heal/SKILL.md`, `../../skills/cron-manager/SKILL.md`,
`../../skills/migrate/SKILL.md`, `../../skills/todo-handling/SKILL.md`, and
`../../skills/workflow/SKILL.md`. Merge them like other user-owned files.

- **`skills/management/SKILL.md`** — updated for the company metaphor: hiring,
  firing, and promotion now think in Employees/Todos/Workflows and route work
  through the MCP. Merge new instructions; preserve user customizations.
- **`skills/self-heal/SKILL.md`**, **`skills/cron-manager/SKILL.md`** — minor
  updates to match the MCP-as-hands surface.
- **`skills/migrate/SKILL.md`** — replaced: `jinn migrate` is now a
  version-aware migration-prompt dispenser (this file is the first prompt it
  ships). If the user hasn't customized their migrate skill, replace it with the
  new template version and ensure its symlinks exist.

### Separate Workflow runs from Todos and Sessions

This release makes the company model unambiguous: Todos are deliberately
authored, tracked work; Workflows are reusable procedures; and Workflow runs
are durable execution records of those procedures. A Workflow invocation never
creates, links, transitions, approves, or mutates a Todo. Workflow runs are not
Sessions.

Semantically merge this contract into customized copies of `CLAUDE.md` and,
only when it is an independent regular file rather than the normal symlink,
`AGENTS.md`. Reconcile the same wording in `docs/company-doctrine.md`,
`docs/org.md`, `skills/todo-handling/SKILL.md`, and
`skills/workflow/SKILL.md`:

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

#### Preserve historical evidence

The historical Workflow-source Todos remain ordinary audit records. Leave them
untouched: do not delete them, change their status, relink them, or reinterpret
them as live Workflow runs. New Workflow invocations do not continue that old
coupling.

The historical `engine: "workflow"` Sessions remain untouched, read-only historical evidence.
They are excluded from focused, status, and live-engine
treatment and redirect through their existing Workflow provenance. Do not
delete, rewrite, resume, or backfill them merely to make them look like current
runs.

#### Preserve delivery compatibility

`callback_deliveries` remains the sole generalized delivery store. Its current
operator requeue and dead-letter surfaces remain the supported recovery path.
Do not create a Workflow delivery store, add a parallel Workflow delivery
lifecycle, rename the table, or rewrite delivery history during this guidance
migration.

Preserve custom employee names, org structure, secrets, unrelated preferences,
project instructions, connector details, and every other unrelated piece of
user-authored content while reconciling these semantics. Do not mutate runtime
Todos, Workflow runs, Sessions, delivery rows, secrets, connectors, cron jobs,
or unrelated config values.

### Config

- **Workflows need NO config change.** Workflows are on by default and their
  evidence root resolves automatically: the gateway uses
  `<JINN_HOME>/workflow-evidence` (created lazily, with its `workflows/`
  subdir) unless the `JINN_WORKFLOW_EVIDENCE_ROOT` environment variable points
  elsewhere. There is no `workflows:` / evidence-root key in `config.yaml` —
  **do not add one** (it would be inert and misleading). Only set the env var if
  the user wants the evidence stored outside their instance folder.
- If a later note introduces a genuine new config key, add it with its default
  and leave all existing user values untouched. This release adds none.

### Engine note (no instance file change)

- **Hermes 0.17.1** — if this instance uses the Hermes engine, its native
  binary/bridge may need a rebuild after upgrading. This is an operator action,
  not a file edit: no instance file needs changing for it. Mention it in your
  report so the user rebuilds Hermes if they run it.

## Merge rules (reminder)

- Preserve every user customization. When a section exists in both, keep the
  user's version unless this note says to replace it.
- Append new sections; never delete user content. Back up any file before a
  non-trivial edit (`<file>.pre-migration.bak`).
- Work only inside the instance folder.

## Version marker

Do not advance `config.yaml` from an engine exit code or from merely finishing
the edits. After verification, write the canonical completion receipt beside
the verified snapshot, covering every reviewed or skipped manifest path. Only
then run the exact keyed `jinn migrate --mark-done 0.26.0 --migration-key …`
command from the automatic migration prompt. Failed or interrupted work must
leave `jinn.version` unchanged.

## Report

Summarize: which `CLAUDE.md`/`AGENTS.md` sections you added or updated, which
docs/skills you copied or merged, which stale Workflow–Todo coupling statements
you removed, which config keys you added, any backups you created, what
personalized content you preserved, and the Hermes-rebuild reminder if
applicable. Confirm that no runtime record or delivery lifecycle was changed.
<!-- END RELEASE RATIONALE -->

This file is generated. The manifest is authoritative; each record below appears exactly once.
The payload paths below are generic package sources. Before review, the gateway creates audited, read-only materialized base payload and materialized target payload copies beneath the instance migration snapshot using that instance's exact template replacements.
Perform the three-way merge only from those materialized snapshot payloads and the current user-owned instance file. Never apply a raw generic payload or copy an unresolved placeholder into the instance. Preserve user customizations and never delete user content without explicit review and a snapshot.

## `CLAUDE.md`

- Operation: `modify`
- Base payload: `files/base/CLAUDE.md`
- Target payload: `files/target/CLAUDE.md`
- Merge instruction: compare the audited materialized base with the current instance path `CLAUDE.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `docs/company-doctrine.md`

- Operation: `add`
- Base payload: none (file did not exist)
- Target payload: `files/target/docs/company-doctrine.md`
- Merge instruction: compare the audited materialized base with the current instance path `docs/company-doctrine.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `docs/cron.md`

- Operation: `modify`
- Base payload: `files/base/docs/cron.md`
- Target payload: `files/target/docs/cron.md`
- Merge instruction: compare the audited materialized base with the current instance path `docs/cron.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `docs/mcp.md`

- Operation: `modify`
- Base payload: `files/base/docs/mcp.md`
- Target payload: `files/target/docs/mcp.md`
- Merge instruction: compare the audited materialized base with the current instance path `docs/mcp.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `docs/org.md`

- Operation: `modify`
- Base payload: `files/base/docs/org.md`
- Target payload: `files/target/docs/org.md`
- Merge instruction: compare the audited materialized base with the current instance path `docs/org.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `docs/overview.md`

- Operation: `modify`
- Base payload: `files/base/docs/overview.md`
- Target payload: `files/target/docs/overview.md`
- Merge instruction: compare the audited materialized base with the current instance path `docs/overview.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `docs/self-modification.md`

- Operation: `modify`
- Base payload: `files/base/docs/self-modification.md`
- Target payload: `files/target/docs/self-modification.md`
- Merge instruction: compare the audited materialized base with the current instance path `docs/self-modification.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/cron-manager/SKILL.md`

- Operation: `modify`
- Base payload: `files/base/skills/cron-manager/SKILL.md`
- Target payload: `files/target/skills/cron-manager/SKILL.md`
- Merge instruction: compare the audited materialized base with the current instance path `skills/cron-manager/SKILL.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/delegation/SKILL.md`

- Operation: `add`
- Base payload: none (file did not exist)
- Target payload: `files/target/skills/delegation/SKILL.md`
- Merge instruction: compare the audited materialized base with the current instance path `skills/delegation/SKILL.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/management/SKILL.md`

- Operation: `modify`
- Base payload: `files/base/skills/management/SKILL.md`
- Target payload: `files/target/skills/management/SKILL.md`
- Merge instruction: compare the audited materialized base with the current instance path `skills/management/SKILL.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/migrate/SKILL.md`

- Operation: `modify`
- Base payload: `files/base/skills/migrate/SKILL.md`
- Target payload: `files/target/skills/migrate/SKILL.md`
- Merge instruction: compare the audited materialized base with the current instance path `skills/migrate/SKILL.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/onboarding/SKILL.md`

- Operation: `modify`
- Base payload: `files/base/skills/onboarding/SKILL.md`
- Target payload: `files/target/skills/onboarding/SKILL.md`
- Merge instruction: compare the audited materialized base with the current instance path `skills/onboarding/SKILL.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/self-heal/SKILL.md`

- Operation: `modify`
- Base payload: `files/base/skills/self-heal/SKILL.md`
- Target payload: `files/target/skills/self-heal/SKILL.md`
- Merge instruction: compare the audited materialized base with the current instance path `skills/self-heal/SKILL.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/sync/SKILL.md`

- Operation: `modify`
- Base payload: `files/base/skills/sync/SKILL.md`
- Target payload: `files/target/skills/sync/SKILL.md`
- Merge instruction: compare the audited materialized base with the current instance path `skills/sync/SKILL.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/todo-handling/SKILL.md`

- Operation: `add`
- Base payload: none (file did not exist)
- Target payload: `files/target/skills/todo-handling/SKILL.md`
- Merge instruction: compare the audited materialized base with the current instance path `skills/todo-handling/SKILL.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/workflow/SKILL.md`

- Operation: `add`
- Base payload: none (file did not exist)
- Target payload: `files/target/skills/workflow/SKILL.md`
- Merge instruction: compare the audited materialized base with the current instance path `skills/workflow/SKILL.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.
