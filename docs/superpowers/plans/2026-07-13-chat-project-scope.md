# Chat Project Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the chat sidebar's Focused/All toggle with a quiet project-scope lens that preserves the flat chronological list, keeps global attention visible, and removes workflow/cron/child execution noise from normal browsing.

**Architecture:** Keep the change in `packages/web`: a pure scope model maps sessions to runtime employee departments, a focused Radix menu renders the lens, and `ChatSidebar` applies the model before its existing recency bucketing. Search remains server-global and unchanged. The review environment uses an isolated Jinn home outside `~/.jinn`, seeded with generic employees and sessions, and is exposed through a Tailscale HTTPS proxy.

**Tech Stack:** React 19, TypeScript, Tailwind CSS 4, Radix Dropdown Menu, Vitest, Testing Library, Jinn sandbox gateway, Playwright, Tailscale Serve.

## Global Constraints

- Do not read from, write to, stop, restart, migrate, or proxy the live `~/.jinn` instance or port `7777`.
- Use runtime employee departments as review-build project scopes; do not hardcode project or personal names in shipped code.
- Keep one flat list ordered `Needs you → Pinned → Today → Yesterday → Older`.
- Search spans all sessions regardless of selected scope.
- Workflow run projections, cron sessions, delegated child sessions, and unknown internal sources never appear in the normal list.
- A project selection persists locally; first use defaults to `All chats` to preserve discoverability.
- All interactive targets are at least 40px and all colors come from Ledger tokens.
- Verify desktop 1440×900 and mobile 390×844 in dark and light themes.

---

### Task 1: Pure chat-scope model

**Files:**
- Create: `packages/web/src/components/chat/chat-scope.ts`
- Test: `packages/web/src/components/chat/__tests__/chat-scope.test.ts`

**Interfaces:**
- Consumes: session source/parent/status/activity fields plus `Map<string, Employee>` from the existing org query.
- Produces: `ChatScope`, `ProjectScopeOption`, `projectIdForSession`, `sessionNeedsAttention`, `projectScopeOptions`, `sessionMatchesScope`, `parseStoredChatScope`, and `chatScopeLabel`.

- [ ] **Step 1: Write failing model tests**

```ts
it('maps employee chats to normalized runtime departments and direct chats to general', () => {
  expect(projectIdForSession(employeeSession, employees, 'jinn')).toBe('platform')
  expect(projectIdForSession(directSession, employees, 'jinn')).toBe('general')
})

it('treats waiting and recent errors as needing attention', () => {
  expect(sessionNeedsAttention({ status: 'waiting' }, now)).toBe(true)
  expect(sessionNeedsAttention(recentError, now)).toBe(true)
  expect(sessionNeedsAttention(staleError, now)).toBe(false)
})

it('rejects missing stored project scopes and preserves valid current ones', () => {
  expect(parseStoredChatScope('project:missing', options)).toBe('all')
  expect(parseStoredChatScope('project:platform', options)).toBe('project:platform')
})
```

- [ ] **Step 2: Run the model tests and confirm RED**

Run: `pnpm --dir packages/web exec vitest run src/components/chat/__tests__/chat-scope.test.ts`

Expected: FAIL because `chat-scope.ts` does not exist.

- [ ] **Step 3: Implement the pure scope model**

```ts
export type ChatScope = 'all' | 'needs' | `project:${string}`

export interface ProjectScopeOption {
  id: string
  label: string
  count: number
}

export function sessionMatchesScope(
  session: ScopeSession,
  scope: ChatScope,
  employees: Map<string, Pick<Employee, 'department'>>,
  portalSlug: string,
  nowMs = Date.now(),
): boolean {
  if (scope === 'all') return true
  if (scope === 'needs') return sessionNeedsAttention(session, nowMs)
  return projectIdForSession(session, employees, portalSlug) === scope.slice('project:'.length)
}
```

- [ ] **Step 4: Run the model tests and confirm GREEN**

Run: `pnpm --dir packages/web exec vitest run src/components/chat/__tests__/chat-scope.test.ts`

Expected: all scope-model tests pass.

### Task 2: Quiet scope menu

**Files:**
- Create: `packages/web/src/components/chat/chat-scope-menu.tsx`
- Test: `packages/web/src/components/chat/__tests__/chat-scope-menu.test.tsx`

**Interfaces:**
- Consumes: `{ value, projects, totalCount, needsCount, onChange }`.
- Produces: `ChatScopeMenu`, a plain-text 40px trigger and one shadowed token-based menu.

- [ ] **Step 1: Write failing interaction tests**

```tsx
render(<ChatScopeMenu value="all" projects={projects} totalCount={8} needsCount={2} onChange={onChange} />)
expect(screen.getByRole('button', { name: /scope: all chats/i })).toBeVisible()
await user.click(screen.getByRole('button', { name: /scope: all chats/i }))
await user.click(screen.getByRole('menuitemradio', { name: /platform/i }))
expect(onChange).toHaveBeenCalledWith('project:platform')
```

- [ ] **Step 2: Run the menu test and confirm RED**

Run: `pnpm --dir packages/web exec vitest run src/components/chat/__tests__/chat-scope-menu.test.tsx`

Expected: FAIL because `ChatScopeMenu` does not exist.

- [ ] **Step 3: Implement the menu**

```tsx
<DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as ChatScope)}>
  <DropdownMenuRadioItem value="all">All chats <Count>{totalCount}</Count></DropdownMenuRadioItem>
  <DropdownMenuRadioItem value="needs">Needs you <Count>{needsCount}</Count></DropdownMenuRadioItem>
  <DropdownMenuSeparator />
  <DropdownMenuLabel>Projects</DropdownMenuLabel>
  {projects.map((project) => (
    <DropdownMenuRadioItem key={project.id} value={`project:${project.id}`}>
      {project.label}<Count>{project.count}</Count>
    </DropdownMenuRadioItem>
  ))}
</DropdownMenuRadioGroup>
```

- [ ] **Step 4: Run the menu test and confirm GREEN**

Run: `pnpm --dir packages/web exec vitest run src/components/chat/__tests__/chat-scope-menu.test.tsx`

Expected: the trigger and selection tests pass with no accessibility warnings.

### Task 3: Integrate scopes into the flat sidebar

**Files:**
- Modify: `packages/web/src/components/chat/chat-sidebar.tsx`
- Modify: `packages/web/src/components/chat/chat-route-helpers.ts`
- Test: `packages/web/src/components/chat/__tests__/chat-route-helpers.test.ts`
- Test: `packages/web/src/components/chat/__tests__/chat-sidebar-helpers.test.ts`

**Interfaces:**
- Consumes: Task 1 scope helpers and Task 2 menu.
- Produces: persisted scope selection, global attention rows, scope-filtered chronological rows, global search, and an Activity handoff for suppressed automation.

- [ ] **Step 1: Extend failing helper tests for permanent automation suppression**

```ts
it('keeps only human-facing parent conversations in normal history', () => {
  expect(isFocusedSession({ source: 'web', parentSessionId: null })).toBe(true)
  expect(isFocusedSession({ source: 'cron' })).toBe(false)
  expect(isFocusedSession({ source: 'web', parentSessionId: 'parent' })).toBe(false)
  expect(isFocusedSession({ source: 'web', workflowProvenance: { kind: 'run' } })).toBe(false)
})
```

- [ ] **Step 2: Run sidebar/helper tests and confirm RED for the new scope integration assertions**

Run: `pnpm --dir packages/web exec vitest run src/components/chat/__tests__/chat-route-helpers.test.ts src/components/chat/__tests__/chat-sidebar-helpers.test.ts`

Expected: scope-related assertions fail against the current Focused/All implementation.

- [ ] **Step 3: Replace Focused/All state with persisted `ChatScope`**

```ts
const CHAT_SCOPE_STORAGE_KEY = 'jinn-sidebar-chat-scope'
const [chatScope, setChatScope] = useState<ChatScope>('all')
const selectChatScope = useCallback((next: ChatScope) => {
  setChatScope(next)
  localStorage.setItem(CHAT_SCOPE_STORAGE_KEY, next)
}, [])
```

- [ ] **Step 4: Build attention and history rows without duplicates**

```ts
for (const session of displayed) {
  if (!isFocusedSession(session)) {
    hiddenAutomated += 1
    continue
  }
  if (sessionNeedsAttention(session, now.getTime())) {
    attentionRows.push(toRow(session))
    continue
  }
  if (chatScope === 'needs' || !sessionMatchesScope(session, chatScope, employeeData, portalSlug, now.getTime())) continue
  // Existing Pinned/Today/Yesterday/Older bucketing remains unchanged.
}
```

- [ ] **Step 5: Replace the segmented control with `ChatScopeMenu` and keep compose/search actions**

```tsx
<ChatScopeMenu
  value={chatScope}
  projects={projectOptions}
  totalCount={conversationCount}
  needsCount={attentionRows.length}
  onChange={selectChatScope}
/>
```

- [ ] **Step 6: Run focused sidebar tests and confirm GREEN**

Run: `pnpm --dir packages/web exec vitest run src/components/chat/__tests__/chat-scope.test.ts src/components/chat/__tests__/chat-scope-menu.test.tsx src/components/chat/__tests__/chat-route-helpers.test.ts src/components/chat/__tests__/chat-sidebar-helpers.test.ts`

Expected: all focused chat-scope and sidebar tests pass.

### Task 4: Isolated seeded review gateway

**Files:**
- Create outside repository: `$REVIEW_HOME/`
- Create outside repository: `$REVIEW_HOME/sandbox-artifacts/`

**Interfaces:**
- Consumes: the built local repository and `JINN_HOME=$REVIEW_HOME`.
- Produces: a gateway on `127.0.0.1:7803` containing generic departments, employees, direct chats, waiting chats, older history, workflow runs, delegated children, and cron runs.

- [ ] **Step 1: Build the repository**

Run: `pnpm build`

Expected: web and gateway production assets build successfully.

- [ ] **Step 2: Initialize the isolated home without the shared instance registry**

Run: `JINN_HOME="${HOME}/.jinn-chat-scope-review" JINN_INSTANCES_REGISTRY="${HOME}/.jinn-chat-scope-review/instances.json" node packages/jinn/dist/bin/jinn.js setup`

Expected: setup writes only below `$REVIEW_HOME`.

- [ ] **Step 3: Seed generic runtime org and sessions**

Seed departments `platform`, `camera`, and `legal`; add at least two employees per department; create human-facing sessions across today/yesterday/older, two `waiting` sessions, and automation records that prove suppression.

- [ ] **Step 4: Start and health-check the sandbox**

Run: `JINN_HOME="${HOME}/.jinn-chat-scope-review" JINN_INSTANCES_REGISTRY="${HOME}/.jinn-chat-scope-review/instances.json" node packages/jinn/dist/bin/jinn.js start --daemon -p 7803`

Expected: `http://127.0.0.1:7803/api/status` returns HTTP 200 and identifies the isolated home.

### Task 5: Verification and Tailscale handoff

**Files:**
- Create outside repository: `$REVIEW_HOME/sandbox-artifacts/<timestamp>/*.png`

**Interfaces:**
- Consumes: production sandbox gateway on `7803`.
- Produces: four screenshot proofs and the HTTPS review URL on Tailscale port `7802`.

- [ ] **Step 1: Run gates**

Run: `pnpm --dir packages/web typecheck && pnpm --dir packages/web test`

Expected: typecheck and web tests pass.

- [ ] **Step 2: Capture and inspect all theme/breakpoint combinations**

Capture desktop dark/light at 1440×900 and mobile dark/light at 390×844. Verify scope switching, global Needs you, older expansion, search, compose, and the absence of automation rows.

- [ ] **Step 3: Expose only the sandbox through Tailscale**

Run: `tailscale serve --bg --https=7802 http://127.0.0.1:7803`

Expected: `https://<tailnet-host>:7802/` serves the sandbox and no handler is added for `7777`.

- [ ] **Step 4: Commit only scoped repository files**

Stage the plan, scope model/menu/tests, and sidebar integration explicitly. Run the privacy leak grep, commit without co-author trailers, and leave the sandbox running for review.
