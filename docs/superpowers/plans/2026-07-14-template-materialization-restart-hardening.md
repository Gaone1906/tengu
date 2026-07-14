# Template Materialization and Restart Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven-development to implement this plan task-by-task. Do not delegate; this tracked upgrade has one implementation owner.

**Goal:** Make setup and migrations share deterministic placeholder materialization, then ensure detached restarts retain the gateway's effective runtime port.

**Architecture:** A pure shared module derives `portalName` and `portalSlug` from instance config and materializes only `.md`, `.yaml`, and `.yml` payloads. Pending migration discovery hashes those inputs into its key and describes materialized payload paths under the migration snapshot; snapshot creation writes and audits those read-only payloads atomically before the COO session is created. Detached restart argv carries the effective port into `restart-entry`, while lifecycle signaling retains the resolved-`JINN_HOME` ownership proof.

**Tech Stack:** TypeScript, Node filesystem/crypto APIs, js-yaml, Vitest, Node native test runner, disposable upgrade harness.

## Global Constraints

- Never start, stop, restart, or signal ports `7777` or `7801`.
- Keep migration manifests and package payloads generic.
- Never reverse a runtime name into a placeholder or reinterpret user content.
- Unknown placeholders remain unchanged and auditable.
- Non-Markdown/YAML payload bytes remain unchanged.
- Preserve all unrelated shared-worktree changes and do not commit.

---

### Task 1: Shared Pure Template Materialization

**Files:**
- Create: `packages/jinn/src/shared/template-materialization.ts`
- Create: `packages/jinn/src/shared/__tests__/template-materialization.test.ts`
- Modify: `packages/jinn/src/cli/setup.ts`

**Interfaces:**
- Produces: `deriveTemplateMaterialization(config)`, `materializeTemplateText(filePath, content, inputs)`, and `findUnresolvedTemplatePlaceholders(content)`.
- Consumes: `{ portal?: { portalName?: string } }`; defaults the name to `Jinn` and derives the slug with setup's existing lowercase/whitespace-to-hyphen rule.

- [ ] Write failing tests for default Jinn, mixed-case names with spaces, unknown placeholders, and non-Markdown/YAML files.
- [ ] Run `pnpm --filter jinn-cli exec vitest run src/shared/__tests__/template-materialization.test.ts` and verify RED because the module does not exist.
- [ ] Implement the three pure functions and replace setup's local replacement function and slug derivation with them.
- [ ] Re-run the focused test and verify GREEN.

### Task 2: Audited Materialized Migration Payloads

**Files:**
- Modify: `packages/jinn/src/migrations/service.ts`
- Modify: `packages/jinn/src/migrations/snapshot.ts`
- Modify: `packages/jinn/src/migrations/__tests__/service.test.ts`
- Modify: `packages/jinn/src/migrations/__tests__/snapshot.test.ts`
- Modify: `packages/jinn/src/gateway/api.ts`
- Modify: `packages/jinn/src/gateway/__tests__/instance-migration-api.test.ts`
- Modify: `packages/jinn/template/skills/migrate/SKILL.md`
- Regenerate: `packages/jinn/template/migrations/0.26.0/**`

**Interfaces:**
- Produces: `MigrationMaterializationPlan` containing the exact portal inputs, their SHA-256, manifest hashes, source payload paths, and planned snapshot-relative materialized paths.
- Extends: `PendingInstanceMigration.materialization`; non-pending results use `null`.
- Extends: `MigrationSnapshotOptions.materialization`; snapshot verification hashes `materialization.json` and every emitted payload.

- [ ] Add failing service tests proving the key and prompt use materialized paths for default and custom portal identities, without changing generic package payloads.
- [ ] Add failing snapshot tests proving known placeholders materialize, genuine user edits remain only in the user snapshot, unknown placeholders remain unresolved, non-Markdown/YAML bytes are copied unchanged, and repeated creation verifies/reuses identical audited outputs.
- [ ] Implement the plan in migration discovery, include its input hash in the migration key, and point the canonical prompt at `.migration-snapshots/<key>/materialized/...`.
- [ ] Materialize and audit payloads atomically inside snapshot creation; pass the plan through the API before session creation.
- [ ] Update the migrate skill to require the snapshot's audited materialized base/target paths and forbid raw generic placeholders in user writes.
- [ ] Regenerate the `0.26.0` bundle and run service, snapshot, completion, API, bundle, and migrate-skill tests.

### Task 3: Product-Backed Lab Classification

**Files:**
- Modify: `scripts/upgrade-lab/run.mjs`
- Modify: `scripts/upgrade-lab/__tests__/guards.test.mjs`

**Interfaces:**
- Consumes: `pending.materialization` and the materialized payload tree returned by `createMigrationSnapshot`.
- Produces: stock/customized classification against materialized base and target payload bytes; user files are never reverse-normalized.

- [ ] Add a failing harness test where a setup-personalized stock file equals the materialized base while a further edited file does not.
- [ ] Pass the product materialization plan into snapshot creation and merge from the audited snapshot payload directory.
- [ ] Require stock paths to reach the materialized target; retain conservative skips for genuine edits.
- [ ] Run the full non-spawning guard suite before any scenario.

### Task 4: Effective-Port Detached Restart

**Files:**
- Modify: `packages/jinn/src/gateway/restart-entry-options.ts`
- Modify: `packages/jinn/src/gateway/restart-entry.ts`
- Modify: `packages/jinn/src/gateway/lifecycle.ts`
- Modify: `packages/jinn/src/gateway/api.ts`
- Modify: `packages/jinn/src/cli/start.ts`
- Modify: `packages/jinn/src/cli/restart.ts`
- Modify: focused restart/lifecycle/API tests.

**Interfaces:**
- Extends: `LifecycleKillOptions` with `port?: number`.
- Produces: `restartEntryOptionsFromArgv(argv)` returning `{ takePort, port }`, rejecting missing, non-integer, or out-of-range ports.
- Changes: `restartDetached({ port })` always appends `--port <effectivePort>` and starts its child with a config object whose port matches argv.

- [ ] Add failing parser and call-site tests proving a runtime override such as `21877` reaches restart-entry even when disk config says `7777`.
- [ ] Implement explicit effective-port propagation from CLI and API restart paths.
- [ ] Keep the existing same-home PID/port ownership proof before every fallback signal and add a foreign-owner regression if coverage is missing.
- [ ] Run focused start, restart, restart-entry, lifecycle-stop, and API tests without exercising protected ports.

### Task 5: Exact-Artifact Verification

**Files:**
- Inspect: candidate tarball and retained disposable artifacts only.

- [ ] Run scoped tests, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm lint`.
- [ ] Pack one exact candidate and record SHA-256.
- [ ] Run `stock`, inspect its summary, then run `customized`, `heavily-customized`, `interrupted`, and `no-instance-change` against that exact tarball.
- [ ] Confirm no contacted port is `7777`/`7801`, every configured lab port matches its launch/restart port, and no foreign PID is signaled.
- [ ] Run privacy and unintended-diff audits; do not commit.
