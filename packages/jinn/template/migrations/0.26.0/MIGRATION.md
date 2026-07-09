<!--
  RELEASE ENGINEER: this migration is versioned 0.26.0 as the expected next
  minor after 0.25.0 (the autonomy surface is a feature release). If the release
  that ships this surface lands under a DIFFERENT version, rename this directory
  to match that version before publishing — `jinn migrate` only surfaces a
  migration once the package version reaches the directory's version.
-->

# Migration: 0.26.0 — Company Autonomy Surface (Todos, Workflows, MCP-as-hands)

## Summary

This release reframes the instance around the **company metaphor as the API**:
Employees, Todos, Workflows, and Triggers are the public model, and the **Jinn
MCP is every employee's primary hands** for company state. Workflows are on by
default with a workflow evidence root, the MCP tool belt is the default
operating surface (shell/filesystem drops to implementation-only), and the
`CLAUDE.md`/`AGENTS.md` doctrine gains anti-bottleneck escalation, the Todo
ledger, Workflows-vs-Todos separation, persistent-delegation discipline, and
bounded autonomy.

You are updating a **user-owned, customized instance**. Merge these changes into
whatever the user already has — preserve their edits, append what's new, never
delete their content.

## What changed on the instance surface

### `CLAUDE.md` and `AGENTS.md` (same content — apply to both)

The operating instructions gained new doctrine. For each item below, check
whether the user's file already has an equivalent section; if not, append it
(keep the user's existing section order, add new sections near the related org
content). If it exists but predates the autonomy surface, update the wording to
match while keeping any user-specific customizations.

- **Employees vs Sub-agents** — employees (via `spawn_session` / `delegate_task`)
  are org roles for cross-role, durable, reviewed work; sub-agents are the
  engine's ephemeral in-session parallel workers for your own legwork.
- **Todos** — the company's task ledger. Delegations, cron fires, and workflow
  runs enter it automatically; the COO creates one Todo per sub-task when
  decomposing a goal. Employees keep their own Todo current (`in_review` when
  finished, `blocked` with a reason, `escalated` only when a decision is needed)
  and never mark their own item `done` — the reviewer does.
- **Workflows** — reusable automations (the HOW). Todos and Workflows are
  separate: Todos record live work; Workflows define how recurring work runs.
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
  (org, sessions, delegation, Todos, Workflows, cron reads, reference reads,
  approvals, managed files). Local shell/filesystem access remains for
  implementation, diagnostics, and repository edits, but is no longer the
  default way to operate the company.

> The template ships neutral placeholders (`{{portalName}}`, `{{portalSlug}}`).
> When merging into the user's file, use the names their instance already uses —
> do not replace their COO/persona names with the raw placeholders.

### `docs/`

- **New file `docs/company-doctrine.md`** — the seven doctrine principles
  (KISS/Minecraft, the company metaphor is the API, anti-bottleneck, one
  interface (MCP), uniform contracts, lean identity context, progressive
  disclosure). Copy it in as-is if the user doesn't have it.
- **`docs/mcp.md`** — updated to describe the built-in Jinn company MCP belt
  (org, sessions, delegation, Todos, Workflows, cron, reference, approvals,
  managed files) alongside the browser/search/fetch servers. Merge the new
  sections; keep any user-added server config.
- **`docs/org.md`**, **`docs/overview.md`**, **`docs/self-modification.md`**,
  **`docs/cron.md`** — reference-doc refreshes for the company metaphor. These
  are not user-customized; apply the updates directly.

### `skills/`

- **`skills/management/SKILL.md`** — updated for the company metaphor: hiring,
  firing, and promotion now think in Employees/Todos/Workflows and route work
  through the MCP. Merge new instructions; preserve user customizations.
- **`skills/self-heal/SKILL.md`**, **`skills/cron-manager/SKILL.md`** — minor
  updates to match the MCP-as-hands surface.
- **`skills/migrate/SKILL.md`** — replaced: `jinn migrate` is now a
  version-aware migration-prompt dispenser (this file is the first prompt it
  ships). If the user hasn't customized their migrate skill, replace it with the
  new template version and ensure its symlinks exist.

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

After applying, the instance's `config.yaml` `jinn.version` should read
`"0.26.0"` (or the confirmed release version — see the note at the top of this
file). If you were launched by `jinn migrate --apply`, jinn stamps this for you;
otherwise the user runs `jinn migrate --mark-done 0.26.0`.

## Report

Summarize: which `CLAUDE.md`/`AGENTS.md` sections you added or updated, which
docs/skills you copied or merged, which config keys you added, any backups you
created, and the Hermes-rebuild reminder if applicable.
