# Vitest Test-Home Isolation Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every `packages/jinn` Vitest run establish a temporary `JINN_HOME` before test modules load, and prove work-item writes cannot reach the default production database.

**Architecture:** A pure package-root helper canonicalizes candidate paths, recognizes the default production home and the operating-system temp tree, redirects unsafe launch environments to one fresh per-run directory, and exposes a loud assertion. Vitest `globalSetup` performs the redirect before workers start; `setupFiles` reasserts safety inside each worker before its test module evaluates. Existing module-level path constants remain unchanged because the pre-worker environment closes the import race without a broad public-path refactor.

**Tech Stack:** TypeScript, Vitest 4 global setup/setup files, Node.js `fs`/`os`/`path`, better-sqlite3 through the real Jinn work-item store.

## Global Constraints

- Never write to gateway ports `7777` or `7788`, or to the default production home `~/.jinn`.
- Production verification may only read `~/.jinn/sessions/registry.db` to count `work_items` before and after the suite.
- Use Node.js `24.13.0` and pnpm.
- Do not add `Co-Authored-By` trailers.
- Keep all repository content generic and leak-check the staged diff before committing.

---

### Task 1: Specify the test-home guard

**Files:**
- Create: `packages/jinn/vitest.test-home.ts`
- Test: `packages/jinn/src/shared/__tests__/test-home-guard.test.ts`

**Interfaces:**
- Produces: `canonicalPath(pathname: string): string`, `isTempPath(pathname: string): boolean`, `assertIsolatedTestHome(home: string | undefined): string`, and `ensureIsolatedTestHome(env?: NodeJS.ProcessEnv): { home: string; created: boolean }`.

- [ ] **Step 1: Write failing unit tests**

```ts
expect(() => assertIsolatedTestHome(path.join(os.homedir(), '.jinn')))
  .toThrow('refusing to run tests against prod JINN_HOME=~/.jinn');
const env: NodeJS.ProcessEnv = {};
const result = ensureIsolatedTestHome(env);
expect(result.created).toBe(true);
expect(env.JINN_HOME).toBe(result.home);
expect(isTempPath(result.home)).toBe(true);
```

- [ ] **Step 2: Run the focused test with an explicit throwaway launch home**

Run: `JINN_HOME="$(mktemp -d /tmp/jinn-red-XXXXXX)" pnpm --filter jinn-cli exec vitest run src/shared/__tests__/test-home-guard.test.ts`

Expected: FAIL because `vitest.test-home.ts` does not exist.

- [ ] **Step 3: Implement the pure guard helper**

Canonicalize existing paths with `realpathSync.native`, canonicalize missing paths through their nearest existing ancestor, reject the canonical default `~/.jinn`, require containment under the canonical `os.tmpdir()`, and allocate unsafe/unset homes with `mkdtempSync(path.join(os.tmpdir(), 'jinn-vitest-'))`.

- [ ] **Step 4: Re-run the focused test**

Expected: unit tests PASS.

### Task 2: Run the guard before every application import

**Files:**
- Create: `packages/jinn/vitest.global-setup.ts`
- Create: `packages/jinn/vitest.setup.ts`
- Modify: `packages/jinn/vitest.config.ts`

**Interfaces:**
- Consumes: `ensureIsolatedTestHome()` and `assertIsolatedTestHome()` from Task 1.
- Produces: a pre-worker per-run `JINN_HOME` and a per-worker fail-closed assertion.

- [ ] **Step 1: Add a failing configuration assertion**

Extend the guard test to read `vitest.config.ts` and require both `globalSetup: './vitest.global-setup.ts'` and `setupFiles: ['./vitest.setup.ts']`.

- [ ] **Step 2: Run it and verify RED**

Expected: FAIL because neither hook is configured.

- [ ] **Step 3: Add the hooks and configuration**

```ts
export default function setup(): (() => void) | undefined {
  const result = ensureIsolatedTestHome();
  assertIsolatedTestHome(process.env.JINN_HOME);
  return result.created
    ? () => fs.rmSync(result.home, { recursive: true, force: true })
    : undefined;
}
```

The worker setup calls only `assertIsolatedTestHome(process.env.JINN_HOME)` so an inheritance/configuration regression aborts loudly before a test module loads.

- [ ] **Step 4: Re-run the focused test**

Expected: PASS.

### Task 3: Prove a real work-item write is isolated

**Files:**
- Modify: `packages/jinn/src/shared/__tests__/test-home-guard.test.ts`

**Interfaces:**
- Consumes: the actual `JINN_HOME` and `SESSIONS_DB` constants plus `createWorkItem()` and `initDb()`.

- [ ] **Step 1: Add the integration assertion**

```ts
expect(isTempPath(JINN_HOME)).toBe(true);
expect(SESSIONS_DB).toBe(path.join(JINN_HOME, 'sessions', 'registry.db'));
expect(SESSIONS_DB).not.toBe(path.join(os.homedir(), '.jinn', 'sessions', 'registry.db'));
const item = createWorkItem({ title: 'test-home guard integration' });
expect(initDb().prepare('SELECT title FROM work_items WHERE id = ?').get(item.id)).toEqual({
  title: 'test-home guard integration',
});
expect(fs.existsSync(SESSIONS_DB)).toBe(true);
```

- [ ] **Step 2: Run the focused test**

Expected: PASS, with the database under the Vitest temp home.

### Task 4: Verify zero production writes and deliver

**Files:**
- Modify only if verification finds a test compatibility issue in the scoped guard files.

- [ ] **Step 1: Record the production work-item count read-only**

Run: `sqlite3 ~/.jinn/sessions/registry.db "SELECT count(*) FROM work_items"`

- [ ] **Step 2: Run the full suite with `JINN_HOME` unset and save its output**

Run: `env -u JINN_HOME pnpm test 2>&1 | tee /tmp/jinn-testguard-full-suite.log`

- [ ] **Step 3: Re-read the production count**

Expected: exactly equal to Step 1.

- [ ] **Step 4: Run typecheck and inspect the complete diff**

Run: `pnpm typecheck`, then `git diff --check`.

- [ ] **Step 5: Stage and run the repository privacy guard**

Run: `pnpm --filter jinn-cli exec vitest run src/shared/__tests__/privacy-guard.test.ts`; expected: PASS with no shipped-source privacy findings.

- [ ] **Step 6: Commit and fast-forward main**

Commit with no co-author trailer, verify `main` still points at the worktree base, then run `git merge --ff-only fix/test-isolation-guard` in the primary worktree without touching its unrelated untracked files.

## Self-Review

- Spec coverage: pre-import override, non-temp/prod detection, loud prod assertion, real DB integration, full-suite before/after proof, typecheck, commit, and fast-forward are all represented.
- Placeholder scan: no deferred implementation placeholders remain.
- Type consistency: both hooks consume the same helper API; the integration assertion uses the existing path/store APIs unchanged.
