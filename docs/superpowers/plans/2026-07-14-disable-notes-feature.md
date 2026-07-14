# Disable Notes Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `gateway.notesEnabled` feature flag, default it to `false`, and remove Notes from all public entry points without deleting its implementation or stored Markdown data.

**Architecture:** The gateway owns the authoritative feature flag and rejects Notes API requests when disabled. The web app fetches the public capability before it renders navigation, search, or a Notes route; the MCP server captures the same setting at startup and does not register Notes tools. The Notes store and components remain unchanged.

**Tech Stack:** TypeScript, Node gateway, React/Vite dashboard, Vitest.

## Global Constraints

- `gateway.notesEnabled` defaults to `false` when omitted.
- Disabled Notes requests return `404`, not an authorization or storage error.
- Do not delete `knowledge/` data, Notes storage, route components, or MCP tool implementations.
- Keep all shipped text and fixtures generic.

---

### Task 1: Gateway flag and API boundary

**Files:**
- Modify: `packages/jinn/src/shared/types.ts`, `packages/jinn/src/shared/config.ts`, `packages/jinn/src/gateway/api.ts`
- Test: `packages/jinn/src/shared/__tests__/config.test.ts`, `packages/jinn/src/gateway/__tests__/notes-routes.test.ts`

**Interfaces:**
- Produces `config.gateway.notesEnabled?: boolean`; omitted means disabled.
- Produces `GET /api/features` with `{ notesEnabled: boolean }`.

- [ ] Write failing tests for boolean config validation and disabled Notes routes returning 404.
- [ ] Run the focused tests and confirm the new expectations fail.
- [ ] Add the optional config field, validation, feature response, and an early `/api/notes` route guard.
- [ ] Re-run focused tests and confirm they pass.

### Task 2: Web exposure boundary

**Files:**
- Modify: `packages/web/src/lib/api.ts`, `packages/web/src/lib/nav.ts`, `packages/web/src/components/global-search.tsx`, `packages/web/src/main.tsx`
- Test: `packages/web/src/lib/__tests__/nav.test.ts`, `packages/web/src/routes/notes/__tests__/navigation.test.tsx`

**Interfaces:**
- Consumes `api.getFeatures(): Promise<{ notesEnabled: boolean }>`.
- Produces navigation/search/route behavior that excludes Notes when the capability is false.

- [ ] Write failing tests for the disabled navigation and search surface.
- [ ] Run the focused web tests and confirm they fail.
- [ ] Gate Notes navigation, global search, and `/notes` routing from the feature response.
- [ ] Re-run focused web tests and confirm they pass.

### Task 3: MCP capability boundary

**Files:**
- Modify: `packages/jinn/src/mcp/server.ts`, `packages/jinn/src/engines/pi-mcp.ts`
- Test: `packages/jinn/src/mcp/__tests__/note-tools.test.ts`

**Interfaces:**
- `buildTools({ notesEnabled?: boolean })` excludes the four Notes verbs when false.
- MCP startup reads the same config flag before advertising tools.

- [ ] Write failing tests that prove disabled tool construction omits Notes while enabled construction retains them.
- [ ] Run the focused MCP test and confirm it fails.
- [ ] Gate Notes tool registration while retaining `buildNoteTools()` unchanged.
- [ ] Re-run focused MCP test and confirm it passes.

### Task 4: Verification

**Files:**
- No new production files.

- [ ] Run the affected gateway and web test suites plus TypeScript checks.
- [ ] Run a privacy leak scan against the final diff.
- [ ] Review `git diff` to confirm only the feature boundary changed.
