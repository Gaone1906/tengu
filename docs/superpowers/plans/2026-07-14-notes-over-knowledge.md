# Notes over Knowledge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the applicable Jinn design, Jinn platform, and test-driven-development skills to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class Apple Notes-inspired Notes surface backed directly by the existing `~/.jinn/knowledge/` Markdown tree, with revision-safe web editing, local speech-to-text, and session-accessible MCP tools.

**Architecture:** Markdown remains the source of truth. A focused notes store recursively projects safe regular `.md` files below `knowledge/` into folder, summary, and document records; the first Markdown heading is the title and the remaining document is the editable body. HTTP and MCP wrappers share that store, while the Vite/React page uses an Apple-style folder → note list → editor hierarchy on mobile and three panes on desktop.

**Tech Stack:** TypeScript ES2022, Node filesystem APIs, Vite 7, React 19, React Router 7, TanStack Query, Tailwind CSS 4.1, Lucide, Vitest, existing `useStt`/`MicWaveform`/`WhisperDownloadModal`.

## Global Constraints

- Work on `main`; do not restart or deploy the live gateway.
- Keep every shipped file generic: no operator names, client names, emails, keys, Slack IDs, or personal absolute home-directory paths.
- Use only `~/.jinn/knowledge/` as the editable Notes root; `docs/` remains read-only and outside this page.
- Recursively include nested Markdown files as folders; ignore hidden entries, non-Markdown files, and all symlinks.
- Use the first Markdown heading as the note title; fall back to the filename stem only when no heading exists.
- Preserve YAML frontmatter/preamble and heading level when editing an existing note.
- Require a content revision for every update so concurrent human/session writes return HTTP 409 instead of clobbering.
- Use atomic same-directory writes and realpath containment; never accept absolute paths, traversal, backslashes, control bytes, or an escaped symlink.
- Match Apple Notes information architecture while using Jinn Ledger tokens, no hardcoded colors, no hairline cards, and complete dark/light × desktop/mobile verification.
- Reuse the existing local STT hook and model-download modal. Dictation inserts at the editor selection and never auto-sends anything.
- Follow TDD: every production behavior is preceded by a focused failing test and an observed expected failure.

---

### Task 1: Filesystem Notes domain

**Files:**
- Create: `packages/jinn/src/notes/store.ts`
- Create: `packages/jinn/src/notes/__tests__/store.test.ts`
- Modify: `packages/jinn/src/shared/types.ts`

**Interfaces:**
- Produces:

```ts
export interface NoteSummary {
  path: string;          // knowledge/<nested-path>.md
  title: string;         // first Markdown heading, else filename stem
  preview: string;       // compact plain-text body excerpt
  folder: string;        // "" for root, otherwise knowledge-relative directory
  updatedAt: string;     // ISO timestamp from mtime
  revision: string;      // SHA-256 of exact file bytes
}

export interface NoteDocument extends NoteSummary {
  body: string;          // content after the title heading; frontmatter is preserved server-side
}

export interface NoteFolder {
  path: string;
  name: string;
  count: number;
}

export type NoteStoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "invalid-path" | "forbidden" | "not-found" | "conflict" | "too-large" | "already-exists"; detail: string; currentRevision?: string };

export function listNotes(options?: { query?: string; home?: string }): { notes: NoteSummary[]; folders: NoteFolder[] };
export function readNote(notePath: string, home?: string): NoteStoreResult<NoteDocument>;
export function createNote(input: { title: string; body?: string; folder?: string }, home?: string): NoteStoreResult<NoteDocument>;
export function updateNote(input: { path: string; expectedRevision: string; title?: string; body?: string; append?: string }, home?: string): NoteStoreResult<NoteDocument>;
```

- [ ] **Step 1: Write failing domain tests**

Cover recursive folder listing, updated-desc ordering, first-heading title extraction, filename fallback, frontmatter preservation, body preview, unique slug creation, append, title/body replacement, expected-revision conflict, atomic replacement, nested traversal/control-byte/backslash/absolute rejection, hidden-file omission, non-Markdown omission, outside-root symlink omission/refusal, leaf symlink write refusal, and the file-size cap.

```ts
it("projects nested Markdown using its first heading as the title", () => {
  seed("knowledge/product/brief.md", "---\ntype: brief\n---\n# Launch brief\n\nShip calmly.\n");
  const { notes, folders } = listNotes({ home });
  expect(notes.find((note) => note.path === "knowledge/product/brief.md")).toMatchObject({
    title: "Launch brief",
    folder: "product",
    preview: "Ship calmly.",
  });
  expect(folders).toContainEqual({ path: "product", name: "product", count: 1 });
});

it("refuses a stale revision without changing bytes", () => {
  const created = createNote({ title: "Plan", body: "One" }, home);
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  const first = updateNote({ path: created.value.path, expectedRevision: created.value.revision, body: "Two" }, home);
  expect(first.ok).toBe(true);
  const stale = updateNote({ path: created.value.path, expectedRevision: created.value.revision, append: "Three" }, home);
  expect(stale).toMatchObject({ ok: false, reason: "conflict" });
  expect(readNote(created.value.path, home)).toMatchObject({ ok: true, value: { body: "Two" } });
});
```

- [ ] **Step 2: Run the store test and verify RED**

Run: `pnpm --filter jinn-cli exec vitest run src/notes/__tests__/store.test.ts`

Expected: FAIL because `src/notes/store.ts` and its exports do not exist.

- [ ] **Step 3: Implement the minimal filesystem store**

Use `lstatSync` to reject symlinks, `realpathSync` containment for the root/parents, `path.posix` validation for public paths, `crypto.createHash("sha256")` for revisions, and `openSync(..., "wx")` + `renameSync` for same-directory atomic updates. Parse and render notes without normalizing unrelated existing bytes: preserve text before the first heading, retain that heading's `#` level, and replace only its title plus the editable tail.

- [ ] **Step 4: Run the focused store test and verify GREEN**

Run: `pnpm --filter jinn-cli exec vitest run src/notes/__tests__/store.test.ts`

Expected: PASS with no warnings.

---

### Task 2: Notes HTTP and MCP contracts

**Files:**
- Modify: `packages/jinn/src/gateway/api.ts`
- Modify: `packages/jinn/src/gateway/__tests__/knowledge-routes.test.ts` or create `packages/jinn/src/gateway/__tests__/notes-routes.test.ts`
- Create: `packages/jinn/src/mcp/note-tools.ts`
- Create: `packages/jinn/src/mcp/__tests__/note-tools.test.ts`
- Modify: `packages/jinn/src/mcp/server.ts`
- Modify: `packages/jinn/src/mcp/__tests__/server.test.ts`
- Modify: `packages/jinn/src/mcp/__tests__/tool-manifest-budget.test.ts`
- Modify: `packages/jinn/src/mcp/__tests__/context-diet.test.ts`
- Modify: `packages/jinn/src/shared/__tests__/template-company-doctrine.test.ts`
- Modify: `packages/jinn/template/CLAUDE.md`
- Modify: `packages/jinn/template/AGENTS.md`
- Modify: `packages/jinn/template/docs/company-doctrine.md`

**Interfaces:**
- Consumes: Task 1 store functions and records.
- Produces these operator/browser and bound-MCP routes:

```text
GET  /api/notes?q=<optional>                         -> { notes, folders }
GET  /api/notes/read?path=knowledge%2F...md          -> { note }
POST /api/notes { title, body?, folder? }            -> 201 { note }
PUT  /api/notes { path, expectedRevision, title?, body?, append? } -> { note }
```

- Produces exactly four new MCP tools:

```text
list_notes   { query? }
read_note    { path }
create_note  { title, body?, folder? }
update_note  { path, expectedRevision, title?, body?, append? }
```

- [ ] **Step 1: Write failing HTTP and MCP tests**

Pin route status mapping (`invalid` 400, `forbidden` 403, `not-found` 404, `conflict` 409, create 201), recursive list/read/create/update round-trips, tool caller-capability requirements, raw control-byte refusal before HTTP, mutually exclusive `body`/`append`, expected-revision requirement, and the exact four flat schemas.

```ts
it("reads then appends through the bound note tools", async () => {
  const created = await tool("create_note").handler({ title: "Ideas", body: "One" }, ctx());
  const note = (created as { note: { path: string; revision: string } }).note;
  const updated = await tool("update_note").handler({
    path: note.path,
    expectedRevision: note.revision,
    append: "Two",
  }, ctx());
  expect(updated).toMatchObject({ note: { title: "Ideas", body: "One\n\nTwo" } });
});
```

- [ ] **Step 2: Run route/tool tests and verify RED**

Run: `pnpm --filter jinn-cli exec vitest run src/gateway/__tests__/notes-routes.test.ts src/mcp/__tests__/note-tools.test.ts`

Expected: FAIL because Notes routes and tools are absent.

- [ ] **Step 3: Implement routes and tools**

Operator requests remain governed by normal gateway authentication. Any request carrying the MCP tool marker must also carry a valid bound session capability before a mutation. Keep descriptions terse enough to preserve the MCP context diet; teach the read-before-update flow in `list_notes`' hint. Emit `notes:changed` with `{ path, revision, action: "created" | "updated" }` after successful writes.

- [ ] **Step 4: Update manifests and company language**

Keep legacy `search_knowledge`/`read_knowledge` for compatibility. Add the four Note verbs to exact tool lists/required-argument maps and recalculate the pinned manifest hashes with the local tokenizer instead of weakening the test blindly. Update the company doctrine so Notes is one of the five public blocks and Triggers are described as a Workflow detail.

- [ ] **Step 5: Run all focused backend tests and verify GREEN**

Run: `pnpm --filter jinn-cli exec vitest run src/notes/__tests__/store.test.ts src/gateway/__tests__/notes-routes.test.ts src/mcp/__tests__/note-tools.test.ts src/mcp/__tests__/server.test.ts src/mcp/__tests__/tool-manifest-budget.test.ts src/mcp/__tests__/context-diet.test.ts src/shared/__tests__/template-company-doctrine.test.ts`

Expected: PASS with the exact expanded MCP manifest under its explicitly justified cap.

---

### Task 3: Notes navigation and data layer

**Files:**
- Modify: `packages/web/src/lib/api.ts`
- Modify: `packages/web/src/lib/nav.ts`
- Modify: `packages/web/src/main.tsx`
- Modify: `packages/web/src/components/global-search.tsx`
- Modify: `packages/web/src/components/chat/__tests__/mobile-tab-bar.test.tsx`
- Modify: `packages/web/src/routes/todos/__tests__/redirect.test.tsx`
- Create: `packages/web/src/routes/notes/types.ts`
- Create: `packages/web/src/routes/notes/use-notes.ts`
- Create: `packages/web/src/routes/notes/__tests__/navigation.test.tsx`

**Interfaces:**
- Consumes the Task 2 HTTP contract.
- Produces `api.listNotes`, `api.readNote`, `api.createNote`, and `api.updateNote` typed methods plus TanStack Query keys `notes`, `note/<path>`.
- [ ] **Step 1: Write failing navigation/data tests**

Assert `/notes` is lazy-routed, desktop navigation order is Chat → Todos → Notes → Workflows, mobile has Chat/Todos/Notes/Workflows/More, the More tab does not own `/notes`, and external `notes:changed` events invalidate the list and matching document query.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm --filter @jinn/web exec vitest run src/routes/notes/__tests__/navigation.test.tsx src/components/chat/__tests__/mobile-tab-bar.test.tsx src/routes/todos/__tests__/redirect.test.tsx`

Expected: FAIL because Notes is not a route or navigation item.

- [ ] **Step 3: Implement types, API methods, queries, and navigation**

Use `NotebookPen` from Lucide. Keep the fifth mobile tab within the existing HIG-compliant tab bar footprint and preserve ≥49px hit targets. Add Notes to global search page destinations without fetching note bodies.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command; expected PASS.

---

### Task 4: Apple Notes-inspired responsive page and voice editor

**Files:**
- Create: `packages/web/src/routes/notes/page.tsx`
- Create: `packages/web/src/routes/notes/note-sidebar.tsx`
- Create: `packages/web/src/routes/notes/note-list.tsx`
- Create: `packages/web/src/routes/notes/note-editor.tsx`
- Create: `packages/web/src/routes/notes/note-mic.tsx`
- Create: `packages/web/src/routes/notes/note-content.ts`
- Create: `packages/web/src/routes/notes/__tests__/note-content.test.ts`
- Create: `packages/web/src/routes/notes/__tests__/page.test.tsx`
- Create: `packages/web/src/routes/notes/__tests__/note-mic.test.tsx`

**Interfaces:**
- Consumes Task 3 hooks/API and existing `useStt`, `MicWaveform`, `WhisperDownloadModal`, `PageLayout`, Ledger tokens, and mobile tab bar.
- Produces one desktop three-pane surface (folders, notes, editor) and a mobile navigation stack (folders → notes → editor).
- [ ] **Step 1: Write failing editor and voice tests**

Pin first-heading titles supplied by the API, selected-folder filtering, updated-desc rows, previews, empty/loading/error/conflict states, new-note creation in the selected folder, 500ms autosave with the loaded revision, save acknowledgement updating the revision, 409 conflict recovery without discarding the draft, mobile Back behavior, and STT insertion at the current selection.

```ts
it("inserts a transcript at the editor selection", () => {
  expect(insertTranscript("Alpha beta", "voice", 6, 6)).toEqual({
    value: "Alpha voice beta",
    selection: 11,
  });
});
```

- [ ] **Step 2: Run page/editor tests and verify RED**

Run: `pnpm --filter @jinn/web exec vitest run src/routes/notes/__tests__/note-content.test.ts src/routes/notes/__tests__/page.test.tsx src/routes/notes/__tests__/note-mic.test.tsx`

Expected: FAIL because the Notes components are absent.

- [ ] **Step 3: Implement the desktop and mobile information architecture**

Desktop: keep the existing Jinn rail, then render a quiet folder sidebar, a grouped-inset note list, and a borderless editor canvas. Mobile: show one level at a time with native large titles and reversible browser/history navigation. Use title, timestamp, and two-line preview rows; selected state uses `--accent-fill`, never a hard border.

- [ ] **Step 4: Implement revision-safe autosave**

Persist an item-scoped local draft before transport, debounce transport by 500ms, serialize/coalesce saves, and acknowledge only the returned revision. On HTTP 409, keep the local draft, show a quiet conflict banner, and offer Reload or Overwrite only after re-reading the current revision; do not silently pick a winner.

- [ ] **Step 5: Implement the centered dictation control**

Place a 52px circular microphone at the bottom center of the editor canvas, above the mobile tab bar/safe area and inside the editor pane on desktop. Idle uses a theme token fill plus overlay shadow; recording expands horizontally into a compact waveform pill and uses system red; transcribing shows progress. Reuse tap-to-toggle and hold-to-talk semantics, language cycling when multiple languages exist, the shared download modal, and a readable inline error. Every transition names exact properties and press feedback is `scale(0.96)`.

- [ ] **Step 6: Run page/editor tests and verify GREEN**

Run the Step 2 command; expected PASS with no accessibility warnings.

---

### Task 5: Visual proof and repository gate

**Files:**
- Create outside the repo: `~/.jinn-audits/design-notes.md`
- Create outside the repo: `~/.jinn-audits/design-notes-mock.html`
- Create outside the repo: `~/.jinn-audits/design-notes-*.png`
- Modify only if needed: `packages/web/src/routes/globals.css`

- [ ] **Step 1: Produce and critique the token-accurate mock**

Capture desktop 1440×900 and mobile 390×844 in dark and light before final UI implementation. Record the chosen pane widths, row heights, mic footprint, and mobile safe-area behavior in the audit.

- [ ] **Step 2: Run a fixture gateway and capture the real page**

Serve `/api/auth/state`, Notes list/read/create/update, STT status, and the shell endpoints the page requests. Start Vite on a scratch port and capture the real route in dark/light × desktop/mobile, including list, selected note, recording, empty folder, and conflict states. Use Playwright for 390px mobile.

- [ ] **Step 3: Inspect every screenshot against Jinn design**

Verify no hardcoded colors, no rest-state hairline cards, correct theme contrast, ≥40px controls, centered/optically balanced mic, safe-area clearance, no clipped editor/list, no mobile horizontal overflow, and no `transition: all`.

- [ ] **Step 4: Run the full gate**

Run:

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

Expected: all commands exit 0.

- [ ] **Step 5: Stage only scoped files and leak-grep**

```bash
git add docs/superpowers/plans/2026-07-14-notes-over-knowledge.md packages/jinn/src/notes packages/jinn/src/gateway/api.ts packages/jinn/src/gateway/__tests__/notes-routes.test.ts packages/jinn/src/mcp packages/jinn/src/shared/types.ts packages/jinn/src/shared/__tests__/template-company-doctrine.test.ts packages/jinn/template packages/web/src
git diff --cached --check
pnpm --filter jinn test -- src/shared/__tests__/privacy-guard.test.ts
```

Expected: `git diff --cached --check` is silent and the privacy guard passes.

- [ ] **Step 6: Commit on main**

```bash
git commit -m "feat: add Notes over company knowledge"
```

Expected: one scoped commit on `main`, with the worktree clean afterward.

## Self-Review

- Spec coverage: existing/nested knowledge files, heading titles, create/edit, desktop/mobile Apple Notes model, Jinn design system, centered STT, MCP read/write, revision safety, visual proof, full verification, main-branch commit, and privacy gate are each mapped to a task.
- Placeholder scan: no deferred implementation markers or unspecified test steps remain.
- Type consistency: `NoteSummary`, `NoteDocument`, `NoteFolder`, `listNotes`, `readNote`, `createNote`, and `updateNote` use the same names and field shapes across store, HTTP, MCP, and web tasks.
