# Multi-Workspace Directory and Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make registered Jinn workspaces host-scoped, remotely reachable, switchable from a neutral desktop launcher, and creatable from the web UI with automatic first-run onboarding.

**Architecture:** Move the registry path and behavior into a focused host-workspace module that is independent of `JINN_HOME`, while preserving the existing CLI facade. The gateway exposes typed list/create operations; creation runs setup and startup in isolated subprocesses, optionally mirrors an existing private Tailscale Serve mapping, and returns a one-time fragment credential so the new browser origin opens directly into onboarding. The web shares one workspace menu/dialog between the desktop rail and the existing mobile list.

**Tech Stack:** TypeScript ES2022, Node filesystem/process APIs, Vitest, React 19, React Router 7, Radix Dialog, Tailwind 4.1, Lucide.

---

### Task 1: Host workspace directory and legacy migration

**Files:**
- Create: `packages/jinn/src/instances/directory.ts`
- Modify: `packages/jinn/src/shared/paths.ts`
- Modify: `packages/jinn/src/cli/instances.ts`
- Test: `packages/jinn/src/instances/directory.test.ts`

- [ ] Write failing tests for macOS, Windows, and XDG paths; v1 array import from `~/.jinn/instances.json`; immutable IDs; atomic schema-v2 writes; and registry override compatibility.
- [ ] Run the focused test and confirm it fails because the host directory module does not exist.
- [ ] Implement `resolveHostDataDir`, `resolveInstancesRegistryPath`, schema validation/normalization, idempotent legacy import, and atomic `0600` persistence.
- [ ] Keep `cli/instances.ts` as a compatibility re-export so existing CLI consumers do not depend on gateway code.
- [ ] Run the focused test and existing CLI instance tests until green.

### Task 2: Workspace naming, creation, startup, and access discovery

**Files:**
- Create: `packages/jinn/src/instances/create.ts`
- Create: `packages/jinn/src/instances/access.ts`
- Modify: `packages/jinn/src/cli/create.ts`
- Modify: `packages/jinn/bin/jinn.ts`
- Test: `packages/jinn/src/instances/create.test.ts`
- Test: `packages/jinn/src/instances/access.test.ts`

- [ ] Write failing tests showing `John` becomes display name `John`, slug `john`, instance id/name `jinn-john`, and home `~/.jinn-john`, while invalid/path-traversal names are rejected.
- [ ] Write failing tests for available-port selection, subprocess setup/start arguments, rollback before registration, and existing registry-based `-i` home resolution.
- [ ] Write failing access tests that parse Tailscale Serve JSON, map internal ports to HTTPS origins (including 443), infer a same-host remote URL when no provider mapping exists, and preserve loopback URLs locally.
- [ ] Implement the creation service with injected subprocess/health dependencies, YAML config patching, registration only after setup succeeds, daemon startup, bounded health polling, and warning-only remote exposure failures.
- [ ] Implement conservative Tailscale cloning only when the current workspace is already behind private Tailscale Serve: `tailscale serve --bg --yes --https=<port> http://127.0.0.1:<port>`; never enable Funnel or public exposure.
- [ ] Update the CLI to use the shared service and resolve `-i` through the host directory, retaining legacy registered homes.
- [ ] Run focused tests until green.

### Task 3: Gateway workspace API and seamless browser handoff

**Files:**
- Modify: `packages/jinn/src/gateway/api.ts`
- Modify: `packages/web/src/lib/auth.ts`
- Modify: `packages/web/src/routes/auth-provider.tsx`
- Test: `packages/jinn/src/gateway/__tests__/instances-api.test.ts`
- Test: `packages/web/src/lib/__tests__/auth.test.ts`
- Test: `packages/web/src/routes/auth-provider.test.tsx`

- [ ] Write failing API tests for an authenticated `GET /api/instances` response keyed by current home identity with `displayName`, `switchUrl`, and runtime state.
- [ ] Write failing API tests for operator-only `POST /api/instances`, duplicate-name/port conflicts, successful create/start, one-time pairing fragment, and nonfatal exposure warnings.
- [ ] Implement current-origin observation, provider-aware URL resolution, home/PID-aware health, and the POST route using injected creation dependencies for tests.
- [ ] Write failing browser-auth tests for consuming and removing a `jinn-pair` hash value before automatically exchanging it.
- [ ] Implement auto-pairing in `AuthProvider`, then re-fetch auth state; leave the ordinary pairing screen as the failure fallback.
- [ ] Run focused gateway and web auth tests until green.

### Task 4: Neutral desktop launcher and shared creation dialog

**Files:**
- Create: `packages/web/src/components/workspaces/workspace-menu.tsx`
- Create: `packages/web/src/components/workspaces/create-workspace-dialog.tsx`
- Create: `packages/web/src/hooks/use-workspaces.ts`
- Modify: `packages/web/src/lib/api.ts`
- Modify: `packages/web/src/components/pill-nav.tsx`
- Modify: `packages/web/src/routes/more/page.tsx`
- Test: `packages/web/src/components/workspaces/workspace-menu.test.tsx`
- Test: `packages/web/src/components/__tests__/pill-nav.test.ts`

- [ ] Write failing component tests for a neutral `Layers3` rail button, a full-name menu, current/running states, real anchors using server-provided URLs, and an Add workspace action.
- [ ] Write failing dialog tests for validation, pending state, inline API errors, and navigation to the returned launch URL.
- [ ] Implement the shared query/mutation hook and quiet overlay menu using existing material/shadow tokens without colored stack icons.
- [ ] Mount the launcher directly after the desktop navigation/settings lane and before the theme control.
- [ ] Keep the current mobile grouped list design, rename its product label to Workspaces, use the same server-provided links, and append a native-style Add workspace row.
- [ ] Run focused web tests until green.

### Task 5: Cross-theme and cross-breakpoint verification

**Files:**
- Create outside repo: `~/.jinn-audits/workspace-launcher-fixture.mjs`
- Create outside repo: `~/.jinn-audits/workspace-launcher-*.png`

- [ ] Build the web package and run it against a fixture gateway with auth disabled and deterministic workspace responses.
- [ ] Capture desktop 1440px dark/light states with the menu open and creation dialog visible.
- [ ] Capture mobile 390px dark/light states and verify the existing More-page layout remains intact.
- [ ] Inspect each image for clipping, theme-token regressions, ≥34px targets, menu reachability, and readable error/loading states.

### Task 6: Repository verification and privacy gate

**Files:**
- Modify only files listed above if verification exposes a defect.

- [ ] Run `pnpm typecheck`.
- [ ] Run focused tests, then `pnpm test` and `pnpm lint`.
- [ ] Run `pnpm build`.
- [ ] Confirm the existing untracked `.artifacts/` directory is untouched.
- [ ] Stage only scoped files and leak-grep the staged diff for personal names, projects, emails, keys, and personal absolute paths.
- [ ] Commit without co-author trailers and report the commit plus any environment-specific Tailscale warning.
