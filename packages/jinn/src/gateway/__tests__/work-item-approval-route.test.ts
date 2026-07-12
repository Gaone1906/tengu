import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../mcp/identity.js";

/**
 * GRS-021b — POST /api/work-items/:id/approval, the operator's approval DECISION
 * surface. Route-level + integration suite driving the REAL handleApiRequest +
 * registry + work-item store (temp JINN_HOME + a real workflow evidence root).
 *
 * What it pins (design §1.3, §6 test plan):
 *   1. HUMAN-ONLY: a tool-marked caller (x-jinn-tool-call) is refused 403 — the
 *      GRS-017 fail-closed pattern (deciding is human-only; requesting is not).
 *   2. DECISION VALIDATION: bad body / decision → 400; unknown item → 404; an
 *      item with no pending approval → 409.
 *   3. NATIVE CONSEQUENCE RULES: approve+in_review → done; reject+in_review →
 *      bounce (rounds++, critique) / max-rounds → escalated; a non-in_review
 *      decision is recorded, status untouched.
 *   4. NATIVE WORKFLOW GATES: parked runs use their own approval authority and
 *      remain fully decoupled from Todo approvals.
 */

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-appr-route-"));
process.env.JINN_HOME = tmpHome;
const orgDir = path.join(tmpHome, "org", "platform");
fs.mkdirSync(orgDir, { recursive: true });
fs.writeFileSync(path.join(orgDir, "department.yaml"), "name: platform\n");
fs.writeFileSync(
  path.join(orgDir, "coo.yaml"),
  "name: coo\ndisplayName: COO\ndepartment: platform\nrank: executive\nengine: codex\nmodel: gpt-5.5\npersona: Runs the company.\n",
);
fs.writeFileSync(
  path.join(orgDir, "platform-manager.yaml"),
  "name: platform-manager\ndisplayName: Platform Manager\ndepartment: platform\nrank: manager\nreportsTo: coo\nengine: codex\nmodel: gpt-5.5\npersona: Manages platform work.\n",
);
fs.writeFileSync(
  path.join(orgDir, "platform-worker.yaml"),
  "name: platform-worker\ndisplayName: Platform Worker\ndepartment: platform\nrank: employee\nreportsTo: platform-manager\nengine: codex\nmodel: gpt-5.5\npersona: Executes platform work.\n",
);
fs.writeFileSync(
  path.join(orgDir, "platform-peer.yaml"),
  "name: platform-peer\ndisplayName: Platform Peer\ndepartment: platform\nrank: employee\nreportsTo: platform-manager\nengine: codex\nmodel: gpt-5.5\npersona: Another platform worker.\n",
);
const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-appr-evidence-"));
fs.mkdirSync(path.join(evidenceRoot, "workflows"), { recursive: true });
process.env.JINN_WORKFLOW_EVIDENCE_ROOT = evidenceRoot;

type Api = typeof import("../api.js");
type Store = typeof import("../../work-items/store.js");
type Approvals = typeof import("../../work-items/approvals.js");
type DefStore = typeof import("../../workflows/definition-store.js");
type Def = typeof import("../../workflows/definition.js");
type RunRec = typeof import("../../workflows/run-reconciler.js");
type RunStore = typeof import("../../workflows/run-store.js");
type Registry = typeof import("../../sessions/registry.js");
let api: Api;
let store: Store;
let approvals: Approvals;
let defStore: DefStore;
let defMod: Def;
let runRec: RunRec;
let runStore: RunStore;
let registry: Registry;
let cooSession: import("../../shared/types.js").Session;
let managerSession: import("../../shared/types.js").Session;
let workerSession: import("../../shared/types.js").Session;
let peerSession: import("../../shared/types.js").Session;

const apiCtx = {
  getConfig: () => ({
    gateway: {},
    engines: { default: "codex", codex: { bin: "codex", model: "gpt-5.5" } },
    sessions: {},
    mcp: {},
  }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => {},
  sessionManager: {
    getEngines: () => new Map([["codex", {}]]),
    getEngine: () => undefined,
    getQueue: () => ({ isRunning: () => false, getPendingCount: () => 0, clearQueue: () => undefined }),
  },
} as unknown as import("../api.js").ApiContext;

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    setHeader() {
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
  };
}

async function call(
  method: string,
  urlPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const payload = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
  const req = Object.assign(Readable.from(payload), {
    method,
    url: urlPath,
    headers: { host: "localhost", "content-type": "application/json", authorization: "Bearer test-token", ...headers },
  });
  const cap = makeRes();
  await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, apiCtx);
  return { status: cap.status, body: cap.body };
}

function toolHeaders(session: import("../../shared/types.js").Session): Record<string, string> {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: session.id,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(session.id),
  };
}

function unmarkedCallerHeaders(session: import("../../shared/types.js").Session, capability?: string): Record<string, string> {
  return {
    [CALLER_SESSION_HEADER]: session.id,
    ...(capability !== undefined ? { [CALLER_SESSION_CAPABILITY_HEADER]: capability } : {}),
  };
}

const cooHeaders = () => toolHeaders(cooSession);
const managerHeaders = () => toolHeaders(managerSession);
const workerHeaders = () => toolHeaders(workerSession);
const peerHeaders = () => toolHeaders(peerSession);
const toolNoCapabilityHeaders = () => ({ [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE });

async function decide(
  itemId: string,
  body: { decision?: unknown; note?: unknown },
  headers: Record<string, string> = managerHeaders(),
): Promise<{ status: number; body: any }> {
  return call("POST", `/api/work-items/${itemId}/approval`, body, headers);
}

/** A native item sitting at `status` with a pending approval attached. */
function pendingItem(
  status: import("../../work-items/store.js").WorkItemStatus,
  over: Record<string, unknown> = {},
  approvalTarget = "platform-manager",
) {
  const item = store.createWorkItem({
    title: "native",
    status,
    source: "human",
    assignee: "platform-worker",
    department: "platform",
    ...over,
  });
  approvals.requestApproval(item.id, { request: "please decide", target: approvalTarget });
  return item;
}

beforeAll(async () => {
  api = await import("../api.js");
  store = await import("../../work-items/store.js");
  approvals = await import("../../work-items/approvals.js");
  defStore = await import("../../workflows/definition-store.js");
  defMod = await import("../../workflows/definition.js");
  runRec = await import("../../workflows/run-reconciler.js");
  runStore = await import("../../workflows/run-store.js");
  registry = await import("../../sessions/registry.js");
  registry.initDb();
  cooSession = registry.createSession({ engine: "codex", source: "web", sourceRef: "coo", title: "coo", employee: "coo" });
  managerSession = registry.createSession({ engine: "codex", source: "web", sourceRef: "manager", title: "manager", employee: "platform-manager" });
  workerSession = registry.createSession({ engine: "codex", source: "web", sourceRef: "worker", title: "worker", employee: "platform-worker" });
  peerSession = registry.createSession({ engine: "codex", source: "web", sourceRef: "peer", title: "peer", employee: "platform-peer" });
});

describe("POST /api/work-items/:id/approval — COO-default authority + validation", () => {
  it("rejects the worker and unrelated peers, but allows the worker's manager and the COO", async () => {
    const item = pendingItem("in_review");
    expect((await decide(item.id, { decision: "approve" }, workerHeaders())).status).toBe(403);
    expect((await decide(item.id, { decision: "approve" }, peerHeaders())).status).toBe(403);
    expect(store.getWorkItem(item.id)!.approvalState).toBe("pending");

    const manager = await decide(item.id, { decision: "approve", note: "ship" }, managerHeaders());
    expect(manager.status).toBe(200);
    expect(manager.body.workItem).toMatchObject({
      approvalState: "approved",
      approvalDecidedBy: "platform-manager",
      status: "done",
    });

    const cooItem = pendingItem("in_review");
    const coo = await decide(cooItem.id, { decision: "approve" }, cooHeaders());
    expect(coo.status).toBe(200);
    expect(coo.body.workItem.approvalDecidedBy).toBe("coo");
  });

  it("rejects unmarked caller-session spoofing without a valid capability on approval decisions", async () => {
    const noCap = pendingItem("in_review");
    const noCapResp = await decide(noCap.id, { decision: "approve" }, unmarkedCallerHeaders(managerSession));
    expect(noCapResp.status).toBe(403);
    expect(store.getWorkItem(noCap.id)!.approvalState).toBe("pending");

    const badCap = pendingItem("in_review");
    const badCapResp = await decide(badCap.id, { decision: "approve" }, unmarkedCallerHeaders(managerSession, "bogus"));
    expect(badCapResp.status).toBe(403);
    expect(store.getWorkItem(badCap.id)!.approvalState).toBe("pending");

    const validCap = pendingItem("in_review");
    const validCapResp = await decide(validCap.id, { decision: "approve" }, unmarkedCallerHeaders(managerSession, ensureSessionCapability(managerSession.id)));
    expect(validCapResp.status).toBe(200);
    expect(validCapResp.body.workItem.approvalDecidedBy).toBe("platform-manager");
  });

  it("allows the operator console to decide and escalate root/COO-targeted approvals", async () => {
    const decideItem = pendingItem("backlog", { assignee: null, department: null }, "coo");

    const decided = await call("POST", `/api/work-items/${decideItem.id}/approval`, { decision: "approve", note: "operator accepted" });
    expect(decided.status).toBe(200);
    expect(decided.body.workItem).toMatchObject({ approvalState: "approved", approvalDecidedBy: "operator" });

    const escalateItem = pendingItem("backlog", { assignee: null, department: null }, "coo");
    const escalated = await call("POST", `/api/work-items/${escalateItem.id}/approval/escalate`, { reason: "operator console" });
    expect(escalated.status).toBe(200);
    expect(escalated.body.workItem.approvalEscalatedAt).toBeTruthy();
    expect(escalated.body.workItem.approvalTarget).toBe("coo");
  });

  it("allows the operator/aCEO path for non-root approvals only after explicit escalation by approval authority", async () => {
    const item = pendingItem("backlog");

    const early = await call("POST", `/api/work-items/${item.id}/approval`, { decision: "approve" });
    expect(early.status).toBe(403);
    expect(early.body.error).toMatch(/explicit.*escalat/i);
    expect(store.getWorkItem(item.id)!.approvalState).toBe("pending");

    const escalated = await call("POST", `/api/work-items/${item.id}/approval/escalate`, { reason: "operator review requested" }, cooHeaders());
    expect(escalated.status).toBe(200);
    expect(escalated.body.workItem.approvalEscalatedAt).toBeTruthy();

    const operator = await call("POST", `/api/work-items/${item.id}/approval`, { decision: "approve", note: "operator accepted" });
    expect(operator.status).toBe(200);
    expect(operator.body.workItem).toMatchObject({ approvalState: "approved", approvalDecidedBy: "operator" });
  });

  it("rejects unmarked caller-session spoofing without a valid capability on escalation", async () => {
    const noCap = pendingItem("backlog");
    const noCapResp = await call("POST", `/api/work-items/${noCap.id}/approval/escalate`, { reason: "spoof" }, unmarkedCallerHeaders(cooSession));
    expect(noCapResp.status).toBe(403);
    expect(store.getWorkItem(noCap.id)!.approvalEscalatedAt).toBeNull();

    const badCap = pendingItem("backlog");
    const badCapResp = await call("POST", `/api/work-items/${badCap.id}/approval/escalate`, { reason: "spoof" }, unmarkedCallerHeaders(cooSession, "bogus"));
    expect(badCapResp.status).toBe(403);
    expect(store.getWorkItem(badCap.id)!.approvalEscalatedAt).toBeNull();
  });

  it("rejects a tool-marked approval caller that has no bound session capability", async () => {
    const item = pendingItem("in_review");
    const resp = await decide(item.id, { decision: "approve" }, toolNoCapabilityHeaders());
    expect(resp.status).toBe(403);
    expect(resp.body.error).toMatch(/caller identity unavailable/i);
    expect(store.getWorkItem(item.id)!.approvalState).toBe("pending");
  });

  it("400s a missing/invalid decision", async () => {
    const item = pendingItem("in_review");
    expect((await decide(item.id, {})).status).toBe(400);
    expect((await decide(item.id, { decision: "maybe" })).status).toBe(400);
  });

  it("404s an unknown item", async () => {
    expect((await decide("wi_missing", { decision: "approve" })).status).toBe(404);
  });

  it("409s an item with no pending approval", async () => {
    const item = store.createWorkItem({ title: "no approval", status: "in_review", source: "human", assignee: "platform-worker" });
    const resp = await decide(item.id, { decision: "approve" });
    expect(resp.status).toBe(409);
  });
});

describe("POST /api/work-items/:id/approval — native consequence rules", () => {
  it("operator cancellation atomically rejects a pending native approval and removes Needs-you leakage", async () => {
    const item = pendingItem("in_review", {}, "coo");

    const cancelled = await call(
      "PUT",
      `/api/work-items/${item.id}/status`,
      { status: "cancelled", note: "operator withdrew the Todo" },
    );

    expect(cancelled.status).toBe(200);
    expect(cancelled.body.workItem).toMatchObject({
      status: "cancelled",
      approvalState: "rejected",
      approvalDecidedBy: "operator",
    });
    const events = store.listWorkItemEvents(item.id);
    expect(events.slice(-2).map((event) => event.kind)).toEqual(["approval_decided", "status_change"]);
    expect(events.at(-2)).toMatchObject({
      actor: "operator",
      detail: { decision: "reject", note: "operator withdrew the Todo" },
    });
    expect(events.at(-1)).toMatchObject({
      actor: "operator",
      fromStatus: "in_review",
      toStatus: "cancelled",
      detail: { action: "archive", note: "operator withdrew the Todo" },
    });

    const needsYou = await call("GET", "/api/work-items?needsAttentionFor=me&limit=100");
    expect(needsYou.status).toBe(200);
    expect((needsYou.body.workItems as Array<{ id: string }>).some((candidate) => candidate.id === item.id)).toBe(false);

    const eventCount = events.length;
    const repeat = await call("PUT", `/api/work-items/${item.id}/status`, { status: "cancelled" });
    expect(repeat.status).toBe(200);
    expect(repeat.body.workItem).toMatchObject({ status: "cancelled", approvalState: "rejected" });
    expect(store.listWorkItemEvents(item.id)).toHaveLength(eventCount);
  });

  it("approve + in_review → done, decision audited", async () => {
    const item = pendingItem("in_review");
    const resp = await decide(item.id, { decision: "approve", note: "ship it" });
    expect(resp.status).toBe(200);
    expect(resp.body).toMatchObject({ escalated: false });
    expect(resp.body).not.toHaveProperty("mirrored");
    expect(resp.body).not.toHaveProperty("runStatus");
    expect(resp.body.workItem.status).toBe("done");
    expect(resp.body.workItem.approvalState).toBe("approved");
    const kinds = store.listWorkItemEvents(item.id).map((e) => e.kind);
    expect(kinds.slice(-2)).toEqual(["approval_decided", "status_change"]);
  });

  it("reject + in_review → bounce to executing, rounds++, critique audited", async () => {
    const item = pendingItem("in_review");
    const resp = await decide(item.id, { decision: "reject", note: "tests are red" });
    expect(resp.status).toBe(200);
    expect(resp.body.workItem.status).toBe("executing");
    expect(resp.body.workItem.rounds).toBe(1);
    expect(resp.body.escalated).toBe(false);
    const sc = store.listWorkItemEvents(item.id).filter((e) => e.kind === "status_change").at(-1)!;
    expect(sc.detail).toMatchObject({ bounce: true, critique: "tests are red" });
  });

  it("reject + in_review at max rounds → escalated instead of looping", async () => {
    const item = pendingItem("in_review", { verifyPolicy: { mode: "verify", maxRounds: 1 } });
    const resp = await decide(item.id, { decision: "reject", note: "still wrong" });
    expect(resp.status).toBe(200);
    expect(resp.body.workItem.status).toBe("escalated");
    expect(resp.body.escalated).toBe(true);
  });

  it("approve + backlog (non-in_review) → decision recorded, status untouched", async () => {
    const item = pendingItem("backlog");
    const resp = await decide(item.id, { decision: "approve" });
    expect(resp.status).toBe(200);
    expect(resp.body.workItem.status).toBe("backlog");
    expect(resp.body.workItem.approvalState).toBe("approved");
    expect(store.listWorkItemEvents(item.id).some((e) => e.kind === "status_change")).toBe(false);
  });
});

describe("native Workflow gate approval integration", () => {
  // trigger → step a (output:'none', fires at spawn) → approval gate. The step
  // fires immediately so the run PARKS at the gate with no engine round-trip; the
  // gate is the last node so approving it completes the run with nothing to spawn.
  function gateDef(id: string): import("../../workflows/definition.js").EditableWorkflowDefinition {
    return {
      schemaVersion: defMod.WORKFLOW_DEFINITION_SCHEMA_VERSION,
      id,
      title: id,
      version: 1,
      status: "active",
      nodes: [
        { id: "trg", type: "trigger", label: "Manual", position: { x: 0, y: 0 }, trigger: { kind: "manual" } },
        { id: "a", type: "step", label: "A", position: { x: 0, y: 0 }, actor: { kind: "engine", ref: "codex" }, options: { output: "none" } },
        { id: "g", type: "gate", label: "G", position: { x: 0, y: 0 }, gate: { kind: "approval", description: "Publish the report?", approvalRef: "ap" } },
      ],
      edges: [
        { id: "e0", from: "trg", to: "a", kind: "sequence" },
        { id: "e1", from: "a", to: "g", kind: "sequence" },
      ],
    } as import("../../workflows/definition.js").EditableWorkflowDefinition;
  }

  async function seedNativeParkedRun(id: string): Promise<{ runId: string }> {
    const def = gateDef(id);
    def.ownerEmployee = "platform-worker";
    defStore.createDefinition(evidenceRoot, def);
    const started = await runRec.startWorkflowRun({
      root: evidenceRoot,
      getDefinition: defStore.getDefinition,
      probeStepSession: () => ({ found: false as const }),
      spawnStep: async () => ({ sessionId: `stub-native:${id}` }),
      now: () => "2026-07-12T12:00:00.000Z",
    }, def, {
      invocation: { sessionId: workerSession.id, reportMode: "resume" },
    });
    expect(started.status).toBe("parked");
    expect(store.getWorkItemBySourceRef("workflow", `workflow:${id}:${started.runId}`)).toBeUndefined();
    return { runId: started.runId };
  }

  it("routes native gate decisions to the requesting employee's manager/root and forbids self-approval", async () => {
    const workflowId = "appr-native-manager";
    const { runId } = await seedNativeParkedRun(workflowId);
    const before = await call("GET", `/api/workflow-definitions/${workflowId}/runs/${runId}`, undefined, managerHeaders());
    expect(before.status).toBe(200);
    expect(before.body.parked.approval).toMatchObject({
      state: "pending",
      requesterEmployee: "platform-worker",
      target: "platform-manager",
      targetKind: "employee",
    });
    expect(before.body.approvalCapability).toMatchObject({ canDecide: true, target: "platform-manager", needsYou: true });

    const self = await call(
      "POST",
      `/api/workflow-definitions/${workflowId}/runs/${runId}/resolve-gate`,
      { decision: "approve" },
      workerHeaders(),
    );
    expect(self.status).toBe(403);

    const approved = await call(
      "POST",
      `/api/workflow-definitions/${workflowId}/runs/${runId}/resolve-gate`,
      { decision: "approve" },
      managerHeaders(),
    );
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("completed");
    expect(approved.body.gateDecisions).toEqual([
      expect.objectContaining({
        gateKey: "ap",
        decision: "approve",
        actor: "platform-manager",
        approval: expect.objectContaining({
          state: "approved",
          requesterEmployee: "platform-worker",
          target: "platform-manager",
          targetKind: "employee",
          entitledEmployees: ["platform-manager", "coo"],
          operatorEntitled: false,
          escalation: null,
          decidedBy: "platform-manager",
          decidedAt: expect.any(String),
        }),
      }),
    ]);

    const duplicate = await call(
      "POST",
      `/api/workflow-definitions/${workflowId}/runs/${runId}/resolve-gate`,
      { decision: "approve" },
      managerHeaders(),
    );
    expect(duplicate.status).toBe(409);
    const after = await call("GET", `/api/workflow-definitions/${workflowId}/runs/${runId}`);
    expect(after.body.gateDecisions).toHaveLength(1);
    expect(store.getWorkItemBySourceRef("workflow", `workflow:${workflowId}:${runId}`)).toBeUndefined();
  });

  it("lets the hierarchy root reject a native gate and fails the run", async () => {
    const workflowId = "appr-native-reject";
    const { runId } = await seedNativeParkedRun(workflowId);
    const rejected = await call(
      "POST",
      `/api/workflow-definitions/${workflowId}/runs/${runId}/resolve-gate`,
      { decision: "reject" },
      cooHeaders(),
    );
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe("failed");
    expect(rejected.body.gateDecisions).toEqual([
      expect.objectContaining({ gateKey: "ap", decision: "reject", actor: "coo" }),
    ]);
  });

  it("lets an authenticated operator decide only after native gate escalation", async () => {
    const workflowId = "appr-native-escalated";
    const { runId } = await seedNativeParkedRun(workflowId);
    const before = await call(
      "POST",
      `/api/workflow-definitions/${workflowId}/runs/${runId}/resolve-gate`,
      { decision: "approve" },
    );
    expect(before.status).toBe(403);

    const escalated = await call(
      "POST",
      `/api/workflow-definitions/${workflowId}/runs/${runId}/gate-approval/escalate`,
      { reason: "operator decision required" },
      managerHeaders(),
    );
    expect(escalated.status).toBe(200);
    expect(escalated.body.parked.approval).toMatchObject({
      escalatedAt: expect.any(String),
      operatorEntitled: true,
      escalation: {
        target: "operator",
        targetKind: "operator",
        at: expect.any(String),
      },
    });

    const approved = await call(
      "POST",
      `/api/workflow-definitions/${workflowId}/runs/${runId}/resolve-gate`,
      { decision: "approve" },
    );
    expect(approved.status).toBe(200);
    expect(approved.body.gateDecisions).toEqual([
      expect.objectContaining({
        decision: "approve",
        actor: "operator",
        approval: expect.objectContaining({
          state: "approved",
          operatorEntitled: true,
          escalation: expect.objectContaining({ target: "operator", targetKind: "operator" }),
          decidedBy: "operator",
          decidedAt: expect.any(String),
        }),
      }),
    ]);
  });

  it("requires explicit legacy adoption before a parked approval can be decided", async () => {
    const workflowId = "appr-legacy-adoption-route";
    const { runId } = await seedNativeParkedRun(workflowId);
    const native = runStore.getRun(evidenceRoot, workflowId, runId)!;
    runStore.saveRun(evidenceRoot, {
      ...native,
      schemaVersion: 2,
      revision: undefined,
      parked: native.parked ? { ...native.parked, approval: undefined } : null,
    });

    const early = await call(
      "POST",
      `/api/workflow-definitions/${workflowId}/runs/${runId}/resolve-gate`,
      { decision: "approve" },
      managerHeaders(),
    );
    expect(early.status).toBe(409);
    expect(early.body.error).toMatch(/adopt/i);
    expect(runStore.getRun(evidenceRoot, workflowId, runId)?.parked?.approval).toBeUndefined();

    const adopted = await call(
      "POST",
      `/api/workflow-definitions/${workflowId}/runs/${runId}/gate-approval/adopt`,
      {},
    );
    expect(adopted.status).toBe(200);
    expect(adopted.body).toMatchObject({
      parked: { approval: { state: "pending", target: "platform-manager" } },
      approvalAdoptions: [{ definitionSource: "snapshot" }],
    });

    const duplicate = await call(
      "POST",
      `/api/workflow-definitions/${workflowId}/runs/${runId}/gate-approval/adopt`,
      {},
    );
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.approvalAdoptions).toHaveLength(1);

    const decided = await call(
      "POST",
      `/api/workflow-definitions/${workflowId}/runs/${runId}/resolve-gate`,
      { decision: "approve" },
      managerHeaders(),
    );
    expect(decided.status).toBe(200);
  });

  it("cancels a live Workflow run through the real run route without a Workflow Todo", async () => {
    const workflowId = "native-run-cancellation-route";
    const definition = gateDef(workflowId);
    definition.nodes = definition.nodes.filter((node) => node.id !== "g");
    definition.edges = definition.edges.filter((edge) => edge.to !== "g");
    const step = definition.nodes.find((node) => node.id === "a");
    if (!step || step.type !== "step") throw new Error("expected step");
    step.options = { output: "handoff" };
    defStore.createDefinition(evidenceRoot, definition);
    let spawned = false;
    const started = await runRec.startWorkflowRun({
      root: evidenceRoot,
      getDefinition: defStore.getDefinition,
      probeStepSession: () => spawned
        ? ({ found: true as const, sessionId: "stub-cancel-route", status: "running" as const })
        : ({ found: false as const }),
      spawnStep: async () => { spawned = true; return { sessionId: "stub-cancel-route" }; },
      now: () => "2026-07-12T12:00:00.000Z",
    }, definition);
    expect(started.status).toBe("running");
    const liveSessionKey = `workflow-run:${started.runId}:a:1`;
    const liveSession = registry.createSession({
      engine: "codex",
      source: "web",
      sourceRef: liveSessionKey,
      sessionKey: liveSessionKey,
      title: "Live Workflow cancellation step",
    });
    registry.updateSession(liveSession.id, { status: "running" });
    expect(registry.getSessionBySessionKey(liveSessionKey)).toMatchObject({
      status: "running",
      sessionKey: liveSessionKey,
    });

    const cancelled = await call(
      "POST",
      `/api/workflow-definitions/${workflowId}/runs/${started.runId}/cancel`,
      { reason: "operator stopped the run" },
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: "running", stopping: { to: "cancelled" } });
    expect(registry.getSessionBySessionKey(liveSessionKey)).toMatchObject({
      status: "interrupted",
      attemptOutcome: "interrupted",
    });
    await runRec.sweepWorkflowRuns(api.workflowRunDriverDeps(evidenceRoot, apiCtx));
    expect(runStore.getRun(evidenceRoot, workflowId, started.runId)).toMatchObject({
      status: "cancelled",
      stopping: { to: "cancelled" },
    });
    expect(store.getWorkItemBySourceRef("workflow", `workflow:${workflowId}:${started.runId}`)).toBeUndefined();

    const duplicate = await call(
      "POST",
      `/api/workflow-definitions/${workflowId}/runs/${started.runId}/cancel`,
      {},
    );
    expect(duplicate.status).toBe(409);
  });
});
