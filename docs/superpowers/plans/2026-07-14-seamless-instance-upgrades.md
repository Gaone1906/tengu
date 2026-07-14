# Seamless Instance Upgrades Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use test-driven-development to implement this plan task-by-task. Use jinn-platform for gateway/web conventions, jinn-sandbox for isolation rules, and skill-creator when adding the reusable upgrade-lab skill.

**Goal:** Make a Jinn package upgrade automatically detect instance-template changes, present an unmistakable migration handoff in the terminal and web UI, and let the user's COO safely merge v0.25 customizations into v0.26 without requiring `jinn migrate` or touching unrelated user content.

**Architecture:** Release automation creates a deterministic, versioned migration bundle from the previous release tag and the candidate template. On first v0.26 gateway boot, a read-only migration service compares `config.yaml`'s `jinn.version` with the installed package, composes the applicable bundles, and exposes one canonical pending-migration contract to the CLI and web UI. The UI automatically opens a prominent, accessible migration dialog and can dispatch the exact prompt to an idempotent COO session; the terminal prints the same event as a colored banner while keeping the copyable prompt plain. The COO performs a three-way, snapshot-first merge and advances the marker only after verification. A separate upgrade lab installs real v0.25 and candidate v0.26 packages into disposable homes and random ports, with an optional Docker wrapper and a guarded local-process fallback.

**Tech Stack:** Node.js 24, TypeScript, Commander, Vite, React 19, React Router, TanStack Query, Tailwind CSS, Vitest, Playwright, npm tarballs, optional Docker.

## Global Constraints

- Never read from, write to, start, stop, or restart the operator's live `~/.jinn` instance or port `7777` during implementation or QA.
- The only authorized personalized-instance write is the new reusable skill at `~/.jinn/skills/jinn-upgrade-lab/`; its test runs must use disposable homes outside `~/.jinn`.
- Preserve the existing uncommitted edits in `.claude/skills/release-jinn-cli/SKILL.md` and `packages/jinn/package.json`; inspect and merge around them rather than reverting or overwriting them.
- Do not publish npm packages, create GitHub releases, push branches, restart the live gateway, or perform any other external/shared mutation.
- The installed package is read-only. Migration may mutate only the selected instance home after an explicit `Open with COO` action or a user-approved terminal handoff.
- A user customization always wins over a stock template default. No user file is deleted without an explicit migration instruction and a backup.
- The migration notification cannot be permanently dismissed while the marker remains behind. `Later` may close the modal for the current page load, but a persistent banner remains and the modal returns after the next gateway/UI reconnect.
- ANSI color is decoration only: honor `NO_COLOR`, disable escape sequences for non-TTY output, never use red for a routine upgrade, and keep the actual agent prompt plain text.
- Tests must prove isolation before they start a gateway: resolved home must not equal or be nested inside the real `~/.jinn`, selected port must not be `7777`, and no real secret store may be mounted or copied.
- Upgrade-lab tests must also protect port `7801`, derive the disposable port deterministically from the nonce-owned lab root, fail if that exact port is occupied, and persist it to the disposable `config.yaml` before any v0.25 gateway start or self-restart can occur.
- Before the lab signals any process, it must prove both that the PID owns the disposable port and that the PID environment identifies the disposable `JINN_HOME`; unknown or foreign ownership is a hard abort.

## User Experience Contract

1. The user updates `jinn-cli` through npm/Homebrew and restarts or opens Jinn normally.
2. If no instance-facing template changed between the instance marker and the installed version, the gateway/web UI starts normally with no migration interruption.
3. If a migration is pending, the terminal prints a compact violet/amber upgrade banner automatically, and the web UI opens a high-contrast violet/amber dialog automatically on its first successful status query.
4. The dialog explains that the update is installed and the user's custom setup is safe. Its primary action is `Open with COO`; its secondary action is `Copy migration prompt`; `Later` closes only the dialog while leaving a persistent `Finish v0.26.0 setup` banner.
5. `Open with COO` creates or reuses one direct COO web session for the exact `(instance, fromVersion, toVersion)` tuple, dispatches the canonical prompt, and navigates to `/?session=<id>`. Repeated clicks never create duplicate migration sessions.
6. The prompt tells the COO to snapshot first, perform a three-way merge from old stock + user instance + new stock, preserve custom content, verify the bundle's postconditions, report changes, then mark completion.
7. The banner/dialog disappears only after `jinn.version` equals the installed package version. Failed or interrupted COO work leaves the marker and reminder intact.

## Task 1: Create deterministic release migration bundles

**Files:**

- Create: `packages/jinn/scripts/instance-migration-bundle.mjs`
- Create: `packages/jinn/src/cli/__tests__/instance-migration-bundle.test.ts`
- Modify: `packages/jinn/package.json`
- Modify: `.claude/skills/release-jinn-cli/SKILL.md`
- Modify: `~/.jinn/skills/release/SKILL.md`
- Regenerate: `packages/jinn/template/migrations/0.26.0/manifest.json`
- Regenerate: `packages/jinn/template/migrations/0.26.0/MIGRATION.md`
- Create as needed: `packages/jinn/template/migrations/0.26.0/files/base/**`
- Create as needed: `packages/jinn/template/migrations/0.26.0/files/target/**`

### Step 1: Write failing bundle-generator tests

Test a temporary git repository with a tagged `v0.25.0` template and a v0.26 worktree. Cover added, modified, removed, renamed-by-content, unchanged, binary, and `template/migrations/**` self-exclusion cases. Assert stable path ordering, SHA-256 hashes, POSIX relative paths, and byte-for-byte deterministic output across two runs.

Define the manifest contract as:

```ts
interface InstanceMigrationManifest {
  schemaVersion: 1
  version: string
  baseVersion: string
  generatedFrom: { baseRef: string; headRef: string }
  files: Array<{
    path: string
    operation: 'add' | 'modify' | 'remove'
    baseSha256: string | null
    targetSha256: string | null
    basePayload: string | null
    targetPayload: string | null
  }>
}
```

Reject an empty bundle unless `--allow-empty` is explicit. Reject a dirty/unresolved version mismatch, unsafe paths containing `..`, symlinks that escape the template root, and any instance-surface diff not represented in the manifest.

Run and confirm failure:

```bash
pnpm --filter jinn-cli test -- src/cli/__tests__/instance-migration-bundle.test.ts
```

### Step 2: Implement the generator and checker

Implement two modes:

```bash
node packages/jinn/scripts/instance-migration-bundle.mjs generate \
  --base-ref v0.25.0 --version 0.26.0

node packages/jinn/scripts/instance-migration-bundle.mjs check \
  --base-ref v0.25.0 --version 0.26.0
```

`generate` must derive the changed paths from git, copy old/new bytes into `files/base/` and `files/target/`, write `manifest.json`, and generate a complete generic `MIGRATION.md` with one explicit merge instruction per manifest record. `check` must generate into a temporary directory and fail if committed output differs. Human-authored rationale may live only inside stable delimited sections that the generator preserves; there must be no `TODO`, `TBD`, `ACTION REQUIRED`, or placeholder version in a release candidate.

Add package scripts named `migration:generate` and `migration:check`. Ensure `npm pack --dry-run` includes the manifest and every referenced payload.

### Step 3: Make both release skills intuitive and mandatory

Replace the manual “decide and hand-audit every template path” step with:

1. Resolve the previous release tag.
2. Run `pnpm --filter jinn-cli migration:generate -- --base-ref <tag> --version <version>`.
3. If the generator reports no instance changes, record that fact and do not create an empty bundle.
4. If it generates a bundle, review only the preserved rationale section and the exact manifest paths.
5. Run `migration:check`, `npm pack --dry-run`, and the upgrade lab before release commit/publish.

Keep all existing irreversible-action approval boundaries. Do not replace the operator's current uncommitted wording wholesale; merge the new gate into it.

### Step 4: Regenerate and audit the v0.26 bundle

Generate from `v0.25.0` to the candidate v0.26 template. Specifically prove the bundle catches every changed doctrine, config, org, and skill file, including `delegation`, `onboarding`, and `sync`. The manifest is the source of truth; the Markdown prompt must reference every record exactly once.

### Step 5: Verify Task 1

```bash
pnpm --filter jinn-cli migration:check -- --base-ref v0.25.0 --version 0.26.0
pnpm --filter jinn-cli test -- src/cli/__tests__/instance-migration-bundle.test.ts
cd packages/jinn && npm pack --dry-run && cd ../..
```

## Task 2: Centralize pending-migration detection, composition, and completion

**Files:**

- Create: `packages/jinn/src/migrations/service.ts`
- Create: `packages/jinn/src/migrations/snapshot.ts`
- Create: `packages/jinn/src/migrations/__tests__/service.test.ts`
- Create: `packages/jinn/src/migrations/__tests__/snapshot.test.ts`
- Modify: `packages/jinn/src/cli/migrate-prompt.ts`
- Modify: `packages/jinn/src/cli/migrate.ts`
- Modify: `packages/jinn/src/shared/version.ts`
- Modify: `packages/jinn/src/shared/paths.ts`

### Step 1: Write failing migration-service tests

Cover no marker, equal versions, marker ahead, one migration, multiple migrations, malformed migration directories, missing manifests, manifest/payload hash mismatch, and customized instance files. Assert one canonical response:

```ts
interface PendingInstanceMigration {
  required: boolean
  fromVersion: string
  toVersion: string
  versions: string[]
  changedFiles: Array<{ path: string; operation: 'add' | 'modify' | 'remove' }>
  prompt: string | null
  migrationKey: string | null
}
```

`migrationKey` is a SHA-256 of the canonical instance realpath, from/to versions, and manifest hashes. No prompt is returned when `required` is false.

### Step 2: Implement the service as the single source of truth

Move range scanning and prompt composition behind `getPendingInstanceMigration({ instanceHome, packageVersion, migrationsDir })`. Validate every manifest and payload hash before composing a prompt. The prompt must name the old/base and target payloads for each file and require the COO to compare:

- base payload: stock v0.25 content,
- user file: current customized instance,
- target payload: stock v0.26 content.

Remove language that implies engine exit code alone means success. Keep `jinn migrate` as a compatibility/fallback command that prints the same service response, but it must no longer be required for discovery.

### Step 3: Add snapshot-first support

Before a migration session is dispatched, create one idempotent snapshot at:

```text
<instance-home>/.migration-snapshots/<migrationKey>/
```

Copy only affected instance paths plus `config.yaml`, `CLAUDE.md`/`AGENTS.md`, and a machine-readable `snapshot.json`. Preserve modes and symlinks without following links outside the instance. Do not copy `secrets/`, session databases, logs, attachments, caches, or unrelated files. Use a temporary sibling directory and atomic rename; repeated calls return the existing verified snapshot.

### Step 4: Make completion explicit and verifiable

Keep `jinn migrate --mark-done 0.26.0`, but require the expected `migrationKey` when called by the automatic COO flow. Before writing, re-read the installed package version, validate all target paths remain inside the instance, confirm the snapshot exists, and require a completion receipt written by the `migrate` skill with the reviewed files and skipped items. Preserve YAML formatting and comments. Remove or deprecate `--apply` auto-stamping on engine exit zero; an interrupted or failed session must leave `jinn.version` unchanged.

### Step 5: Verify Task 2

```bash
pnpm --filter jinn-cli test -- src/migrations/__tests__/service.test.ts src/migrations/__tests__/snapshot.test.ts src/cli/__tests__/migrate.test.ts src/cli/__tests__/migrate-prompt.test.ts
```

## Task 3: Expose the migration through the gateway and an idempotent COO handoff

**Files:**

- Modify: `packages/jinn/src/gateway/api.ts`
- Create: `packages/jinn/src/gateway/__tests__/instance-migration-api.test.ts`
- Modify: `packages/jinn/src/mcp/attachment.ts`
- Modify: `packages/jinn/src/mcp/__tests__/attachment.test.ts`
- Modify: `packages/jinn/src/mcp/resolver.ts`

### Step 1: Write failing API/auth/idempotency tests

Add tests for:

- `GET /api/status` includes `version` and a small `migration` summary.
- `GET /api/instance-migration` returns the canonical pending contract.
- `POST /api/instance-migration/open` requires normal browser mutation authorization, creates the snapshot first, creates one direct/COO web session, dispatches the canonical prompt, and returns `{ sessionId, reused, migrationKey }`.
- Repeating the POST with the same migration key reuses the session even across gateway restart.
- Concurrent duplicate POSTs produce one session.
- A failed snapshot or invalid bundle produces no session and no marker change.
- Once completion advances the marker, GET returns `required:false` and POST returns `409 MIGRATION_NOT_PENDING`.

Use a deterministic `sourceRef`/`sessionKey` of `instance-migration:<migrationKey>` and the existing session registry as the durable idempotency authority. Do not add a second shadow session store.

### Step 2: Implement the endpoints through existing session dispatch

Reuse the same validated selection, queue, attempt, and `runWebSession` machinery as `POST /api/sessions`. Do not shell out to `jinn migrate --apply`. Return the session ID so the web UI can navigate to `/?session=<encoded-id>`.

### Step 3: Make the COO capable by default in v0.26

Change `JINN_ATTACH_DEFAULT` to `true`, update its documentation, and prove an explicit instance config value of `false` still wins as a kill switch. Update resolver/setup tests so an upgraded v0.25 instance without a newly added MCP block receives the built-in Jinn MCP by default, while an operator who explicitly disabled it stays disabled.

### Step 4: Verify Task 3

```bash
pnpm --filter jinn-cli test -- src/gateway/__tests__/instance-migration-api.test.ts src/mcp/__tests__/attachment.test.ts
```

## Task 4: Add automatic, eye-catching terminal presentation

**Files:**

- Create: `packages/jinn/src/cli/migration-notice.ts`
- Create: `packages/jinn/src/cli/__tests__/migration-notice.test.ts`
- Modify: `packages/jinn/src/cli/start.ts`
- Modify: `packages/jinn/src/cli/migrate.ts`

### Step 1: Write failing color and output tests

Test TTY, non-TTY, `NO_COLOR=1`, narrow terminals, Unicode-disabled terminals, no pending migration, and multiple migrations. Assert:

- TTY heading uses violet/magenta, the attention line uses amber/yellow, and the action uses cyan.
- No routine migration line uses red.
- Non-TTY and `NO_COLOR` contain zero ANSI escape sequences.
- The canonical prompt bytes are identical with and without color.
- Start output contains the reminder automatically when pending and nothing when current.

### Step 2: Implement the notice

Render a compact bordered notice before the ordinary “gateway ready” output:

```text
╭─ Jinn update installed ─────────────────────────╮
│ v0.25.0 → v0.26.0 needs one safe setup merge.   │
│ Your custom files are preserved. Open the UI or │
│ hand the prompt below to your COO.               │
╰──────────────────────────────────────────────────╯
```

After the colored notice, print the canonical prompt as plain text only when the process owns an interactive terminal. For daemon/log mode, print the compact reminder and let the web UI carry the full prompt. Never block gateway startup waiting for stdin.

### Step 3: Verify Task 4

```bash
pnpm --filter jinn-cli test -- src/cli/__tests__/migration-notice.test.ts src/cli/__tests__/migrate.test.ts
```

## Task 5: Add the automatic web migration dialog and persistent banner

**Files:**

- Create: `packages/web/src/components/migration/instance-migration-gate.tsx`
- Create: `packages/web/src/components/migration/__tests__/instance-migration-gate.test.tsx`
- Modify: `packages/web/src/lib/api.ts`
- Modify: `packages/web/src/lib/query-keys.ts`
- Modify: `packages/web/src/main.tsx`
- Modify as needed: `packages/web/src/routes/globals.css`
- Create: `e2e/instance-migration.spec.ts`

### Step 1: Add typed client contracts and failing component tests

Add `api.getInstanceMigration()` and `api.openInstanceMigration(migrationKey)`. The gate query starts after providers mount, retries transient errors, and never blocks the underlying app shell.

Test:

- no UI when current,
- modal auto-opens when pending,
- `Later` closes the modal but leaves the banner,
- clicking the banner reopens it,
- `Copy migration prompt` writes exactly the canonical prompt and shows accessible confirmation,
- `Open with COO` disables while pending, calls the idempotent endpoint once, then navigates to `/?session=<id>`,
- API failure preserves the banner and offers retry,
- polling/websocket invalidation removes both surfaces after completion,
- keyboard focus trap, Escape behavior, reduced motion, light/dark contrast classes, mobile wrapping, and screen-reader labels.

### Step 2: Implement the visual system

Use existing Dialog primitives and design tokens. The banner/dialog should use a violet-to-indigo accent with an amber attention chip and a Sparkles icon; reserve red for actual errors. Use a subtle one-time glow/pulse only when `prefers-reduced-motion` allows it. Copy should lead with reassurance:

```text
v0.26.0 is installed. Your custom setup is safe.
One guided merge will bring your instance up to date.
```

Primary button: `Open with COO`. Secondary: `Copy migration prompt`. Tertiary: `Later`. The banner text is `Finish v0.26.0 setup` and cannot be dismissed while pending.

### Step 3: Mount globally and verify visually

Mount `InstanceMigrationGate` inside `ClientProviders` and outside the route-level Suspense boundary so it appears on every page. Add Playwright coverage at desktop light, desktop dark, and mobile widths; capture artifacts into the isolated test output only.

### Step 4: Verify Task 5

```bash
pnpm --filter web test -- src/components/migration/__tests__/instance-migration-gate.test.tsx
pnpm --filter web typecheck
pnpm exec playwright test e2e/instance-migration.spec.ts
```

## Task 6: Build the real v0.25 → v0.26 isolated upgrade lab

**Files:**

- Create: `scripts/upgrade-lab/run.mjs`
- Create: `scripts/upgrade-lab/fixtures/stock-v025.mjs`
- Create: `scripts/upgrade-lab/fixtures/customized-v025.mjs`
- Create: `scripts/upgrade-lab/fixtures/heavily-customized-v025.mjs`
- Create: `scripts/upgrade-lab/Dockerfile`
- Create: `scripts/upgrade-lab/docker-entrypoint.sh`
- Create: `scripts/upgrade-lab/README.md`
- Create: `scripts/upgrade-lab/__tests__/guards.test.mjs`
- Modify: root `package.json`
- Modify as needed: `.gitignore`

### Step 1: Write and run failing hard-isolation guard tests

The harness must refuse to run unless all checks pass before installation or process spawn:

- lab root is a newly created directory under `os.tmpdir()` or an explicit disposable path,
- lab root and home realpaths are neither equal to nor inside the real `~/.jinn`,
- `HOME`, `JINN_HOME`, npm prefix/cache, XDG paths, instance registry, logs, and attachments all resolve inside the lab root,
- no source path under `~/.jinn/secrets` is copied or mounted,
- port is deterministically derived from the nonce-owned lab root, bound on `127.0.0.1`, and asserted not to equal protected ports `7777` or `7801`,
- setup's generated `config.yaml` is rewritten atomically so `gateway.port` equals the chosen disposable port before the first gateway start,
- a start preflight refuses an occupied port, and a signal preflight refuses any PID whose `JINN_HOME` is unknown or differs from the disposable home,
- a regression fixture proves a simulated self-restart cannot signal a foreign listener and leaves that listener alive,
- child processes receive an explicit minimal environment rather than inheriting all host environment variables,
- cleanup only deletes a directory containing a lab-owned nonce file.

Run:

```bash
node --test scripts/upgrade-lab/__tests__/guards.test.mjs
```

### Step 2: Implement the package-accurate local runner

The default mode must work without Docker:

1. Create the guarded temp root.
2. `npm pack jinn-cli@0.25.0` into a lab-local cache.
3. `pnpm --filter jinn-cli pack --pack-destination <lab-cache>` for the candidate v0.26 tarball.
4. Install each tarball into a distinct lab-local npm prefix with lifecycle scripts disabled.
5. Run v0.25 `jinn setup` against the lab home and seed the selected fixture.
6. Atomically persist the chosen lab port into the generated `config.yaml`, verify it reads back exactly, and only then release the port reservation.
7. Run the ownership/availability preflight and start the v0.25 gateway on the persisted port; create representative sessions/cron/org state and record a baseline.
8. Stop only a PID proven to own both the disposable port and disposable `JINN_HOME`, switch the executable to the candidate package, preflight again, and start v0.26 on the same lab home/port.
9. Exercise the status and migration APIs, open the COO handoff using a stub engine that records the prompt, simulate a verified migration receipt, then mark done.
10. Save JSON results, logs, prompt, manifest audit, and Playwright screenshots under `<lab-root>/artifacts`.
11. Stop only the ownership-verified lab PID and clean the root unless `--keep` is set.

Add `pnpm upgrade-lab -- --scenario <name>` and `--candidate-tarball <path>` so release QA can test the exact packed artifact without rebuilding.

### Step 3: Add Docker as a stronger optional wrapper

The Docker image runs the same Node harness, never mounts the host home, uses `--network none` during package setup, and exposes no fixed host port. Mount only the repository read-only plus a disposable artifact directory. The wrapper must print a clear fallback message when Docker is unavailable and run the guarded local mode instead; Docker absence is not a test failure.

### Step 4: Implement the scenario matrix

Required scenarios:

| Scenario | v0.25 fixture | Required proof |
|---|---|---|
| `stock` | untouched template | all changed stock files merge, marker advances, no reminder remains |
| `customized` | custom `CLAUDE.md`, config values, one edited stock skill, one custom skill | all sentinels survive, target doctrine/skills appear, no custom file is deleted |
| `heavily-customized` | renamed sections, removed stock skill, custom org/cron/docs, marker missing | conservative merge, explicit skipped/conflict report, reminder remains until receipt |
| `interrupted` | customized fixture | killed COO session leaves marker/reminder intact; retry reuses the migration session |
| `no-instance-change` | current marker plus internal-only candidate fixture | no prompt, banner, snapshot, or migration session |

For every scenario also prove existing sessions, Todos, workflows, cron definitions, org employees, and gateway data survive the package swap; the v0.25 PID is gone before v0.26 binds; the live port `7777` was never contacted; and the live `~/.jinn` mtimes/hashes for a preselected sentinel set are unchanged before/after.

### Step 5: Verify Task 6

```bash
node --test scripts/upgrade-lab/__tests__/guards.test.mjs
pnpm upgrade-lab -- --scenario stock
pnpm upgrade-lab -- --scenario customized
pnpm upgrade-lab -- --scenario heavily-customized
pnpm upgrade-lab -- --scenario interrupted
pnpm upgrade-lab -- --scenario no-instance-change
```

## Task 7: Package the lab as a reusable Jinn skill

**Files:**

- Create: `~/.jinn/skills/jinn-upgrade-lab/SKILL.md`
- Create: `~/.jinn/skills/jinn-upgrade-lab/scripts/run.sh`
- Create: `~/.jinn/skills/jinn-upgrade-lab/references/scenario-contract.md`

### Step 1: Create the skill with discovery-grade frontmatter

Use:

```yaml
---
name: jinn-upgrade-lab
description: Safely test Jinn package upgrades such as v0.25 to v0.26 in a disposable home and random port without touching the live ~/.jinn instance or port 7777. Use for release migration QA, rollback checks, and reproducible upgrade regressions.
---
```

The skill must tell `jinn-dev` to prefer an exact candidate tarball, choose Docker when available, fall back to guarded process isolation, run the relevant scenario matrix, inspect artifacts, and report `PASS`, `FAIL`, or `BLOCKED` with artifact paths. It must explicitly prohibit live gateway restarts and direct edits to the operator's instance.

### Step 2: Add a thin safe wrapper

`scripts/run.sh` may only locate `~/Projects/jinn`, validate the requested scenario/candidate arguments, and invoke the repository's canonical harness. It must not duplicate upgrade logic. Use strict shell mode, quote every path, and forward no secret-bearing environment variables.

### Step 3: Validate skill discovery and behavior

```bash
test -f ~/.jinn/skills/jinn-upgrade-lab/SKILL.md
sed -n '1,20p' ~/.jinn/skills/jinn-upgrade-lab/SKILL.md
~/.jinn/skills/jinn-upgrade-lab/scripts/run.sh --scenario stock --dry-run
```

Confirm both `.claude/skills/jinn-upgrade-lab` and `.agents/skills/jinn-upgrade-lab` resolve through Jinn's normal skill synchronization; do not restart the live gateway to force this.

## Task 8: Full regression, adversarial review, and release gate

**Files:**

- Modify only where failures prove a required correction.

### Step 1: Run scoped suites first

```bash
pnpm --filter jinn-cli typecheck
pnpm --filter jinn-cli test -- src/migrations src/cli/__tests__/migration-notice.test.ts src/gateway/__tests__/instance-migration-api.test.ts src/mcp/__tests__/attachment.test.ts
pnpm --filter web typecheck
pnpm --filter web test -- src/components/migration/__tests__/instance-migration-gate.test.tsx
node --test scripts/upgrade-lab/__tests__/guards.test.mjs
```

### Step 2: Run repository-wide gates

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm lint
```

If the repository has pre-existing unrelated failures, record their exact command/output and prove the touched packages' scoped suites pass. Do not weaken, skip, or delete tests to make the gate green.

### Step 3: Run the packed-artifact upgrade matrix

Create one candidate tarball after the clean build and pass that exact file to every scenario. Record package SHA-256 in the lab summary so all scenarios prove the same artifact.

### Step 4: Perform independent code review and QA

The reviewer must inspect the implementation against this plan, review every migration/security/isolation diff, run at least the `customized`, `interrupted`, and `no-instance-change` scenarios independently, inspect desktop/mobile screenshots, and confirm the live `~/.jinn` sentinel hashes plus port `7777` remained untouched. Findings must include severity, exact file/line, reproduction, and required fix. The implementer fixes valid findings; the reviewer reruns targeted QA and issues a final `PASS` only when no blocking/high-severity finding remains.

## Final Acceptance Checklist

- A release cannot ship an uncovered instance-template change.
- Updating and reopening Jinn automatically reveals a pending migration; the user never needs to discover or type `jinn migrate`.
- The terminal notice is eye-catching in color and clean in `NO_COLOR`/non-TTY environments.
- The web UI automatically opens an accessible, attractive migration dialog and keeps a persistent reminder until completion.
- One click opens exactly one COO session with the canonical prompt and a verified snapshot.
- v0.25 custom doctrine, config, skills, org, docs, and state survive the v0.26 transition.
- Failed/interrupted work never advances the marker or suppresses the reminder.
- Gateway/web/database/internal migrations require no manual user action.
- The real `~/.jinn`, live gateway PID, secrets, and port `7777` are untouched by every lab run.
- `jinn-dev` can rerun the packaged `jinn-upgrade-lab` skill for later releases.
- All scoped tests, typechecks, builds, lab scenarios, and independent review pass before v0.26 release work resumes.
