# Upgrade Lab Port Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent every disposable v0.25 upgrade-lab run and self-restart from targeting a live or foreign gateway process.

**Architecture:** Persist the nonce-derived high loopback port into the disposable instance configuration immediately after v0.25 setup. Separate start and restart preflights: starts require an unoccupied configured port, while restarts require the configured port to be owned by the expected disposable PID whose `JINN_HOME` resolves to the lab home. All signaling remains behind the ownership assertion.

**Tech Stack:** Node.js ES modules, Node native test runner, loopback TCP inspection, YAML-preserving text update.

## Global Constraints

- Never target protected ports `7777` or `7801`.
- Never start, stop, restart, or signal a live instance.
- Do not run the upgrade lab until isolated guard tests pass.
- Preserve unrelated shared-worktree changes and do not commit.
- Keep repository content generic and free of personal paths or instance data.

---

### Task 1: Restart Ownership Regression

**Files:**
- Modify: `scripts/upgrade-lab/__tests__/guards.test.mjs`
- Modify: `scripts/upgrade-lab/run.mjs`

**Interfaces:**
- Consumes: `assertLabProcessTarget({ pid, port, labHome }, dependencies)` and the disposable config port.
- Produces: `assertLabRestartPreflight({ pid, port, labHome }, dependencies)` and `runVerifiedLabRestart({ pid, port, labHome, restart }, dependencies)`.

- [ ] **Step 1: Write the failing foreign-owner regression**

Add a test that supplies a listener PID whose reported `JINN_HOME` is outside the lab, invokes the restart handoff, and asserts both that it throws and that neither the restart callback nor signal callback runs.

- [ ] **Step 2: Run the focused test to verify RED**

Run: `node --test --test-name-pattern='self-restart' scripts/upgrade-lab/__tests__/guards.test.mjs`

Expected: FAIL because the verified restart interface is not exported.

- [ ] **Step 3: Implement the minimal restart preflight and handoff**

Read the configured port, require it to equal the restart port, reuse `assertLabProcessTarget` for PID/listener/home ownership, then invoke the injected restart callback only after the assertions pass.

- [ ] **Step 4: Run the focused test to verify GREEN**

Run: `node --test --test-name-pattern='self-restart' scripts/upgrade-lab/__tests__/guards.test.mjs`

Expected: PASS with no process signal or gateway spawn.

### Task 2: Start and Configuration Guards

**Files:**
- Modify: `scripts/upgrade-lab/__tests__/guards.test.mjs`
- Modify: `scripts/upgrade-lab/run.mjs`

**Interfaces:**
- Consumes: deterministic nonce-derived port and v0.25-created `config.yaml`.
- Produces: persisted `gateway.port` and an unoccupied-port start preflight.

- [ ] **Step 1: Add or retain regressions for protected ports, deterministic derivation, config persistence, config/launch mismatch, and occupied foreign ports**

Use dependency injection for ownership probes so the tests cannot contact or signal a real gateway.

- [ ] **Step 2: Run the guard suite**

Run: `node --test scripts/upgrade-lab/__tests__/guards.test.mjs`

Expected: all guard tests PASS; no gateway process is started.

- [ ] **Step 3: Verify call ordering statically**

Confirm `persistLabGatewayPort(...)` follows v0.25 `setup` and precedes every `startGateway(...)`, and that every harness signal passes through `signalVerifiedLabProcess(...)`.

### Task 3: Safe Upgrade Matrix Resume

**Files:**
- Inspect: `scripts/upgrade-lab/run.mjs`
- Inspect: generated `artifacts/summary.json`

**Interfaces:**
- Consumes: one exact candidate tarball and one exact v0.25 baseline tarball.
- Produces: scenario summaries with one candidate SHA-256 and retained evidence paths.

- [ ] **Step 1: Run non-spawning dry-run validation**

Run: `node scripts/upgrade-lab/run.mjs --scenario stock --dry-run`

Expected: isolation and deterministic safe-port checks PASS; contacted protected ports remain absent.

- [ ] **Step 2: Run the stock scenario only after Tasks 1 and 2 pass**

Use the exact candidate tarball selected for the release and retain artifacts for inspection.

- [ ] **Step 3: Inspect stock evidence before expanding the matrix**

Verify configured-port persistence, protected-port avoidance, unchanged live sentinels, candidate SHA-256, prompt, manifest, logs, and screenshots.

- [ ] **Step 4: Run the remaining scenarios with the same candidate tarball**

Run `customized`, `heavily-customized`, `interrupted`, and `no-instance-change`, stopping immediately on any gateway or ownership anomaly.

