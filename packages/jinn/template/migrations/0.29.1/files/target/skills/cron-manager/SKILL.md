---
name: cron-manager
description: Create, edit, delete, enable, disable, and inspect scheduled cron jobs
---

# Cron Manager Skill

Use this skill for scheduled prompts. Jobs live in `$JINN_HOME/cron/jobs.json`; `$JINN_HOME` defaults to `~/.jinn`. The gateway validates and hot-reloads this array.

Use `list_cron_jobs` for current definitions and `get_cron_run_history` for execution evidence. Mutations currently use a narrow filesystem edit: preserve unrelated jobs, validate the complete JSON array, and let the watcher reload it.

## Job shape

```json
{
  "id": "unique-id",
  "name": "weekday-summary",
  "enabled": true,
  "schedule": "0 9 * * 1-5",
  "timezone": "UTC",
  "engine": "claude",
  "model": "sonnet",
  "employee": "coo-name",
  "prompt": "Review the latest activity and return a concise summary.",
  "delivery": { "connector": "slack", "channel": "#updates" }
}
```

- `id` and `name` must be unique; use a stable id.
- `schedule` is a five-field cron expression; `timezone` is an IANA timezone.
- `engine` is one of claude, codex, antigravity, grok, pi, hermes.
- `model` is optional and must be supported by the selected engine.
- `employee` and `delivery` are optional; `prompt` is required.

## Operations

- Create: collect the schedule, timezone, prompt, engine/model, employee, and delivery; explain that omitted delivery means logged output only; default new jobs to enabled.
- Edit or toggle: identify one job by id or unique name, change only requested fields, and report the new state.
- Delete: show the matched job and get confirmation before removal.
- List or diagnose: prefer the read tools; include schedule, timezone, engine, employee, delivery, latest status, and relevant error evidence.

Validate cron syntax, timezone, engine/model compatibility, connector target, employee existence, unique ids/names, and JSON before saving. If the file is malformed, stop and report the repair needed; never silently replace it with an empty array.

## Delivery ownership

Analytical, reporting, or decision-informing jobs with delivery should target the COO. The COO delegates, reviews, filters noise, and produces the final deliverable. Direct employee delivery is reserved for simple, no-review output such as a health signal.

After any mutation, re-read with `list_cron_jobs` and report what changed. Use `get_cron_run_history` when the user asks whether the job actually ran.
