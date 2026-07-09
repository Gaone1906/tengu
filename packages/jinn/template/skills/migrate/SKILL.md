---
name: migrate
description: Bring this {{portalName}} instance up to date after a package upgrade by applying the composed migration prompt
---

# Migrate Skill

## Trigger

This skill activates when the user runs `/migrate`, when launched by
`jinn migrate --apply`, or when asked to update/upgrade the instance after a
package upgrade.

## Overview

Upgrading the jinn package updates the gateway binary, but your instance folder
(`~/.jinn` and its equivalents) is **user-owned and divergent** — it holds your
custom `CLAUDE.md`/`AGENTS.md`, skills, config, and org. The package never
auto-mutates it.

Instead, `jinn migrate` is a **prompt dispenser**. It range-scans the
per-release `MIGRATION.md` files shipped in the package (for every version
between your instance's `jinn.version` marker and the installed package version),
composes the relevant ones — in ascending order — into **one agent-ready
prompt**, and prints it. That prompt is what you act on. There is **no
deterministic file copy** and no `migrations/` staging directory anymore.

You receive the composed prompt one of two ways:

- **`jinn migrate --apply`** pipes the prompt straight into this instance's
  agent (that's you). After you finish, jinn advances the `jinn.version` marker.
- **`jinn migrate`** (default) prints the prompt so the user can paste it into
  an agent themselves. In that case the marker is advanced by
  `jinn migrate --mark-done <version>` once the changes look right.

## Your job when you receive the composed prompt

The composed prompt starts with a preamble stating the version range and the
rules, followed by one `## ===== Migration <version> =====` section per release,
in ascending order. Apply them **in order**, following these rules:

1. **Merge intelligently.** Add new sections, config keys, skills, and docs the
   notes describe; update what the notes say to update.
2. **Preserve the user's customizations.** Never overwrite the user's own edits
   to `CLAUDE.md`/`AGENTS.md`, config values, or skills with template defaults.
   When a section exists in both, keep the user's version unless a note says to
   replace it.
3. **Never delete user content.** Only remove something if a note explicitly
   says to — and back it up first (`<file>.pre-migration.bak`).
4. **Work only inside the instance folder.** Do not touch the jinn package.
5. **Report what you changed** at the end: files added, files merged (one-line
   summary each), and anything you skipped or that needs the user's attention.

## Merge strategy reference

### CLAUDE.md / AGENTS.md

These are the most sensitive files — users heavily customize them.

1. Identify sections by markdown headings (`# Heading`, `## Heading`).
2. **New sections**: if a migration note describes a section the user's file
   lacks, append it (keep the user's existing order; new sections go at the end).
3. **Existing sections**: keep the user's version unless a note explicitly says
   to replace it.
4. **Deleted sections**: only remove if a note says to, and back up first.

### config.yaml

1. **New keys**: add with their default values under the right parent.
2. **Existing keys**: never overwrite — the user's values win.
3. **Removed keys**: only remove if a note explicitly says to (rare).
4. Remember to leave `jinn.version` for the marker step (below).

### Skills

1. **New skill directories**: create them, then ensure symlinks exist in
   `.claude/skills/<name>` and `.agents/skills/<name>` (each →
   `../../skills/<name>`).
2. **Updated skills**: if the user never customized the skill, replace it with
   the new version the note describes; if they did, merge cautiously and
   preserve their additions.

### Docs

Reference docs under `docs/` are not user-customized — apply the note's changes
directly.

## Version marker

After all sections are applied, the instance's `jinn.version` in `config.yaml`
must equal the target version named in the preamble.

- Launched via `jinn migrate --apply`: **jinn stamps the marker for you** after
  your run completes — don't edit it yourself unless the note says to.
- Prompt was printed (default mode): tell the user to run
  `jinn migrate --mark-done <version>` once the changes look right, or update
  `jinn.version` manually.

## Error handling

- Apply sections in ascending order. If one can't be applied cleanly, **stop**,
  say which version and step failed, and leave the marker unchanged so a re-run
  retries from the same point.
- If a merge conflict can't be resolved safely, **ask the user** rather than
  guessing.

## Dry run

If the user just wants a preview, summarize what each section would change —
without modifying any files. (`jinn migrate` with no flags already prints the
prompt and changes nothing.)
