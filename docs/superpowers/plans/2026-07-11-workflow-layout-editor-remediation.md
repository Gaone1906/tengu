# Workflow Layout and Editor Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every generated workflow persist a deterministic, readable strict-left-to-right layout and make the Workflow Editor capable of repairing, applying, saving, reloading, and running the real graph on desktop and mobile.

**Architecture:** The gateway becomes the sole layout authority through a pure `workflows/layout.ts` normalizer and quality evaluator. Definitions carry server-owned layout provenance; all generated/unknown writes normalize before the existing atomic store write, while manual writes are preserved only when structurally valid and otherwise return actionable geometry errors. The web editor keeps a real mutable graph draft, requests the same server plan for Tidy preview, applies that preview explicitly, and persists geometry/topology through the existing optimistic-lock save path.

**Tech Stack:** TypeScript, Vitest, Node file-backed workflow store, React 19, XyFlow/React Flow, Tailwind/Ledger tokens, Playwright, Jinn sandbox gateway.

## Global Constraints

- Use Codex GPT-5.6-sol xhigh only for implementation and review work; five final authoring probes use fresh GPT-5.5-low sandbox children as explicitly required.
- RED tests must be written and observed failing before production changes.
- The normalizer is pure, deterministic, idempotent, strict-LTR, 20px-grid-snapped, and covers linear, branch, merge, approval, supported error lane, and bounded loop graphs.
- Expanded envelopes include rendered card height plus model/employee dock discs and caption reserve; horizontal clearance is at least 96px and same-rank vertical clearance at least 64px.
- MCP/SOP/unknown AI graphs never become manual truth; valid manual layouts preserve byte-equivalent coordinates and structurally invalid manual saves reject with actionable errors.
- Plan/validate returns provenance, quality reasons, and a normalized preview; persisted generated definitions atomically contain normalized coordinates.
- Unsupported `edge.on` is rejected. Recipes/schema teach `options.onError`, `lane:'error'`, switch/wait/fail nodes, and that text `ERROR` is ordinary output rather than a transport/session failure.
- Tidy uses the gateway normalizer, previews without mutating the draft, and reveals a distinct Apply layout action; Apply/drag/connect/add/remove participate in dirty, discard, save, reload, and leave guards.
- Mobile opens the first/current/failed/approval node at readable zoom; Fit all remains explicit. Desktop fits only when the result stays readable.
- The Executions lens has a first-class Run action with JSON input and stable idempotency key; no raw POST instructions remain. Failure evidence and approval actions remain intact.
- Use only Ledger tokens; no hardcoded colors, no gratuitous chrome, no rest hairlines, 40–44px interactive hit areas, and reduced-motion-safe transitions.
- Use a fresh sanitized throwaway `JINN_HOME`, ports 7800+, and never access, mutate, restart, or test production `:7777` or production `~/.jinn` data.
- Preserve unrelated dirty worktree changes; commit only scoped files; no `Co-Authored-By` trailers.
- Before every commit run staged privacy grep and whitespace audit.

---

## File map and ownership

- `packages/jinn/src/workflows/layout.ts`: pure layout envelopes, provenance/quality types, quality evaluator, deterministic normalizer, and write policy.
- `packages/jinn/src/workflows/definition.ts`: persisted `layout` metadata and closed edge-field validation.
- `packages/jinn/src/workflows/authoring.ts`, `sop.ts`: mark AI/SOP input generated and return layout diagnostics/preview.
- `packages/jinn/src/workflows/definition-store.ts`: normalize generated/unknown writes inside the existing atomic transaction and reject invalid manual writes.
- `packages/jinn/src/mcp/workflow-tools.ts`: closed nested raw-graph schema and accurate authoring recipe.
- `packages/jinn/src/gateway/api.ts`: plan response and existing create/update routes consume the layout policy; run route remains execution authority.
- `packages/web/src/lib/api.ts`: layout wire types, plan API, and start-run API.
- `packages/web/src/routes/workflow/edit.tsx`: mutable graph draft, topology/geometry operations, Tidy preview, Apply layout, save/discard/reload.
- `packages/web/src/routes/workflow/canvas.tsx`, `canvas-view.tsx`, `canvas-model.ts`: editable React Flow gestures, readable framing, explicit Fit all, loop routing, progressive controls.
- `packages/web/src/routes/workflow/run-view.tsx`: Run action with input/idempotency and existing evidence/approval preservation.
- `packages/web/src/routes/workflow/page.tsx`: browser leave guard for every editor mutation.
- `packages/jinn/src/workflows/__tests__/layout.test.ts`, `definition-store.test.ts`, `definition.test.ts`, `packages/jinn/src/mcp/__tests__/workflow-tools.test.ts`: server RED/GREEN proof.
- `packages/web/src/routes/workflow/__tests__/edit-graph.test.tsx`, `canvas-model.test.ts`, `canvas.test.tsx`, `run-view.test.tsx`, `page.test.tsx`: client RED/GREEN proof.
- `scripts/workflow-layout-sandbox/`: sanitized seed, five-child authoring runner, browser matrix, and geometry metrics; writes runtime output only under sandbox artifacts.

### Task 1: Server layout contract and RED property suite

**Files:**
- Create: `packages/jinn/src/workflows/__tests__/layout.test.ts`
- Modify: `packages/jinn/src/workflows/__tests__/definition.test.ts`
- Modify: `packages/jinn/src/workflows/__tests__/definition-store.test.ts`
- Modify: `packages/jinn/src/mcp/__tests__/workflow-tools.test.ts`

**Interfaces:**
- Produces the wished-for API `normalizeWorkflowLayout(def)`, `evaluateWorkflowLayout(def)`, `prepareWorkflowLayoutForWrite(def, intent)`, and `WorkflowLayoutDiagnostics` consumed by Task 2.

- [ ] **Step 1: Write the six-shape RED table and invariant helpers**

```ts
const shapes = {
  linear: linearDefinition(),
  branch: branchDefinition(),
  merge: mergeDefinition(),
  approval: approvalDefinition(),
  error: errorLaneDefinition(),
  loop: boundedLoopDefinition(),
}

for (const [name, input] of Object.entries(shapes)) {
  it(`${name}: is deterministic, idempotent, snapped, clear, and strict-LTR`, () => {
    const once = normalizeWorkflowLayout(input)
    const twice = normalizeWorkflowLayout(once.definition)
    expect(twice.definition.nodes).toEqual(once.definition.nodes)
    expect(once.diagnostics.reasons).toEqual(twice.diagnostics.reasons)
    expect(gridViolations(once.definition)).toEqual([])
    expect(expandedEnvelopeOverlaps(once.definition)).toEqual([])
    expect(nonLoopClearanceViolations(once.definition, 96)).toEqual([])
    expect(verticalClearanceViolations(once.definition, 64)).toEqual([])
  })
}
```

- [ ] **Step 2: Add RED quality/provenance cases**

```ts
it.each(['missing', 'overlap', 'backtracking', 'index-like', 'poor-clearance', 'bad-merge', 'tangled'])(
  'normalizes %s generated/unknown layouts',
  (kind) => expect(prepareWorkflowLayoutForWrite(badLayout(kind), 'generated').definition.layout)
    .toEqual({ source: 'normalized', version: 1 }),
)

it('preserves valid manual coordinates', () => {
  const manual = validManualDefinition()
  expect(prepareWorkflowLayoutForWrite(manual, 'manual').definition.nodes).toEqual(manual.nodes)
})

it('rejects overlapping manual coordinates with node ids and a Tidy instruction', () => {
  expect(() => prepareWorkflowLayoutForWrite(overlappingManualDefinition(), 'manual'))
    .toThrow(/overlap.*build.*verify.*Tidy/i)
})
```

- [ ] **Step 3: Add RED dock-envelope and loop-route assertions**

```ts
it('reserves model/employee dock discs and caption lanes', () => {
  const result = normalizeWorkflowLayout(fourWayBranchWithDocks())
  expect(expandedEnvelopeOverlaps(result.definition)).toEqual([])
  expect(result.diagnostics.envelopes.find((x) => x.nodeId === 'author')!.height)
    .toBeGreaterThan(result.diagnostics.envelopes.find((x) => x.nodeId === 'plain')!.height)
})

it('excludes bounded loop back-edges from rank and emits a stable below-graph route', () => {
  const result = normalizeWorkflowLayout(boundedLoopDefinition())
  expect(result.diagnostics.loopRoutes).toEqual({ retry: { side: 'below', lane: 0 } })
})
```

- [ ] **Step 4: Add RED schema/store/MCP assertions**

```ts
expect(validateDefinition(defWithEdgeOn()).errors).toContainEqual(
  expect.objectContaining({ code: 'unsupported-edge-field', ref: 'bad-edge' }),
)
expect(createDefinition(root, generatedDefinition()).layout).toEqual({ source: 'normalized', version: 1 })
expect(JSON.parse(readFileSync(file, 'utf8')).nodes).toEqual(created.nodes)
expect(plan.layout.normalizedPreview.layout).toEqual({ source: 'normalized', version: 1 })
expect(rawDefinitionSchema.additionalProperties).toBe(false)
```

- [ ] **Step 5: Run RED and save evidence**

Run:
```bash
pnpm --filter jinn-cli test -- src/workflows/__tests__/layout.test.ts src/workflows/__tests__/definition.test.ts src/workflows/__tests__/definition-store.test.ts src/mcp/__tests__/workflow-tools.test.ts 2>&1 | tee /tmp/workflow-layout-red-server.txt
```
Expected: FAIL because `layout.ts`, `layout` metadata, unsupported edge-field validation, normalization policy, and plan diagnostics do not exist.

### Task 2: Pure normalizer, provenance, quality gate, schema, and atomic persistence

**Files:**
- Create: `packages/jinn/src/workflows/layout.ts`
- Modify: `packages/jinn/src/workflows/definition.ts`
- Modify: `packages/jinn/src/workflows/authoring.ts`
- Modify: `packages/jinn/src/workflows/sop.ts`
- Modify: `packages/jinn/src/workflows/definition-store.ts`
- Modify: `packages/jinn/src/mcp/workflow-tools.ts`
- Modify: `packages/jinn/src/gateway/api.ts`

**Interfaces:**
- Produces:
```ts
export type WorkflowLayoutSource = 'generated' | 'normalized' | 'manual'
export interface WorkflowLayoutMetadata { source: WorkflowLayoutSource; version: 1 }
export interface WorkflowLayoutDiagnostics {
  source: WorkflowLayoutSource
  version: 1
  normalized: boolean
  reasons: LayoutReason[]
  quality: { valid: boolean; score: number }
  envelopes: LayoutEnvelope[]
  loopRoutes: Record<string, { side: 'below'; lane: number }>
}
export function evaluateWorkflowLayout(def: EditableWorkflowDefinition): WorkflowLayoutDiagnostics
export function normalizeWorkflowLayout(def: EditableWorkflowDefinition): { definition: EditableWorkflowDefinition; diagnostics: WorkflowLayoutDiagnostics }
export function prepareWorkflowLayoutForWrite(def: EditableWorkflowDefinition, intent?: 'generated' | 'manual'): { definition: EditableWorkflowDefinition; diagnostics: WorkflowLayoutDiagnostics }
```

- [ ] **Step 1: Add persisted provenance and strict edge-field validation**

```ts
export interface EditableWorkflowDefinition {
  // existing fields
  layout?: WorkflowLayoutMetadata
}

const EDGE_KEYS = new Set(['id', 'from', 'to', 'kind', 'label', 'gate', 'when', 'lane'])
for (const key of Object.keys(e as object)) {
  if (!EDGE_KEYS.has(key)) err('unsupported-edge-field', `edge "${e.id}" has unsupported field "${key}"; use options.onError:'error-edge' on the source and lane:'error' on its failure edge`, e.id)
}
```

- [ ] **Step 2: Implement fixed semantic envelopes**

```ts
export const LAYOUT_GRID = 20
export const LAYOUT_HORIZONTAL_CLEARANCE = 120
export const LAYOUT_VERTICAL_CLEARANCE = 80
export function nodeLayoutEnvelope(node: WorkflowNode): LayoutEnvelope {
  const card = cardSize(node)
  const docks = node.type === 'step' && node.instructions && node.actor && (node.options?.model || node.actor.kind === 'employee')
  return { nodeId: node.id, width: card.width, height: card.height + (docks ? 156 : 0) }
}
```

- [ ] **Step 3: Implement deterministic ranks, stable lane order, merge placement, and bounded-loop routing**

```ts
const structuralEdges = def.edges.filter((edge) => edge.kind !== 'loop')
const rank = longestPathRanks(def.nodes, structuralEdges)
const order = authoredDepthFirstOrder(def.nodes, structuralEdges)
const groups = groupByRank(def.nodes, rank, order)
const xByRank = cumulativeEnvelopeWidths(groups, LAYOUT_HORIZONTAL_CLEARANCE)
const positioned = placeRankGroups(groups, xByRank, LAYOUT_VERTICAL_CLEARANCE)
centerMergesOnPredecessors(positioned, structuralEdges)
resolveRankCollisions(positioned, groups)
snapAll(positioned, LAYOUT_GRID)
const loopRoutes = routeLoopsBelow(def.edges.filter((edge) => edge.kind === 'loop'))
```

- [ ] **Step 4: Implement write policy and diagnostics**

```ts
export function prepareWorkflowLayoutForWrite(def, intent = def.layout?.source === 'manual' ? 'manual' : 'generated') {
  const quality = evaluateWorkflowLayout(def)
  if (intent === 'manual') {
    if (!quality.quality.valid) throw new WorkflowLayoutError(quality.reasons)
    return { definition: { ...def, layout: { source: 'manual', version: 1 } }, diagnostics: quality }
  }
  return normalizeWorkflowLayout({ ...def, layout: { source: 'generated', version: 1 } })
}
```

- [ ] **Step 5: Apply policy inside create/update before existing atomic serialization**

```ts
const prepared = prepareWorkflowLayoutForWrite(def, def.layout?.source === 'manual' ? 'manual' : 'generated')
assertValid(prepared.definition, 'definition')
writeExclusive(definitionFile(root, def.id), serializeDefinition(prepared.definition), def.id)
```

- [ ] **Step 6: Return plan diagnostics and normalized preview**

```ts
const layout = normalizeWorkflowLayout(compiled.definition)
return {
  ok: validation.ok && execution.ok,
  definition: compiled.definition,
  layout: { diagnostics: layout.diagnostics, normalizedPreview: layout.definition },
  validation,
  execution,
}
```

- [ ] **Step 7: Close MCP schemas and teach execution semantics**

Use nested `additionalProperties:false` schemas for definition, nodes, edges, options, retry/session, conditions, actor, trigger, gate, and position. Node `type` enumerates `trigger|step|gate|switch|fail|wait`; edge `lane` enumerates only `error`; no `on` field exists. Add this exact recipe sentence: `Assistant text such as "ERROR" is ordinary successful output. Error lanes activate only when the session/transport settles failed after retry policy.`

- [ ] **Step 8: Run GREEN server suite and commit phase 1**

Run:
```bash
pnpm --filter jinn-cli test -- src/workflows/__tests__/layout.test.ts src/workflows/__tests__/definition.test.ts src/workflows/__tests__/definition-store.test.ts src/mcp/__tests__/workflow-tools.test.ts
pnpm --filter jinn-cli typecheck
git diff --check
git add packages/jinn/src/workflows/layout.ts packages/jinn/src/workflows/definition.ts packages/jinn/src/workflows/authoring.ts packages/jinn/src/workflows/sop.ts packages/jinn/src/workflows/definition-store.ts packages/jinn/src/mcp/workflow-tools.ts packages/jinn/src/gateway/api.ts packages/jinn/src/workflows/__tests__/layout.test.ts packages/jinn/src/workflows/__tests__/definition.test.ts packages/jinn/src/workflows/__tests__/definition-store.test.ts packages/jinn/src/mcp/__tests__/workflow-tools.test.ts
LEAK_PATTERN=$(sed -n "s/.*git diff --cached | grep -iE '\([^']*\)'.*/\1/p" "$HOME/.jinn/CLAUDE.md" | head -1); git diff --cached | grep -iE "$LEAK_PATTERN" && exit 1 || true
git commit -m "feat(workflows): normalize generated graph layouts"
```
Expected: focused tests and typecheck PASS; staged privacy grep returns no matches.

### Task 3: Editor/canvas/run RED behavior suite

**Files:**
- Create: `packages/web/src/routes/workflow/__tests__/edit-graph.test.tsx`
- Modify: `packages/web/src/routes/workflow/__tests__/canvas-model.test.ts`
- Modify: `packages/web/src/routes/workflow/__tests__/canvas.test.tsx`
- Modify: `packages/web/src/routes/workflow/__tests__/run-view.test.tsx`
- Create: `packages/web/src/routes/workflow/__tests__/page.test.tsx`

**Interfaces:**
- Produces the wished-for props `editable`, `onPositionChange`, `onConnectNodes`, `onRemoveNode`, `layoutPreview`, `onTidy`, `onApplyLayout`, and API methods `planWorkflowDefinition`/`startWorkflowRun`.

- [ ] **Step 1: Add RED graph-draft unit tests**

```ts
expect(moveNode(graph, 'build', { x: 413, y: 187 }).nodes.find(n => n.id === 'build')!.position)
  .toEqual({ x: 420, y: 180 })
expect(connectNodes(graph, 'build', 'verify').edges).toContainEqual(expect.objectContaining({ from: 'build', to: 'verify' }))
expect(removeNode(graph, 'verify').edges.some(e => e.from === 'verify' || e.to === 'verify')).toBe(false)
expect(addNode(graph, 'step').nodes).toHaveLength(graph.nodes.length + 1)
expect(isGraphDirty(definition, changedGraph)).toBe(true)
```

- [ ] **Step 2: Add RED component gestures, Tidy preview, Apply, save, discard, and reload tests**

```ts
fireEvent.click(screen.getByRole('button', { name: 'Tidy' }))
await waitFor(() => expect(planWorkflowDefinition).toHaveBeenCalled())
expect(screen.getByRole('button', { name: 'Apply layout' })).toBeEnabled()
expect(screen.queryByTestId('wf-edit-dirty')).toBeNull()
fireEvent.click(screen.getByRole('button', { name: 'Apply layout' }))
expect(screen.getByTestId('wf-edit-dirty')).toBeTruthy()
fireEvent.click(screen.getByTestId('wf-edit-save'))
expect(updateWorkflowDefinition).toHaveBeenCalledWith('sample', expect.objectContaining({ layout: { source: 'manual', version: 1 } }), 3)
```

- [ ] **Step 3: Add RED editable React Flow and mobile framing tests**

```ts
expect(buildFlowGraph(nodes, null, vi.fn(), edges, true).flowNodes.every(n => n.draggable && n.connectable)).toBe(true)
expect(pickFocusNode(failedNodes)?.id).toBe('failed')
expect(initialViewportPlan({ mobile: true, nodes: failedNodes }).zoom).toBeGreaterThanOrEqual(0.85)
expect(initialViewportPlan({ mobile: false, fitZoom: 0.42, nodes }).mode).toBe('focus')
```

- [ ] **Step 4: Add RED Run action tests**

```ts
fireEvent.click(screen.getByRole('button', { name: 'Run' }))
fireEvent.change(screen.getByLabelText('Run input'), { target: { value: '{"ticket":"A-1"}' } })
fireEvent.click(screen.getByRole('button', { name: 'Start run' }))
await waitFor(() => expect(startWorkflowRun).toHaveBeenCalledWith('sample', { ticket: 'A-1' }, expect.any(String)))
expect(screen.queryByText(/POST \/api\/workflow-definitions/)).toBeNull()
```

- [ ] **Step 5: Run RED and save evidence**

Run:
```bash
pnpm --filter @jinn/web test -- src/routes/workflow/__tests__/edit-graph.test.tsx src/routes/workflow/__tests__/canvas-model.test.ts src/routes/workflow/__tests__/canvas.test.tsx src/routes/workflow/__tests__/run-view.test.tsx src/routes/workflow/__tests__/page.test.tsx 2>&1 | tee /tmp/workflow-layout-red-web.txt
```
Expected: FAIL on missing graph operations, editable props, layout plan/apply actions, readable framing, and Run API/action.

### Task 4: Real graph editing, shared Tidy/Apply, framing, loop routes, and Run UI

**Files:**
- Modify: `packages/web/src/lib/api.ts`
- Modify: `packages/web/src/routes/workflow/edit.tsx`
- Modify: `packages/web/src/routes/workflow/canvas-model.ts`
- Modify: `packages/web/src/routes/workflow/canvas.tsx`
- Modify: `packages/web/src/routes/workflow/canvas-view.tsx`
- Modify: `packages/web/src/routes/workflow/run-view.tsx`
- Modify: `packages/web/src/routes/workflow/page.tsx`
- Modify: `packages/web/src/routes/globals.css` only if a missing reduced-motion/token-safe rule is required.

**Interfaces:**
- Consumes Task 2 plan response and provenance.
- Produces a mutable `WorkflowGraphDraft` and persisted manual layout/topology.

- [ ] **Step 1: Add wire types and gateway calls**

```ts
export interface WorkflowLayoutWire { source: 'generated' | 'normalized' | 'manual'; version: 1 }
export interface WorkflowPlanWire { ok: boolean; layout: { diagnostics: LayoutDiagnosticsWire; normalizedPreview: EditableWorkflowDefinitionWire } }
planWorkflowDefinition: (definition) => post<WorkflowPlanWire>('/api/workflow-definitions/plan', { definition })
startWorkflowRun: (id, input, idempotencyKey) => post<WorkflowRunWire>(`/api/workflow-definitions/${encodeURIComponent(id)}/run`, { input, idempotencyKey })
```

- [ ] **Step 2: Introduce one mutable graph draft**

```ts
interface WorkflowGraphDraft { nodes: WorkflowNodeWire[]; edges: WorkflowEdgeWire[]; layout: WorkflowLayoutWire }
const [graph, setGraph] = useState(() => graphFromDefinition(definition))
const dirty = isDirty(def, drafts) || isGraphDirty(def, graph) || triggerDirty
```

All operations return new arrays, snap drag positions to 20px, mint collision-proof ids, remove incident edges, and set `layout:{source:'manual',version:1}`.

- [ ] **Step 3: Enable controlled React Flow gestures**

Set `draggable/connectable/selectable` from `editable`; wire `onNodeDragStop`, `onConnect`, selection, Delete/Backspace for non-trigger nodes, and prevent self/dangling/duplicate edges. Keep run canvases read-only.

- [ ] **Step 4: Add progressively disclosed Add/Remove controls**

The editor toolbar gets one quiet `Add` button opening a token-only menu for Step, Approval, Switch, Wait, and Fail. Defaults are schema-valid (`step` inline; approval with generated ref; wait 5 minutes; fail with editable starter message). The selected inspector gets a destructive `Remove step` action; trigger removal is unavailable.

- [ ] **Step 5: Make Tidy a server preview with explicit Apply layout**

`Tidy` posts the current graph with generated intent, overlays `normalizedPreview.nodes` without dirtying the draft, and reveals `Apply layout`. Apply copies preview positions into `graph.nodes`, clears preview, sets manual provenance, and marks dirty. Any topology/property edit clears a stale preview.

- [ ] **Step 6: Implement readable framing and loop route data**

```ts
export function initialViewportPlan({ mobile, fitZoom, nodes }) {
  const focus = pickFocusNode(nodes)
  if (mobile || fitZoom < 0.65) return { mode: 'focus', nodeId: focus?.id, zoom: mobile ? 0.9 : 0.8 }
  return { mode: 'fit', zoom: fitZoom }
}
```

Prioritize parked, failed/blocked, running/active, current, first non-trigger. Keep Fit all explicit. For `kind:'loop'`, compute one below-graph lane per stable edge order and pass it to the custom edge so the right-out/left-in path clears every expanded envelope.

- [ ] **Step 7: Add first-class Run with input/idempotency**

Add a quiet Run button to the Executions strip and empty state. It reveals an inline `Run input` JSON field and stable generated idempotency key, validates JSON locally, calls `startWorkflowRun`, refreshes/selects the returned run, and preserves all existing failed banners, node evidence, and approval actions.

- [ ] **Step 8: Add unload/lens/back guards for graph mutations**

Use the existing `onDirtyChange` signal for property, geometry, topology, and Apply changes. Register `beforeunload` while dirty, retain current lens/back confirmations, and ensure Discard reconstructs graph/drafts/layout from the last persisted definition.

- [ ] **Step 9: Run GREEN web suite and commit**

Run:
```bash
pnpm --filter @jinn/web test -- src/routes/workflow/__tests__/edit-graph.test.tsx src/routes/workflow/__tests__/canvas-model.test.ts src/routes/workflow/__tests__/canvas.test.tsx src/routes/workflow/__tests__/run-view.test.tsx src/routes/workflow/__tests__/page.test.tsx
pnpm --filter @jinn/web typecheck
git diff --check
git add packages/web/src/lib/api.ts packages/web/src/routes/workflow packages/web/src/routes/globals.css
LEAK_PATTERN=$(sed -n "s/.*git diff --cached | grep -iE '\([^']*\)'.*/\1/p" "$HOME/.jinn/CLAUDE.md" | head -1); git diff --cached | grep -iE "$LEAK_PATTERN" && exit 1 || true
git commit -m "feat(web): make workflow graphs editable and runnable"
```

### Task 5: Integrated route/store tests and regression gates

**Files:**
- Modify: `packages/jinn/src/mcp/__tests__/workflow-tools.test.ts`
- Modify: `packages/jinn/src/gateway/__tests__/workflow-run-fanout-route.test.ts`
- Modify: `packages/web/src/routes/workflow/__tests__/edit-graph.test.tsx`
- Modify: `packages/web/src/routes/workflow/__tests__/run-view.test.tsx`

- [ ] **Step 1: Add integration tests for normalized create/update/reload**

Create via real MCP route, read the file, update a valid manual layout, reload, and assert the exact applied coordinates and provenance survive. Submit an overlapping manual save and assert HTTP 400 includes node ids, clearance, and Tidy guidance.

- [ ] **Step 2: Add execution integration tests**

Start twice with the same idempotency key and assert one run id; start with JSON input and assert frozen invocation input; assert transport/session failure still renders failed evidence and a parked approval run still renders/decides through the existing route.

- [ ] **Step 3: Run all relevant suites**

Run:
```bash
pnpm --filter jinn-cli test -- src/workflows src/mcp/__tests__/workflow-tools.test.ts src/gateway/__tests__/workflow-run-fanout-route.test.ts
pnpm --filter @jinn/web test -- src/routes/workflow
```
Expected: PASS with no snapshots as the sole proof of geometry.

- [ ] **Step 4: Commit integration gates**

```bash
git add packages/jinn/src/mcp/__tests__/workflow-tools.test.ts packages/jinn/src/gateway/__tests__/workflow-run-fanout-route.test.ts packages/web/src/routes/workflow/__tests__
LEAK_PATTERN=$(sed -n "s/.*git diff --cached | grep -iE '\([^']*\)'.*/\1/p" "$HOME/.jinn/CLAUDE.md" | head -1); git diff --cached | grep -iE "$LEAK_PATTERN" && exit 1 || true
git commit -m "test(workflows): gate layout editor and run integration"
```

### Task 6: Sanitized sandbox and browser matrix

**Files:**
- Create: `scripts/workflow-layout-sandbox/seed.mjs`
- Create: `scripts/workflow-layout-sandbox/author-five.mjs`
- Create: `scripts/workflow-layout-sandbox/browser-matrix.mjs`
- Create: `scripts/workflow-layout-sandbox/measure.mjs`

- [ ] **Step 1: Create a fresh isolated home and build**

```bash
export JINN_HOME=/tmp/jinn-workflow-layout-$RANDOM/home
export JINN_PORT=7810
mkdir -p "$JINN_HOME"
pnpm build
JINN_HOME="$JINN_HOME" node packages/jinn/dist/bin/jinn.js create jinn-workflow-layout -p "$JINN_PORT"
JINN_HOME="$JINN_HOME" node packages/jinn/dist/bin/jinn.js -i jinn-workflow-layout start --daemon
curl -fsS "http://127.0.0.1:$JINN_PORT/api/status"
```

The scripts assert `JINN_PORT >= 7800` and reject any base URL containing `:7777` before making a request.

- [ ] **Step 2: Seed canonical/new/invalid/manual/run states**

Seed linear, branch, merge, approval, supported error lane, and bounded loop definitions through sandbox APIs. Seed new trigger-only, invalid manual overlap (plan-only), valid manual, success, terminal failure, and parked approval records. All names/emails are generic.

- [ ] **Step 3: Launch five fresh GPT-5.5-low sandbox children**

Use the sandbox gateway session API with `engine:'codex'`, `model:'gpt-5.5-low'`, and prompts for representative linear, branch+merge, approval+wait, supported error-lane, and bounded-loop workflows. Each prompt explicitly uses the sandbox MCP endpoint/config and writes only under `$JINN_HOME`; assert every returned session id exists in the sandbox registry and no external gateway URL appears in its context.

- [ ] **Step 4: Run browser matrix**

For every canonical and child-authored graph capture 1440×900 and 390×844, dark/light, normal/reduced motion: initial Editor, Tidy preview, Apply, Save, reload, Executions empty/run success/failure/approval. Record screenshots, trace JSON, console errors, viewport zoom, focus node, scroll positions, and accessibility results under `$JINN_HOME/sandbox-artifacts/<timestamp>/`.

- [ ] **Step 5: Enforce geometry/readability measurements**

Fail the script on any expanded-envelope overlap, non-loop `target.x < source.right + 96`, same-rank vertical gap below 64, merge not right of every predecessor, zoom below 0.75 mobile initial focus or 0.65 desktop fit, clipped labels, missing focus, horizontal body scroll, or Apply+reload coordinate mismatch.

### Task 7: Full verification, central review, and handoff

- [ ] **Step 1: Run full builds/typechecks/tests**

```bash
pnpm --filter jinn-cli typecheck
pnpm --filter @jinn/web typecheck
pnpm --filter jinn-cli test
pnpm --filter @jinn/web test
pnpm --filter jinn-cli build
pnpm --filter @jinn/web build
```

- [ ] **Step 2: Run audits**

```bash
git diff --check main...HEAD
git log --format=%B main..HEAD | rg -i 'Co-Authored-By' && exit 1 || true
LEAK_PATTERN=$(sed -n "s/.*git diff --cached | grep -iE '\([^']*\)'.*/\1/p" "$HOME/.jinn/CLAUDE.md" | head -1); git diff main...HEAD | grep -iE "$LEAK_PATTERN" && exit 1 || true
rg -n 'transition: all|transition-all|rgba\(' packages/web/src/routes/workflow packages/web/src/routes/globals.css
```

Adjudicate each result: no new workflow hardcoded color/transition-all; existing unrelated matches do not block if absent from `main...HEAD`.

- [ ] **Step 3: Review the whole branch centrally**

Review requirements against commits and RED/GREEN logs, inspect every browser screenshot in both themes/breakpoints, compare API/file/browser coordinates, and fix every Critical/Important finding with a covering test before re-review.

- [ ] **Step 4: Update the Jinn design skill with learned durable rules**

If verification confirms new durable rules, append concise generic guidance to `~/.jinn/skills/jinn-design/SKILL.md`: server-owned layout provenance, expanded-envelope normalization, Tidy preview versus Apply, and readable focus framing. Do not place private sandbox paths in the public repo.

- [ ] **Step 5: Final report and Todo handoff**

Report commits, exact RED/GREEN log paths, sandbox home/port and whether stopped, browser artifact directory, five child session ids, full command results, and Before/After tables grouped by the applicable design principles. Move `wi_c239479ad914` to `in_review`; do not merge, deploy, or restart production.

## Plan self-review

- Spec coverage: all nine implementation requirements map to Tasks 1–6; determinism/property tests, six shapes, dock envelopes, manual preservation/rejection, persistence, editor gestures, Apply layout, mobile focus, Run action, failure/approval, five low-model children, and the complete browser matrix are explicit.
- Placeholder scan: no `TBD`, `TODO`, “implement later,” or unspecified error-handling step remains.
- Type consistency: `WorkflowLayoutMetadata` ↔ `WorkflowLayoutWire`, `WorkflowLayoutDiagnostics` ↔ `LayoutDiagnosticsWire`, `normalizedPreview`, `planWorkflowDefinition`, and `startWorkflowRun` use one spelling throughout.
- Execution choice: the user already selected strict plan → TDD → implementation with constrained agent-team parallelism, so execution proceeds without another approval prompt.
