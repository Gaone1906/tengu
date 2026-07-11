# Workflow Layout Independent-QA Remediation Implementation Plan

> **For agentic workers:** Execute this plan task-by-task under strict RED → GREEN TDD. Steps use checkbox syntax for tracking.

**Goal:** Remediate all eight findings in `/tmp/jinn-workflow-layout-review-report.md` without weakening layout authority, execution safety, approval routing, SPA navigation safety, responsive framing, or the MCP authoring contract.

**Architecture:** Geometry intent is inferred only from node identity/positions and edge identity/endpoints; execution metadata is orthogonal. Structural validation becomes the shared fail-fast boundary for graph complexity and non-loop DAG safety, while the layout evaluator uses bounded port-to-port segment analysis. Run reads project caller-specific approval capability without persisting it. The web moves to React Router's data-router API so a single blocked-navigation dialog can preserve the intended destination across Save, Discard, and Stay. Canvas framing observes only meaningful breakpoint/orientation class changes, preserving user viewport ownership between those changes.

**Tech Stack:** TypeScript, Node/Vitest, React 19, React Router 7 data router, React Flow, Playwright, pnpm/Turborepo.

## Global Constraints

- Work only in the existing isolated workflow-layout worktree on `feat/wi-c239479ad914-workflow-layout`.
- Preserve the existing 25-commit range and add scoped remediation commits.
- No merge, deploy, push, or production `:7777` access/mutation/restart/test.
- Final sandbox must use a fresh sanitized `JINN_HOME` and a pinned free port `7920+`.
- Every production change requires a targeted test observed failing for the expected reason first.
- Keep public repo content generic; no private names, paths, credentials, or customer/project data.
- No `Co-Authored-By` trailers.

---

### Task 1: Make geometry authority independent from execution properties

**Files:**
- Modify: `packages/jinn/src/workflows/definition-store.ts`
- Modify: `packages/jinn/src/workflows/__tests__/definition-store.test.ts`
- Modify: `packages/web/src/routes/workflow/__tests__/edit-graph.test.tsx`

**Interfaces:**
- Keeps `inferUpdateLayoutIntent(existing, candidate, patch)` private.
- Defines geometry/topology equality as node-id + exact position and edge-id + endpoints only.

- [ ] **Step 1: Write the property matrix RED test**

Create one valid manual graph and mutate, one at a time: node label, instructions, actor, role, gates, `options.model`, effort, output, retry, `onError`, timeout, session, cadence, optional, `todoTransition`, switch/fail/wait config, edge label, kind, lane, gate, and conditions. For every still-valid mutation assert exact positions and `layout:{source:'manual',version:1}` survive.

```ts
for (const mutate of PROPERTY_ONLY_MUTATIONS) {
  const before = createDefinition(root, manualDefinition(), { layoutIntent: 'manual' })
  const after = updateDefinition(root, before.id, mutate(structuredClone(before)))
  expect(after.nodes.map(({ id, position }) => [id, position])).toEqual(
    before.nodes.map(({ id, position }) => [id, position]),
  )
  expect(after.layout).toEqual({ source: 'manual', version: 1 })
}
```

- [ ] **Step 2: Run RED and retain the failure**

Run:
```bash
pnpm --filter jinn-cli test -- src/workflows/__tests__/definition-store.test.ts \
  > /tmp/workflow-layout-remediation-manual-red.txt 2>&1
```
Expected: lane/kind mutations return normalized coordinates/provenance.

- [ ] **Step 3: Implement geometry-only comparison**

Compare node sets by `id + position.x/y` and edge sets by `id + from/to`, independent of array order and all execution/display properties. A changed node/edge set or endpoint remains generated intent; unchanged geometry/topology preserves an existing manual intent and revalidates it.

- [ ] **Step 4: Add editor-to-API lane regression and run GREEN**

Assert the real editor save payload for `onError:'error-edge'` + `lane:'error'` omits manual intent while the store preserves exact manual coordinates. Run focused server/web suites and commit:
```bash
git commit -m "fix(workflows): separate layout authority from execution config"
```

### Task 2: Reject non-loop cycles and bound graph complexity before layout

**Files:**
- Modify: `packages/jinn/src/workflows/definition.ts`
- Modify: `packages/jinn/src/workflows/authoring.ts`
- Modify: `packages/jinn/src/gateway/api.ts`
- Modify: `packages/jinn/src/workflows/__tests__/definition.test.ts`
- Create: `packages/jinn/src/workflows/__tests__/complexity.test.ts`
- Modify: `packages/jinn/src/gateway/__tests__/workflow-definitions-route.test.ts`

**Interfaces:**
- Export `MAX_WORKFLOW_NODES = 96`, `MAX_WORKFLOW_EDGES = 384`, `MAX_WORKFLOW_EDGES_PER_NODE = 4`, and `MAX_WORKFLOW_DEFINITION_BYTES = 256 * 1024`.
- Add validation codes `too-many-nodes`, `too-many-edges`, `graph-too-dense`, `definition-too-large`, and `non-loop-cycle`.

- [ ] **Step 1: Write cycle RED tests**

Cover `trigger→a→b→a`, error-lane cycles, switch cycles, mixed sequence/handoff cycles, and a legal bounded loop whose declared loop edge is removed before DAG validation. Assert validate/plan/create/update all reject the illegal shapes before persistence.

```ts
expect(codes(validateDefinition(sequenceCycle()))).toContain('non-loop-cycle')
expect(codes(validateDefinition(validBoundedLoop()))).not.toContain('non-loop-cycle')
expect(() => createDefinition(root, sequenceCycle(), { layoutIntent: 'generated' })).toThrow(/cycle/i)
```

- [ ] **Step 2: Write complexity and responsiveness RED tests**

Assert accepted near-limit sparse graphs complete inside a generous `500ms` wall/timer-delay budget, over-limit node/edge/density/input graphs reject inside `100ms`, and create/update never write an over-limit file.

```ts
const started = performance.now()
let timerDelay = 0
const tick = new Promise<void>((resolve) => setTimeout(() => { timerDelay = performance.now() - started; resolve() }, 0))
const planned = planWorkflowAuthoringInput({ definition: nearLimitDag() })
await tick
expect(planned.ok).toBe(true)
expect(timerDelay).toBeLessThan(500)
```

- [ ] **Step 3: Run and retain RED**

```bash
pnpm --filter jinn-cli test -- \
  src/workflows/__tests__/definition.test.ts \
  src/workflows/__tests__/complexity.test.ts \
  src/gateway/__tests__/workflow-definitions-route.test.ts \
  > /tmp/workflow-layout-remediation-safety-red.txt 2>&1
```

- [ ] **Step 4: Implement fail-fast limits and stable DAG validation**

Check serialized size and node/edge/density counts before per-node/per-edge validation. Build stable non-loop adjacency over validated endpoints, run Kahn/DFS in `O(V+E)`, and return an actionable cycle path. Reuse the `256KiB` constant at the workflow HTTP boundaries and direct authoring compiler.

- [ ] **Step 5: Run GREEN, mutation checks, and commit**

Mutate away each limit/cycle guard and confirm its targeted test fails, then commit:
```bash
git commit -m "fix(workflows): bound and validate executable graphs"
```

### Task 3: Detect all bounded non-loop segment crossings

**Files:**
- Modify: `packages/jinn/src/workflows/layout.ts`
- Modify: `packages/jinn/src/workflows/__tests__/layout.test.ts`

**Interfaces:**
- Port segment: source expanded-envelope right-center → target expanded-envelope left-center.
- Exclude loop edges and edge pairs sharing either endpoint.

- [ ] **Step 1: Write crossing RED and property tests**

Cover unequal ranks, long edges, port offsets, collinear non-crossing, shared endpoints, and routed loops. Add seeded generated-DAG loops proving normalizer determinism/idempotency and bounded completion without snapshot-only assertions.

```ts
expect(evaluateWorkflowLayout(unequalRankCrossing()).reasons.map((r) => r.code)).toContain('edge-crossing')
expect(evaluateWorkflowLayout(sharedEndpointFanout()).reasons.map((r) => r.code)).not.toContain('edge-crossing')
```

- [ ] **Step 2: Run RED and retain evidence**

```bash
pnpm --filter jinn-cli test -- src/workflows/__tests__/layout.test.ts \
  > /tmp/workflow-layout-remediation-crossing-red.txt 2>&1
```

- [ ] **Step 3: Implement bounded sweep candidates and strict write postcondition**

Sort port segments by minimum x, compare only overlapping x/y bounding boxes, then apply robust proper-segment intersection. Graph limits bound the worst candidate count. After normalization, throw `WorkflowLayoutError` if diagnostics remain invalid.

- [ ] **Step 4: Run GREEN and commit**

```bash
git commit -m "fix(workflows): validate bounded edge intersections"
```

### Task 4: Publish caller-specific approval capability and render honest controls

**Files:**
- Modify: `packages/jinn/src/gateway/api.ts`
- Modify: `packages/jinn/src/gateway/__tests__/workflow-definitions-route.test.ts`
- Modify: `packages/jinn/src/gateway/__tests__/work-item-approval-route.test.ts`
- Modify: `packages/web/src/lib/api.ts`
- Modify: `packages/web/src/routes/workflow/run-view.tsx`
- Modify: `packages/web/src/routes/workflow/__tests__/run-view.test.tsx`
- Modify: `e2e/workflow-layout/workflow-layout.spec.ts`

**Interfaces:**
- Add non-persisted `approvalCapability: { canDecide:boolean; target:string|null; needsYou:boolean; escalated:boolean } | null` to run responses.

- [ ] **Step 1: Write server RED for authorized, unauthorized, operator, and Needs-you routing**

Use real capability-bound sessions and mirrored Todos. GET/start/resolve responses must agree with the same `resolveApprovalDecisionAuthority` used by POST; unauthorized POST remains 403.

- [ ] **Step 2: Write web RED**

Authorized parked runs render Approve/Reject. Unauthorized runs render no active decision controls and calm `Waiting on <target>` plus escalation/Needs-you guidance.

- [ ] **Step 3: Run RED and retain evidence**

```bash
pnpm --filter jinn-cli test -- src/gateway/__tests__/workflow-definitions-route.test.ts src/gateway/__tests__/work-item-approval-route.test.ts \
  > /tmp/workflow-layout-remediation-approval-server-red.txt 2>&1
pnpm --filter @jinn/web test -- src/routes/workflow/__tests__/run-view.test.tsx \
  > /tmp/workflow-layout-remediation-approval-web-red.txt 2>&1
```

- [ ] **Step 4: Implement one read projection and gate the UI**

Project capability from the mirrored approval record at every run-response boundary without modifying the durable run. Pass `onResolveGate` only when `canDecide` is true; keep the backend authority check unchanged.

- [ ] **Step 5: Replace the E2E 403-click contract, run GREEN, and commit**

```bash
git commit -m "fix(workflows): project approval authority into run views"
```

### Task 5: Guard every SPA exit while preserving the intended target

**Files:**
- Modify: `packages/web/src/main.tsx`
- Modify: `packages/web/src/routes/workflow/page.tsx`
- Modify: `packages/web/src/routes/workflow/edit.tsx`
- Modify: `packages/web/src/routes/workflow/__tests__/page.test.tsx`
- Modify: `packages/web/src/routes/workflow/__tests__/edit-graph.test.tsx`
- Modify: `e2e/workflow-layout/workflow-layout.spec.ts`

**Interfaces:**
- Add `WorkflowLeaveActions { save(): Promise<boolean>; discard(): void }` registered by the editor.
- One calm dialog offers `Stay`, `Discard`, and `Save` for router blocks and lens changes.

- [ ] **Step 1: Write RED for all navigation paths**

Use a real `createMemoryRouter` to exercise Link/sidebar, breadcrumb, global-search-style programmatic navigation, workflow-id change, Back/Forward POP, and local Editor→Executions. Assert Stay resets, Discard proceeds to the exact blocked target, Save proceeds only after a successful save, and focus returns coherently.

- [ ] **Step 2: Run RED and retain evidence**

```bash
pnpm --filter @jinn/web test -- src/routes/workflow/__tests__/page.test.tsx src/routes/workflow/__tests__/edit-graph.test.tsx \
  > /tmp/workflow-layout-remediation-navigation-red.txt 2>&1
```

- [ ] **Step 3: Move the app to a data router and implement one blocker dialog**

Replace `BrowserRouter + Routes` with `createBrowserRouter + RouterProvider + Outlet`. Use `useBlocker(editDirty)` for all SPA/PUSH/REPLACE/POP/programmatic navigation and retain `beforeunload` for document exits. The blocker stores React Router's intended location; no manual path reconstruction.

- [ ] **Step 4: Run GREEN/browser navigation coverage and commit**

```bash
git commit -m "fix(web): guard dirty workflow navigation"
```

### Task 6: Reframe on controlled breakpoint/orientation changes only

**Files:**
- Modify: `packages/web/src/routes/workflow/canvas-view.tsx`
- Modify: `packages/web/src/routes/workflow/canvas.tsx`
- Modify: `packages/web/src/routes/workflow/__tests__/canvas-model.test.ts`
- Modify: `packages/web/src/routes/workflow/__tests__/canvas.test.tsx`
- Modify: `e2e/workflow-layout/workflow-layout.spec.ts`

**Interfaces:**
- Add pure `canvasViewportClass(width,height): 'mobile-portrait'|'mobile-landscape'|'desktop-portrait'|'desktop-landscape'`.
- Include the observed class in `viewportFrameKey`; exact pixel changes do not alter identity.

- [ ] **Step 1: Write RED for desktop↔mobile, same-breakpoint rotation, and user pan ownership**

Mock `ResizeObserver`, emit controlled dimensions, and assert exactly one reframe per class change; same-class resize and graph position changes do not reframe. Explicit Fit all/user pan remains owned until a meaningful class change.

- [ ] **Step 2: Run RED and retain evidence**

```bash
pnpm --filter @jinn/web test -- src/routes/workflow/__tests__/canvas-model.test.ts src/routes/workflow/__tests__/canvas.test.tsx \
  > /tmp/workflow-layout-remediation-framing-red.txt 2>&1
```

- [ ] **Step 3: Implement ResizeObserver viewport classification and run GREEN**

Observe the actual `[data-testid=wf-canvas]` container, include only breakpoint/orientation class in frame identity, and continue excluding geometry-only changes.

- [ ] **Step 4: Commit**

```bash
git commit -m "fix(web): reframe workflows on viewport class changes"
```

### Task 7: Reuse closed authoring schemas on every MCP write tool

**Files:**
- Modify: `packages/jinn/src/mcp/workflow-tools.ts`
- Modify: `packages/jinn/src/mcp/__tests__/workflow-tools.test.ts`
- Modify: `packages/jinn/src/mcp/__tests__/tool-manifest-budget.test.ts`

**Interfaces:**
- Shared closed SOP schema for plan/validate/create/update.
- Shared closed raw definition schema for plan/validate/create.
- Closed mutable patch schema for update.

- [ ] **Step 1: Write manifest RED snapshots/assertions**

For all four authoring tools assert closed nested options/session/retry/gate/condition/node/edge schemas, `onError`, `lane`, switch/wait/fail fields, no `edge.on`, and rejection of unknown opaque fields.

- [ ] **Step 2: Run RED and retain evidence**

```bash
pnpm --filter jinn-cli test -- src/mcp/__tests__/workflow-tools.test.ts src/mcp/__tests__/tool-manifest-budget.test.ts \
  > /tmp/workflow-layout-remediation-schema-red.txt 2>&1
```

- [ ] **Step 3: Implement shared schema builders, run GREEN, and commit**

```bash
git commit -m "fix(mcp): close every workflow authoring schema"
```

### Task 8: Fresh isolated re-QA and independent review handoff

**Files:**
- Modify as required by RED browser failures: `e2e/workflow-layout/**`
- Update: `docs/superpowers/plans/2026-07-12-workflow-layout-independent-qa-remediation.md`

- [ ] **Step 1: Run focused suites, both typechecks, and both builds**

```bash
pnpm --filter jinn-cli test -- src/workflows src/gateway/__tests__/workflow-definitions-route.test.ts src/gateway/__tests__/work-item-approval-route.test.ts src/mcp/__tests__/workflow-tools.test.ts
pnpm --filter @jinn/web test -- src/routes/workflow
pnpm typecheck --force
pnpm build --force
```

- [ ] **Step 2: Run five fresh GPT-5.5-low authors and the new browser matrix on 7920**

```bash
JINN_VERIFY_PORT=7920 JINN_IMPLEMENTATION_GREEN=1 \
  ./scripts/verify-workflow-layout.sh --with-authors \
  > /tmp/workflow-layout-remediation-browser-final.txt 2>&1
```

Required browser additions: authorized/unauthorized approval, Needs-you guidance, sidebar/breadcrumb/global-search/programmatic/Back navigation, Save/Discard/Stay destination preservation, desktop↔mobile and both same-breakpoint orientation transitions, user pan/Fit-all ownership, Apply+reload, success/failure/approval, and every canonical/child-authored graph in both themes/motion modes.

- [ ] **Step 3: Run full suites and audits**

```bash
pnpm --filter jinn-cli test
pnpm --filter @jinn/web test
pnpm typecheck --force
pnpm build --force
git diff --check main...HEAD
git log --format=%B main..HEAD | grep -i 'Co-Authored-By'
pnpm --filter jinn-cli test -- src/shared/__tests__/privacy-guard.test.ts
```

- [ ] **Step 4: Re-run exact integration analysis**

Record local-main and origin-main SHAs/counts, confirm the corrected branch still descends from `main@62dda29`, and probe the complete corrected range in a disposable worktree. Guidance must remain: integrate the complete range onto local main only after reviewer PASS; reconcile the unpublished local-main baseline before attempting origin-main.

- [ ] **Step 5: Send the corrected evidence to session `d8293c0c-8508-4fdc-944a-5c042acb5d08`**

Do not recommend merging until that same independent reviewer returns PASS. If a finding repeats for three reviewer rounds without architectural progress, stop and escalate rather than forwarding in circles.

## Plan self-review

- Coverage: all five HIGH and three MEDIUM findings have a dedicated RED→GREEN task and browser/integration follow-up.
- TDD: every production edit is preceded by a retained targeted failure log.
- Architecture: geometry authority, structural safety, layout quality, approval capability, navigation blocking, viewport ownership, and authoring schema remain separate concerns.
- Privacy/deploy: all test fixtures are generic and all runtime verification is pinned to a fresh `7920+` sandbox.
