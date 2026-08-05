# Instance migration bundle: 0.29.0 → 0.29.1

<!-- BEGIN RELEASE RATIONALE -->
The hands-free Talk voice orchestrator is retired, so `talk/` is removed from the stock instance. Both files in it — `talk/orchestrator-persona.md` and `talk/card-reference.md` — instructed the instance's agents to POST to `/api/talk/*` endpoints that no longer exist, so leaving them in place keeps misdirecting every agent that reads them.

Both are user-editable. Snapshot each one and compare it against the audited materialized base payload before removing anything. If the instance copy differs from the base, do not delete it: preserve it and flag it for review, because the operator may have written persona or card guidance worth keeping elsewhere. Only a byte-identical copy is safe to remove without review.

Removing `talk/` does not affect read-aloud. `/api/tts`, the Kokoro engine, and push-to-talk dictation are unchanged, and the `talk.kokoro` config key keeps its name and its meaning, so no `config.yaml` edit is needed.

This bundle also carries the instance-surface updates that landed alongside the retirement: the compact, MCP-first operating doctrine and reference docs; connector-instance identity; the current delegation, management, Todo, Workflow, cron, onboarding, self-heal, and skill-discovery playbooks; and the workflow-trigger script convention under `scripts/workflow-triggers/`.

The Notes and Experiments skills are new stock capabilities. Add them when absent, but preserve any user-owned file already present at either path and flag a conflict instead of overwriting it.
<!-- END RELEASE RATIONALE -->

This file is generated. The manifest is authoritative; each record below appears exactly once.
The payload paths below are generic package sources. Before review, the gateway creates audited, read-only materialized base payload and materialized target payload copies beneath the instance migration snapshot using that instance's exact template replacements.
Perform the three-way merge only from those materialized snapshot payloads and the current user-owned instance file. Never apply a raw generic payload or copy an unresolved placeholder into the instance. Preserve user customizations and never delete user content without explicit review and a snapshot.

## `CLAUDE.md`

- Operation: `modify`
- Base payload: `files/base/CLAUDE.md`
- Target payload: `files/target/CLAUDE.md`
- Merge instruction: compare the audited materialized base with the current instance path `CLAUDE.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `docs/architecture.md`

- Operation: `modify`
- Base payload: `files/base/docs/architecture.md`
- Target payload: `files/target/docs/architecture.md`
- Merge instruction: compare the audited materialized base with the current instance path `docs/architecture.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `docs/company-doctrine.md`

- Operation: `modify`
- Base payload: `files/base/docs/company-doctrine.md`
- Target payload: `files/target/docs/company-doctrine.md`
- Merge instruction: compare the audited materialized base with the current instance path `docs/company-doctrine.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `docs/connectors.md`

- Operation: `modify`
- Base payload: `files/base/docs/connectors.md`
- Target payload: `files/target/docs/connectors.md`
- Merge instruction: compare the audited materialized base with the current instance path `docs/connectors.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

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

## `docs/skills.md`

- Operation: `modify`
- Base payload: `files/base/docs/skills.md`
- Target payload: `files/target/docs/skills.md`
- Merge instruction: compare the audited materialized base with the current instance path `docs/skills.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `scripts/workflow-triggers/README.md`

- Operation: `add`
- Base payload: none (file did not exist)
- Target payload: `files/target/scripts/workflow-triggers/README.md`
- Merge instruction: compare the audited materialized base with the current instance path `scripts/workflow-triggers/README.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/cron-manager/SKILL.md`

- Operation: `modify`
- Base payload: `files/base/skills/cron-manager/SKILL.md`
- Target payload: `files/target/skills/cron-manager/SKILL.md`
- Merge instruction: compare the audited materialized base with the current instance path `skills/cron-manager/SKILL.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/delegation/SKILL.md`

- Operation: `modify`
- Base payload: `files/base/skills/delegation/SKILL.md`
- Target payload: `files/target/skills/delegation/SKILL.md`
- Merge instruction: compare the audited materialized base with the current instance path `skills/delegation/SKILL.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/experiments/SKILL.md`

- Operation: `add`
- Base payload: none (file did not exist)
- Target payload: `files/target/skills/experiments/SKILL.md`
- Merge instruction: compare the audited materialized base with the current instance path `skills/experiments/SKILL.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/find-and-install/SKILL.md`

- Operation: `modify`
- Base payload: `files/base/skills/find-and-install/SKILL.md`
- Target payload: `files/target/skills/find-and-install/SKILL.md`
- Merge instruction: compare the audited materialized base with the current instance path `skills/find-and-install/SKILL.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/management/SKILL.md`

- Operation: `modify`
- Base payload: `files/base/skills/management/SKILL.md`
- Target payload: `files/target/skills/management/SKILL.md`
- Merge instruction: compare the audited materialized base with the current instance path `skills/management/SKILL.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/notes/SKILL.md`

- Operation: `add`
- Base payload: none (file did not exist)
- Target payload: `files/target/skills/notes/SKILL.md`
- Merge instruction: compare the audited materialized base with the current instance path `skills/notes/SKILL.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

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

## `skills/todo-handling/SKILL.md`

- Operation: `modify`
- Base payload: `files/base/skills/todo-handling/SKILL.md`
- Target payload: `files/target/skills/todo-handling/SKILL.md`
- Merge instruction: compare the audited materialized base with the current instance path `skills/todo-handling/SKILL.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/workflow/SKILL.md`

- Operation: `modify`
- Base payload: `files/base/skills/workflow/SKILL.md`
- Target payload: `files/target/skills/workflow/SKILL.md`
- Merge instruction: compare the audited materialized base with the current instance path `skills/workflow/SKILL.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `talk/card-reference.md`

- Operation: `remove`
- Base payload: `files/base/talk/card-reference.md`
- Target payload: none (file is removed from stock)
- Merge instruction: compare the audited materialized base with the current instance path `talk/card-reference.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `talk/orchestrator-persona.md`

- Operation: `remove`
- Base payload: `files/base/talk/orchestrator-persona.md`
- Target payload: none (file is removed from stock)
- Merge instruction: compare the audited materialized base with the current instance path `talk/orchestrator-persona.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.
