# Active Platform Lines Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the four active, session-scoped Jinn feature lines into local `main`, verify the combined product, deploy it safely, and remove only proven-integrated temporary Git state.

**Architecture:** Use an isolated `main` worktree so the active Todo designer can finish without losing its uncommitted files. Merge the shared platform line first, then the backend CAS, callback lifecycle, and Workflow lines; resolve conflicts by preserving the newest compatible contracts from both sides rather than choosing one branch wholesale.

**Tech Stack:** Git worktrees, TypeScript, pnpm/Turborepo, Vitest, Vite.

## Global Constraints

- Never modify or delete operator-owned scratch files.
- Never merge unrelated historical, release, PR, or experimental branches.
- Never add a `Co-Authored-By` trailer.
- Keep all shipped repository content generic; run the privacy firewall before the final commit.
- Use `jinn restart` semantics, never stop/start, after the combined tree is verified.

---

### Task 1: Merge the active platform heads

**Files:**
- Modify: Git history and conflict-resolved files selected by the four branch merges.
- Create: `docs/superpowers/plans/2026-07-12-integrate-active-platform-lines.md`

**Interfaces:**
- Consumes: local `main` at `62dda29649692e6ed01a05cab78f4856a4d4bc3b`.
- Produces: one combined `main` containing the active platform, Todo backend, callback lifecycle, and Workflow heads.

- [ ] **Step 1: Merge the current platform line**

```bash
git merge --no-ff feat/wi-cce21d70992a-activity-ledger
```

Expected: Activity foundation, child-preview/delegation UI, Todo frontend work, and engine-specific rate-limit handling enter `main`.

- [ ] **Step 2: Merge Todo backend concurrency**

```bash
git merge --no-ff fix/todo-cas-backend-rebase
```

Expected: versioned conditional Todo edits, replay keys, request bounds, and strict JSON validation coexist with the frontend adapter.

- [ ] **Step 3: Merge callback and notification lifecycle hardening**

```bash
git merge --no-ff fix/wi-883144-notification-lifecycle
```

Expected: durable callback receipts, recovery/dead-letter support, and nonterminal rate-limit notification behavior coexist with Activity migrations.

- [ ] **Step 4: Merge Workflow layout/editor work**

```bash
git merge --no-ff feat/wi-c239479ad914-workflow-layout
```

Expected: normalized layouts, persistent editor geometry, accessible navigation, strict authoring schemas, and run-key integrity enter the combined tree.

### Task 2: Close the Todo frontend race

**Files:**
- Modify: only committed Todo frontend files produced by the already-running designer session.

**Interfaces:**
- Consumes: the designer's final commit on `feat/wi-cce21d70992a-activity-ledger`.
- Produces: combined `main` with no uncommitted Todo residual omitted.

- [ ] **Step 1: Confirm the designer committed its two active files**

```bash
git -C ../../jinn status --short
git log -1 --oneline feat/wi-cce21d70992a-activity-ledger
```

- [ ] **Step 2: Merge the updated head**

```bash
git merge --no-ff feat/wi-cce21d70992a-activity-ledger
```

Expected: either a small follow-up merge or “Already up to date.”

### Task 3: Verify the combined product

**Files:**
- Test: all gateway and web suites.

**Interfaces:**
- Consumes: combined integration tree.
- Produces: evidence that the merged tree builds and passes its full regression suites.

- [ ] **Step 1: Run gateway tests and typecheck**

```bash
pnpm --filter jinn-cli test
pnpm --filter jinn-cli typecheck
```

- [ ] **Step 2: Run web tests and typecheck**

```bash
pnpm --filter @jinn/web test
pnpm --filter @jinn/web typecheck
```

- [ ] **Step 3: Run the production build**

```bash
pnpm build
```

- [ ] **Step 4: Run repository audits**

```bash
git diff --check main@{1}..main
git log main@{1}..main --format=%B | grep -i 'Co-Authored-By' && exit 1 || true
git diff main@{1}..main | grep -iE 'hristo|jimmyenglish|pravko|movekit|sqlnoir|homy|spycam|asomaniac|kiwilabs|tucker@|/Users/' && exit 1 || true
```

### Task 4: Deploy and clean

**Files:**
- Remove: only integrated temporary worktrees and their active feature branches.

**Interfaces:**
- Consumes: verified local `main`.
- Produces: live gateway on verified main plus a compact worktree/branch set.

- [ ] **Step 1: Restart through the Jinn CLI**

```bash
node packages/jinn/dist/bin/jinn.js restart
```

- [ ] **Step 2: Verify the gateway returns**

```bash
curl -fsS http://127.0.0.1:7777/api/status
```

- [ ] **Step 3: Remove only worktrees whose commits are ancestors of main**

```bash
git merge-base --is-ancestor <worktree-head> main
git worktree remove <path>
```

- [ ] **Step 4: Delete only integrated active feature branches**

```bash
git branch -d feat/wi-cce21d70992a-activity-ledger
git branch -d fix/todo-cas-backend-rebase
git branch -d fix/callback-delivery-idempotency
git branch -d fix/callback-residual-durability
git branch -d fix/wi-883144-notification-lifecycle
git branch -d integrate/todo-cas-frontend-a3c0
git branch -d feat/wi-c239479ad914-workflow-layout
```

Expected: Git refuses any branch not fully integrated; no force deletion is used.
