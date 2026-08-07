# Verified findings — upstream Jinn

Everything here was read from source at `github.com/hristo2612/jinn@main` or verified locally.
Paths are relative to `packages/jinn/src/` unless noted.

## Verified locally (2026-08-07)

`strings` on the installed Claude Code binary (`/opt/homebrew/Caskroom/claude-code/2.1.185/claude`):

| Field | Occurrences |
|---|---|
| `seven_day` | 79 |
| `five_hour` | 41 |
| `resets_at` | 18 |
| `used_percentage` | 11 |
| `remaining_percentage` | 4 |
| `context_window_size` | 3 |
| `exceeds_200k_tokens` | 2 |

**The statusline JSON on this machine really does carry 5-hour and 7-day usage with reset timestamps.**
The governor's premise is not an assumption.

Still unverified (needs Jinn installed): that the snapshot file appears and refreshes per assistant
message in practice. That's verification step 2 of the plan.

## The sensor already exists

`shared/claude-settings.ts` — `buildSessionSettings()` writes a per-session Claude settings file
containing:

- **hooks** relayed via `HOOK_RELAY_SCRIPT`: `SessionStart`, `UserPromptSubmit`, `Stop`,
  `StopFailure`, `PreToolUse`, `PostToolUse`, `Notification`
- an optional **statusLine** recorder (`node -e <inline> <dir> <sessionId>`) that reads the statusline
  JSON on stdin and atomically writes (mode `0o600`) to `<statusLineDir>/<sessionId>.json`, keeping
  `captured_at`, `jinn_session_id`, `model`, `version`, `rate_limits`, `context_window`, `cost`

On disk: **`~/.jinn/tmp/engine-limits/claude/<sessionId>.json`** (`CLAUDE_LIMITS_DIR` =
`ENGINE_LIMITS_DIR/claude`; `CLAUDE_SETTINGS_DIR` = `~/.jinn/tmp/settings`).

Every field the GUI needs is already on disk, per session, refreshed on every assistant message.
Nothing surfaces it to the UI and nothing enforces a threshold.

## How Jinn drives Claude

`engines/claude-interactive.ts`:

- **`node-pty` spawn of the genuine `claude` binary, no `-p`** — source comment: *"no -p →
  cc_entrypoint=cli"*. Deliberately interactive, so it bills against the normal Max pool rather than
  the separate non-interactive credit ($100/mo on Max 5x).
- argv via `buildInteractiveArgs()`: `--chrome`, `--dangerously-skip-permissions`,
  `--disallowedTools` (AskUserQuestion, ExitPlanMode), `--settings`, `--resume` (when resuming),
  `--model`, `--effort`, `--append-system-prompt`; prompt after `--`.
- `buildPtyEnv()`: `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000`, `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`,
  `CLAUDE_CODE_RESUME_TOKEN_THRESHOLD=999999999`.
- **`autoApproveSafetyPrompts`** (default on) — reads the terminal, parses the dialog via
  `parsePermissionPrompt()`, answers with keystrokes via `answerPermissionPrompt()`.
- Rate limits detected via the `StopFailure` hook with `error === "rate_limit"` →
  `rateLimitFromStopFailure()` → `EngineRateLimitInfo`.

⚠️ `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000` on a 200k-context model may push auto-compact **past the
ceiling**, meaning sessions hit a wall instead of compacting. **Verify empirically before changing.**

## Limits collection

`shared/engine-limits.ts` — `collectEngineLimits()` returns
`{generatedAt, default, engines: Record<string, EngineLimitEngineSnapshot>}`. For Claude it prefers,
in order: (1) a live **OAuth Usage API** (per-model buckets), (2) the **statusline snapshot** (only
`five_hour` / `seven_day`), (3) a static registry marked unavailable. `claudeSnapshotFile()` scans
`CLAUDE_LIMITS_DIR` for `.json` files with rate-limit data and returns the most-recently-modified one.
Snapshots older than **30 min** are stale.

> Earlier note that `cli/limits.ts` "only covers Grok/Pi/Hermes" was **wrong** — that's just the
> explicit-refresh step. Claude limits come from the OAuth API / statusline snapshot.

## Enforcement seam (copy this pattern)

`gateway/budgets.ts` — `isBudgetExhausted()`, a **calendar-month cost cap per employee** in currency
units. Enforced in `runWebSession` **before the engine runs** ("blocks an over-budget employee before
the engine runs"), across web, API, delegation, and workflow paths (PLA-54 closed a gap where it was
connector-only). Boundary is inclusive: exhausted at exactly the cap.

This is where the usage governor should hook in — same call site, beside `isBudgetExhausted()`.

## The auto-resume blocker

`gateway/rate-limit-waiting-resume.ts` — on an engine usage limit the session enters status
`"waiting"` with `lastError` like `"Codex usage limit — resumes 2099-01-01T00:00:00.000Z"`. Per its
own test, it does **not** auto-resume: the stale wait state is cleared only when a user POSTs a new
message, which then returns `{status: "queued", sessionId}` and clears `lastError`.

**Unattended resume must clear this programmatically or it silently never fires.** Needs a regression
test.

## Security — more exists than expected

`shared/command-policy.ts` — `evaluateCommandPolicy(command): {action: "allow"|"block", reason?}`.
Hardcoded deny-list:

1. recursive home/root removal
2. `sudo` destructive removal
3. disk-destructive (`mkfs`, `dd`, `diskutil erase`)
4. exfiltration — fires when a `SECRET_PATH` pattern (SSH keys, `.env`, Jinn secrets) **and** an
   `EXFIL` pattern (`curl`, `wget`, `nc`, `scp`, `rsync`, `ftp`, `python http.server`) co-occur

`gateway/hook-endpoint.ts` — on `PreToolUse` with `tool_name === "Bash"`, calls the policy and returns
**HTTP 451** with the reason, rejecting *before* delivery to the hook registry.

**Gaps:** Bash-only (Write/Edit/NotebookEdit unchecked); no git-destructive or SQL-destructive
patterns; no workspace path confinement; no restore points. And since `--dangerously-skip-permissions`
is set and safety prompts are auto-approved, **this deny-list is the only gate**.

## Org and work items

- `shared/types.ts` — `Employee { name, system?, displayName, department, rank: "executive"|"manager"|"senior"|"employee", engine, model, persona, ... }`.
  **No first-class project entity** — projects are `cwd` paths.
- `work-items/` — `store.ts`, `relations.ts`, `transitions.ts`, `comments.ts`, `approvals.ts`,
  `departments.ts`, `live-events.ts`, `reconcile.ts`, `migrate.ts`, `labels.ts`, `attachments.ts`,
  `workflow-event-feed.ts`. WorkItem: `id` (e.g. "JIN-1"), `parentId`, `rootId`, `depth` (≤3),
  `status`, `approvalState`, `assignee`, `updatedAt`. **No completion-percentage aggregation exists.**
- `departments.ts` — departments are **user-defined** slugs, lazily registered via
  `resolveDepartmentPrefix()`; work items join on `w.department = d.slug`;
  `listDepartmentsWithCounts()` → `{slug, prefix, createdAt, todoCount}`.

## Cron

`cron/{jobs,runner,scheduler,validation,run-summary}.ts` — each fire **starts a fresh session**
(`sessionManager.route()`, logical id `cron:${jobId}:${fireIso}`), mints the durable work item
**before** spawning ("the record of INTENT"), then `reconcileWorkItem()` + `notifyTodoChanged()`.
Idempotent per `fireIso`; **no "skip if busy"**; ad-hoc callers without `fireIso` are never deduped.

## Frontend

`packages/web/src/` — `main.tsx`, `components/`, `context/`, `hooks/`, `lib/`, `routes/`, `test/`.
Routes: `chat`, `cron`, `experiments`, `file`, `limits`, `logs`, `more`, `notes`, `org`, `redesign`,
`settings`, `skills`, `todos`, `workflow`, plus `auth-provider.tsx`, `providers.tsx`,
`client-providers.tsx`, `settings-provider.tsx`, `globals.css`.

**`routes/limits/` already exists** (`page.tsx`, `use-engine-limits.ts`) — an account-level limits
page to extend, not duplicate.

`packages/gateway-events/src/index.ts` — shared event types between gateway and web.
