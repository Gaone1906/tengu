# Gateway Auth Default and Proxy Diagnosis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make fresh gateways authentication-enabled without adding localhost friction, route proxy-caused scoped-write failures to an actionable error, and remove the speculative Claude capability fallback.

**Architecture:** Keep caller classification unchanged and add one refusal-message classifier at the API boundary: only an unauthenticated, forwarded request on an auth-disabled/not-required gateway receives the proxy diagnosis; tool-marked identity loss keeps the existing MCP error. Fresh setup config enables auth, `jinn create` finalization materializes the existing owner-only gateway token, and the existing single-use URL-fragment bootstrap remains the only automatic localhost browser pairing path.

**Tech Stack:** TypeScript ES2022, Node HTTP, YAML configuration, React browser auth client, Vitest, pnpm/Turborepo.

## Global Constraints

- Work only in the dedicated `jinn-ici-400` worktree based on `origin/main`; do not alter the canonical checkout.
- Do not use or restart ports 7777, 7850, 7788.
- Existing instances receive no migration or config rewrite.
- Local auto-pair must require the CLI-authored, single-use, 60-second URL-fragment grant; loopback address alone is not operator identity.
- Forwarded requests without configured auth fail closed with HTTP 403 and an actionable proxy/auth message.
- Genuine tool identity loss retains `UNIDENTIFIED_TOOL_CALL_ERROR` and its `JINN_SESSION_ID` / `JINN_SESSION_CAPABILITY` guidance.
- Public shipped source, tests, templates, and docs remain generic and contain no operator-specific data.
- Git commits use the repository-configured maintainer identity and no co-author trailer.
- Full build, typecheck, test, and lint must pass before pushing and fast-forwarding `origin/main`.

---

### Task 1: Cause-aware scoped-write refusal

**Files:**
- Modify: `packages/jinn/src/gateway/api.ts`
- Test: `packages/jinn/src/gateway/__tests__/browser-operator-authorization.test.ts`

**Interfaces:**
- Consumes: `resolveScopedWriteCallerIdentity(req, context)`, `shouldRequireGatewayAuth(config)`, `FORWARDED_REQUEST_HEADERS`, and `requestHeaderValues(req, name)`.
- Produces: `PROXIED_OPERATOR_AUTH_ERROR: string` and a private error-selection helper used by the scoped-write preflight.

- [ ] **Step 1: Write failing proxy-cause tests**

Add a real HTTP `POST /api/sessions` test with same-origin browser metadata plus `x-forwarded-for`. Assert status 403, assert the body explains forwarded headers, no configured gateway auth, `gateway.authRequired: true`, and pairing, and assert it does not mention `JINN_SESSION_ID` or `JINN_SESSION_CAPABILITY`.

Add a second test with the same forwarded header plus `x-jinn-tool-call: jinn-mcp`. Assert status 403 and the unchanged MCP identity-loss message containing both environment variable names. This pins cause precedence.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter jinn-cli exec vitest run src/gateway/__tests__/browser-operator-authorization.test.ts`

Expected: the proxied browser request returns the current `caller identity unavailable` MCP error, so the actionable proxy-message assertions fail.

- [ ] **Step 3: Implement the minimal error classifier**

In `api.ts`, define:

```ts
export const PROXIED_OPERATOR_AUTH_ERROR =
  "operator authentication failed: this request reached the gateway through a proxy " +
  "(forwarded headers present) but the gateway has no auth configured, so it cannot be trusted as the operator. " +
  "Enable gateway auth (gateway.authRequired: true) and pair your device; same-origin operator trust does not apply to proxied requests.";
```

Add a helper that returns this constant only when all conditions hold: caller kind is `unauthenticated`, a full request is available, one of `FORWARDED_REQUEST_HEADERS` is present, and `shouldRequireGatewayAuth(context.getConfig())` is false. Return `UNIDENTIFIED_TOOL_CALL_ERROR` otherwise. Use it in `rejectUnverifiedIdentifiedApiCaller`; do not change `resolveCallerIdentity` or same-origin trust rules.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm --filter jinn-cli exec vitest run src/gateway/__tests__/browser-operator-authorization.test.ts`

Expected: all browser authorization tests pass, including the two new cause-routing cases.

- [ ] **Step 5: Commit**

```bash
git add packages/jinn/src/gateway/api.ts packages/jinn/src/gateway/__tests__/browser-operator-authorization.test.ts
git commit -m "fix(auth): diagnose proxied operator failures"
```

### Task 2: Auth-enabled fresh instances with local auto-pair

**Files:**
- Modify: `packages/jinn/src/cli/setup.ts`
- Modify: `packages/jinn/src/cli/create.ts`
- Test: `packages/jinn/src/cli/__tests__/config-seed.test.ts`
- Test: `packages/jinn/src/cli/__tests__/create-verify.test.ts`
- Test: `packages/jinn/src/cli/__tests__/start.test.ts`
- Test: `packages/jinn/src/gateway/__tests__/auth-ux-api.test.ts`

**Interfaces:**
- Consumes: `ensureGatewayAuthToken(home)`, the fresh-install `DEFAULT_CONFIG`, `issueLocalBootstrapGrant()`, and `POST /api/auth/bootstrap`.
- Produces: `finalizeCreatedInstance(home: string, name: string, port: number): void`, a fresh `gateway.authRequired: true` config, an owner-only `gateway.json` token at creation time, and a credentialed local browser session after bootstrap exchange.

- [ ] **Step 1: Write failing default/create tests**

In `config-seed.test.ts`, parse or inspect the canonical `DEFAULT_CONFIG` source and assert the shipped fresh gateway block contains `authRequired: true`.

In `create-verify.test.ts`, write a representative setup-created config to a temp instance home, call the wished-for `finalizeCreatedInstance(home, "auth-test", 7891)`, then assert the port and portal name were patched and `gateway.json` contains a token of at least 32 characters with mode 0600.

- [ ] **Step 2: Run the focused CLI tests and verify RED**

Run: `pnpm --filter jinn-cli exec vitest run src/cli/__tests__/config-seed.test.ts src/cli/__tests__/create-verify.test.ts`

Expected: the default-auth assertion fails and `finalizeCreatedInstance` is not exported.

- [ ] **Step 3: Implement fresh auth and creation finalization**

Add `authRequired: true` under `gateway` in `DEFAULT_CONFIG`. Extract the existing create-time port/portal patch into `finalizeCreatedInstance`, call `ensureGatewayAuthToken(home)` after the config write, and call the helper from `runCreate` only after setup has successfully populated the new home. Do not add a migration or modify existing config files.

- [ ] **Step 4: Pin local auto-pair under auth-required config**

Change the `start.test.ts` config fixture to `authRequired: true` and keep the existing assertion that interactive start opens a URL with a valid single-use bootstrap grant. Add an API test that exchanges a valid loopback grant, captures the two HttpOnly cookies, and verifies `/api/auth/state` reports `authenticated: true`; also retain the existing remote/proxied bootstrap rejection tests.

- [ ] **Step 5: Run focused auth tests and verify GREEN**

Run: `pnpm --filter jinn-cli exec vitest run src/cli/__tests__/config-seed.test.ts src/cli/__tests__/create-verify.test.ts src/cli/__tests__/start.test.ts src/gateway/__tests__/auth-security.test.ts src/gateway/__tests__/auth-ux-api.test.ts`

Expected: all tests pass and `validateGatewayExposure` coverage remains green.

- [ ] **Step 6: Commit**

```bash
git add packages/jinn/src/cli/setup.ts packages/jinn/src/cli/create.ts packages/jinn/src/cli/__tests__/config-seed.test.ts packages/jinn/src/cli/__tests__/create-verify.test.ts packages/jinn/src/cli/__tests__/start.test.ts packages/jinn/src/gateway/__tests__/auth-ux-api.test.ts
git commit -m "feat(auth): secure new gateways by default"
```

### Task 3: Remove the unproven Claude parent-env fallback

**Files:**
- Revert: `packages/jinn/src/engines/claude-interactive.ts`
- Revert: `packages/jinn/src/mcp/__tests__/engine-wiring.test.ts`
- Verify: `packages/jinn/src/mcp/__tests__/server-bootstrap.test.ts`

**Interfaces:**
- Consumes: per-session non-secret argv from `attachSessionIdentity` and capability derivation in `resolveMcpServerBootstrap`.
- Produces: no top-level PTY capability copy; MCP identity survives configured MCP-env filtering through the already-reachable argv bootstrap path.

- [ ] **Step 1: Record reachability verdict**

Trace the Claude production launch from `resolveEngineRunMcp` through `attachSessionIdentity`, `--mcp-config`, and `server-entry`. Confirm the child receives `--jinn-session-id`, `--jinn-home`, and `--jinn-gateway-url`, and derives its bound capability from the per-instance key even when server env is stripped. Since no reachable launch path was found that loses those arguments while preserving only the PTY parent env, classify `f49f8df4` as speculative.

- [ ] **Step 2: Revert the commit**

Run: `git revert --no-edit f49f8df4`

Expected: the `ResolvedMcpConfig`/identity-env additions disappear from `claude-interactive.ts`, and the speculative engine-wiring test is removed while argv-bootstrap tests remain.

- [ ] **Step 3: Verify the supported fallback**

Run: `pnpm --filter jinn-cli exec vitest run src/mcp/__tests__/server-bootstrap.test.ts src/mcp/__tests__/engine-wiring.test.ts`

Expected: both suites pass without copying a capability into the parent PTY environment.

### Task 4: Full verification, throwaway proof, and landing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-20-gateway-auth-default.md` only to check completed steps if useful.

**Interfaces:**
- Consumes: built CLI, free 78xx loopback port, isolated temporary HOME, HTTP requests, and GitHub `origin/main`.
- Produces: green repository verification, a destroyed throwaway instance, pushed commits, and fast-forwarded `origin/main`.

- [ ] **Step 1: Run complete repository checks**

Run, capturing verbatim tails:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

Expected: all commands exit 0.

- [ ] **Step 2: Audit the diff and staged content**

Review `git diff origin/main...HEAD`, `git diff --check`, and run the required staged leak grep. Confirm there are no personal names, projects, emails, keys, Slack IDs, absolute user paths, or co-author trailers in shipped changes.

- [ ] **Step 3: Create an isolated throwaway instance**

Use a `mktemp -d` HOME and a verified-free port in 7800-7899 excluding 7850, 7788, and 7777. Build first, then run the built `jinn create jinn-authtest --port <port>`. Assert its config contains `authRequired: true`, `gateway.json` already contains an owner-only token, and `validateGatewayExposure` permits the loopback config.

- [ ] **Step 4: Verify local bootstrap and proxied behavior**

Start the throwaway gateway in the foreground without touching existing daemons, capture the CLI-opened dashboard URL, exchange its one-time fragment grant, and store the resulting cookies. Verify an authenticated local dashboard API call succeeds. Send a forwarded-header `POST /api/sessions` without cookies and assert 403 plus the new proxy diagnosis; mint/redeem a pairing code (or reuse the authenticated local device as the paired proof), send the same forwarded request with paired cookies, and assert it passes the auth gate.

- [ ] **Step 5: Destroy the throwaway instance**

Stop only the throwaway gateway, remove its isolated HOME/registry, and verify the selected port is no longer listening. Do not touch 7777, 7850, 7788, or their daemons.

- [ ] **Step 6: Land on `origin/main`**

Push the feature branch, verify `origin/main` has not moved unexpectedly, then push the verified branch tip to `origin/main` as a fast-forward. Do not modify or reset the canonical checkout or its local `main` branch.

- [ ] **Step 7: Update Todo and report**

Move `ICI-400` to `in_review` with the commit hashes and verification summary. Report the design, changed files, verbatim command tails, C verdict, `origin/main` commits, and throwaway proof. End with `DONE`.

## Self-Review

- Spec coverage: Tasks 1-4 cover proxy diagnosis, fresh auth default, local auto-pair, token materialization, exposure validation, the `f49f8df4` verdict, full suite, isolated manual proof, cleanup, and landing.
- Placeholder scan: no TBD/TODO/later placeholders remain.
- Type consistency: `finalizeCreatedInstance(home, name, port)` and `PROXIED_OPERATOR_AUTH_ERROR` are named consistently across tests and implementation steps.
