# v0.28 Release Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the v0.28.0 package a safe, auditable upgrade from both public v0.26.0 and v0.27.0 without publishing, tagging, or pushing the release.

**Architecture:** Keep instance-file migration snapshot-first and receipt-gated, but make the receipt contract self-contained in the generated prompt. Replace the lossy one-shot Workflow import with a conservative, report-backed import that only converts behavior-equivalent definitions and always preserves legacy source/history. Generalize the canonical upgrade lab so one exact v0.28.0 tarball can be exercised against either public baseline.

**Tech Stack:** TypeScript, Node.js 24, better-sqlite3, Vitest, Playwright, pnpm, npm package tarballs.

## Global Constraints

- Preserve all pre-existing user changes in the dirty `main` checkout.
- Use RED → GREEN TDD for every production behavior change.
- Never touch live instance data or protected gateway ports `7777` and `7801` during upgrade-lab runs.
- Do not push `main`, publish npm, create `v0.28.0`, create a GitHub Release, or trigger Homebrew.
- Use the exact same v0.28.0 candidate tarball for every upgrade scenario.
- Never add a `Co-Authored-By` trailer.

---

### Task 1: Make the migration prompt self-contained

**Files:**
- Modify: `packages/jinn/src/migrations/__tests__/service.test.ts`
- Modify: `packages/jinn/src/migrations/service.ts`

**Interfaces:**
- Consumes: `composePrompt()` migration key, snapshot root, and changed-file list.
- Produces: exact operator instructions for `.migration-snapshots/<key>/completion-receipt.json`.

- [ ] **Step 1: Write the failing prompt-contract test**

Assert that the generated prompt names `completion-receipt.json` and contains the exact JSON fields:

```ts
expect(first.prompt).toContain(path.join(snapshotRoot, "completion-receipt.json"))
expect(first.prompt).toContain('"schemaVersion": 1')
expect(first.prompt).toContain('"migrationKey"')
expect(first.prompt).toContain('"reviewedFiles"')
expect(first.prompt).toContain('"skippedItems"')
expect(first.prompt).toContain('"verifiedAt"')
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter jinn-cli exec vitest run src/migrations/__tests__/service.test.ts
```

Expected: failure because the current prompt only says “completion receipt” without the filename or schema.

- [ ] **Step 3: Add the exact receipt block to `composePrompt()`**

The prompt must show this contract with the live migration key:

```json
{
  "schemaVersion": 1,
  "migrationKey": "<exact key>",
  "reviewedFiles": ["<every reviewed manifest path>"],
  "skippedItems": [{"path": "<skipped/conflicted path>", "reason": "<why>"}],
  "verifiedAt": "<ISO-8601 timestamp>"
}
```

- [ ] **Step 4: Run the service, snapshot, and completion suites and verify GREEN**

Run:

```bash
pnpm --filter jinn-cli exec vitest run \
  src/migrations/__tests__/service.test.ts \
  src/migrations/__tests__/snapshot.test.ts \
  src/migrations/__tests__/completion.test.ts
```

Expected: all migration tests pass.

- [ ] **Step 5: Commit the scoped prompt fix**

```bash
git add -- packages/jinn/src/migrations/service.ts packages/jinn/src/migrations/__tests__/service.test.ts
git commit -m "fix(migrations): specify completion receipt contract"
```

### Task 2: Make legacy Workflow conversion conservative and auditable

**Files:**
- Modify: `packages/jinn/src/workflows/__tests__/import-v1.test.ts`
- Modify: `packages/jinn/src/workflows/import-v1.ts`
- Modify: `packages/jinn/template/skills/workflow/SKILL.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: legacy `workflow-evidence/workflows/*.definition.json` and `workflow-evidence/reports/runs`.
- Produces: disabled behavior-equivalent v2 drafts plus `workflows/legacy-v1-import-report.json`; unsupported definitions and all legacy history remain untouched.

- [ ] **Step 1: Write failing tests for lossy definitions**

Cover an edge containing `when`, a `loop` edge, a scheduled trigger, gates, and unsupported execution options. Each must be preserved as unsupported rather than converted with changed semantics.

- [ ] **Step 2: Write failing tests for a durable idempotent report**

The report must include schema version, source path, SHA-256 for every source definition, imported/preserved outcomes with reasons, legacy run-file counts, and active legacy run ids. A second import must reuse the report without duplicate rows.

- [ ] **Step 3: Run the import suite and verify RED**

Run:

```bash
pnpm --filter jinn-cli exec vitest run src/workflows/__tests__/import-v1.test.ts
```

Expected: current code imports conditional/loop edges lossily and writes no report.

- [ ] **Step 4: Implement strict semantic preflight**

Only manual-trigger, step-only, sequence/handoff definitions whose options map exactly may be converted. Reject unsupported nodes, triggers, gates, conditions, loop/error semantics, and execution options with a concrete reason before any insert.

- [ ] **Step 5: Implement transaction + atomic report**

Convert all sources first, insert compatible definitions as disabled drafts in one immediate transaction without overwriting existing v2 definitions, then atomically write the import report. Treat the report as the completion marker, not “database has at least one row.”

- [ ] **Step 6: Document the upgrade contract**

State that imported drafts are disabled, unsupported definitions and legacy run evidence remain in place, the report must be reviewed, and active v1 runs should be drained before upgrading.

- [ ] **Step 7: Run Workflow migration/repository/recovery tests and verify GREEN**

Run:

```bash
pnpm --filter jinn-cli exec vitest run \
  src/workflows/__tests__/import-v1.test.ts \
  src/workflows/__tests__/repository-migrations.test.ts \
  src/workflows/__tests__/workflow-recovery.test.ts
```

Expected: all pass; no lossy legacy conversion remains.

- [ ] **Step 8: Commit the scoped Workflow hardening**

```bash
git add -- \
  packages/jinn/src/workflows/import-v1.ts \
  packages/jinn/src/workflows/__tests__/import-v1.test.ts \
  packages/jinn/template/skills/workflow/SKILL.md \
  CHANGELOG.md
git commit -m "fix(workflows): preserve legacy semantics during v2 import"
```

### Task 3: Generalize the canonical upgrade lab for v0.28

**Files:**
- Modify: `scripts/upgrade-lab/__tests__/guards.test.mjs`
- Modify: `scripts/upgrade-lab/run.mjs`
- Modify: `scripts/upgrade-lab/state-probe.mjs`
- Move: `scripts/upgrade-lab/fixtures/stock-v025.mjs` → `scripts/upgrade-lab/fixtures/stock.mjs`
- Move: `scripts/upgrade-lab/fixtures/customized-v025.mjs` → `scripts/upgrade-lab/fixtures/customized.mjs`
- Move: `scripts/upgrade-lab/fixtures/heavily-customized-v025.mjs` → `scripts/upgrade-lab/fixtures/heavily-customized.mjs`

**Interfaces:**
- Consumes: one candidate tarball and one baseline tarball whose versions are read from their installed `package.json`.
- Produces: version-labelled scenario summaries proving v0.26.0→v0.28.0 and v0.27.0→v0.28.0.

- [ ] **Step 1: Write failing version-agnostic harness tests**

Assert that the harness does not contain hard-coded package versions, derives candidate/baseline versions, uses the candidate migration directory, and sets the no-change marker to the candidate version.

- [ ] **Step 2: Write failing candidate state-probe tests**

Assert that old packages seed session/Todo/Workflow/cron/org state and the candidate query reads the v2 Workflow repository plus the legacy import report instead of importing removed `definition-store.js`.

- [ ] **Step 3: Run guard tests and verify RED**

Run:

```bash
node --test scripts/upgrade-lab/__tests__/guards.test.mjs
```

Expected: hard-coded `0.25.0`, `0.26.0`, and removed `definition-store.js` paths fail the new assertions.

- [ ] **Step 4: Parameterize package versions and migration paths**

Read installed package versions, label artifacts dynamically, select `template/migrations/<candidateVersion>`, and make `no-instance-change` stamp the candidate marker.

- [ ] **Step 5: Split old seeding from candidate querying**

Use `seed-old`/`query-old` with legacy stores and `query-candidate` with `WorkflowRepository`. Compare stable identity/content while requiring imported Workflow drafts to be disabled and source-preserved.

- [ ] **Step 6: Run guard tests and dry runs and verify GREEN**

Run:

```bash
node --test scripts/upgrade-lab/__tests__/guards.test.mjs
node scripts/upgrade-lab/run.mjs --scenario stock --candidate-tarball <candidate> --baseline-tarball <v0.26> --dry-run
node scripts/upgrade-lab/run.mjs --scenario stock --candidate-tarball <candidate> --baseline-tarball <v0.27> --dry-run
```

Expected: guards and both dry runs pass without contacting protected ports.

- [ ] **Step 7: Commit the upgrade-lab generalization**

```bash
git add -- scripts/upgrade-lab
git commit -m "test(upgrade): cover v0.26 and v0.27 to v0.28"
```

### Task 4: Regenerate and validate the v0.28 release artifact

**Files:**
- Preserve/modify: `packages/jinn/package.json`
- Preserve/modify: `CHANGELOG.md`
- Regenerate: `packages/jinn/template/migrations/0.28.0/**`

**Interfaces:**
- Consumes: `v0.27.0`, the current instance template, and all release-hardening commits.
- Produces: the exact v0.28.0 package tarball and migration bundle.

- [ ] **Step 1: Regenerate and check the migration bundle**

```bash
pnpm --filter jinn-cli migration:generate -- --base-ref v0.27.0 --version 0.28.0
pnpm --filter jinn-cli migration:check -- --base-ref v0.27.0 --version 0.28.0
```

- [ ] **Step 2: Build once and pack the exact candidate**

```bash
pnpm build
cd packages/jinn
npm pack --dry-run
npm pack --pack-destination <nonce-owned-temp-directory>
```

Record the tarball SHA-256 and reuse this exact path.

- [ ] **Step 3: Run all ten upgrade scenarios**

Run `stock`, `customized`, `heavily-customized`, `interrupted`, and `no-instance-change` once from public v0.26.0 and once from public v0.27.0, always with the exact candidate tarball.

- [ ] **Step 4: Run every local release gate**

```bash
pnpm build
pnpm test
pnpm typecheck
```

Expected: all packages pass.

- [ ] **Step 5: Inspect package contents and staged release scope**

Confirm `npm pack --dry-run` includes the manifest, every base/target payload, Workflow import/report code, and current frontend assets. Stage only `packages/jinn/package.json`, `CHANGELOG.md`, and `packages/jinn/template/migrations/0.28.0`.

- [ ] **Step 6: Create the local release commit**

```bash
git commit -m "release: v0.28.0 — explicit Workflows and collaborative Todos"
```

- [ ] **Step 7: Stop before external release actions**

Report commit hashes, exact candidate SHA-256, scenario summaries, build/test/typecheck totals, and any remaining risks. Do not push, publish, tag, release, or update Homebrew.
