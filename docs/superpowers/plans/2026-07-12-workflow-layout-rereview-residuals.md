# Workflow Layout Re-review Residuals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Close the six residual Workflow findings with durable idempotency, exact routed lens state, accessible dirty-navigation decisions, user-owned viewports, one runtime-enforced workflow schema, and a real production-tokenizer manifest budget.

**Architecture:** The gateway owns an immutable run invocation claim keyed by workflow, stable principal, and idempotency key. A canonical request fingerprint is claimed atomically before execution and replayed only on exact equality; mismatches surface one sanitized typed conflict through HTTP, MCP, and React. Workflow definition structure moves to one shared recursive schema consumed by runtime validation and the four authoring manifests. The web route derives its committed lens from workflow ID plus search state, uses the existing Radix dialog primitive for blocked navigation, and separates volatile run status from hard viewport identity while explicitly recording user viewport ownership.

**Tech Stack:** TypeScript, Node file-backed stores, Vitest, Zod 4/shared JSON Schema, React 19, React Router, Radix Dialog, XyFlow, Tailwind/Ledger tokens, Playwright, pinned js-tiktoken o200k_base, Jinn sandbox gateway.

## Global constraints

- Use Codex GPT-5.6-sol xhigh only for implementation and review. The final five author probes alone use fresh GPT-5.5-low sandbox children.
- Observe strict RED before production code for every finding and retain compact failing output under bounded /tmp evidence files.
- Work only in this isolated Workflow worktree; preserve unrelated worktrees and scratch files.
- Use fresh sanitized throwaway JINN_HOME instances and pinned ports 8060+. Never contact, inspect, mutate, restart, or test production :7777.
- Do not merge, deploy, restart production, or add authorship/sign-off trailers.
- Keep commits scoped: plan, idempotency, route/dialog, viewport, schema/token budget, sandbox verification evidence.
- Before every commit run git diff --check, staged privacy/secret/port scans, and staged trailer scan.
- The browser run is valid only when disk preflight passes, every cell finishes, every listener stops, and the report distinguishes product failures from environment limits. Partial is never called full.
- Preserve the already-passing manual geometry, cycle, graph-bound, approval authority, segment-crossing, Apply-layout, persistence, failure, and approval behavior.

## Root-cause map

| Finding | Root cause | Owning seam |
|---|---|---|
| 1. Run idempotency | fireRef lookup ignores definition/version, input, immutable overrides, and principal; HTTP discards the authorized actor and always returns 201 | run idempotency, store/reconciler, gateway, MCP, Run UI |
| 2. Exact dirty target lens | React Router reuses WorkflowPage; mode, initialLive, and showLive are one-shot state | workflow page/run view |
| 3. Leave-dialog accessibility | A hand-built role=dialog is not a modal interaction boundary | shared Radix dialog + workflow wrapper |
| 4. Viewport ownership | status/current are frame identity and no user ownership cancels auto-frame work | canvas view/canvas |
| 5. Runtime workflow schema | manifests are closed but tools/call and raw routes/store do not enforce the same recursive structure | shared workflow schema + MCP dispatcher/routes/store |
| 6. Manifest budget | ceil(chars/4) measures neither exact JSON-RPC/provider payload nor production encoding | token-budget helper/test + compressed manifests |

---

## Task 0: Freeze the reviewed plan and ledger

**Files:**
- Create: docs/superpowers/plans/2026-07-12-workflow-layout-rereview-residuals.md
- Modify: the worktree SDD progress ledger outside the checkout

- [ ] Record this plan path and six pending findings in the SDD ledger without overwriting the completed earlier phase.
- [ ] Run git diff --check and staged privacy/trailer scans.
- [ ] Commit the plan alone with message: docs: plan workflow rereview remediation.

Expected: one documentation commit, clean checkout, no service interaction.

---

## Task 1: RED — immutable run invocation claims and typed conflict parity

**Files:**
- Create: packages/jinn/src/workflows/__tests__/run-idempotency.test.ts
- Modify: packages/jinn/src/workflows/__tests__/run-store.test.ts
- Modify: packages/jinn/src/workflows/__tests__/run-reconciler.test.ts
- Modify: packages/jinn/src/gateway/__tests__/workflow-definitions-route.test.ts
- Modify: packages/jinn/src/gateway/__tests__/workflow-operation-authority-route.test.ts
- Modify: packages/jinn/src/mcp/__tests__/workflow-tools.test.ts
- Modify: packages/jinn/src/mcp/__tests__/server.test.ts
- Modify: packages/web/src/lib/__tests__/workflow-api.test.ts
- Modify: packages/web/src/routes/workflow/__tests__/run-view.test.tsx

**Wished-for interfaces:**

~~~ts
export const WORKFLOW_RUN_IDEMPOTENCY_CONFLICT =
  'workflow-run-idempotency-conflict'

export interface WorkflowRunInvocationRequest {
  workflowId: string
  definitionVersion: number
  definitionDigest: string
  trigger: { source: string; event: string; payload: Record<string, unknown> }
  input: Record<string, unknown>
  initialStepOverrides: Record<string, WorkflowStepPromptOverride>
  principal: string
}

export interface WorkflowRunInvocationClaim {
  schemaVersion: 1
  workflowId: string
  principal: string
  idempotencyKey: string
  runId: string
  fingerprint: string
  request: WorkflowRunInvocationRequest
  createdAt: string
}
~~~

- [ ] Add canonicalization tests: recursively sorted object keys, preserved array order, omitted input/overrides normalized to {}, stable SHA-256 digest, and no caller-object mutation.
- [ ] Add the complete tuple matrix. Exact equality replays; changing definition version/digest, trigger source/event/payload, input property/value/array order, initial step override, workflow ID, or stable principal must never replay discarded intent.
- [ ] Prove later editPendingWorkflowStepPrompt mutations do not change the immutable initial request used for replay decisions.
- [ ] Add an exclusive claim-store test with two workers/processes racing one evidence root. Exactly one claim/run wins; the loser replays exact intent or conflicts.
- [ ] Add restart/crash recovery: exact replay after restart returns the same run; a durable preallocated claim resumes safely before spawn; corrupt/legacy claims fail closed when equality cannot be proven.
- [ ] Replace the unsafe route expectation that key reuse with different input returns 201. Assert typed sanitized 409, unchanged run/file count, and no leaked key/input/override/principal/fingerprint.
- [ ] Cover both run routes; same employee across sessions shares a stable employee principal, different principals have separate namespaces, and system schedule/manual sources remain separated.
- [ ] Assert MCP returns isError:true with safe code/run guidance and no 201-shaped discarded success.
- [ ] Assert the web API preserves status, code, and safe runId on a typed error.
- [ ] Assert Run UI keeps input/evidence intact on 409, does not select the old run, and progressively reveals an explicit Start as new run action that rotates the key only after operator intent.
- [ ] Run the focused gateway/web tests with dot reporters and tee compact RED evidence to /tmp.

Expected RED: old mismatched replay/201 behavior, missing persisted claim, missing typed web error, and missing explicit new-run recovery.

---

## Task 2: GREEN — atomic canonical idempotency across store, gateway, MCP, and UI

**Files:**
- Create: packages/jinn/src/workflows/run-idempotency.ts
- Modify: packages/jinn/src/workflows/run-store.ts
- Modify: packages/jinn/src/workflows/run-reconciler.ts
- Modify: packages/jinn/src/gateway/api.ts
- Modify: packages/jinn/src/mcp/workflow-tools.ts
- Modify: packages/web/src/lib/api.ts
- Modify: packages/web/src/routes/workflow/run-view.tsx
- Modify: tests from Task 1

- [ ] Implement stable canonical JSON and definition/request digests using Node crypto. Never persist secrets or emit fingerprint material in errors.
- [ ] Normalize stable principals at authorization: operator, employee:<name>, or system:<source>. Never use session ID, capability, raw token, or forwarded header as principal.
- [ ] Persist immutable initial overrides/request metadata separately from mutable effective run.stepOverrides.
- [ ] Derive claim paths from hashes, not raw user text. Create with exclusive wx semantics and the same durable write discipline as existing stores.
- [ ] Preallocate the run ID in the claim. The winner saves/resumes that exact run before execution; a loser compares the durable request and replays or throws WorkflowRunIdempotencyConflict.
- [ ] Preserve the existing per-run advancement lock after claim acquisition; it is not the claim lock.
- [ ] Pass authority.actor into the reconciler. Manual API calls use the authorized stable principal; machine triggers use system:<source>.
- [ ] Return 201 for a newly created run, 200 for exact replay, typed 409 for mismatch, and retain 422 durable execution-failure behavior.
- [ ] Preserve typed conflict through gatewayFailure, WorkflowApiError, and Run UI. Copy states that the key belongs to another request without revealing tuple details.
- [ ] Run Task 1 suites GREEN, then mutations that constant-fold the fingerprint, omit tuple fields, or revert 409 to 201; every mutation must fail.
- [ ] Run touched gateway/web typechecks.
- [ ] Commit: fix(workflows): bind run keys to immutable intent.

---

## Task 3: RED — exact route lens, accessible leave dialog, and viewport ownership

**Files:**
- Modify: packages/web/src/routes/workflow/__tests__/page.test.tsx
- Create: packages/web/src/routes/workflow/__tests__/workflow-leave-dialog.test.tsx
- Modify: packages/web/src/routes/workflow/__tests__/canvas-model.test.ts
- Modify: packages/web/src/routes/workflow/__tests__/canvas-framing.test.tsx

- [ ] Make page mocks render workflow ID, mode, and initialLive; location-only assertions are insufficient.
- [ ] Add dirty cross-workflow Save/Discard/Stay tests for sidebar, breadcrumb, search, programmatic navigation, and same-workflow lens changes. Save failure retains source; Save success and Discard render the exact target.
- [ ] Add POP Back/Forward plus direct edit/runs/live URLs. URL, title, rendered subtree, workflow ID, and live seed must agree.
- [ ] Add modal tests for initial Stay focus, Tab/Shift-Tab loop, background aria-hidden/inert, outside-interaction suppression, Escape=Stay, restoration, and retry after failed Save.
- [ ] Cover normal button, local lens control, and a real nested DropdownMenuItem origin. Restore to a connected initiator or stable menu trigger, never a removed item.
- [ ] Parameterize core modal tests at 1440 and 390 widths and normal/reduced motion. Semantics cannot depend on animation completion.
- [ ] Change the pure framing assertion that status alters viewportFrameKey; volatile status/current must be excluded from hard identity.
- [ ] Capture ReactFlow.onMoveStart. After real pan, wheel/pinch zoom, Fit all, zoom-in, and zoom-out, repeated status/current ticks add no fitView/setCenter calls on desktop or mobile.
- [ ] Add a deferred initial fitView race. User interaction before resolution invalidates the continuation so stale unreadable-zoom logic cannot call setCenter.
- [ ] Assert onMoveStart(null, viewport) is programmatic and does not claim ownership. New run/view, topology, breakpoint, and orientation may each frame once.
- [ ] Run the four focused web tests with a dot reporter and compact RED evidence.

Expected RED: retained old lens, focus behind overlay, volatile status refits, and stale async continuation wins.

---

## Task 4: GREEN — keyed lens, Radix decision boundary, and hard/volatile frame split

**Files:**
- Create: packages/web/src/routes/workflow/workflow-leave-dialog.tsx
- Modify: packages/web/src/routes/workflow/page.tsx
- Modify: packages/web/src/routes/workflow/run-view.tsx only if a keyed child is insufficient
- Modify: packages/web/src/routes/workflow/canvas-view.tsx
- Modify: packages/web/src/routes/workflow/canvas.tsx
- Modify: tests from Task 3

- [ ] Derive the requested lens from committed workflowId + searchParams and synchronize only after navigation commits. Key editor by workflow ID and executions by workflow ID plus live seed. Do not globally key the router.
- [ ] Preserve the exact pending location. Stay leaves source URL/dirty state untouched; Save/Discard proceed to the same target, including POP deltas and query state.
- [ ] Replace the overlay with a small wrapper around existing Dialog, DialogContent, DialogTitle, and DialogDescription. Use Ledger tokens and quiet existing button treatments; add no new chrome.
- [ ] Focus Stay on open, map Escape/controlled close to Stay, remain modal on failed Save, and prevent outside-dismiss ambiguity. Prevent the missing-trigger fallback and restore only a connected captured origin or stable nested-menu trigger.
- [ ] Define viewportFrameKey from hard identity only: view/run identity, node IDs/kinds/positions, edge topology, breakpoint/orientation generation. Exclude status/current.
- [ ] Record viewport intent on a real XyFlow move-start event and on Fit/zoom controls. Increment the frame request generation immediately to cancel in-flight automatic continuations.
- [ ] Permit one automatic frame for initial async focus and each hard transition. Repeated ticks never reopen Fit all or steal pan/zoom.
- [ ] Run Task 3 suites GREEN plus focused accessibility/run/editor suites and mutations.
- [ ] Commit route/dialog and viewport changes as separate scoped commits.

---

## Task 5: RED — one recursive runtime schema and real manifest tokenizer

**Files:**
- Create: packages/jinn/src/workflows/__tests__/schema.test.ts
- Modify: packages/jinn/src/workflows/__tests__/definition-store.test.ts
- Modify: packages/jinn/src/gateway/__tests__/workflow-definitions-route.test.ts
- Modify: packages/jinn/src/gateway/__tests__/workflow-operation-authority-route.test.ts
- Modify: packages/jinn/src/mcp/__tests__/workflow-tools.test.ts
- Modify: packages/jinn/src/mcp/__tests__/server.test.ts
- Modify: packages/jinn/src/mcp/__tests__/tool-manifest-budget.test.ts

**Wished-for interfaces:**

~~~ts
export const workflowDefinitionSchema = /* shared strict recursive schema */
export const workflowPatchSchema = /* strict nested contracts; partial root */
export const workflowSopSchema = /* strict SOP envelope */
export const workflowAuthoringSchemas = {
  plan: workflowAuthoringEnvelope('definition'),
  validate: workflowAuthoringEnvelope('definition'),
  create: workflowAuthoringEnvelope('definition'),
  update: workflowAuthoringEnvelope('patch'),
}
~~~

- [ ] Add a path matrix for unknown fields at root, node, position, actor, trigger, filter, gate, gates[], options, retry, session, loop, layout, condition, SOP, wake-up, and SOP step. Include mysteryMode and step-level onError.
- [ ] Assert supported options.onError, edge.lane, switch/wait/fail, gate, authority, and loop contracts still pass.
- [ ] Exercise raw plan, validate, create, and update routes; direct store calls; each MCP tool handler; and generic tools/call. All reject before handler/store mutation with the same path-aware error.
- [ ] Assert atomicity: no file on rejected create; byte-identical file and unchanged version/updatedAt on rejected update.
- [ ] Explicitly model canonical persisted authority fields needed by current authorization; reject caller attempts to smuggle legacy authority aliases where that seam disallows them.
- [ ] Assert all four advertised authoring schemas derive from the same shared components and remain recursively closed.
- [ ] Replace proxy counting with the maximum exact serialized payload over JSON-RPC tools/list, the owned Pi provider wrapper, and a checked-in/version-pinned provider fixture. Tokenize with pinned o200k_base and cap at <=7000 including headroom.
- [ ] Add a 310-character ordinary-text mutation. It must exceed/fail the real-token gate even though the old proxy passes.
- [ ] Add fail-closed fallback coverage: an unchanged payload may use a checked-in SHA-256 plus attested real count if tokenizer assets cannot load; any changed payload fails rather than using chars/4.
- [ ] Run focused schema/store/routes/MCP/budget tests with compact RED evidence.

Expected RED: unknowns persist/call handlers, exact payload exceeds the 7000-token wish, and the 310-character mutation evades the old proxy.

---

## Task 6: GREEN — shared strict schema, dispatcher enforcement, and <=7000-token manifest

**Files:**
- Create: packages/jinn/src/workflows/schema.ts
- Create: packages/jinn/src/mcp/tool-manifest-budget.ts
- Modify: packages/jinn/src/workflows/definition.ts
- Modify: packages/jinn/src/workflows/definition-store.ts
- Modify: packages/jinn/src/workflows/authoring.ts
- Modify: packages/jinn/src/workflows/sop.ts
- Modify: packages/jinn/src/gateway/api.ts
- Modify: packages/jinn/src/mcp/toolkit.ts
- Modify: packages/jinn/src/mcp/server.ts
- Modify: packages/jinn/src/mcp/workflow-tools.ts
- Modify: packages/jinn/src/engines/pi-mcp.ts
- Modify: packages/jinn/package.json
- Modify: pnpm-lock.yaml
- Modify: tests from Task 5

- [ ] Define every recursive envelope once with z.strictObject and path-aware errors. Export runtime parsing and JSON Schema from the same Zod 4 module; do not keep a second MCP-only allowlist.
- [ ] Parse and reject unknowns; never use default object stripping. Patches may omit root fields, but any supplied nested object remains strict.
- [ ] Validate before compilation/normalization/authorization spreading/state capture/mutation at every raw route. Validate direct store inputs/candidates as defense in depth.
- [ ] Extend JinnMcpTool with a runtime parser. Generic tools/call validates arguments before handler invocation; workflow handlers consume the validated shared type.
- [ ] Keep validateDefinition as semantic graph validation; structural parsing complements it.
- [ ] Pin js-tiktoken 1.0.21 exactly, use bundled local o200k_base ranks, and document tokenizer/version/wrapper fixture in the budget helper.
- [ ] Reduce the manifest below 7000 by deduplicating prose, using compact enums where equivalent, and reducing duplicated authoring declarations or safely consolidating aliases while preserving all committing-tool contracts. Do not weaken schema parity to hit budget.
- [ ] Run Task 5 suites GREEN, then mutations opening nested additionalProperties, bypassing dispatcher validation, reverting a route to raw spread, replacing tokenizer with chars/4, and appending 310 characters. Each fails.
- [ ] Run the full focused workflow gateway set and forced Jinn typecheck/build.
- [ ] Commit schema enforcement and token-budget work separately.

---

## Task 7: Bounded full verification in a fresh sandbox

**Files:**
- Modify: playwright.workflow-layout.config.ts
- Modify: scripts/verify-workflow-layout.sh
- Modify only as required: scripts/workflow-layout-sandbox/**
- Generate bounded reports only under the fresh sandbox artifact root.

- [ ] Inspect free bytes/inodes and expected build/browser budget before starting. Preserve existing scratch. If the floor is unmet, stop instead of beginning a partial matrix.
- [ ] Add a byte/inode preflight and explicit artifact caps. Use list/compact JSON reporting; disable HTML/JUnit duplication, trace, video, and automatic screenshots. Retain all metric JSON but only curated review-state/failure screenshots.
- [ ] Remove transient per-author Codex homes and fake-home package/engine caches after sanitizing author results; never delete unrelated scratch. Cap retained verification output.
- [ ] Create a fresh sanitized home and bind gateway/web to pinned unused ports 8060+. Assert scripts reject 7777 and non-sandbox homes.
- [ ] Run five fresh GPT-5.5-low authors for linear, branch/merge, approval/wait, error lane, and bounded loop. Definitions, sessions, and evidence remain in the sandbox. Include schema-correction probes.
- [ ] Run 1440x900 and 390x844, light/dark, normal/reduced motion. Cover canonical shapes, new/invalid/manual graphs, Apply+Save+reload, exact replay/conflict/start-as-new, success/failure/approval authorized/unauthorized/Needs-you, exact dirty paths, accessible modal, and status ticks after pan/zoom/Fit.
- [ ] Measure zero envelope overlap, strict-LTR clearance, scroll/focus, readable zoom, no unexpected reframe, modal focus/inert behavior, and URL/title/lens agreement.
- [ ] Treat ENOSPC, excluded setup, compositor blanking, missing cells, timeouts, or listener leaks as incomplete. Fix and rerun fresh; do not combine partial runs into a claimed full pass.
- [ ] Stop all listeners and scrub capabilities/credentials from retained reports.

---

## Task 8: Full gates, audits, ancestry, and reviewer handoff

- [ ] Focused gateway/web suites from Tasks 1-6 GREEN.
- [ ] Full gateway/Jinn and web suites GREEN with bounded reporters.
- [ ] Forced uncached typechecks and production builds for both packages GREEN.
- [ ] Re-run all prior workflow property/mutation/performance gates, including near-limit timer-delay responsiveness.
- [ ] Run whitespace, privacy, secrets, credential, :7777, Ledger/style, dependency, diff, and commit-trailer audits.
- [ ] Confirm ancestry against local-main merge-base 62dda29649692e6ed01a05cab78f4856a4d4bc3b. State that stale origin/main must first be reconciled through that local-main lineage. Do not split, cherry-pick, merge, or deploy.
- [ ] Produce a six-finding Before/After table grouped by intent integrity, navigation continuity, inclusive interaction, viewport respect, schema truth, and context economy.
- [ ] Include scoped commits, RED paths/counts, GREEN counts, browser artifact path/cell count, disk budget, five-author evidence, and production-port non-contact evidence.
- [ ] Send the exact six-finding map and artifacts to reviewer session d8293c0c-8508-4fdc-944a-5c042acb5d08 and request the same reviewer perform a fresh full re-review.
- [ ] Do not recommend merge until that reviewer returns full PASS.

## Final acceptance contract

The work is complete only when exact-key/exact-tuple replay is durable across concurrency/restart; mismatched intent is typed 409 everywhere; every dirty decision lands on or stays at the exact workflow lens; the leave decision is an accessible modal; user viewport ownership survives status ticks; one shared strict recursive schema rejects unknowns atomically at every seam; exact provider-wrapped manifests are <=7000 o200k_base tokens and the 310-character mutation fails; all bounded browser cells and five fresh authors complete in one new sandbox; all tests/typechecks/builds/audits pass; and the same reviewer returns PASS.
