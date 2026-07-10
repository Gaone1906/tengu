# Durable PTY Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore long-lived CLI terminals after reconnect, PTY exit, and gateway restart without blank screens, duplicate output, or out-of-order terminal mutations.

**Architecture:** A headless xterm instance will consume the same bytes as each live PTY and serialize bounded, geometry-aware snapshots. `PtyStreamManager` will atomically register subscribers at a sequence boundary, provide a snapshot through that boundary, and buffer later deltas until the WebSocket has sent `reset`/`snapshot`/`ready`. The last good snapshot will be debounced to an instance-local state directory and retained across PTY exit; the browser will show restoring/error/exited states until the server explicitly declares readiness.

**Tech Stack:** TypeScript, `@xterm/headless`, `@xterm/addon-serialize`, node-pty, ws, React 19, browser xterm.js, Vitest.

## Global Constraints

- Work only in `/private/tmp/jinn-bug2`, based on current `main` with `29df488` in its ancestry.
- Do not touch the TLS proxy warning path.
- Use Node `24.13.0` and pnpm.
- Keep snapshots between 1,000-2,000 lines and no larger than 256-512 KiB.
- Persist with debounced atomic replacement beneath the active instance home.
- Delete durable state on session reset/delete.
- Never touch the production gateway on ports `7777`/`7788` or the production `~/.jinn` state.

---

### Task 1: Headless xterm snapshot and durable store

**Files:**
- Create: `packages/jinn/src/engines/pty-snapshot.ts`
- Create: `packages/jinn/src/engines/__tests__/pty-snapshot.test.ts`
- Modify: `packages/jinn/src/shared/paths.ts`
- Modify: `packages/jinn/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `PtySnapshot`, `PtySnapshotStore`, `SerializedPtySnapshot`, `PTY_SNAPSHOT_MAX_BYTES`, and `PTY_SNAPSHOT_SCROLLBACK_LINES`.
- `PtySnapshot.write(data)` queues split escape sequences in exact order; `capture()` waits for queued writes and returns `{ data, cols, rows, visible }`.
- `PtySnapshotStore.load`, `schedule`, `flush`, and `delete` use a hashed session filename and atomic temp-file rename.

- [ ] **Step 1: Add failing snapshot tests**

  Cover split escape sequences, cursor movement, clears, colors, more than 5,000 lines, serialized byte/line bounds, atomic persistence, restart loading, and deletion.

- [ ] **Step 2: Run the focused test and verify RED**

  Run: `pnpm --filter jinn-cli exec vitest run src/engines/__tests__/pty-snapshot.test.ts`

  Expected: fail because `pty-snapshot.ts` and its exports do not exist.

- [ ] **Step 3: Add compatible xterm dependencies and implement the minimal snapshot/store**

  Use `@xterm/headless@^6.0.0` with `@xterm/addon-serialize@^0.14.0`. Serialize at most 1,500 scrollback lines; reduce the requested line count until the UTF-8 payload is at most 512 KiB. Persist versioned JSON beneath `PTY_SNAPSHOTS_DIR` with unique temporary files followed by rename.

- [ ] **Step 4: Run focused tests and verify GREEN**

  Run the Task 1 Vitest command and confirm all assertions pass.

### Task 2: Atomic stream subscription and lifecycle protocol

**Files:**
- Modify: `packages/jinn/src/engines/pty-view-engine.ts`
- Modify: `packages/jinn/src/engines/pty-stream.ts`
- Modify: `packages/jinn/src/engines/__tests__/pty-stream.test.ts`

**Interfaces:**
- Replaces `subscribeOutput` + `getScrollback` with `subscribeWithSnapshot(sessionId, onData, onControl)` returning `{ snapshot, start, unsubscribe }`.
- `snapshot` resolves to the exact terminal state at the synchronous subscription boundary; `start()` releases ordered events produced after it.
- Control events are `restoring`, `reset`, `snapshot`, `ready`, `error`, and `exited`.

- [ ] **Step 1: Rewrite stream tests for the desired atomic contract**

  Assert snapshot-before-delta ordering at an injected attach boundary, reconnect without duplication, first visible paint readiness, clear/cursor-only output remaining unready, PTY exit retaining the last good snapshot, and a 5,000-line bounded soak.

- [ ] **Step 2: Run focused tests and verify RED**

  Run: `pnpm --filter jinn-cli exec vitest run src/engines/__tests__/pty-stream.test.ts`

  Expected: fail because the atomic subscription and structured lifecycle events are absent.

- [ ] **Step 3: Implement the sequence-bound subscription**

  Register a paused subscriber synchronously, capture the snapshot through the current write promise, and queue all later events until `start()`. On a new PTY generation retain the previous snapshot while emitting `restoring`; after the first visible headless paint emit `reset`, authoritative `snapshot`, and `ready`, then ordered later deltas. Persist later ready captures without clearing the last good state on exit.

- [ ] **Step 4: Run focused tests and verify GREEN**

  Run the Task 2 Vitest command and confirm all assertions pass.

### Task 3: Engine contract migration and explicit failure reporting

**Files:**
- Modify: `packages/jinn/src/engines/claude-interactive.ts`
- Modify: `packages/jinn/src/engines/codex-interactive.ts`
- Modify: `packages/jinn/src/engines/grok-interactive.ts`
- Modify: `packages/jinn/src/engines/hermes-interactive.ts`
- Modify: `packages/jinn/src/engines/antigravity.ts`
- Modify: matching interactive-engine tests under `packages/jinn/src/engines/__tests__/`

**Interfaces:**
- Every `PtyViewEngine` delegates `subscribeWithSnapshot` to `PtyStreamManager`.
- Every engine exposes `restartPty(sessionId, opts)` for the recovery action.
- Current PTY exit calls `onPtyExit(sessionId, exitEvent)`; asynchronous resume failures call `reportError`.

- [ ] **Step 1: Add/adjust failing engine contract tests**

  Assert asynchronous Claude resume failure becomes an explicit stream error and a restart releases/recreates the PTY instead of silently returning.

- [ ] **Step 2: Run targeted engine tests and verify RED**

  Run the interactive Claude/Codex/Grok/Hermes/Antigravity test files.

- [ ] **Step 3: Migrate engines with no provider/proxy behavior changes**

  Delegate the new subscription, exit, resize, and restart methods to the common stream/lifecycle helpers. Keep the TLS proxy source untouched.

- [ ] **Step 4: Run targeted engine tests and verify GREEN**

### Task 4: Snapshot-first WebSocket framing and resume deadline

**Files:**
- Modify: `packages/jinn/src/gateway/pty-ws.ts`
- Create: `packages/jinn/src/gateway/__tests__/pty-ws.test.ts`

**Interfaces:**
- On attach: await the atomic snapshot, send JSON `reset`, JSON `snapshot`, optional JSON `ready`, call `start()`, then forward binary deltas.
- On restore failure/deadline: send recoverable JSON `error` without clearing the socket or last good screen.
- On `{type:"restart"}`: invoke `restartPty` with the last validated geometry and re-arm the deadline.

- [ ] **Step 1: Add failing framing tests**

  Assert no binary delta precedes snapshot framing, attach-boundary bytes remain exact, persisted restart snapshot is the first paint, deadline produces an error, ready cancels it, and restart requests invoke engine recovery.

- [ ] **Step 2: Run the focused test and verify RED**

  Run: `pnpm --filter jinn-cli exec vitest run src/gateway/__tests__/pty-ws.test.ts`

- [ ] **Step 3: Implement framing/deadline/restart**

  Treat all structured events as JSON controls and all deltas as binary. Do not close the WebSocket for recoverable resume failures.

- [ ] **Step 4: Run focused tests and verify GREEN**

### Task 5: Durable cleanup on reset/delete

**Files:**
- Modify: `packages/jinn/src/sessions/registry.ts`
- Modify: `packages/jinn/src/sessions/__tests__/registry-delete-queue-items.test.ts`

**Interfaces:**
- A successful `deleteSession` or each successful member of `deleteSessions` removes its persisted PTY snapshot.
- Preserved linked attempts do not delete their snapshot because the durable session remains.

- [ ] **Step 1: Add failing cleanup tests**

  Seed snapshot files, delete/reset sessions, and assert successful deletions remove them while refused linked deletions preserve them.

- [ ] **Step 2: Run focused tests and verify RED**

- [ ] **Step 3: Invoke idempotent snapshot deletion after successful database transactions**

- [ ] **Step 4: Run focused tests and verify GREEN**

### Task 6: Browser authoritative-snapshot state machine

**Files:**
- Modify: `packages/web/src/components/cli-terminal.tsx`
- Create: `packages/web/src/components/__tests__/cli-terminal.test.tsx`

**Interfaces:**
- `reset` clears xterm, `snapshot` writes the authoritative serialization, `ready` removes restoring UI, and binary deltas never independently declare readiness.
- `error`/`exited` retain a visible recovery panel and the last good terminal paint.
- The recovery panel sends `{type:"restart"}` and returns to restoring state.

- [ ] **Step 1: Add failing component tests**

  Mock xterm/WebSocket and assert clear-only binary bytes do not hide fallback, snapshot + ready paints/removes fallback, reconnect does not duplicate, and failed resume exposes a usable restart action.

- [ ] **Step 2: Run the focused web test and verify RED**

  Run: `pnpm --filter @jinn/web exec vitest run src/components/__tests__/cli-terminal.test.tsx`

- [ ] **Step 3: Implement the protocol-driven UI**

  Keep “Restoring terminal…” visible until `ready`. Render recoverable error/exited text and a minimum 40×40 px restart button with explicit transform transition and `active:scale(0.96)` behavior; do not use arbitrary byte presence as a paint signal.

- [ ] **Step 4: Run focused tests and verify GREEN**

### Task 7: Complete verification, privacy check, commit, and fast-forward

**Files:**
- Review every modified file and the final staged diff.

- [ ] **Step 1: Run targeted PTY and web scopes**

  Run the snapshot, stream, WebSocket, interactive-engine, registry cleanup, and web terminal tests; save verbatim output tails.

- [ ] **Step 2: Run full verification under Node 24.13.0**

  Run `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `pnpm test`; confirm all exit 0 and save verbatim tails.

- [ ] **Step 3: Review scope and staged privacy**

  Confirm no TLS proxy changes. Run the required staged leak grep and ensure it has no unexpected matches.

- [ ] **Step 4: Commit without co-author trailers**

  Commit the isolated branch with a focused `fix(terminal): restore durable PTY snapshots` message.

- [ ] **Step 5: Fast-forward main and prove ancestry**

  From the primary checkout, run `git merge --ff-only <commit>` and `git merge-base --is-ancestor <commit> main`; report the commit SHA and the successful ancestry exit code.
