# Company-derived Todo Prefix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each Jinn company a stable three-letter Todo prefix derived from its company name, so `IC-IDEV` creates `ICI-1`, `ICI-2`, and so on.

**Architecture:** Add a dedicated `portal.companyName` setting rather than reusing the assistant-facing Portal Name. Normalize the first three ASCII letters of the company name and freeze that prefix inside the Todo allocator on its first allocation. Todo parsing accepts the public `<AAA>-N` grammar, while the database allocator and insert guards ensure one instance cannot issue a second prefix after initialization.

**Tech Stack:** TypeScript, SQLite/better-sqlite3, YAML configuration, React 19, TanStack Query, Vitest, Node test runner.

## Global Constraints

- Work directly on `main` and preserve the unrelated Chat Archive working-tree changes.
- `portalName` continues to name the assistant/portal; `companyName` names the operator's company.
- Normalize with Unicode NFKD, uppercase, discard non-ASCII letters, and take the first three letters. Reject names that yield fewer than three letters.
- A company prefix is frozen by the first committed Todo allocation. Renaming the company never rewrites existing IDs and never changes the allocator prefix.
- The public Todo grammar is `^[A-Z]{3}-[1-9][0-9]*$` with a positive safe-integer suffix.
- The database, API, MCP, CLI, UI, URLs, search, logs, and copy/share surfaces use the same identifier.
- Do not restart the gateway, convert the live private instance, deploy, release, or publish.

---

### Task 1: Define the public company-prefix grammar

**Files:**
- Modify: `packages/jinn/src/work-items/id.ts`
- Test: `packages/jinn/src/work-items/__tests__/phase-a-identity.test.ts`
- Modify: `packages/web/src/lib/todo-id.ts`
- Test: `packages/web/src/routes/todos/__tests__/todo-public-state.test.ts`

**Interfaces:**
- Produces: `deriveTodoIdPrefix(companyName: unknown): string`, generic `parseTodoId(value)`, `formatTodoId(prefix, ordinal)`, and equivalent web parsing.
- Consumes: raw configured company names and public Todo strings.

- [ ] **Step 1: Write failing backend and web tests**

Test that `IC-IDEV` derives `ICI`, punctuation is ignored, accented Latin letters normalize deterministically, fewer than three ASCII letters fail, `ICI-1` and `ACM-9007199254740991` parse, and malformed/lowercase/unsafe-integer IDs fail.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm --filter jinn-cli exec vitest run src/work-items/__tests__/phase-a-identity.test.ts
pnpm --filter @jinn/web exec vitest run src/routes/todos/__tests__/todo-public-state.test.ts
```

Expected: failures because the implementation still hard-codes `JIN` and has no company-prefix derivation.

- [ ] **Step 3: Implement the minimal grammar helpers**

Use one backend implementation for derivation and a matching public grammar in the web client. Error text must describe `<AAA>-N`, not `JIN-N`.

- [ ] **Step 4: Re-run both tests and verify GREEN**

Expected: both focused files pass without warnings.

### Task 2: Freeze the prefix in the durable allocator

**Files:**
- Modify: `packages/jinn/src/work-items/migrate.ts`
- Modify: `packages/jinn/src/work-items/store.ts`
- Test: `packages/jinn/src/work-items/__tests__/identity-schema.test.ts`
- Test: `packages/jinn/src/work-items/__tests__/migrate.test.ts`
- Test: `packages/jinn/src/work-items/__tests__/store.test.ts`

**Interfaces:**
- Consumes: `deriveTodoIdPrefix(loadConfig().portal.companyName)` on the first allocation.
- Produces: allocator row `{ singleton, prefix, high_water }`, immutable prefix guards, and `allocateWorkItemId(db, companyName)`.

- [ ] **Step 1: Write failing allocator tests**

Cover first allocation `IC-IDEV -> ICI-1`, continued allocation after a config rename still producing `ICI-2`, two concurrent first allocations agreeing on one prefix, direct SQL prefix mutation refusal, mismatched-prefix insert refusal, and startup verification of prefix/row consistency.

- [ ] **Step 2: Run the allocator tests and verify RED**

Run:

```bash
pnpm --filter jinn-cli exec vitest run src/work-items/__tests__/identity-schema.test.ts src/work-items/__tests__/migrate.test.ts src/work-items/__tests__/store.test.ts
```

Expected: failures because the allocator has no prefix column and still formats fixed `JIN-N` IDs.

- [ ] **Step 3: Implement prefix persistence and guards**

Add nullable `prefix` to an unused allocator. The first burn atomically stores the derived prefix; every later burn uses the stored prefix regardless of the current company name. Strengthen the insert/issuance triggers and startup verifier so all stored Todo IDs use the allocator prefix. A missing/invalid company name blocks only the first allocation with a clear configuration error.

- [ ] **Step 4: Re-run allocator tests and verify GREEN**

Expected: all focused allocator/store tests pass.

### Task 3: Capture Company Name during setup and onboarding

**Files:**
- Modify: `packages/jinn/src/shared/types.ts`
- Modify: `packages/jinn/src/cli/setup.ts`
- Modify: `packages/jinn/src/gateway/api.ts`
- Modify: `packages/web/src/lib/api.ts`
- Modify: `packages/web/src/lib/settings.ts`
- Modify: `packages/web/src/routes/settings-provider.tsx`
- Modify: `packages/web/src/components/onboarding-wizard.tsx`
- Modify: `packages/web/src/routes/settings/page.tsx`
- Test: `packages/jinn/src/gateway/__tests__/onboarding.test.ts`
- Test: `packages/web/src/components/__tests__/onboarding-wizard.test.tsx`

**Interfaces:**
- Produces: optional persisted `portal.companyName`, onboarding API support, and an operator-editable Company Name field.
- Consumes: `deriveTodoIdPrefix` for validation without allocating an ID.

- [ ] **Step 1: Write failing API and UI tests**

Require a valid company name during first-run completion, persist `IC-IDEV`, expose the derived preview `ICI-1`, reject a name with fewer than three Latin letters, and keep Portal Name independent.

- [ ] **Step 2: Run focused onboarding tests and verify RED**

Run:

```bash
pnpm --filter jinn-cli exec vitest run src/gateway/__tests__/onboarding.test.ts
pnpm --filter @jinn/web exec vitest run src/components/__tests__/onboarding-wizard.test.tsx
```

Expected: failures because `companyName` is not accepted or rendered.

- [ ] **Step 3: Implement configuration and UI support**

Add Company Name beside Portal Name in onboarding and settings. The API validates it before writing config. Changing it later updates display/config only; the allocator remains frozen and authoritative once a Todo exists.

- [ ] **Step 4: Re-run onboarding tests and verify GREEN**

Expected: backend and web onboarding tests pass.

### Task 4: Update prerelease conversion planning and public surfaces

**Files:**
- Modify: `tools/prerelease-todo-converter/inventory.mjs`
- Test: `tools/prerelease-todo-converter/__tests__/inventory.test.mjs`
- Modify: `docs/superpowers/plans/2026-07-14-jinn-sole-todo-identifier.md`
- Update affected JIN-specific comments/copy/tests under `packages/jinn/src/**` and `packages/web/src/**` only where they assert a fixed prefix.

**Interfaces:**
- Consumes: an explicit company name/prefix for offline dry-run mapping.
- Produces: deterministic `ICI-1..ICI-N` dry-run maps and generic product documentation.

- [ ] **Step 1: Write failing converter and surface tests**

Assert an explicit `ICI` mapping, stable ordering, and refusal of invalid prefixes. Retain generic `JIN-N` examples where they are merely valid sample IDs, but remove claims that `JIN` is the only prefix.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test tools/prerelease-todo-converter/__tests__/inventory.test.mjs
rg -n "fixed.*JIN|only Todo grammar.*JIN|expected JIN-N" packages docs tools
```

Expected: converter expectations fail and stale fixed-prefix claims are found.

- [ ] **Step 3: Implement explicit-prefix dry-run mapping and update documentation**

Keep the converter dry-run-only and root-only. Do not add a live apply path.

- [ ] **Step 4: Re-run focused tests and stale-copy audit**

Expected: converter tests pass and no production documentation claims a fixed `JIN` prefix.

### Task 5: Verify and selectively commit the feature

**Files:**
- Verify all files changed by Tasks 1-4.
- Preserve: `docs/superpowers/plans/2026-07-14-chat-archive.md` and all existing Chat Archive tracked changes.

**Interfaces:**
- Produces: one reviewable company-prefix commit on `main` without unrelated hunks.

- [ ] **Step 1: Run focused suites**

Run the Todo identity, store, API/MCP, Workflow Todo ingress, onboarding, Todo web routing, and converter suites.

- [ ] **Step 2: Run broad gates**

```bash
pnpm --filter jinn-cli typecheck
pnpm --filter @jinn/web typecheck
pnpm exec turbo build --force
```

- [ ] **Step 3: Audit scope and privacy**

Use an alternate index or interactive staging so the Chat Archive work remains unstaged. Run `git diff --check`, the repository privacy grep, and the no-`Co-Authored-By` check.

- [ ] **Step 4: Commit only the company-prefix feature**

```bash
git commit -m "feat(todos): derive ids from company name"
```
