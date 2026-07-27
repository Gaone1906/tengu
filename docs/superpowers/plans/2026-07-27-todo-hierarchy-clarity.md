# Todo Hierarchy Clarity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make parent/sub-task structure explicit in chat and MCP responses, while teaching agents to create one root Todo per durable outcome instead of one top-level Todo per checklist step.

**Architecture:** Preserve the existing normalized Todo tree and audit rows. Enrich server-authored Todo activity blocks and MCP compact summaries with `parentId`, `rootId`, and `depth`; let the web transcript compose consecutive same-root creation receipts into one grouped collection; and strengthen shipped/live doctrine so hierarchy is chosen intentionally.

**Tech Stack:** TypeScript, React 19, React Router, Tailwind CSS 4, Vitest, Testing Library, SQLite-backed Jinn Todo APIs.

## Global Constraints

- Preserve the existing `work_items.parent_id/root_id/depth` schema and depth-three cap.
- Do not touch or overwrite unrelated upgrade-lab changes already present in the working tree.
- Keep all shipped code, tests, fixtures, and template copy generic.
- Use existing Ledger tokens; no new hardcoded colors or resting hairlines.
- Preserve one durable audit event per Todo mutation even when the web transcript groups receipts.

---

### Task 1: Hierarchy-aware Todo activity receipts

**Files:**
- Modify: `packages/jinn/src/gateway/chat-activity.ts`
- Create: `packages/jinn/src/gateway/__tests__/chat-activity.test.ts`

**Interfaces:**
- Consumes: `WorkItem.parentId`, `WorkItem.rootId`, and `WorkItem.depth`.
- Produces: `todoActivityBlock(item, action)` payload fields `parentId`, `rootId`, and `depth`.

- [ ] **Step 1: Write the failing gateway unit test**

```ts
const block = todoActivityBlock(child, "created").block;
expect(block.payload).toMatchObject({
  todoId: "JIN-2",
  parentId: "JIN-1",
  rootId: "JIN-1",
  depth: 1,
});
```

- [ ] **Step 2: Run the test and confirm it fails because the hierarchy fields are absent**

Run: `pnpm --filter jinn-cli exec vitest run src/gateway/__tests__/chat-activity.test.ts`

Expected: FAIL with a payload mismatch naming `parentId`, `rootId`, or `depth`.

- [ ] **Step 3: Add the three fields to the persisted activity payload**

```ts
payload: {
  todoId: item.id,
  parentId: item.parentId,
  rootId: item.rootId,
  depth: item.depth,
  action,
  status: item.status,
  assignee: item.assignee,
  approvalState: item.approvalState,
  updatedAt: item.updatedAt,
}
```

- [ ] **Step 4: Run the focused test and confirm it passes**

Run: `pnpm --filter jinn-cli exec vitest run src/gateway/__tests__/chat-activity.test.ts`

Expected: PASS.

### Task 2: Group same-root Todo creation receipts in chat

**Files:**
- Create: `packages/web/src/components/chat/todo-activity-burst.tsx`
- Modify: `packages/web/src/components/chat/chat-messages.tsx`
- Modify: `packages/web/src/components/chat/company-activity-card.tsx`
- Test: `packages/web/src/components/chat/__tests__/chat-messages-tool-group.test.tsx`
- Test: `packages/web/src/components/chat/__tests__/company-activity-card.test.tsx`

**Interfaces:**
- Consumes: consecutive `todo-activity` blocks whose `payload.action === "created"` and whose `payload.rootId` matches.
- Produces: one `todo-burst` `MessageItem` rendered by `TodoActivityBurst`; single child receipts render as “Sub-task” and expose their parent.

- [ ] **Step 1: Add failing transcript tests**

```tsx
expect(screen.getByTestId("todo-activity-burst")).toBeTruthy();
expect(screen.getAllByText(/Todo ·/)).toHaveLength(0);
expect(screen.getByText("2 sub-tasks")).toBeTruthy();
```

Also assert a standalone child receipt says `Sub-task · JIN-2` and exposes `Parent JIN-1`.

- [ ] **Step 2: Run the two focused web suites and confirm the new assertions fail**

Run: `pnpm --filter @jinn/web exec vitest run src/components/chat/__tests__/chat-messages-tool-group.test.tsx src/components/chat/__tests__/company-activity-card.test.tsx`

Expected: FAIL because receipts remain independent and the card has no parent treatment.

- [ ] **Step 3: Implement consecutive same-root grouping**

Add a `todo-burst` `MessageItem` variant carrying the original messages and raw start index. Group only two or more adjacent assistant messages that each contain exactly one created Todo activity block and share a non-empty `rootId`; preserve all raw messages for folding, timestamps, and audit navigation.

- [ ] **Step 4: Implement the quiet grouped collection**

Render one root header and flat child rows inside a single token-driven grouped inset. Every row opens its canonical Todo route; show at most six children initially and expose a quiet “Show N more” control. On mobile keep controls at least 34px tall and use the same layout without horizontal scrolling.

- [ ] **Step 5: Render a standalone child honestly**

For `todo-activity` blocks with a non-null `parentId`, change the noun from `Todo` to `Sub-task` and add a `Parent` fact. Do not change the canonical Todo link.

- [ ] **Step 6: Run focused web tests**

Run: `pnpm --filter @jinn/web exec vitest run src/components/chat/__tests__/chat-messages-tool-group.test.tsx src/components/chat/__tests__/company-activity-card.test.tsx`

Expected: PASS.

### Task 3: MCP hierarchy summaries and filters

**Files:**
- Modify: `packages/jinn/src/mcp/work-item-tools.ts`
- Test: `packages/jinn/src/mcp/__tests__/work-item-tools.test.ts`
- Test: `packages/jinn/src/mcp/__tests__/tool-manifest-budget.test.ts`

**Interfaces:**
- Consumes: gateway compact rows containing `parentId`, `rootId`, and `depth`; existing `/api/work-items` `parent` and `root` query parameters.
- Produces: hierarchy-bearing list/search summaries and `parentId`/`rootId` list filters.

- [ ] **Step 1: Add failing MCP schema, forwarding, and summary tests**

```ts
expect(tool("list_work_items").inputSchema.properties).toHaveProperty("parentId");
expect(tool("list_work_items").inputSchema.properties).toHaveProperty("rootId");
expect(result.workItems[0]).toMatchObject({
  parentId: "JIN-1",
  rootId: "JIN-1",
  depth: 1,
});
expect(calls[0].url).toContain("parent=JIN-1");
expect(calls[0].url).toContain("root=JIN-1");
```

- [ ] **Step 2: Run focused MCP tests and confirm they fail for missing schema/summary fields**

Run: `pnpm --filter jinn-cli exec vitest run src/mcp/__tests__/work-item-tools.test.ts src/mcp/__tests__/tool-manifest-budget.test.ts`

Expected: FAIL on absent hierarchy properties.

- [ ] **Step 3: Preserve hierarchy in compact results and forward canonical filters**

Add `parentId`, `rootId`, and `depth` to `summarize`. Add canonical `parentId` and `rootId` schema properties to `list_work_items`; parse them with `parseTodoId` and forward them as `parent` and `root`. Update the tool description to state that results include roots and sub-tasks unless `rootsOnly` is requested.

- [ ] **Step 4: Run focused MCP tests**

Run: `pnpm --filter jinn-cli exec vitest run src/mcp/__tests__/work-item-tools.test.ts src/mcp/__tests__/tool-manifest-budget.test.ts`

Expected: PASS.

### Task 4: Agent doctrine

**Files:**
- Modify: `packages/jinn/template/CLAUDE.md`
- Modify: `packages/jinn/template/skills/todo-handling/SKILL.md`
- Modify: `~/.jinn/CLAUDE.md`
- Modify: `~/.jinn/skills/todo-handling/SKILL.md`
- Test: `packages/jinn/src/mcp/__tests__/work-item-tools.test.ts`
- Test: `packages/jinn/src/shared/__tests__/template-company-doctrine.test.ts`

**Interfaces:**
- Produces: one-root-per-outcome doctrine, an explicit parent-first creation recipe, and a rule that procedural checklist steps remain body/checklist/activity unless independently owned or reviewed.

- [ ] **Step 1: Add failing template doctrine assertions**

```ts
expect(template).toContain("one root Todo for the durable outcome");
expect(template).toContain("A checklist does not imply one Todo per item");
expect(todoSkill).toContain('"parentId": "ACM-42"');
```

- [ ] **Step 2: Run the focused doctrine suites and confirm the copy assertions fail**

Run: `pnpm --filter jinn-cli exec vitest run src/mcp/__tests__/work-item-tools.test.ts src/shared/__tests__/template-company-doctrine.test.ts`

Expected: FAIL because the current doctrine says one Todo per durable sub-task and has no parent-first example.

- [ ] **Step 3: Update shipped template doctrine and Todo skill**

State that one operator outcome gets one root; only independently assignable/reviewable deliverables become children via `parentId`; procedural steps stay in the parent body, comments, or activity. Teach `get_work_item_tree` and `rootsOnly: true`.

- [ ] **Step 4: Mirror the same generic doctrine into the live instance**

Patch the live `CLAUDE.md` and `skills/todo-handling/SKILL.md` without copying any personal content into the public repo.

- [ ] **Step 5: Run focused doctrine suites**

Run: `pnpm --filter jinn-cli exec vitest run src/mcp/__tests__/work-item-tools.test.ts src/shared/__tests__/template-company-doctrine.test.ts`

Expected: PASS.

### Task 5: Verification and visual review

**Files:**
- Review only: all scoped files above.

**Interfaces:**
- Produces: verified backend, MCP, template, and responsive UI behavior without a live gateway restart.

- [ ] **Step 1: Run all focused suites**

Run the gateway, MCP, template, and web commands from Tasks 1–4.

- [ ] **Step 2: Run repository gates**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`

Expected: all commands exit zero.

- [ ] **Step 3: Verify desktop/mobile and dark/light**

Use a fixture gateway with `authRequired:false`, start Vite on a scratch port, and capture the grouped Todo receipt at 1440px and 390px in both themes. Confirm one collection, readable hierarchy, no clipping, no resting hairlines, and ≥34px mobile controls.

- [ ] **Step 4: Review scope and privacy**

Run: `git diff --check`

Run: `git diff -- packages/jinn/src/gateway/chat-activity.ts packages/jinn/src/gateway/__tests__/chat-activity.test.ts packages/jinn/src/mcp/work-item-tools.ts packages/jinn/src/mcp/__tests__/work-item-tools.test.ts packages/web/src/components/chat/chat-messages.tsx packages/web/src/components/chat/todo-activity-burst.tsx packages/web/src/components/chat/company-activity-card.tsx packages/web/src/components/chat/__tests__/chat-messages-tool-group.test.tsx packages/web/src/components/chat/__tests__/company-activity-card.test.tsx packages/jinn/template/CLAUDE.md packages/jinn/template/skills/todo-handling/SKILL.md`

Leak scan the scoped diff for personal names, projects, emails, Slack IDs, and absolute home paths.
