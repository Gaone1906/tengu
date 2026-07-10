# Manager-Aware Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep skip-level delegation fully allowed while surfacing exactly one durable visibility signal to the delegated employee's manager.

**Architecture:** The delegation route continues to mint/link/dispatch the requested employee unchanged, then invokes a fail-open visibility helper. The helper uses the resolved org hierarchy to distinguish skip-level work from direct-report or same-manager work, posts one notification-role message to the manager's latest usable session through the existing restart-safe queue, and falls back to one linked Todo audit note when the manager has no session.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, Node.js 24.13.0, pnpm 10.6.4.

## Global Constraints

- Build from `main` HEAD `149dd005f4127cbbd88e93aed1630a1de7879821` in the isolated `/private/tmp/jinn-mgraware` worktree.
- Skip-level delegation remains allowed and dispatches to the originally requested employee.
- Emit at most one manager-visibility signal per new delegation; idempotent delegation replays emit none.
- Direct-report and same-manager delegations emit no manager-visibility signal.
- Visibility failures never block, reroute, or change the delegation response.
- Never access gateway ports 7777 or 7788, and never write to an installed Jinn home.
- Keep all shipped fixtures and documentation generic; no personal names, projects, paths, identifiers, or credentials.
- Use Node.js 24.13.0 and pnpm; do not add `Co-Authored-By` trailers.

---

### Task 1: Resolve and surface manager visibility

**Files:**
- Create: `packages/jinn/src/gateway/manager-visibility.ts`
- Test: `packages/jinn/src/gateway/__tests__/manager-visibility.test.ts`

**Interfaces:**
- Consumes: `resolveOrgHierarchy(roster)`, `searchSessionsFiltered({ employee })`, `notifyManagerVisibility`, and `appendWorkItemEvent`.
- Produces: `surfaceManagerVisibility(input): void`, a fail-open post-dispatch helper.

- [ ] **Step 1: Write failing classification and delivery tests**

```ts
it("notifies the target manager once for a skip-level delegation", () => {
  surfaceManagerVisibility(input({ delegator: root, target: worker }));
  expect(notifyManagerVisibility).toHaveBeenCalledOnce();
  expect(notifyManagerVisibility).toHaveBeenCalledWith(managerSession.id, expect.objectContaining({
    manager: "team-lead",
    employee: "worker",
  }));
});

it("does not notify for a direct report or same-manager delegation", () => {
  surfaceManagerVisibility(input({ delegator: teamLead, target: worker }));
  surfaceManagerVisibility(input({ delegator: peer, target: worker }));
  expect(notifyManagerVisibility).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter jinn-cli exec vitest run src/gateway/__tests__/manager-visibility.test.ts`

Expected: FAIL because `manager-visibility.ts` does not exist.

- [ ] **Step 3: Implement fail-open hierarchy classification and the fallback link**

```ts
export function surfaceManagerVisibility(input: ManagerVisibilityInput): void {
  try {
    const hierarchy = resolveOrgHierarchy(input.roster);
    const manager = hierarchy.nodes[input.employee]?.parentName;
    const delegator = input.delegatorSession?.employee ?? null;
    const delegatorManager = delegator ? hierarchy.nodes[delegator]?.parentName ?? null : null;
    if (!manager || delegator === manager || delegatorManager === manager) return;

    const managerSession = searchSessionsFiltered({ employee: manager }, 20)
      .find((session) => session.status !== "error");
    if (managerSession) {
      notifyManagerVisibility(managerSession.id, {
        manager,
        managerDisplay: input.roster.get(manager)?.displayName || manager,
        delegator,
        delegatorDisplay: delegator ? input.roster.get(delegator)?.displayName || delegator : "The operator",
        employee: input.employee,
        employeeDisplay: hierarchy.nodes[input.employee].employee.displayName,
        childSessionId: input.childSession.id,
        workItemId: input.workItemId,
        title: input.title,
      });
      return;
    }
    appendWorkItemEvent({
      workItemId: input.workItemId,
      kind: "note",
      actor: "delegation",
      detail: {
        managerVisibility: {
          manager,
          delegator,
          employee: input.employee,
          childSessionId: input.childSession.id,
          title: input.title,
        },
      },
    });
  } catch (error) {
    logger.warn(`Manager visibility failed open: ${error instanceof Error ? error.message : String(error)}`);
  }
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm --filter jinn-cli exec vitest run src/gateway/__tests__/manager-visibility.test.ts`

Expected: PASS with skip-level, direct-report, same-manager, no-session fallback, and failure-open cases covered.

### Task 2: Send visibility through the durable notification route

**Files:**
- Modify: `packages/jinn/src/sessions/callbacks.ts`
- Modify: `packages/jinn/src/gateway/api.ts`
- Modify: `packages/jinn/src/sessions/__tests__/callbacks.test.ts`
- Modify: `packages/jinn/src/gateway/__tests__/delegations-route.test.ts`

**Interfaces:**
- Consumes: `_sendRaw(sessionId, message, displayMessage, structured)` and the delegation's resolved roster, child session, Todo, and delegator session.
- Produces: `notifyManagerVisibility(managerSessionId, details): void` and a single post-dispatch `surfaceManagerVisibility` call.

- [ ] **Step 1: Write failing callback payload and route behavior tests**

```ts
it("posts manager visibility as a notification-role session message", async () => {
  notifyManagerVisibility("manager-session", details);
  await flushPromises();
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/sessions/manager-session/message"), expect.objectContaining({
    body: expect.stringContaining('"role":"notification"'),
  }));
});

it("dispatches a skip-level delegation to the requested IC and notifies its manager exactly once", async () => {
  const response = await delegateAs("root", "worker");
  expect(response.status).toBe(201);
  expect(registry.getSession(response.body.sessionId)?.employee).toBe("worker");
  expect(engineRuns).toContainEqual(expect.objectContaining({ sessionId: response.body.sessionId }));
  expect(managerVisibilityRequests()).toHaveLength(1);
});
```

- [ ] **Step 2: Run both focused suites and verify RED**

Run: `pnpm --filter jinn-cli exec vitest run src/sessions/__tests__/callbacks.test.ts src/gateway/__tests__/delegations-route.test.ts`

Expected: FAIL because the callback sender and route hook are missing.

- [ ] **Step 3: Add the notification sender and post-dispatch route hook**

```ts
export function notifyManagerVisibility(managerSessionId: string, details: ManagerVisibilityDetails): void {
  _sendRaw(managerSessionId, managerVisibilityPrompt(details), managerVisibilityDisplay(details), {
    meta: managerVisibilityMeta(details),
  }).catch((error) => logger.warn(
    `[callbacks] Failed to notify manager session ${managerSessionId}: ${error instanceof Error ? error.message : String(error)}`,
  ));
}

dispatchWebSessionRun(session, task, engine, config, context, dispatchOptions);
surfaceManagerVisibility({ roster, employee: employeeName, delegatorSession, childSession: session, workItemId: workItem.id, title });
```

The visibility hook is after dispatch and catches every error internally, so the requested IC remains the execution target and the response remains `201` even if visibility cannot be surfaced.

- [ ] **Step 4: Run delegation and sessions scope and verify GREEN**

Run: `pnpm --filter jinn-cli exec vitest run src/gateway/__tests__/delegations-route.test.ts src/gateway/__tests__/manager-visibility.test.ts src/sessions/__tests__/callbacks.test.ts src/gateway/__tests__/callback-reliability.test.ts src/sessions/registry.test.ts src/sessions/queue.test.ts`

Expected: PASS with one skip-level signal, no direct-report signal, unchanged employee dispatch, and restart-safe notification coverage.

### Task 3: Update doctrine and integrate

**Files:**
- Modify: `packages/jinn/template/CLAUDE.md`

**Interfaces:**
- Consumes: the existing Delegation doctrine section.
- Produces: generic manager-aware, manager-not-gated guidance for newly seeded homes.

- [ ] **Step 1: Replace the overlapping delegation bullets**

```md
- Prefer delegating through managers. You MAY delegate skip-level directly to an IC when it is faster; the IC's manager is notified so they retain visibility.
- The hierarchy remains advisory and never blocks or reroutes direct access.
```

- [ ] **Step 2: Run staged privacy scan and verification**

Run the staged-diff privacy-firewall scan defined in the repository operating instructions.

Expected: no personal names, project names, emails, identifiers, credentials, or local user paths.

Run: `pnpm typecheck`

Expected: all workspace typechecks pass.

Run: `pnpm test`

Expected: the full workspace suite passes.

- [ ] **Step 3: Commit, fast-forward main, and confirm ancestry**

```bash
git commit -m "feat(delegation): surface skip-level work to managers"
git -C ~/Projects/jinn merge --ff-only feat/manager-aware-routing
git -C ~/Projects/jinn merge-base --is-ancestor <commit> main
```

Expected: `main` points at the feature commit and the ancestry command exits 0.

- [ ] **Step 4: Remove the worktree**

Run: `git -C ~/Projects/jinn worktree remove /private/tmp/jinn-mgraware && git -C ~/Projects/jinn branch -d feat/manager-aware-routing`

Expected: the worktree path and temporary branch are gone while the commit remains on `main`.
