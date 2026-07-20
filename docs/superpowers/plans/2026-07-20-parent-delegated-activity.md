# Parent Delegated Activity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a pulsing orange status on a parent session while any employee session in its descendant tree is still active.

**Architecture:** Keep persisted session status unchanged and derive a request-time `delegatedActivity` summary from the session graph. The gateway attaches the summary to session payloads; existing session lifecycle invalidations refresh it, while the web renders it using the existing orange background-work grammar in the sidebar and composer toolbar.

**Tech Stack:** TypeScript, Node.js, React 19, TanStack Query, Vitest, Testing Library, Tailwind CSS 4.1.

## Global Constraints

- Work directly on `main` and commit the completed feature on `main`.
- Keep all shipped code and fixtures generic; no personal names, projects, emails, IDs, keys, or absolute personal paths.
- Orange means the parent is idle while delegated work continues; blue remains foreground work by the session itself.
- Descendant activity is transitive and includes running, queued, waiting, and post-turn background runtime activity.
- Do not mutate durable `Session.status` and do not add a database migration.
- Reuse existing StateLine/pulse styles and theme tokens; verify dark/light and desktop/mobile behavior.

---

### Task 1: Derive delegated activity from the session tree

**Files:**
- Create: `packages/jinn/src/sessions/delegated-activity.ts`
- Create: `packages/jinn/src/sessions/__tests__/delegated-activity.test.ts`
- Modify: `packages/jinn/src/shared/types.ts`

**Interfaces:**
- Consumes: `Session[]` and a `ReadonlySet<string>` of active session IDs.
- Produces: `buildDelegatedActivityIndex(sessions, activeIds): Map<string, DelegatedActivity>` and shared `DelegatedActivity` shape `{ activeSessions: number; employees: string[] }`.

- [ ] **Step 1: Write failing graph tests**

Cover direct children, transitive grandchildren, multiple active descendants, duplicate employee de-duplication, inactive descendants, and cycle safety.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter jinn-cli test -- src/sessions/__tests__/delegated-activity.test.ts`

Expected: FAIL because `buildDelegatedActivityIndex` does not exist.

- [ ] **Step 3: Implement the minimal graph reducer**

For every active session, walk `parentSessionId` links with a per-walk visited set. Increment each ancestor's active-session count and add the descendant employee slug to a set; materialize stable arrays at the boundary.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm --filter jinn-cli test -- src/sessions/__tests__/delegated-activity.test.ts`

Expected: PASS.

### Task 2: Add the summary to session API payloads

**Files:**
- Modify: `packages/jinn/src/gateway/api.ts`
- Modify: `packages/jinn/src/gateway/__tests__/session-serialization.test.ts`

**Interfaces:**
- Consumes: `buildDelegatedActivityIndex`, queue transport state, stored waiting state, and runtime `backgroundActivity`.
- Produces: serialized `Session.delegatedActivity`, or `null` when no descendant is active.

- [ ] **Step 1: Write failing serialization tests**

Assert that a parent serializes a transitive summary while preserving `status: "idle"`, and that inactive/error descendants do not appear.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter jinn-cli test -- src/gateway/__tests__/session-serialization.test.ts`

Expected: FAIL because session serialization does not expose delegated activity.

- [ ] **Step 3: Implement request-scoped activity indexing**

Build the activity index once for list payloads and once for individual session responses. Treat transport `running`/`queued`, stored `waiting`, and active runtime streams as active. Attach the matching summary without changing stored status.

- [ ] **Step 4: Run gateway tests and verify GREEN**

Run: `pnpm --filter jinn-cli test -- src/gateway/__tests__/session-serialization.test.ts src/sessions/__tests__/delegated-activity.test.ts`

Expected: PASS.

### Task 3: Render the orange parent status

**Files:**
- Modify: `packages/web/src/lib/api.ts`
- Modify: `packages/web/src/components/chat/background-activity-status.tsx`
- Modify: `packages/web/src/components/chat/chat-pane.tsx`
- Modify: `packages/web/src/components/chat/chat-sidebar.tsx`
- Modify: `packages/web/src/components/chat/__tests__/background-activity-status.test.tsx`
- Modify: `packages/web/src/components/chat/__tests__/chat-sidebar-helpers.test.ts`
- Modify: `packages/web/src/components/chat/__tests__/chat-pane.test.tsx`

**Interfaces:**
- Consumes: `DelegatedActivity` from session list/detail payloads and org employee display names already loaded by `ChatPane`.
- Produces: orange sidebar activity dot and composer copy `Employee name working`, `N employees working`, or `Delegated work in progress`.

- [ ] **Step 1: Write failing UI behavior tests**

Assert that idle parents with delegated activity receive the orange activity state, foreground running still wins blue, and the composer renders singular/plural/fallback delegated copy using the existing pulse and reduced-motion behavior.

- [ ] **Step 2: Run the focused web tests and verify RED**

Run: `pnpm --filter @jinn/web test -- src/components/chat/__tests__/background-activity-status.test.tsx src/components/chat/__tests__/chat-sidebar-helpers.test.ts src/components/chat/__tests__/chat-pane.test.tsx`

Expected: FAIL because the UI ignores `delegatedActivity`.

- [ ] **Step 3: Implement the minimal presentation changes**

Generalize the toolbar status component to prefer delegated copy when present, resolve one employee slug through existing org data, and classify delegated activity as orange in the sidebar after foreground/error precedence.

- [ ] **Step 4: Run the focused web tests and verify GREEN**

Run: `pnpm --filter @jinn/web test -- src/components/chat/__tests__/background-activity-status.test.tsx src/components/chat/__tests__/chat-sidebar-helpers.test.ts src/components/chat/__tests__/chat-pane.test.tsx`

Expected: PASS.

### Task 4: Verify the integrated feature and commit

**Files:**
- Modify only the files listed above if verification exposes a scoped issue.

**Interfaces:**
- Consumes: completed gateway and web implementation.
- Produces: verified main-branch commit.

- [ ] **Step 1: Run repository gates**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`

Expected: all commands pass.

- [ ] **Step 2: Verify both themes and breakpoints**

Use a fixture gateway to capture idle, foreground-running, one-descendant, and multiple-descendant states at 1440px and 390px in dark and light themes. Confirm the status does not shift composer controls and the orange dot remains legible.

- [ ] **Step 3: Review the diff and privacy gate**

Run: `git diff --check` and inspect the scoped diff. Stage only feature files, then run the staged leak grep required by the repository instructions.

- [ ] **Step 4: Commit on main**

Run: `git commit -m "feat: show delegated work on parent sessions"`

Expected: one scoped commit on `main` with no co-author trailers.

## Self-Review

- Spec coverage: orange semantics, parent overview, composer detail, transitive descendants, live lifecycle refresh, and true-rest behavior are covered.
- Placeholder scan: no deferred implementation or unspecified error handling remains.
- Type consistency: `DelegatedActivity` is shared by gateway serialization and the web wire type; UI counts `employees` while retaining `activeSessions` for accurate task metadata.
