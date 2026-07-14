# Jinn Pair Browser Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `jinn pair` give accurate browser-based pairing instructions without attempting the bearer-authenticated request that the gateway intentionally rejects.

**Architecture:** Keep pairing-code minting owned by an authenticated, loopback browser cookie. The CLI becomes a pure guidance surface for Settings > Pairing, while `jinn unpair` continues using bearer auth against the device routes that accept it.

**Tech Stack:** TypeScript, Commander.js, Vitest, Jinn gateway REST handlers

## Global Constraints

- Direct bearer requests to `POST /api/auth/pairing-codes` must remain forbidden.
- The CLI must not send the gateway bearer token to the pairing-code mint route.
- `GET` and `DELETE /api/auth/devices` remain bearer-authenticated for `jinn unpair`.
- Public repository content must stay generic and contain no operator-specific data.

---

### Task 1: Lock the CLI-to-route authentication contract

**Files:**
- Modify: `packages/jinn/src/cli/__tests__/pair.test.ts`
- Modify: `packages/jinn/src/gateway/__tests__/auth-ux-api.test.ts`

**Interfaces:**
- Consumes: `pairingSetupResponse(port: number)` and `formatPairingSetupInstructions(setup)` from the CLI module.
- Produces: A regression contract proving bearer minting is rejected while the CLI directs users to the browser-only path.

- [ ] **Step 1: Write the failing tests**

Add CLI expectations for this response shape:

```ts
expect(pairingSetupResponse(7777)).toEqual({
  action: "create_pairing_code_in_browser",
  url: "http://127.0.0.1:7777/settings",
  section: "Pairing",
});
```

Extend the gateway bearer-rejection test to assert the same helper selects `create_pairing_code_in_browser`, coupling the CLI behavior to the route's intentional 403 contract.

- [ ] **Step 2: Run tests to verify RED**

Run: `pnpm --filter jinn-cli test -- --run packages/jinn/src/cli/__tests__/pair.test.ts packages/jinn/src/gateway/__tests__/auth-ux-api.test.ts`

Expected: FAIL because `pairingSetupResponse` and `formatPairingSetupInstructions` do not exist yet.

- [ ] **Step 3: Commit the red contract when the implementation is green**

Stage only this ticket's test hunks together with the implementation in Task 2; do not stage unrelated dirty worktree changes.

### Task 2: Retire bearer pairing-code creation in the CLI

**Files:**
- Modify: `packages/jinn/src/cli/pair.ts`
- Modify: `packages/jinn/bin/jinn.ts`

**Interfaces:**
- Consumes: gateway port from the existing gateway-info/config lookup.
- Produces: `PairingSetupResponse`, `pairingSetupResponse(port)`, and `formatPairingSetupInstructions(setup)`.

- [ ] **Step 1: Implement the minimal browser-guidance path**

Replace `requestPairingCode()` with:

```ts
export interface PairingSetupResponse {
  action: "create_pairing_code_in_browser";
  url: string;
  section: "Pairing";
}

export function pairingSetupResponse(port: number): PairingSetupResponse {
  return {
    action: "create_pairing_code_in_browser",
    url: `http://127.0.0.1:${port}/settings`,
    section: "Pairing",
  };
}
```

Make `runPair()` print that object for `--json`, otherwise print steps to open the URL, select **Create pairing code**, and enter the result on the other browser. Do not require or read the gateway token for this path.

- [ ] **Step 2: Keep unpair behavior explicit**

Retain the bearer headers in `requestPairedDevices()` and `requestUnpairDevice()`. Update empty-list copy so it no longer claims `jinn pair` directly creates a code.

- [ ] **Step 3: Update command help**

Change the `pair` description from creating a code to showing how to create one in the local dashboard, and describe `--json` as structured instructions.

- [ ] **Step 4: Run targeted tests to verify GREEN**

Run the same targeted Vitest command from Task 1.

Expected: PASS, including direct bearer rejection and browser-guidance assertions.

### Task 3: Verify and hand off

**Files:**
- Verify only; no additional files expected.

**Interfaces:**
- Consumes: the completed CLI and auth-contract changes.
- Produces: build/test/lint evidence and a review-ready work item.

- [ ] **Step 1: Run focused and full checks**

Run: `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build` from the repository root.

Expected: all commands exit 0.

- [ ] **Step 2: Review scope and privacy**

Inspect `git diff` and stage only the plan, CLI, CLI tests, command registration, and the isolated auth-contract test hunk. Run the required staged leak grep.

- [ ] **Step 3: Commit**

```bash
git commit -m "fix(cli): align pair with browser auth contract"
```

- [ ] **Step 4: Move the work item to review**

Update `wi_225e70adc989` to `in_review` with the exact verification evidence; do not self-close it.
