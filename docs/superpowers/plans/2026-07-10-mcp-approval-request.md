# MCP Todo Approval Request Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a capability-bound agent request a routed, idempotent approval on a Todo through the built-in Jinn MCP surface.

**Architecture:** Add one thin MCP adapter that posts to a dedicated gateway route. The route authenticates the caller, permits the Todo owner/assignee, linked executor, authorized manager/root, or operator, then delegates persistence and default routing to the existing `requestApproval` primitive; decision and escalation authority remain untouched.

**Tech Stack:** TypeScript, Vitest, better-sqlite3, Node.js 24.13.0, pnpm 10.6.4.

## Global Constraints

- Build from `main` HEAD `185564bc3a96e6776b747b3537b15f875b19d3e0` in `/private/tmp/jinn-apreq`.
- Never access port `7777`, `~/.jinn/`, or port `7788` while implementing or verifying.
- Reuse `requestApproval`; do not change approval decision/escalation authority or persistence semantics.
- Preserve repository privacy and unrelated changes; no `Co-Authored-By` trailer.
- Run all verification with Node.js `24.13.0` and pnpm.

---

### Task 1: Specify the MCP request contract

**Files:**
- Modify: `packages/jinn/src/mcp/__tests__/work-item-tools.test.ts`
- Modify: `packages/jinn/src/mcp/__tests__/server.test.ts`
- Modify: `packages/jinn/src/mcp/__tests__/tool-manifest-budget.test.ts`

**Interfaces:**
- Consumes: `buildApprovalTools()` and the existing MCP HTTP test stub.
- Produces: `request_work_item_approval { id, request, target? }` posting to `/api/work-items/:id/approval/request`.

- [ ] **Step 1: Write failing discovery and forwarding tests**

```ts
expect(names.has("request_work_item_approval")).toBe(true);
await requestTool.handler(
  { id: "wi_approval", request: "Approve release", target: "platform-manager" },
  ctx,
);
expect(calls[0]).toMatchObject({
  method: "POST",
  body: { request: "Approve release", target: "platform-manager" },
});
expect(new URL(calls[0].url).pathname).toBe("/api/work-items/wi_approval/approval/request");
```

- [ ] **Step 2: Run the focused MCP tests and verify RED**

Run: `PATH=$HOME/.nvm/versions/node/v24.13.0/bin:$PATH pnpm --filter jinn-cli exec vitest run src/mcp/__tests__/work-item-tools.test.ts src/mcp/__tests__/server.test.ts src/mcp/__tests__/tool-manifest-budget.test.ts`

Expected: FAIL because `request_work_item_approval` is not registered.

### Task 2: Specify route authority, routing, idempotency, and compatibility

**Files:**
- Modify: `packages/jinn/src/mcp/__tests__/work-item-tools.test.ts`

**Interfaces:**
- Consumes: the real in-process gateway/API/store test harness and `listWorkItemEvents`.
- Produces: evidence that default routing uses the existing chain of command, identical re-requests append one event, foreign/missing Todos fail safely, and decision/escalation still operate.

- [ ] **Step 1: Write failing integration tests**

```ts
const first = await requestTool.handler({ id: item.id, request: "Approve release" }, ctxFor(owner.id));
const second = await requestTool.handler({ id: item.id, request: "Approve release" }, ctxFor(owner.id));
expect(first).toEqual(second);
expect(store.getWorkItem(item.id)).toMatchObject({
  approvalState: "pending",
  approvalTarget: "platform-manager",
});
expect(store.listWorkItemEvents(item.id).filter((event) => event.kind === "approval_requested")).toHaveLength(1);
await expect(requestTool.handler({ id: item.id, request: "Steal review" }, ctxFor(outsider.id))).rejects.toThrow(/403/);
await expect(requestTool.handler({ id: "wi_missing", request: "Missing" }, ctxFor(owner.id))).rejects.toThrow(/404/);
```

- [ ] **Step 2: Run the integration test and verify RED**

Run: `PATH=$HOME/.nvm/versions/node/v24.13.0/bin:$PATH pnpm --filter jinn-cli exec vitest run src/mcp/__tests__/work-item-tools.test.ts`

Expected: FAIL because the request route/tool do not exist.

### Task 3: Implement the route and MCP adapter

**Files:**
- Modify: `packages/jinn/src/gateway/api.ts`
- Modify: `packages/jinn/src/mcp/approval-tools.ts`
- Modify: `packages/jinn/src/mcp/__tests__/server.test.ts`
- Modify: `packages/jinn/src/mcp/__tests__/tool-manifest-budget.test.ts`

**Interfaces:**
- Consumes: `requestApproval(id, { request, target?, actor })`, `ownsWorkItem`, `authorizeWorkItemOwnerManagerOrRoot`, `gatewayRequest`, and caller capability headers.
- Produces: the request route and registered MCP tool without altering decision/escalation behavior.

- [ ] **Step 1: Add the request route**

```ts
params = matchRoute("/api/work-items/:id/approval/request", pathname);
if (method === "POST" && params) {
  const caller = resolveWorkItemCaller(req, res, context);
  if (!caller) return;
  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return;
  if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
    return badRequest(res, "request body must be a JSON object");
  }
  const body = parsed.body as Record<string, unknown>;
  const request = typeof body.request === "string" ? body.request.trim() : "";
  if (!request) return badRequest(res, "request is required");
  if (body.target !== undefined && (typeof body.target !== "string" || !body.target.trim())) {
    return badRequest(res, "target must be a non-empty string when provided");
  }
  const target = typeof body.target === "string" ? body.target.trim() : undefined;
  const item = getWorkItem(params.id);
  if (!item) return notFound(res);
  const linkedOwner = caller.kind === "session" && ownsWorkItem(caller.session, item, listSessionsByWorkItem(item.id));
  const authorized = linkedOwner ? { ok: true as const } : authorizeWorkItemOwnerManagerOrRoot(caller, item, "request approval on");
  if (!authorized.ok) return json(res, { error: authorized.error }, authorized.status);
  if (target) {
    const roster = scanOrg();
    const root = resolveRootApprovalTarget();
    if (!roster.has(target) && root?.name !== target) {
      return badRequest(res, `approval target "${target}" is not an org employee or the configured root approval target`);
    }
  }
  return json(res, {
    workItem: requestApproval(params.id, {
      request,
      ...(target ? { target } : {}),
      actor: workItemActor(caller),
    }),
  });
}
```

- [ ] **Step 2: Add the MCP tool**

```ts
const request: JinnMcpTool = {
  name: "request_work_item_approval",
  description: "Request an idempotent routed approval on a Todo you own or execute.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" }, request: { type: "string" }, target: { type: "string" } },
    required: ["id", "request"],
  },
  handler: async (args, ctx) => {
    assertIdentity(ctx);
    const id = requireString(args, "id");
    const payload = { request: requireString(args, "request") } as Record<string, unknown>;
    const target = optionalString(args, "target");
    if (target !== undefined) payload.target = target;
    const { status, body } = await gatewayRequest(ctx, "POST", `/api/work-items/${encodeURIComponent(id)}/approval/request`, payload);
    if (status >= 400) throw gatewayFailure(`requesting approval for work item "${id}"`, status, body);
    return body;
  },
};
```

- [ ] **Step 3: Run focused tests and verify GREEN**

Run: `PATH=$HOME/.nvm/versions/node/v24.13.0/bin:$PATH pnpm --filter jinn-cli exec vitest run src/mcp/__tests__/work-item-tools.test.ts src/mcp/__tests__/server.test.ts src/mcp/__tests__/tool-manifest-budget.test.ts src/gateway/__tests__/work-item-approval-route.test.ts src/work-items/__tests__/approvals.test.ts`

Expected: PASS.

### Task 4: Verify, integrate, and clean up

**Files:**
- No production additions beyond Tasks 1–3.

**Interfaces:**
- Consumes: repository scripts and git worktree state.
- Produces: a leak-clean commit fast-forwarded to `main`, ancestry proof, requested test tails, and no remaining task worktree.

- [ ] **Step 1: Run required verification under Node 24.13.0**

Run `pnpm typecheck`, the focused MCP/approval scope, `pnpm test`, `pnpm build`, and `pnpm lint`, capturing verbatim tails.

- [ ] **Step 2: Leak-check and commit**

Stage only intended files, run the required staged-diff leak grep, and commit without co-author trailers.

- [ ] **Step 3: Fast-forward `main`, prove ancestry, and remove the worktree**

Confirm `main` has not diverged, fast-forward it to the task commit, run `git merge-base --is-ancestor <commit> main`, record the exit status and main SHA, then remove `/private/tmp/jinn-apreq`.
