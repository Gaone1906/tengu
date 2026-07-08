import { describe, it, expect, vi, beforeEach } from "vitest";
import { runCronJob } from "../runner.js";
import type { CronJob, Connector, JinnConfig } from "../../shared/types.js";
import { findEmployee } from "../../gateway/org.js";

// Stub the run-log helpers so we don't touch the filesystem. `hasRunLogEntry`
// defaults to false (fire not yet run) so existing tests exercise the normal path;
// idempotency tests override it per-case.
vi.mock("../jobs.js", () => ({
  appendRunLog: vi.fn(),
  hasRunLogEntry: vi.fn(() => false),
}));

// Stub org scanning
vi.mock("../../gateway/org.js", () => ({
  scanOrg: vi.fn(() => []),
  findEmployee: vi.fn(),
}));

// Stub the work-item store so these tests never touch a real registry.db (this
// file sets no JINN_HOME). Real store/link coverage lives in
// work-items/__tests__/store.test.ts against a temp JINN_HOME.
vi.mock("../../work-items/store.js", () => ({
  createWorkItem: vi.fn(() => ({ id: "wi_test" })),
  linkSession: vi.fn(),
}));

// Stub the reconciler (GRS-003b-2b links then reconciles the pre-minted item). Real
// derivation coverage lives in work-items/__tests__/reconcile.test.ts.
vi.mock("../../work-items/reconcile.js", () => ({
  reconcileWorkItem: vi.fn(),
}));

// Stub the session lookup used by the guard-time bridge repair (GRS-003b-2b). This
// file sets no JINN_HOME, so a real registry read would hit the live DB. Default:
// no session found → repair is a no-op; the self-heal test overrides per-case.
vi.mock("../../sessions/registry.js", () => ({
  getSessionBySessionKey: vi.fn(() => undefined),
}));

// Stub logger
vi.mock("../../shared/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "test-job",
    name: "Test Job",
    enabled: true,
    schedule: "0 * * * *",
    prompt: "do something",
    ...overrides,
  };
}

function makeConfig(overrides: Partial<JinnConfig["cron"]> = {}): JinnConfig {
  return {
    engines: { default: "claude", claude: { model: "opus" } },
    logging: { file: false, stdout: false, level: "info" },
    cron: {
      alertConnector: "slack",
      alertChannel: "#cron-alerts",
      ...overrides,
    },
  } as JinnConfig;
}

function makeMockConnector(): Connector {
  return {
    name: "slack",
    sendMessage: vi.fn().mockResolvedValue(undefined),
    replyMessage: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as Connector;
}

function makeMockSessionManager(delayMs = 0) {
  return {
    route: vi.fn().mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ sessionId: "sess-123" }), delayMs),
        ),
    ),
  } as any;
}

describe("runCronJob — latency alerting", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a Slack alert when job duration exceeds alertThresholdMs", async () => {
    const connector = makeMockConnector();
    const connectors = new Map<string, Connector>([["slack", connector]]);
    // Session takes 200ms, threshold is 100ms → should alert
    const sessionManager = makeMockSessionManager(200);
    const config = makeConfig({ alertThresholdMs: 100 });

    await runCronJob(makeJob(), sessionManager, config, connectors);

    expect(connector.sendMessage).toHaveBeenCalledWith(
      { channel: "#cron-alerts" },
      expect.stringContaining("Test Job"),
    );
    // Alert message should mention the duration
    const alertCall = (connector.sendMessage as any).mock.calls[0];
    expect(alertCall[1]).toMatch(/slow|latency|exceeded/i);
  });

  it("does NOT alert when job completes within alertThresholdMs", async () => {
    const connector = makeMockConnector();
    const connectors = new Map<string, Connector>([["slack", connector]]);
    // Session takes ~0ms, threshold is 5000ms → no alert
    const sessionManager = makeMockSessionManager(0);
    const config = makeConfig({ alertThresholdMs: 5000 });

    await runCronJob(makeJob(), sessionManager, config, connectors);

    expect(connector.sendMessage).not.toHaveBeenCalled();
  });

  it("does NOT alert when alertThresholdMs is not configured", async () => {
    const connector = makeMockConnector();
    const connectors = new Map<string, Connector>([["slack", connector]]);
    const sessionManager = makeMockSessionManager(0);
    const config = makeConfig(); // no alertThresholdMs

    await runCronJob(makeJob(), sessionManager, config, connectors);

    expect(connector.sendMessage).not.toHaveBeenCalled();
  });

  it("still logs success even when latency alert fires", async () => {
    const { appendRunLog } = await import("../jobs.js");
    const connector = makeMockConnector();
    const connectors = new Map<string, Connector>([["slack", connector]]);
    const sessionManager = makeMockSessionManager(200);
    const config = makeConfig({ alertThresholdMs: 100 });

    await runCronJob(makeJob(), sessionManager, config, connectors);

    expect(appendRunLog).toHaveBeenCalledWith(
      "test-job",
      expect.objectContaining({ status: "success" }),
    );
  });

  it("does not double-alert on failure (only failure alert, not latency)", async () => {
    const connector = makeMockConnector();
    const connectors = new Map<string, Connector>([["slack", connector]]);
    const sessionManager = {
      route: vi.fn().mockRejectedValue(new Error("API exploded")),
    } as any;
    const config = makeConfig({ alertThresholdMs: 1 });

    await runCronJob(makeJob(), sessionManager, config, connectors);

    // Should only get the failure alert, not a latency alert
    expect(connector.sendMessage).toHaveBeenCalledTimes(1);
    const alertMsg = (connector.sendMessage as any).mock.calls[0][1];
    expect(alertMsg).toContain("failed");
  });
});

describe("runCronJob — work-item dogfood (GRS-002)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("mints a cron-sourced work item, links the spawned session, and reconciles it", async () => {
    const { createWorkItem, linkSession } = await import("../../work-items/store.js");
    const { reconcileWorkItem } = await import("../../work-items/reconcile.js");
    const connector = makeMockConnector();
    const connectors = new Map<string, Connector>([["slack", connector]]);
    const sessionManager = makeMockSessionManager(0); // resolves { sessionId: "sess-123" }

    await runCronJob(makeJob({ id: "wi-job", name: "WI Job", prompt: "do work" }), sessionManager, makeConfig(), connectors);

    expect(createWorkItem).toHaveBeenCalledTimes(1);
    const arg = (createWorkItem as any).mock.calls[0][0];
    // GRS-003b-2b: minted `open` (durable intent, zero sessions yet) — NOT hardcoded
    // `active`. The live status is derived by the reconciler after link.
    expect(arg).toMatchObject({ title: "WI Job", source: "cron", status: "backlog", body: "do work" });
    // GRS-003b-1: the source_ref is a deterministic per-fire id (ISO), not Date.now().
    expect(arg.sourceRef).toMatch(/^cron:wi-job:\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/);
    expect(linkSession).toHaveBeenCalledWith("wi_test", "sess-123");
    expect(reconcileWorkItem).toHaveBeenCalledWith("wi_test");
  });

  it("uses a deterministic per-fire source_ref: same fireIso ⇒ identical id (GRS-003b-1)", async () => {
    const { createWorkItem } = await import("../../work-items/store.js");
    const connectors = new Map<string, Connector>([["slack", makeMockConnector()]]);
    const sessionManager = makeMockSessionManager(0);
    const fireIso = "2026-07-01T06:00:00.000Z";
    const job = makeJob({ id: "wi-job", name: "WI Job", prompt: "do work" });

    // Re-invoke the SAME logical fire twice (e.g. a retry). The caller-owned fireIso
    // must yield the exact same source_ref both times so the store dedupes it.
    await runCronJob(job, sessionManager, makeConfig(), connectors, { fireIso });
    await runCronJob(job, sessionManager, makeConfig(), connectors, { fireIso });

    const refs = (createWorkItem as any).mock.calls.map((c: any[]) => c[0].sourceRef);
    expect(refs).toEqual([
      "cron:wi-job:2026-07-01T06:00:00.000Z",
      "cron:wi-job:2026-07-01T06:00:00.000Z",
    ]);
  });

  it("does not collide across jobs: same fireIso + different jobId ⇒ distinct source_ref", async () => {
    const { createWorkItem } = await import("../../work-items/store.js");
    const connectors = new Map<string, Connector>([["slack", makeMockConnector()]]);
    const sessionManager = makeMockSessionManager(0);
    const fireIso = "2026-07-01T06:00:00.000Z";

    await runCronJob(makeJob({ id: "job-a", name: "A" }), sessionManager, makeConfig(), connectors, { fireIso });
    await runCronJob(makeJob({ id: "job-b", name: "B" }), sessionManager, makeConfig(), connectors, { fireIso });

    const refs = (createWorkItem as any).mock.calls.map((c: any[]) => c[0].sourceRef);
    expect(refs).toEqual([
      "cron:job-a:2026-07-01T06:00:00.000Z",
      "cron:job-b:2026-07-01T06:00:00.000Z",
    ]);
    // The jobId is part of the key, so two different jobs firing at the same instant
    // never dedupe onto one work item.
    expect(refs[0]).not.toBe(refs[1]);
  });

  it("honors an explicit fireIso verbatim in the source_ref", async () => {
    const { createWorkItem } = await import("../../work-items/store.js");
    const connectors = new Map<string, Connector>([["slack", makeMockConnector()]]);
    const sessionManager = makeMockSessionManager(0);

    await runCronJob(
      makeJob({ id: "abc", name: "Abc" }),
      sessionManager,
      makeConfig(),
      connectors,
      { fireIso: "2026-12-31T23:59:59.999Z" },
    );

    expect((createWorkItem as any).mock.calls[0][0].sourceRef).toBe("cron:abc:2026-12-31T23:59:59.999Z");
  });

  it("does not break the cron job when work-item minting throws", async () => {
    const { createWorkItem, linkSession } = await import("../../work-items/store.js");
    const { reconcileWorkItem } = await import("../../work-items/reconcile.js");
    (createWorkItem as any).mockImplementationOnce(() => {
      throw new Error("db boom");
    });
    const { appendRunLog } = await import("../jobs.js");
    const connector = makeMockConnector();
    const connectors = new Map<string, Connector>([["slack", connector]]);
    const sessionManager = makeMockSessionManager(0);

    await runCronJob(makeJob(), sessionManager, makeConfig(), connectors);

    // Mint failure is best-effort: the actual cron job (route) still runs and records
    // success; with no work item, link + reconcile are simply skipped.
    expect(sessionManager.route).toHaveBeenCalledTimes(1);
    expect(appendRunLog).toHaveBeenCalledWith("test-job", expect.objectContaining({ status: "success" }));
    expect(linkSession).not.toHaveBeenCalled();
    expect(reconcileWorkItem).not.toHaveBeenCalled();
  });
});

describe("runCronJob — atomic cron-bridge ordering (GRS-003b-2b)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("mints the work item BEFORE spawning the session (durable intent precedes the irreversible step)", async () => {
    const { createWorkItem } = await import("../../work-items/store.js");
    const connectors = new Map<string, Connector>([["slack", makeMockConnector()]]);
    const sessionManager = makeMockSessionManager(0);

    await runCronJob(makeJob({ id: "wi-job", name: "WI Job" }), sessionManager, makeConfig(), connectors);

    // Ordering is the whole point: intent must be durable before the non-rollbackable spawn.
    const mintOrder = (createWorkItem as any).mock.invocationCallOrder[0];
    const routeOrder = (sessionManager.route as any).mock.invocationCallOrder[0];
    expect(mintOrder).toBeLessThan(routeOrder);
  });

  it("keeps the minted work item when the session spawn fails (no lost intent, no orphan link)", async () => {
    const { createWorkItem, linkSession } = await import("../../work-items/store.js");
    const { reconcileWorkItem } = await import("../../work-items/reconcile.js");
    const { appendRunLog } = await import("../jobs.js");
    const connector = makeMockConnector();
    const connectors = new Map<string, Connector>([["slack", connector]]);
    const sessionManager = {
      route: vi.fn().mockRejectedValue(new Error("spawn exploded")),
    } as any;

    await runCronJob(makeJob({ id: "wi-job", name: "WI Job" }), sessionManager, makeConfig(), connectors);

    // Intent survives the irreversible-step failure: the item was already minted (as `open`),
    // so it is NOT lost. But nothing gets linked/reconciled onto a session that never spawned,
    // and the failure is recorded as an error run-log.
    expect(createWorkItem).toHaveBeenCalledTimes(1);
    expect((createWorkItem as any).mock.calls[0][0]).toMatchObject({ status: "backlog" });
    expect(linkSession).not.toHaveBeenCalled();
    expect(reconcileWorkItem).not.toHaveBeenCalled();
    expect(appendRunLog).toHaveBeenCalledWith("wi-job", expect.objectContaining({ status: "error" }));
  });

  it("links THEN reconciles after a successful spawn (derives live status, never hardcodes it)", async () => {
    const { linkSession } = await import("../../work-items/store.js");
    const { reconcileWorkItem } = await import("../../work-items/reconcile.js");
    const connectors = new Map<string, Connector>([["slack", makeMockConnector()]]);
    const sessionManager = makeMockSessionManager(0);

    await runCronJob(makeJob({ id: "wi-job", name: "WI Job" }), sessionManager, makeConfig(), connectors);

    expect(linkSession).toHaveBeenCalledWith("wi_test", "sess-123");
    expect(reconcileWorkItem).toHaveBeenCalledWith("wi_test");
    // Reconcile must run AFTER link (it reads the freshly-linked session's state).
    const linkOrder = (linkSession as any).mock.invocationCallOrder[0];
    const reconcileOrder = (reconcileWorkItem as any).mock.invocationCallOrder[0];
    expect(linkOrder).toBeLessThan(reconcileOrder);
  });

  it("treats a link/reconcile failure as best-effort (cron job still succeeds)", async () => {
    const { linkSession } = await import("../../work-items/store.js");
    const { reconcileWorkItem } = await import("../../work-items/reconcile.js");
    const { appendRunLog } = await import("../jobs.js");
    (linkSession as any).mockImplementationOnce(() => {
      throw new Error("link boom");
    });
    const connectors = new Map<string, Connector>([["slack", makeMockConnector()]]);
    const sessionManager = makeMockSessionManager(0);

    await runCronJob(makeJob({ id: "wi-job", name: "WI Job" }), sessionManager, makeConfig(), connectors);

    // Link threw → reconcile is skipped (same guarded block), but the job still records success.
    expect(reconcileWorkItem).not.toHaveBeenCalled();
    expect(appendRunLog).toHaveBeenCalledWith("wi-job", expect.objectContaining({ status: "success" }));
  });
});


describe("runCronJob — execution idempotency (GRS-003b-2a)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips the run when this fireIso already recorded an outcome (no re-run, no duplicate log)", async () => {
    const { hasRunLogEntry, appendRunLog } = await import("../jobs.js");
    const { createWorkItem } = await import("../../work-items/store.js");
    (hasRunLogEntry as any).mockReturnValue(true); // this exact fire already ran

    const connectors = new Map<string, Connector>([["slack", makeMockConnector()]]);
    const sessionManager = makeMockSessionManager(0);
    const fireIso = "2026-07-01T06:00:00.000Z";

    await runCronJob(
      makeJob({ id: "wi-job", name: "WI Job", prompt: "do work" }),
      sessionManager,
      makeConfig(),
      connectors,
      { fireIso },
    );

    // Guard checked the durable ledger with this fire's deterministic sessionKey.
    expect(hasRunLogEntry).toHaveBeenCalledWith("wi-job", "cron:wi-job:2026-07-01T06:00:00.000Z");
    // Short-circuited BEFORE route/append: prompt not re-run, no second run-log row.
    expect(sessionManager.route).not.toHaveBeenCalled();
    expect(appendRunLog).not.toHaveBeenCalled();
    // Bridge repair was ATTEMPTED (guard self-heal), but with no prior session found
    // (default mock) there is nothing to repair, so no work item is minted.
    expect(createWorkItem).not.toHaveBeenCalled();
  });

  it("self-heals a half-linked bridge on re-fire: links the existing session WITHOUT re-running the prompt (GRS-003b-2b, Codex Major #1)", async () => {
    const { hasRunLogEntry, appendRunLog } = await import("../jobs.js");
    const { createWorkItem, linkSession } = await import("../../work-items/store.js");
    const { reconcileWorkItem } = await import("../../work-items/reconcile.js");
    const { getSessionBySessionKey } = await import("../../sessions/registry.js");
    (hasRunLogEntry as any).mockReturnValue(true); // prior fire recorded a terminal outcome
    // The prior fire DID spawn a session, but its best-effort link/reconcile failed →
    // item stuck `open`, zero linked sessions, guard would otherwise block repair forever.
    (getSessionBySessionKey as any).mockReturnValue({ id: "sess-orphan", status: "idle" });

    const connectors = new Map<string, Connector>([["slack", makeMockConnector()]]);
    const sessionManager = makeMockSessionManager(0);
    const fireIso = "2026-07-01T06:00:00.000Z";

    await runCronJob(
      makeJob({ id: "wi-job", name: "WI Job", prompt: "do work" }),
      sessionManager,
      makeConfig(),
      connectors,
      { fireIso },
    );

    // Prompt is NOT re-run and NO duplicate run-log is appended...
    expect(sessionManager.route).not.toHaveBeenCalled();
    expect(appendRunLog).not.toHaveBeenCalled();
    // ...but the durable bridge is repaired idempotently: get-or-create the item for this
    // fire, link the found session, reconcile the live status.
    expect(getSessionBySessionKey).toHaveBeenCalledWith("cron:wi-job:2026-07-01T06:00:00.000Z");
    expect(createWorkItem).toHaveBeenCalledWith(expect.objectContaining({ source: "cron", status: "backlog", sourceRef: "cron:wi-job:2026-07-01T06:00:00.000Z" }));
    expect(linkSession).toHaveBeenCalledWith("wi_test", "sess-orphan");
    expect(reconcileWorkItem).toHaveBeenCalledWith("wi_test");
  });

  it("runs normally on the first fire (ledger has no matching entry yet)", async () => {
    const { hasRunLogEntry, appendRunLog } = await import("../jobs.js");
    (hasRunLogEntry as any).mockReturnValue(false); // first time this fire runs

    const connectors = new Map<string, Connector>([["slack", makeMockConnector()]]);
    const sessionManager = makeMockSessionManager(0);
    const fireIso = "2026-07-01T06:00:00.000Z";

    await runCronJob(
      makeJob({ id: "wi-job", name: "WI Job", prompt: "do work" }),
      sessionManager,
      makeConfig(),
      connectors,
      { fireIso },
    );

    expect(sessionManager.route).toHaveBeenCalledTimes(1);
    expect(appendRunLog).toHaveBeenCalledWith("wi-job", expect.objectContaining({ status: "success" }));
  });

  it("never dedupes an ad-hoc call with no fireIso (each is a new fire)", async () => {
    const { hasRunLogEntry } = await import("../jobs.js");
    // Even if the ledger somehow reports a match, the guard is gated on opts.fireIso,
    // so an ad-hoc call (fresh per-call ISO) must still run.
    (hasRunLogEntry as any).mockReturnValue(true);

    const connectors = new Map<string, Connector>([["slack", makeMockConnector()]]);
    const sessionManager = makeMockSessionManager(0);

    await runCronJob(makeJob(), sessionManager, makeConfig(), connectors); // no opts.fireIso

    expect(hasRunLogEntry).not.toHaveBeenCalled();
    expect(sessionManager.route).toHaveBeenCalledTimes(1);
  });
});

describe("runCronJob — engine selection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("passes cron job effortLevel as the session-level override without clobbering the employee default", async () => {
    vi.mocked(findEmployee).mockReturnValue({
      name: "jimbo",
      department: "operations",
      rank: "manager",
      engine: "claude",
      model: "opus",
      persona: "COO",
      effortLevel: "medium",
    } as any);
    const connector = makeMockConnector();
    const connectors = new Map<string, Connector>([["slack", connector]]);
    const sessionManager = makeMockSessionManager(0);

    await runCronJob(
      makeJob({ employee: "jimbo", engine: "claude", model: "opus", effortLevel: "high" }),
      sessionManager,
      makeConfig(),
      connectors,
    );

    const routeOpts = sessionManager.route.mock.calls[0][2];
    // Job effort is the per-fire session override.
    expect(routeOpts.effortLevel).toBe("high");
    // The employee object is passed through UNMODIFIED: an invalid job effort
    // must not clobber the employee default, so resolveEffort() can skip an
    // invalid session effort and fall back to the employee's valid default.
    expect(routeOpts.employee.effortLevel).toBe("medium");
    expect(routeOpts.engine).toBe("claude");
    expect(routeOpts.model).toBe("opus");
  });

  it("leaves session effortLevel undefined when the cron job sets none (legacy behavior)", async () => {
    vi.mocked(findEmployee).mockReturnValue({
      name: "jimbo",
      department: "operations",
      rank: "manager",
      engine: "claude",
      model: "opus",
      persona: "COO",
      effortLevel: "medium",
    } as any);
    const connectors = new Map<string, Connector>([["slack", makeMockConnector()]]);
    const sessionManager = makeMockSessionManager(0);

    await runCronJob(
      makeJob({ employee: "jimbo", engine: "claude", model: "opus" }),
      sessionManager,
      makeConfig(),
      connectors,
    );

    const routeOpts = sessionManager.route.mock.calls[0][2];
    // No job effort → no session-level override; downstream resolveEffort() uses
    // the employee default (still present on the untouched employee object).
    expect(routeOpts.effortLevel).toBeUndefined();
    expect(routeOpts.employee.effortLevel).toBe("medium");
  });

  it("passes cron job effortLevel even when no employee file is found", async () => {
    vi.mocked(findEmployee).mockReturnValue(undefined);
    const connectors = new Map<string, Connector>([["slack", makeMockConnector()]]);
    const sessionManager = makeMockSessionManager(0);

    await runCronJob(
      makeJob({ employee: "jimbo", engine: "claude", model: "opus", effortLevel: "high" }),
      sessionManager,
      makeConfig(),
      connectors,
    );

    const routeOpts = sessionManager.route.mock.calls[0][2];
    expect(routeOpts.effortLevel).toBe("high");
    expect(routeOpts.employee).toBeUndefined();
  });
});

describe("runCronJob — managed workflow jobs (GRS-014d)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // mockReturnValue survives clearAllMocks — restore the file default (no prior fire).
    const { hasRunLogEntry } = await import("../jobs.js");
    (hasRunLogEntry as any).mockReturnValue(false);
  });

  function managedJob(overrides: Partial<CronJob> = {}): CronJob {
    // Sync-shaped: no prompt, no employee/engine — the fire is typed, not an LLM turn.
    return {
      id: "workflow:wf-1",
      name: "WF One",
      enabled: true,
      schedule: "0 * * * *",
      managedBy: "workflow",
      workflowId: "wf-1",
      ...overrides,
    };
  }

  it("fires the workflow handler instead of a prompt session — no route, no work item, no org scan", async () => {
    const { appendRunLog } = await import("../jobs.js");
    const { createWorkItem } = await import("../../work-items/store.js");
    const { scanOrg } = await import("../../gateway/org.js");
    const connectors = new Map<string, Connector>([["slack", makeMockConnector()]]);
    const sessionManager = makeMockSessionManager(0);
    const fire = vi.fn().mockResolvedValue({ ok: true, note: "workflow run run-x started (status: running)", runId: "run-x" });
    const fireIso = "2026-07-04T06:00:00.000Z";

    await runCronJob(managedJob(), sessionManager, makeConfig(), connectors, { fireIso, workflowFire: fire });

    // The typed fire path: handler called with the job + the scheduler-owned fireIso...
    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledWith(expect.objectContaining({ id: "workflow:wf-1" }), fireIso);
    // ...and NO prompt-session machinery ran (no LLM in the trigger path).
    expect(sessionManager.route).not.toHaveBeenCalled();
    expect(createWorkItem).not.toHaveBeenCalled();
    expect(scanOrg).not.toHaveBeenCalled();
    // One honest terminal run-log row for the fire, carrying the run id.
    expect(appendRunLog).toHaveBeenCalledTimes(1);
    expect(appendRunLog).toHaveBeenCalledWith(
      "workflow:wf-1",
      expect.objectContaining({
        status: "success",
        sessionKey: `cron:workflow:wf-1:${fireIso}`,
        sessionId: null,
        workflowRunId: "run-x",
        resultPreview: expect.stringContaining("run-x"),
      }),
    );
  });

  it("is INERT without a wired handler: no session, no crash, an honest error row (evidence-root gating)", async () => {
    const { appendRunLog } = await import("../jobs.js");
    const connectors = new Map<string, Connector>([["slack", makeMockConnector()]]);
    const sessionManager = makeMockSessionManager(0);

    // A production-shaped gateway (no workflow evidence root) never wires workflowFire.
    await runCronJob(managedJob(), sessionManager, makeConfig(), connectors, { fireIso: "2026-07-04T06:00:00.000Z" });

    expect(sessionManager.route).not.toHaveBeenCalled();
    expect(appendRunLog).toHaveBeenCalledWith(
      "workflow:wf-1",
      expect.objectContaining({ status: "error", error: expect.stringContaining("no workflow fire handler") }),
    );
  });

  it("records an error row when the handler reports a non-ok outcome (stale job)", async () => {
    const { appendRunLog } = await import("../jobs.js");
    const connectors = new Map<string, Connector>([["slack", makeMockConnector()]]);
    const sessionManager = makeMockSessionManager(0);
    const fire = vi.fn().mockResolvedValue({ ok: false, note: "workflow definition \"wf-1\" no longer exists" });

    await runCronJob(managedJob(), sessionManager, makeConfig(), connectors, { fireIso: "2026-07-04T06:00:00.000Z", workflowFire: fire });

    expect(appendRunLog).toHaveBeenCalledWith(
      "workflow:wf-1",
      expect.objectContaining({ status: "error", error: expect.stringContaining("no longer exists") }),
    );
  });

  it("records an error row when the handler throws (fire never crashes the scheduler tick)", async () => {
    const { appendRunLog } = await import("../jobs.js");
    const connectors = new Map<string, Connector>([["slack", makeMockConnector()]]);
    const sessionManager = makeMockSessionManager(0);
    const fire = vi.fn().mockRejectedValue(new Error("store exploded"));

    await expect(
      runCronJob(managedJob(), sessionManager, makeConfig(), connectors, { fireIso: "2026-07-04T06:00:00.000Z", workflowFire: fire }),
    ).resolves.toBeUndefined();

    expect(appendRunLog).toHaveBeenCalledWith(
      "workflow:wf-1",
      expect.objectContaining({ status: "error", error: "store exploded" }),
    );
  });

  it("short-circuits a re-invocation whose fireIso already recorded a terminal row — handler not called, no bridge repair", async () => {
    const { hasRunLogEntry, appendRunLog } = await import("../jobs.js");
    const { getSessionBySessionKey } = await import("../../sessions/registry.js");
    (hasRunLogEntry as any).mockReturnValue(true);
    const connectors = new Map<string, Connector>([["slack", makeMockConnector()]]);
    const sessionManager = makeMockSessionManager(0);
    const fire = vi.fn();

    await runCronJob(managedJob(), sessionManager, makeConfig(), connectors, { fireIso: "2026-07-04T06:00:00.000Z", workflowFire: fire });

    expect(fire).not.toHaveBeenCalled();
    expect(appendRunLog).not.toHaveBeenCalled();
    // Managed jobs have no session/work-item bridge — the guard-time repair is skipped.
    expect(getSessionBySessionKey).not.toHaveBeenCalled();
  });

  it("a manual trigger (no fireIso) still fires the handler with a fresh per-call fireIso", async () => {
    const connectors = new Map<string, Connector>([["slack", makeMockConnector()]]);
    const sessionManager = makeMockSessionManager(0);
    const fire = vi.fn().mockResolvedValue({ ok: true, note: "started", runId: "run-y" });

    await runCronJob(managedJob(), sessionManager, makeConfig(), connectors, { workflowFire: fire });

    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire.mock.calls[0][1]).toMatch(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/);
    expect(sessionManager.route).not.toHaveBeenCalled();
  });
});
