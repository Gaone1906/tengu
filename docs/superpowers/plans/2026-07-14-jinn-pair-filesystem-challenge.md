# Jinn Pair Filesystem Challenge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore `jinn pair` code minting by proving same-owner write access to `JINN_HOME` without allowing bearer-authenticated pairing-code creation.

**Architecture:** A public-but-loopback-only challenge route creates a ten-second in-memory challenge and names an owner-only file beneath `JINN_HOME`. The CLI writes the nonce to that file and submits only the challenge ID; the gateway validates regular-file type, exact `0600` mode, same owner as `JINN_HOME`, exact nonce, TTL, and single-use state before minting a pairing code.

**Tech Stack:** TypeScript, Node.js `fs`/`crypto`, gateway REST routes, Vitest

## Global Constraints

- `Authorization: Bearer <gateway token>` must continue to receive `403` from `POST /api/auth/pairing-codes`.
- Both challenge issuance and challenge redemption require a loopback socket and loopback `Host` header.
- Challenges expire after 10 seconds, are single-use, and delete their proof file after any redemption attempt.
- The proof establishes same-owner local filesystem control, not human presence. Any same-user local process with shell access can deliberately complete it.
- Persisted browser-device integrity is out of scope and tracked separately as `wi_cd73aaa4399e`.
- Public repository content must remain generic and contain no operator-specific data.

---

### Task 1: Challenge primitive

**Files:**
- Create: `packages/jinn/src/gateway/pairing-challenge.ts`
- Create: `packages/jinn/src/gateway/__tests__/pairing-challenge.test.ts`

**Interfaces:**
- Produces: `PAIRING_CHALLENGE_TTL_MS`, `PairingChallengeStore`, `issuePairingChallenge(jinnHome, store?, now?, idFactory?, nonceFactory?)`, and `consumePairingChallenge(jinnHome, challengeId, store?, now?)`.
- Consumes: a POSIX `JINN_HOME` owned by the gateway process user.

- [ ] **Step 1: Write failing primitive tests**

Cover exact `0600` same-owner success, replay, expiry, nonce mismatch, broad mode, and symlink/non-file rejection. Use deterministic IDs/nonces and isolated temporary homes.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter jinn-cli exec vitest run src/gateway/__tests__/pairing-challenge.test.ts`

Expected: FAIL because `pairing-challenge.ts` does not exist.

- [ ] **Step 3: Implement the minimal primitive**

Use this contract:

```ts
export const PAIRING_CHALLENGE_TTL_MS = 10_000;

export interface PairingChallenge {
  challengeId: string;
  nonce: string;
  path: string;
  expiresAt: number;
}

export function issuePairingChallenge(...): PairingChallenge;
export function consumePairingChallenge(...): boolean;
```

Store the raw nonce only in memory for the ten-second lifetime. Delete the map entry before validation and unlink the server-named file in `finally`, making mismatch and replay terminal.

- [ ] **Step 4: Run GREEN**

Run the Task 1 Vitest command and expect all challenge primitive tests to pass.

### Task 2: Route security and lifecycle

**Files:**
- Modify: `packages/jinn/src/gateway/auth.ts`
- Modify: `packages/jinn/src/gateway/api.ts`
- Modify: `packages/jinn/src/gateway/__tests__/auth-security.test.ts`
- Modify: `packages/jinn/src/gateway/__tests__/auth-ux-api.test.ts`

**Interfaces:**
- Consumes: `issuePairingChallenge` and `consumePairingChallenge` from Task 1.
- Produces: `POST /api/auth/pairing-challenges` and challenge-ID redemption on `POST /api/auth/pairing-codes`.

- [ ] **Step 1: Write failing route tests**

Add tests for loopback challenge issuance plus valid redemption, direct bearer `403`, non-loopback socket/Host `403`, and expired/reused/mismatched challenge `403`. Keep the existing authenticated-browser cookie path green.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter jinn-cli exec vitest run src/gateway/__tests__/auth-security.test.ts src/gateway/__tests__/auth-ux-api.test.ts`

Expected: FAIL because the challenge route and route-local challenge redemption do not exist.

- [ ] **Step 3: Exempt only the route-local proof flow from generic bearer middleware**

Make POST challenge issuance and pairing-code redemption return `false` from `authRequiredForRequest`. Add both to the API's unauthenticated-mutation allowlist, remove pairing-code minting from the generic operator-only table, then enforce all authority inside the two auth routes.

- [ ] **Step 4: Implement route-local checks**

For challenge issuance: reject scoped identity grants, require loopback socket plus Host, issue and return `{ challengeId, nonce, path, expiresAt, ttlSeconds }`.

For pairing-code redemption: parse the body, reject bearer first, reject scoped identity grants, require loopback socket plus Host, consume `challengeId` when present, otherwise retain the authenticated-browser cookie path. Return `403` for invalid challenge proof.

- [ ] **Step 5: Run GREEN**

Run the Task 2 Vitest command and expect all auth security/UX tests to pass.

### Task 3: Restore CLI code minting and lock the cross-layer contract

**Files:**
- Modify: `packages/jinn/src/cli/pair.ts`
- Modify: `packages/jinn/src/cli/__tests__/pair.test.ts`
- Modify: `packages/jinn/src/gateway/__tests__/auth-ux-api.test.ts`
- Modify: `packages/jinn/bin/jinn.ts`

**Interfaces:**
- Consumes: the two routes from Task 2 and the server-returned proof-file path.
- Produces: `requestPairingCode({ port, jinnHome?, fetchImpl? })` returning `{ code, expiresAt, ttlSeconds? }`.

- [ ] **Step 1: Write failing CLI and cross-layer tests**

Test the two POST requests, absence of any Authorization header, exact `0600` file write, cleanup on failure, response-path confinement to the selected `JINN_HOME`, and an adapter that runs the real CLI helper against `handleApiRequest` with a shared temporary home.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter jinn-cli exec vitest run src/cli/__tests__/pair.test.ts src/gateway/__tests__/auth-ux-api.test.ts`

Expected: FAIL because the CLI still prints browser instructions and never executes the challenge exchange.

- [ ] **Step 3: Implement the CLI exchange**

POST to `http://127.0.0.1:<port>/api/auth/pairing-challenges`, validate the returned path equals `JINN_HOME/pair-challenge-<challengeId>`, write the exact nonce with `flag: "wx"` and mode `0o600`, POST `{ challengeId }` to `/api/auth/pairing-codes`, and remove only a file the CLI itself created in `finally`.

- [ ] **Step 4: Restore user-facing code output**

Restore `formatPairingInstructions(pairing, port)`, JSON code output, and the CLI help text that says `jinn pair` creates a one-time code.

- [ ] **Step 5: Run GREEN**

Run the Task 3 Vitest command and expect the unit and real cross-layer contract tests to pass.

### Task 4: Verification and review handoff

**Files:**
- Verify all ticket files; do not stage unrelated dirty worktree changes.

**Interfaces:**
- Produces: a focused commit and review-ready Todo evidence.

- [ ] **Step 1: Run full verification**

Run: `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`.

Expected: all commands exit 0.

- [ ] **Step 2: Verify live behavior**

Restart only through `jinn restart` if deployment is required, then verify the built CLI prints a usable code, direct bearer remains `403`, and no challenge file remains.

- [ ] **Step 3: Stage isolated hunks and privacy-check**

Stage only the new plan/module/tests and ticket-specific hunks in shared dirty files. Run `git diff --cached --check` and the required staged leak grep.

- [ ] **Step 4: Commit and return to review**

```bash
git commit -m "fix(auth): prove local filesystem control for pairing"
```

Move `wi_225e70adc989` to `in_review` with test evidence, the explicit same-user residual, and the linked follow-up `wi_cd73aaa4399e`.
