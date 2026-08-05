---
name: notes
description: Find, read, create, and safely update durable Markdown knowledge
---

# Notes Skill

Use Notes for durable facts, decisions, preferences, and project context that should help future sessions. Notes are Markdown files in `knowledge/`; `docs/` remains read-only reference material.

## Tools

- `list_notes`: browse folders or search by text.
- `read_note`: read one Note and receive its current revision.
- `create_note`: create a Note from a title, optional body, and optional folder.
- `update_note`: change a title or body, or append content, using the current revision.

## Safe update rule

Before every update, read it before updating and pass its returned revision as expectedRevision. If the revision conflicts, read the Note again, reconcile the newer content, and retry; never overwrite concurrent changes blindly.

Search before creating so one topic does not fragment across duplicate Notes. Prefer updating an existing canonical Note when it already owns the subject.

## Writing guidance

- Keep entries concise, factual, and useful beyond the current task.
- Record decisions with their context and date when timing matters.
- Correct stale facts instead of appending contradictory versions.
- Never store credentials, tokens, or other secrets in a Note.
- Do not use Notes for temporary scratch output or session transcripts.
