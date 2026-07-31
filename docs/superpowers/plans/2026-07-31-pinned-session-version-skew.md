# Pinned Session Version-Skew Crash Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the chat sidebar renderable when a newly built web client receives the legacy session-list envelope from a gateway process that has not yet restarted.

**Architecture:** Normalize the pinned-session response at the web API boundary, accepting both the current array contract and the legacy `{ sessions, counts, perGroup }` envelope. Keep `ChatSidebar` consuming one stable array contract; do not spread version-skew handling into rendering code.

**Tech Stack:** TypeScript, React 19, TanStack Query, Vitest, Vite 7

## Global Constraints

- Preserve the current pinned-session array response without modification.
- Accept the legacy session-list envelope during rolling build/restart version skew.
- Do not encode any instance-specific names, ports, paths, or data in shipped source or tests.
- Restart affected gateways with `jinn restart` only after the repository checks pass.

---

### Task 1: Normalize pinned-session API responses

**Files:**
- Modify: `packages/web/src/lib/api.ts`
- Test: `packages/web/src/lib/__tests__/api-errors.test.ts`

**Interfaces:**
- Consumes: `get<T>(path: string, init?: RequestInit): Promise<T>` and the existing `/api/sessions?pinned=1` endpoint.
- Produces: `api.getPinnedSessions(): Promise<Record<string, unknown>[]>` for both current arrays and legacy `SessionsResponse` envelopes.

- [ ] **Step 1: Write the failing regression test**

```ts
it("unwraps the legacy sessions envelope for pinned-session version skew", async () => {
  const sessions = [{ id: "session-pinned" }]
  authFetch.mockResolvedValue(new Response(JSON.stringify({
    sessions,
    counts: { __direct__: 1 },
    perGroup: 50,
  }), { status: 200, headers: { "Content-Type": "application/json" } }))

  await expect(api.getPinnedSessions()).resolves.toEqual(sessions)
})
```

- [ ] **Step 2: Run the focused test to verify RED**

Run: `pnpm --filter @jinn/web test -- src/lib/__tests__/api-errors.test.ts`

Expected: FAIL because the current client returns the non-iterable envelope unchanged instead of its `sessions` array.

- [ ] **Step 3: Implement the minimal compatibility normalization**

```ts
getPinnedSessions: async () => {
  const payload = await get<unknown>("/api/sessions?pinned=1")
  if (Array.isArray(payload)) return payload as Record<string, unknown>[]
  if (payload && typeof payload === "object" && Array.isArray((payload as SessionsResponse).sessions)) {
    return (payload as SessionsResponse).sessions
  }
  return []
},
```

- [ ] **Step 4: Run the focused test to verify GREEN**

Run: `pnpm --filter @jinn/web test -- src/lib/__tests__/api-errors.test.ts`

Expected: PASS.

- [ ] **Step 5: Verify the changed surface**

Run:

```bash
pnpm --filter @jinn/web typecheck
pnpm --filter @jinn/web test
pnpm --filter @jinn/web build
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

Expected: all commands exit 0.

### Task 2: Deploy and verify affected gateways

**Files:**
- Modify: none
- Test: live gateway status endpoints and browser console/error inspection

**Interfaces:**
- Consumes: the built `packages/jinn/dist/web` assets and the running instance inventory.
- Produces: compatible daemon/API state and a crash-free chat dashboard on every affected running instance.

- [ ] **Step 1: Reconfirm the read-only process inventory**

Run `jinn list`, inspect gateway command lines/listening ports, and compare daemon start times with the backend feature commit/build timestamps.

- [ ] **Step 2: Restart only affected gateways**

Run `jinn restart` with each affected instance home selected through the CLI's supported instance mechanism. Never use stop/start.

- [ ] **Step 3: Health-check APIs and dashboards**

Verify each restarted status endpoint, confirm the pinned-session endpoint returns an array, then load the dashboard in a paired browser and assert no uncaught `TypeError` or `is not iterable` console/runtime error.

- [ ] **Step 4: Review and commit**

Stage only the regression test, compatibility fix, and this plan. Run the required staged privacy leak grep, inspect the staged diff, and commit without co-author trailers.
