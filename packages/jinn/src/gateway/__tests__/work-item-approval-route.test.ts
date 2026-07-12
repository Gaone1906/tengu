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
 *   4. MIRRORED park: a REAL parked run's Todo, decided through THIS route,
 *      unparks + completes via the shipped resolve-gate authority.
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
type Bridge = typeof import("../../work-items/workflow-bridge.js");
type Registry = typeof import("../../sessions/registry.js");
let api: Api;
let store: Store;
let approvals: Approvals;
let defStore: DefStore;
let defMod: Def;
let runRec: RunRec;
let bridgeMod: Bridge;
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
    getQueue: () => ({ isRunning: () => false, getPendingCount: () => 0 }),
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
  bridgeMod = await import("../../work-items/workflow-bridge.js");
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
    expect(resp.body).toMatchObject({ mirrored: false, escalated: false });
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

describe("POST /api/work-items/:id/approval — mirrored workflow park (integration)", () => {
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

  // Create a REAL parked run on the evidence root using a stub spawn (so it parks
  // without a live engine), minting + mirroring the Todo via the real bridge. The
  // DECISION then goes through the real handleApiRequest route.
  async function seedParkedRun(id: string): Promise<{ runId: string; todoId: string }> {
    const def = gateDef(id);
    defStore.createDefinition(evidenceRoot, def);
    const stubDeps = {
      root: evidenceRoot,
      getDefinition: defStore.getDefinition,
      probeStepSession: () => ({ found: false as const }),
      spawnStep: async () => ({ sessionId: `stub:${id}` }),
      workItems: bridgeMod.createWorkflowTodoBridge(),
      now: () => "2026-07-05T10:00:00.000Z",
    } as unknown as Parameters<RunRec["startWorkflowRun"]>[0];
    const started = await runRec.startWorkflowRun(stubDeps, def);
    expect(started.status).toBe("parked");
    const todo = store.getWorkItemBySourceRef("workflow", `workflow:${id}:${started.runId}`)!;
    expect(todo).toBeTruthy();
    return { runId: started.runId, todoId: todo.id };
  }

  it("projects real approval authority and Needs-you routing onto a parked run per current principal", async () => {
    const workflowId = "appr-int-capability";
    const { runId, todoId } = await seedParkedRun(workflowId);

    // Prove the capability is derived from the same real Todo that powers the
    // Needs-you queue, not guessed from run.status or accepted after a 403 click.
    const cooQueue = await call("GET", "/api/work-items?needsAttentionFor=me&limit=100", undefined, cooHeaders());
    expect(cooQueue.status).toBe(200);
    expect((cooQueue.body.workItems as Array<{ id: string }>).some((item) => item.id === todoId)).toBe(true);

    const workerQueue = await call("GET", "/api/work-items?needsAttentionFor=me&limit=100", undefined, workerHeaders());
    expect(workerQueue.status).toBe(200);
    expect((workerQueue.body.workItems as Array<{ id: string }>).some((item) => item.id === todoId)).toBe(false);

    const authorized = await call("GET", `/api/workflow-definitions/${workflowId}/runs/${runId}`, undefined, cooHeaders());
    expect(authorized.status).toBe(200);
    expect(authorized.body.approvalCapability).toEqual({
      canDecide: true,
      target: "coo",
      needsYou: true,
      escalated: false,
    });

    const unauthorized = await call("GET", `/api/workflow-definitions/${workflowId}/runs/${runId}`, undefined, workerHeaders());
    expect(unauthorized.status).toBe(200);
    expect(unauthorized.body.approvalCapability).toEqual({
      canDecide: false,
      target: "coo",
      needsYou: false,
      escalated: false,
    });

    // Read projection must never weaken the mutation boundary.
    const forbidden = await call(
      "POST",
      `/api/workflow-definitions/${workflowId}/runs/${runId}/resolve-gate`,
      { decision: "approve" },
      workerHeaders(),
    );
    expect(forbidden.status).toBe(403);
    expect(store.getWorkItem(todoId)!.approvalState).toBe("pending");
  });

  it("a real parked run → approve via the Todo route → run unparks + completes through resolve-gate", async () => {
    const { runId, todoId } = await seedParkedRun("appr-int-ok");

    // The run's Todo carries a MIRRORED pending approval (one operator queue).
    const todo = store.getWorkItem(todoId)!;
    expect(todo.approvalState).toBe("pending");
    expect(todo.approvalRequest).toBe("Publish the report?");
    expect(todo.approvalRef).toBe(`workflow-gate:appr-int-ok:${runId}:ap`);

    // Approve through the ONE Todo route — it routes to the shipped resolve-gate.
    const decideResp = await call("POST", `/api/work-items/${todoId}/approval`, { decision: "approve" }, cooHeaders());
    expect(decideResp.status).toBe(200);
    expect(decideResp.body.mirrored).toBe(true);
    expect(decideResp.body.workItem.approvalState).toBe("approved");

    // The parked run actually unparked and completed via resolve-gate semantics.
    const runResp = await call("GET", `/api/workflow-definitions/appr-int-ok/runs/${runId}`);
    expect(runResp.status).toBe(200);
    expect(runResp.body.status).toBe("completed");
    // …and the run's terminal reflected onto the Todo (completed → done).
    expect(store.getWorkItem(todoId)!.status).toBe("done");
  });

  it("a real parked run → send back (reject) via the Todo route → run fails through resolve-gate", async () => {
    const { runId, todoId } = await seedParkedRun("appr-int-reject");

    const decideResp = await call("POST", `/api/work-items/${todoId}/approval`, { decision: "reject", note: "not yet" }, cooHeaders());
    expect(decideResp.status).toBe(200);
    expect(decideResp.body.mirrored).toBe(true);
    expect(decideResp.body.workItem.approvalState).toBe("rejected");

    const runResp = await call("GET", `/api/workflow-definitions/appr-int-reject/runs/${runId}`);
    expect(runResp.body.status).toBe("failed");
    // failed run → blocked Todo (terminal reflect).
    expect(store.getWorkItem(todoId)!.status).toBe("blocked");
  });

  it("rejects operator cancellation of a pending Workflow-gate mirror and leaves the run authority resolvable", async () => {
    const workflowId = "appr-int-cancel-conflict";
    const { runId, todoId } = await seedParkedRun(workflowId);
    const before = store.getWorkItem(todoId)!;
    expect(before.approvalState).toBe("pending");
    expect(before.approvalRef).toBe(`workflow-gate:${workflowId}:${runId}:ap`);

    const archive = await call(
      "POST",
      `/api/work-items/${todoId}/archive`,
      { note: "operator tried to archive the mirror" },
    );
    expect(archive.status).toBe(409);
    expect(archive.body.error).toMatch(/Workflow.*gate.*run.*author/i);

    const cancel = await call(
      "PUT",
      `/api/work-items/${todoId}/status`,
      { status: "cancelled", note: "operator tried to cancel the mirror" },
    );

    expect(cancel.status).toBe(409);
    expect(cancel.body.error).toMatch(/Workflow.*gate.*run.*author/i);
    expect(store.getWorkItem(todoId)).toMatchObject({
      status: before.status,
      approvalState: "pending",
      approvalRef: before.approvalRef,
    });

    const bridge = bridgeMod.createWorkflowTodoBridge();
    bridge.mirrorParkedGate(
      { workflowId, runId, title: workflowId, status: "parked" },
      { ref: "ap", description: "Publish the report?" },
    );
    expect(store.listWorkItemEvents(todoId).filter((event) => event.kind === "approval_requested")).toHaveLength(1);

    const resolve = await call(
      "POST",
      `/api/workflow-definitions/${workflowId}/runs/${runId}/resolve-gate`,
      { decision: "approve" },
      cooHeaders(),
    );
    expect(resolve.status).toBe(200);
    expect(resolve.body.status).toBe("completed");
    expect(store.getWorkItem(todoId)).toMatchObject({ status: "done", approvalState: "approved" });

    const needsYou = await call("GET", "/api/work-items?needsAttentionFor=me&limit=100");
    expect((needsYou.body.workItems as Array<{ id: string }>).some((candidate) => candidate.id === todoId)).toBe(false);
  });

  // QA finding 1 (mirror/resolve desync): a gate resolved DIRECTLY through the
  // shipped resolve-gate route (the workflow UI's own Review button — NOT the Todo
  // route) must ALSO clear the mirrored Todo approval, or it ghosts in "Needs you"
  // forever and can't be repaired (retrying the Todo route → 409 run-not-parked).
  it("a gate resolved DIRECTLY via resolve-gate clears the mirrored Todo (no ghost in Needs-you)", async () => {
    const { runId, todoId } = await seedParkedRun("appr-int-direct");
    expect(store.getWorkItem(todoId)!.approvalState).toBe("pending"); // mirror pending

    const workerBypass = await call("POST", `/api/workflow-definitions/appr-int-direct/runs/${runId}/resolve-gate`, { decision: "approve" }, workerHeaders());
    expect(workerBypass.status).toBe(403);
    expect(store.getWorkItem(todoId)!.approvalState).toBe("pending");

    const operatorBypass = await call("POST", `/api/workflow-definitions/appr-int-direct/runs/${runId}/resolve-gate`, { decision: "approve" });
    expect(operatorBypass.status).toBe(403);
    expect(store.getWorkItem(todoId)!.approvalState).toBe("pending");

    const spoofedManagerBypass = await call(
      "POST",
      `/api/workflow-definitions/appr-int-direct/runs/${runId}/resolve-gate`,
      { decision: "approve" },
      unmarkedCallerHeaders(managerSession),
    );
    expect(spoofedManagerBypass.status).toBe(403);
    expect(store.getWorkItem(todoId)!.approvalState).toBe("pending");

    const bogusCapBypass = await call(
      "POST",
      `/api/workflow-definitions/appr-int-direct/runs/${runId}/resolve-gate`,
      { decision: "approve" },
      unmarkedCallerHeaders(managerSession, "bogus"),
    );
    expect(bogusCapBypass.status).toBe(403);
    expect(store.getWorkItem(todoId)!.approvalState).toBe("pending");

    // Resolve through the DIRECT resolve-gate route (bypasses the Todo route).
    const resolveResp = await call("POST", `/api/workflow-definitions/appr-int-direct/runs/${runId}/resolve-gate`, { decision: "approve" }, cooHeaders());
    expect(resolveResp.status).toBe(200);
    expect(resolveResp.body.status).toBe("completed");

    // The ledger reacted: the mirror is CLEARED (not pending) — no ghost.
    const todo = store.getWorkItem(todoId)!;
    expect(todo.approvalState).not.toBe("pending");
    expect(todo.approvalState).toBe("approved");
    expect(todo.status).toBe("done"); // terminal reflect still lands

    // "Needs you" derivation (approval_state='pending' ∪ blocked ∪ escalated) no
    // longer lists this Todo.
    const needsYou = store.listWorkItems().filter(
      (w) => w.approvalState === "pending" || w.status === "blocked" || w.status === "escalated",
    );
    expect(needsYou.some((w) => w.id === todoId)).toBe(false);

    // And retrying the Todo route is a clean refusal, not a partial repair.
    const retry = await call("POST", `/api/work-items/${todoId}/approval`, { decision: "approve" }, cooHeaders());
    expect(retry.status).toBe(409); // no pending approval to decide
  });

  it("a Todo-triggered parked run can be resolved directly via resolve-gate using the original Todo mirror", async () => {
    const workflowId = "appr-int-todo-triggered";
    const def = gateDef(workflowId);
    def.nodes[0].trigger = { kind: "todo-status-change", toStatus: "in_review" } as never;
    defStore.createDefinition(evidenceRoot, def);
    const triggerTodo = store.createWorkItem({
      title: "triggering Todo",
      status: "in_review",
      source: "human",
      assignee: "platform-worker",
      department: "platform",
    });
    const stubDeps = {
      root: evidenceRoot,
      getDefinition: defStore.getDefinition,
      probeStepSession: () => ({ found: false as const }),
      spawnStep: async () => ({ sessionId: `stub:${workflowId}` }),
      workItems: bridgeMod.createWorkflowTodoBridge(),
      now: () => "2026-07-05T10:00:00.000Z",
    } as unknown as Parameters<RunRec["startWorkflowRun"]>[0];

    const started = await runRec.startWorkflowRun(stubDeps, def, {
      trigger: { kind: "todo-status-change", fireRef: "wie_todo_gate" } as never,
      triggerTodoId: triggerTodo.id,
    });
    expect(started.status).toBe("parked");
    expect(store.getWorkItemBySourceRef("workflow", `workflow:${workflowId}:${started.runId}`)).toBeFalsy();
    expect(store.getWorkItem(triggerTodo.id)!.approvalRef).toBe(`workflow-gate:${workflowId}:${started.runId}:ap`);

    const resolveResp = await call("POST", `/api/workflow-definitions/${workflowId}/runs/${started.runId}/resolve-gate`, { decision: "approve" }, cooHeaders());

    expect(resolveResp.status).toBe(200);
    expect(resolveResp.body.status).toBe("completed");
    const todoAfter = store.getWorkItem(triggerTodo.id)!;
    expect(todoAfter.approvalState).toBe("approved");
    expect(todoAfter.approvalDecidedBy).toBe("coo");
  });

  it("a gate REJECTED directly via resolve-gate clears the mirror to rejected + blocks the Todo", async () => {
    const { runId, todoId } = await seedParkedRun("appr-int-direct-reject");
    const resolveResp = await call("POST", `/api/workflow-definitions/appr-int-direct-reject/runs/${runId}/resolve-gate`, { decision: "reject" }, cooHeaders());
    expect(resolveResp.status).toBe(200);
    expect(resolveResp.body.status).toBe("failed");
    const todo = store.getWorkItem(todoId)!;
    expect(todo.approvalState).toBe("rejected"); // mirror cleared, not pending
    expect(todo.status).toBe("blocked");
  });
});
