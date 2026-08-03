# Instance migration bundle: 0.29.0 → 0.29.1

<!-- BEGIN RELEASE RATIONALE -->
The hands-free Talk voice orchestrator is retired, so `talk/` is removed from the stock instance. Both files in it — `talk/orchestrator-persona.md` and `talk/card-reference.md` — instructed the instance's agents to POST to `/api/talk/*` endpoints that no longer exist, so leaving them in place keeps misdirecting every agent that reads them.

Both are user-editable. Snapshot each one and compare it against the audited materialized base payload before removing anything. If the instance copy differs from the base, do not delete it: preserve it and flag it for review, because the operator may have written persona or card guidance worth keeping elsewhere. Only a byte-identical copy is safe to remove without review.

Removing `talk/` does not affect read-aloud. `/api/tts`, the Kokoro engine, and push-to-talk dictation are unchanged, and the `talk.kokoro` config key keeps its name and its meaning, so no `config.yaml` edit is needed.

This bundle also carries the instance-surface updates that landed alongside the retirement: refreshed operating doctrine in `CLAUDE.md`, connector documentation, the Todo and Workflow skills, and a new workflow-trigger script convention under `scripts/workflow-triggers/`.
<!-- END RELEASE RATIONALE -->

This file is generated. The manifest is authoritative; each record below appears exactly once.
The payload paths below are generic package sources. Before review, the gateway creates audited, read-only materialized base payload and materialized target payload copies beneath the instance migration snapshot using that instance's exact template replacements.
Perform the three-way merge only from those materialized snapshot payloads and the current user-owned instance file. Never apply a raw generic payload or copy an unresolved placeholder into the instance. Preserve user customizations and never delete user content without explicit review and a snapshot.

## `CLAUDE.md`

- Operation: `modify`
- Base payload: `files/base/CLAUDE.md`
- Target payload: `files/target/CLAUDE.md`
- Merge instruction: compare the audited materialized base with the current instance path `CLAUDE.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `docs/connectors.md`

- Operation: `modify`
- Base payload: `files/base/docs/connectors.md`
- Target payload: `files/target/docs/connectors.md`
- Merge instruction: compare the audited materialized base with the current instance path `docs/connectors.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `scripts/workflow-triggers/README.md`

- Operation: `add`
- Base payload: none (file did not exist)
- Target payload: `files/target/scripts/workflow-triggers/README.md`
- Merge instruction: compare the audited materialized base with the current instance path `scripts/workflow-triggers/README.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

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
