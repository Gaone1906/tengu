# Testing `packages/jinn`

## Run the suite with the repo's own scripts

```bash
pnpm test                      # whole repo, via turbo
pnpm --filter jinn-cli test    # just this package
```

Both load `packages/jinn/vitest.config.ts`. **Do not run `npx vitest` from the repo
root.** The root has no Vitest config, so Vitest falls back to defaults — no
`globalSetup`, no `setupFiles`, and therefore no isolation guard.

## The invariant

> **A test run must never read or write the live gateway home (`~/.jinn`).**
> Every suite runs against a throwaway `JINN_HOME` under the OS temp dir.

This is not a style preference. The live home holds `sessions/registry.db`, which
carries the operator's real sessions, messages, and Todos.

### Why it is enforced in two places

1. **`vitest.global-setup.ts` + `vitest.setup.ts`** — redirect `JINN_HOME` to a
   fresh temp dir before workers start, then re-assert inside each worker.
   Registered via `vitest.config.ts`.

2. **`src/shared/paths.ts`** — `assertTestRunIsIsolated()` throws at module load
   when `process.env.VITEST` is set and `JINN_HOME` is not under the temp root.

Layer 1 alone is not sufficient, and this is the whole lesson: it only arms when
Vitest actually loads `vitest.config.ts`. Layer 2 sits at the boundary that every
registry-touching module imports, so it cannot be bypassed by choosing a
different cwd, config, or runner. Production is unaffected — the check is inert
unless `VITEST`/`VITEST_WORKER_ID` is set.

### What happens when you get it wrong

```
Refusing to run tests against a non-temp JINN_HOME=/Users/you/.jinn.
Tests must never touch the live gateway registry (/Users/you/.jinn/sessions/registry.db).
Run the suite with the repo's own script — `pnpm test`, or `pnpm --filter jinn-cli test` — ...
```

The run fails at import time, before any test body executes and before any write.

### History — why we care this much

- **2026-07-06** — a run wrote 66 fixture sessions into the live registry. Cleaned
  up; the guard was added (see `docs/superpowers/plans/2026-07-10-test-isolation-guard.md`),
  but only at layer 1.
- **2026-07-25** — recurred at ~4x the size via `npx vitest` from the repo root:
  286 sessions, 704 messages, 328 queue items, and **16 real Todos (ICI-580…595)**.
  Todo IDs come from a trigger-protected append-only allocator, so those 16 can
  never be reissued — a permanent hole in the live ledger caused by a test.

Cleanup after the fact is not a fix. That is why layer 2 exists.

## Ambient environment

`vitest.setup.ts` scrubs gateway/engine env vars (`JINN_SESSION_ID`,
`_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`, `CODEX_HOME`, …). Running the suite
from inside a live Jinn session otherwise leaks them into every worker, making
results depend on who ran them — this genuinely broke
`claude-interactive-compact-window.test.ts`.

If you add a test asserting on an env var the gateway also sets, add it to
`LEAKY_ENV_VARS` rather than scrubbing it in that one test.

## Writing a test that touches the registry

Prefer letting the harness supply the home. If a test needs its own, set it
**before** importing anything that reads `paths.ts`:

```ts
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-my-feature-"));
process.env.JINN_HOME = tmp;
const reg = await import("../registry.js");   // dynamic import, after the env is set
```

A static `import` is hoisted above the assignment and will bind the wrong home.
