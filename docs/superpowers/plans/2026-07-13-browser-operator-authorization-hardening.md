# Browser Operator Authorization Hardening Implementation Plan

> **For agentic workers:** Execute inline in this session. The assignment explicitly forbids subagents and requires direct work on `main`.

**Goal:** Bind auth-disabled browser operator fallback to a genuine direct local gateway connection and reject malformed request authorities without throwing or reflecting private input.

**Architecture:** Keep explicit bearer/cookie authentication unchanged. For the browser-only fallback, validate one strict Host authority and complete browser Fetch Metadata, reject proxy/forwarding evidence, and require both ends of the actual socket to be loopback with the authority port matching the listener port. Parse API request targets against a fixed internal base only after authority validation so raw Host can never throw through the server.

**Tech Stack:** Node.js HTTP/raw TCP, TypeScript strict mode, Vitest, existing Jinn gateway authorization helpers.

## Global Constraints

- Work directly on `main`; path-stage only scoped files and preserve unrelated dirty/untracked work.
- Use disposable `JINN_HOME` directories and ephemeral non-production ports; never access or restart `:7777`.
- Strict RED→GREEN TDD: deterministic failing real-network tests precede production edits.
- Do not add proxy trust or touch Todo/Workflow lifecycle semantics, approvals, or unrelated UI.
- Keep public repository content generic and add no commit co-author trailer.

---

### Task 1: Real-network defect reproductions

**Files:**
- Modify: `packages/jinn/src/gateway/__tests__/browser-operator-authorization.test.ts`

**Interfaces:**
- Consumes: `handleApiRequest(req, res, context)` through a real ephemeral HTTP listener.
- Produces: regression coverage for proxy-shaped Origin-less requests, invalid/duplicate authority, and listener-bound local browser access.

- [ ] Add a raw TCP request helper that returns the HTTP status and JSON body without normalizing malformed or duplicate Host headers.
- [ ] Add a proxy-shaped Origin-less request with same-origin Fetch Metadata and rewritten loopback Host; expect fixed 403.
- [ ] Add a malformed Host request; expect fixed non-reflective 400, no handler rejection, and a healthy follow-up request.
- [ ] Add the fail-closed matrix for missing/invalid metadata, forwarding headers, wrong listener port, duplicate/ambiguous Host, DNS-rebinding-style Host, and auth-enabled anonymous access.
- [ ] Run `pnpm --filter jinn-cli exec vitest run src/gateway/__tests__/browser-operator-authorization.test.ts` and record the expected authorization 200-vs-403 and malformed-authority 500/rejection-vs-400 failures.

### Task 2: Request-bound browser authorization

**Files:**
- Modify: `packages/jinn/src/gateway/api.ts`
- Modify: `packages/jinn/src/gateway/server.ts`
- Modify: `packages/jinn/src/gateway/__tests__/upgrade-identity-guard.test.ts`

**Interfaces:**
- Consumes: `IncomingMessage.headers`, `rawHeaders`, `socket.remoteAddress`, `socket.localAddress`, and `socket.localPort`.
- Produces: `isSameOriginBrowserRequest(req, config): boolean` and a fixed invalid-authority response at the API boundary.

- [ ] Add a strict, non-throwing request-authority parser that requires exactly one Host and never reflects its input.
- [ ] Change browser operator fallback to consume the request, reject forwarding/proxy indicators, require complete Fetch Metadata, and bind authority to the actual loopback listener port and loopback peer/local addresses.
- [ ] Preserve explicit `verifyGatewayAuth` bearer/cookie behavior before the browser fallback.
- [ ] Validate authority before API URL construction and parse the relative request target against a fixed internal base.
- [ ] Pass the full request to operator-authority call sites; header-only identity checks remain capability/bearer-only.
- [ ] Update PTY WebSocket tests/call site with realistic same-origin WebSocket metadata and socket evidence.
- [ ] Run the focused authorization and upgrade tests and record GREEN.

### Task 3: Verification and commit

**Files:**
- Verify only the scoped files above and this plan.

**Interfaces:**
- Consumes: repository scripts and staged diff.
- Produces: one scoped commit on `main` with reproducible evidence.

- [ ] Run focused gateway authorization/Todo tests and the fail-closed matrix.
- [ ] Run relevant full gateway and web tests, then root `pnpm typecheck`, `pnpm build`, and `pnpm lint`.
- [ ] Inspect `git diff`, confirm unrelated files remain untouched, and run the staged privacy leak grep.
- [ ] Verify the commit message/body has no co-author trailer.
- [ ] Path-stage only scoped files and commit directly to `main`.
- [ ] Confirm no disposable listener remains and production `:7777` was never accessed or restarted.
