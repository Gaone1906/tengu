# Chat Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let operators archive a chat without deleting its messages, hide it from normal chat lists, and recover it from search.

**Architecture:** Persist an optional `archived_at` timestamp on the session row. Normal list and count queries exclude archived rows while search intentionally includes them; archive and unarchive are explicit session routes. The chat sidebar recognizes search-result archives, renders a compact archived state, and provides reversible actions without changing the permanent-delete path.

**Tech Stack:** TypeScript, SQLite/better-sqlite3, Node HTTP gateway, React 19, TanStack Query, Vitest.

## Global Constraints

- Work on `main`; do not overwrite unrelated working-tree changes.
- Keep the public repository generic; no personal data or local paths in shipped code.
- Use an additive SQLite migration so existing homes retain all chats.
- Default chat browsing excludes archived chats; text search includes them.
- Verify backend and web tests, type checks, both themes, and desktop/mobile screenshots before handoff.

---

### Task 1: Persist and query the archive state

**Files:**
- Modify: `packages/jinn/src/shared/types.ts`
- Modify: `packages/jinn/src/sessions/registry.ts`
- Test: `packages/jinn/src/sessions/__tests__/registry-pagination.test.ts`

**Interfaces:**
- Produces: `Session.archivedAt?: string | null` and `archiveSession(id): Session | undefined` / `unarchiveSession(id): Session | undefined`.
- Consumes: existing `sessions` SQLite table and `rowToSession` projection.

- [ ] **Step 1: Write failing registry tests**

```ts
it('hides an archived chat from normal lists and group totals but returns it from search', () => {
  reg.archiveSession('titled-1')
  expect(reg.listSessions().map((session) => session.id)).not.toContain('titled-1')
  expect(reg.searchSessions('budget').map((session) => session.id)).toContain('titled-1')
})

it('restores an archived chat to normal lists', () => {
  reg.unarchiveSession('titled-1')
  expect(reg.listSessions().map((session) => session.id)).toContain('titled-1')
})
```

- [ ] **Step 2: Run the registry test to verify it fails**

Run: `pnpm --filter jinn-cli exec vitest run src/sessions/__tests__/registry-pagination.test.ts`

Expected: FAIL because archive lifecycle methods and archive-aware list filtering do not exist.

- [ ] **Step 3: Implement the additive archive field and lifecycle methods**

```ts
export interface Session {
  // existing fields
  archivedAt?: string | null;
}

export function archiveSession(id: string): Session | undefined {
  const now = new Date().toISOString();
  initDb().prepare('UPDATE sessions SET archived_at = ? WHERE id = ?').run(now, id);
  return getSession(id);
}

export function unarchiveSession(id: string): Session | undefined {
  initDb().prepare('UPDATE sessions SET archived_at = NULL WHERE id = ?').run(id);
  return getSession(id);
}
```

Add nullable `archived_at` to `CREATE_TABLE` and `migrateSessionsSchema`, project it in `rowToSession`, and add `archived_at IS NULL` to normal session list, group page, per-group window, and group-count queries. Keep search unfiltered so archived chats are discoverable.

- [ ] **Step 4: Run the registry test to verify it passes**

Run: `pnpm --filter jinn-cli exec vitest run src/sessions/__tests__/registry-pagination.test.ts`

Expected: PASS.

### Task 2: Add reversible gateway routes

**Files:**
- Modify: `packages/jinn/src/gateway/api.ts`
- Test: `packages/jinn/src/gateway/__tests__/codex-home-delete-cleanup.test.ts`

**Interfaces:**
- Consumes: `archiveSession(id)` and `unarchiveSession(id)` from the registry.
- Produces: `POST /api/sessions/:id/archive` and `POST /api/sessions/:id/unarchive`, each returning the serialized session and broadcasting `session:updated`.

- [ ] **Step 1: Write failing route tests**

```ts
it('archives without deleting session messages or the Codex home', async () => {
  const session = registry.createSession({ engine: 'codex', source: 'web', sourceRef: 'archive-1' });
  const dir = seedCodexHome(session.id);
  const res = await call('POST', `/api/sessions/${session.id}/archive`, {});
  expect(res.status).toBe(200);
  expect(res.body.archivedAt).toEqual(expect.any(String));
  expect(registry.getSession(session.id)).toBeDefined();
  expect(fs.existsSync(dir)).toBe(true);
})

it('unarchives a retained session', async () => {
  const res = await call('POST', `/api/sessions/${session.id}/unarchive`, {});
  expect(res.body.archivedAt).toBeNull();
})
```

- [ ] **Step 2: Run the route test to verify it fails**

Run: `pnpm --filter jinn-cli exec vitest run src/gateway/__tests__/codex-home-delete-cleanup.test.ts`

Expected: FAIL with 404 because the archive routes do not exist.

- [ ] **Step 3: Implement the two routes**

```ts
if (method === 'POST' && params) {
  const session = getSession(params.id);
  if (!session) return notFound(res);
  const updated = archiveSession(params.id);
  context.emit('session:updated', { sessionId: params.id });
  return json(res, serializeSession(updated!, context));
}
```

Place matching archive/unarchive routes adjacent to session mutation routes. Preserve the session, messages, queue metadata, and engine snapshot; only change `archived_at`.

- [ ] **Step 4: Run the route test to verify it passes**

Run: `pnpm --filter jinn-cli exec vitest run src/gateway/__tests__/codex-home-delete-cleanup.test.ts`

Expected: PASS.

### Task 3: Expose archive and recovery in the chat UI

**Files:**
- Modify: `packages/web/src/lib/api.ts`
- Modify: `packages/web/src/hooks/use-sessions.ts`
- Modify: `packages/web/src/components/chat/chat-sidebar.tsx`
- Modify: `packages/web/src/routes/chat/page.tsx`
- Test: `packages/web/src/components/chat/__tests__/chat-sidebar-helpers.test.ts`

**Interfaces:**
- Consumes: `archivedAt` from session list/search responses and archive endpoints.
- Produces: `api.archiveSession(id)`, `api.unarchiveSession(id)`, archive-aware cache updates, sidebar archive/unarchive controls, and archived search-result affordances.

- [ ] **Step 1: Write failing UI/helper tests**

```ts
it('keeps archived chats discoverable in a search result', () => {
  expect(isArchivedSession({ archivedAt: '2026-07-14T10:00:00.000Z' })).toBe(true)
})

it('treats a restored chat as active', () => {
  expect(isArchivedSession({ archivedAt: null })).toBe(false)
})
```

- [ ] **Step 2: Run the web test to verify it fails**

Run: `pnpm --filter @jinn/web exec vitest run src/components/chat/__tests__/chat-sidebar-helpers.test.ts`

Expected: FAIL because the archive helper and UI state do not exist.

- [ ] **Step 3: Implement the minimal UI and cache behavior**

```ts
archiveSession: (id: string) => post<Record<string, unknown>>(`/api/sessions/${id}/archive`, {}),
unarchiveSession: (id: string) => post<Record<string, unknown>>(`/api/sessions/${id}/unarchive`, {}),
```

Add archive/unarchive mutations that remove an archived chat from the normal cached list and invalidate list/search queries. In the sidebar, offer **Archive chat** in each session action menu; when search returns an archived chat, render an `Archived` label and substitute **Unarchive chat**. Add archive/unarchive to the active chat’s overflow menu. Archiving the active chat follows the same safe neighbor navigation as delete, but does not close its tab or destroy any transcript; selecting it through search shows its archived state and lets the operator restore it.

- [ ] **Step 4: Run the web test to verify it passes**

Run: `pnpm --filter @jinn/web exec vitest run src/components/chat/__tests__/chat-sidebar-helpers.test.ts`

Expected: PASS.

- [ ] **Step 5: Verify the completed feature**

Run:

```bash
pnpm --filter jinn-cli typecheck
pnpm --filter @jinn/web typecheck
pnpm --filter jinn-cli test
pnpm --filter @jinn/web test
```

Expected: all commands pass.

Review the chat sidebar at desktop 1440px and mobile 390px in light and dark themes: archive an ordinary chat, confirm it disappears from browse lists, search for it, verify the archived label and unarchive control, restore it, and confirm it returns normally.
