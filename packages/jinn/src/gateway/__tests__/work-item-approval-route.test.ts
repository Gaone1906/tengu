import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
 * registry + work-item store (temp JINN_HOME).
 *
 * What it pins (design §1.3, §6 test plan):
 *   1. HUMAN-ONLY: a tool-marked caller (x-jinn-tool-call) is refused 403 — the
 *      GRS-017 fail-closed pattern (deciding is human-only; requesting is not).
 *   2. DECISION VALIDATION: bad body / decision → 400; unknown item → 404; an
 *      item with no pending approval → 409.
 *   3. NATIVE CONSEQUENCE RULES: approve+in_review → done; reject+in_review →
 *      bounce (rounds++, critique) / max-rounds → escalated; a non-in_review
 *      decision is recorded, status untouched.
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
  "name: platform-manager\ndisplayName: Platform Manager\ndepartment: platform\nrank: manager\nreportsTo: platform-director\nengine: codex\nmodel: gpt-5.5\npersona: Manages platform work.\n",
);
fs.writeFileSync(
  path.join(orgDir, "platform-director.yaml"),
  "name: platform-director\ndisplayName: Platform Director\ndepartment: platform\nrank: manager\nreportsTo: coo\nengine: codex\nmodel: gpt-5.5\npersona: Manages the platform manager.\n",
);
fs.writeFileSync(
  path.join(orgDir, "platform-worker.yaml"),
  "name: platform-worker\ndisplayName: Platform Worker\ndepartment: platform\nrank: employee\nreportsTo: platform-manager\nengine: codex\nmodel: gpt-5.5\npersona: Executes platform work.\n",
);
fs.writeFileSync(
  path.join(orgDir, "platform-peer.yaml"),
  "name: platform-peer\ndisplayName: Platform Peer\ndepartment: platform\nrank: employee\nreportsTo: platform-manager\nengine: codex\nmodel: gpt-5.5\npersona: Another platform worker.\n",
);
fs.writeFileSync(
  path.join(orgDir, "review-manager.yaml"),
  "name: review-manager\ndisplayName: Review Manager\ndepartment: platform\nrank: manager\nreportsTo: coo\nengine: codex\nmodel: gpt-5.5\npersona: Manages the review team.\n",
);
fs.writeFileSync(
  path.join(orgDir, "reviewer.yaml"),
  "name: reviewer\ndisplayName: Reviewer\ndepartment: platform\nrank: employee\nreportsTo: review-manager\nengine: codex\nmodel: gpt-5.5\npersona: Reviews platform work.\n",
);
type Api = typeof import("../api.js");
type Store = typeof import("../../work-items/store.js");
type Approvals = typeof import("../../work-items/approvals.js");
type Registry = typeof import("../../sessions/registry.js");
let api: Api;
let store: Store;
let approvals: Approvals;
let registry: Registry;
let callbacks: typeof import("../../sessions/callbacks.js");
let cooSession: import("../../shared/types.js").Session;
let directorSession: import("../../shared/types.js").Session;
let managerSession: import("../../shared/types.js").Session;
let workerSession: import("../../shared/types.js").Session;
let peerSession: import("../../shared/types.js").Session;
let reviewManagerSession: import("../../shared/types.js").Session;
const processFetch = globalThis.fetch;

const apiConfig = {
  gateway: { host: "127.0.0.1", authDisabled: true },
  engines: { default: "codex", codex: { bin: "codex", model: "gpt-5.5" } },
  sessions: {},
  mcp: {},
};

/** Runs an operator-only mirrored gate resolves into, keyed `<workflowId>/<runId>`. */
const workflowRuns = new Map<string, { definition: { nodes: unknown[] } }>();

const apiCtx = {
  getConfig: () => apiConfig,
  config: apiConfig,
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  jinnHome: tmpHome,
  emit: () => {},
  workflowService: {
    getRun: (workflowId: string, runId: string) => workflowRuns.get(`${workflowId}/${runId}`) ?? null,
  },
  sessionManager: {
    getEngines: () => new Map([["codex", {}]]),
    getEngine: () => undefined,
    getQueue: () => ({ isRunning: () => false, getPendingCount: () => 0, clearQueue: () => undefined }),
  },
} as unknown as import("../api.js").ApiContext;

const viteOrigin = "http://127.0.0.1:4174";
const gatewayAuthority = "127.0.0.1:7800";

function browserReq(
  method: string,
  urlPath: string,
  body?: unknown,
  overrides: Record<string, string> = {},
) {
  const payload = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
  const headers: Record<string, string> = {
    host: gatewayAuthority,
    accept: "application/json",
    referer: `${viteOrigin}/workflows`,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": "Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36",
    ...(body !== undefined ? { "content-type": "application/json" } : {}),
    ...(method !== "GET" ? { origin: viteOrigin } : {}),
    ...overrides,
  };
  const req = Object.assign(Readable.from(payload), {
    method,
    url: urlPath,
    headers,
    rawHeaders: Object.entries(headers).flatMap(([name, value]) => [name, value]),
    socket: {
      remoteAddress: "127.0.0.1",
      localAddress: "127.0.0.1",
      localPort: 7800,
    },
  });
  return req as unknown as Parameters<Api["handleApiRequest"]>[0];
}

async function browserCall(
  method: string,
  urlPath: string,
  body?: unknown,
  overrides: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const cap = makeRes();
  await api.handleApiRequest(browserReq(method, urlPath, body, overrides), cap.res, apiCtx);
  return { status: cap.status, body: cap.body };
}

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
const directorHeaders = () => toolHeaders(directorSession);
const managerHeaders = () => toolHeaders(managerSession);
const workerHeaders = () => toolHeaders(workerSession);
const peerHeaders = () => toolHeaders(peerSession);
const reviewManagerHeaders = () => toolHeaders(reviewManagerSession);
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
  registry = await import("../../sessions/registry.js");
  callbacks = await import("../../sessions/callbacks.js");
  (await import("../../shared/db.js")).initDb();
  globalThis.fetch = async () => {
    throw new Error("work-item approval route test callback transport is offline");
  };
  cooSession = registry.createSession({ engine: "codex", source: "web", sourceRef: "coo", title: "coo", employee: "coo" });
  directorSession = registry.createSession({ engine: "codex", source: "web", sourceRef: "director", title: "director", employee: "platform-director" });
  managerSession = registry.createSession({ engine: "codex", source: "web", sourceRef: "manager", title: "manager", employee: "platform-manager" });
  workerSession = registry.createSession({ engine: "codex", source: "web", sourceRef: "worker", title: "worker", employee: "platform-worker" });
  peerSession = registry.createSession({ engine: "codex", source: "web", sourceRef: "peer", title: "peer", employee: "platform-peer" });
  reviewManagerSession = registry.createSession({ engine: "codex", source: "web", sourceRef: "review-manager", title: "review manager", employee: "review-manager" });
});

afterEach(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  callbacks.__resetCallbackRetrySweepForTest();
});

afterAll(async () => {
  globalThis.fetch = processFetch;
  (await import("../../shared/db.js")).__closeDbForTest();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("POST /api/work-items/:id/approval — COO-default authority + validation", () => {
  it("allows a non-root manager grandparent of the Todo owner to decide its approval", async () => {
    const item = pendingItem("in_review");

    const director = await call("POST", `/api/work-items/${item.id}/approvals/decide`, { decision: "approve", note: "ship" }, directorHeaders());

    expect(director.status).toBe(200);
    expect(director.body.workItem).toMatchObject({
      approvalState: "approved",
      approvalDecidedBy: "platform-director",
      status: "done",
    });
  });

  it("refuses a manager who is only an ancestor of the explicit routed target", async () => {
    const item = pendingItem("in_review", {}, "reviewer");

    const targetManager = await decide(item.id, { decision: "approve" }, reviewManagerHeaders());

    expect(targetManager.status).toBe(403);
    expect(store.getWorkItem(item.id)!.approvalState).toBe("pending");
  });

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
    expect((await decide("JIN-999", { decision: "approve" })).status).toBe(404);
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

/* A gate the workflow definition declared operator-only. Default routing puts
 * an approval at the org hierarchy root, so the COO can approve a pipeline the
 * COO started — a governance hole when the gate authorizes an auto-merge. The
 * flag lives on the workflow node and is read back through the approval ref,
 * so the definition stays the single source of truth for who may decide. */
describe("POST /api/work-items/:id/approval — an operator-only mirrored gate", () => {
  function operatorOnlyItem(operatorOnly: boolean, runKey = "merge-flow/run-1") {
    workflowRuns.set(runKey, {
      definition: { nodes: [{ id: "gate", type: "approval", name: "Gate", config: { description: "Merge?", operatorOnly } }] },
    });
    const item = store.createWorkItem({
      title: "auto-merge gate", status: "in_review", source: "workflow",
      assignee: "platform-worker", department: "platform",
    });
    approvals.requestApproval(item.id, {
      request: "Merge to the default branch?",
      ref: `workflow:${runKey.replace("/", ":")}:gate`,
      target: "platform-manager",
    });
    return item;
  }

  it("refuses the routed manager AND the COO", async () => {
    const item = operatorOnlyItem(true);

    const manager = await decide(item.id, { decision: "approve" }, managerHeaders());
    expect(manager.status).toBe(403);
    expect(manager.body.error).toContain("operator-only");

    const coo = await decide(item.id, { decision: "approve" }, cooHeaders());
    expect(coo.status).toBe(403);
    expect(coo.body.error).toContain("operator-only");

    expect(store.getWorkItem(item.id)!.approvalState).toBe("pending");
  });

  it("still refuses the COO after the gate has been escalated", async () => {
    const item = operatorOnlyItem(true, "merge-flow/run-escalated");
    await call("POST", `/api/work-items/${item.id}/approval/escalate`, {}, managerHeaders());

    const coo = await decide(item.id, { decision: "approve" }, cooHeaders());
    expect(coo.status).toBe(403);
    expect(store.getWorkItem(item.id)!.approvalState).toBe("pending");
  });

  it("lets the operator decide it", async () => {
    const item = operatorOnlyItem(true, "merge-flow/run-operator");
    const operator = await decide(item.id, { decision: "approve", note: "merge it" }, {});
    expect(operator.status).toBe(200);
    expect(operator.body.workItem).toMatchObject({ approvalState: "approved", approvalDecidedBy: "operator" });
  });

  it("leaves a mirrored gate that is NOT operator-only on ordinary hierarchy routing", async () => {
    const item = operatorOnlyItem(false, "merge-flow/run-ordinary");
    const manager = await decide(item.id, { decision: "approve" }, managerHeaders());
    expect(manager.status).toBe(200);
    expect(manager.body.workItem.approvalDecidedBy).toBe("platform-manager");
  });
});

/* The same reservation on a NATIVE gate — one with no workflow behind it. It is
 * stored in `work_item_approval_operator_only`, a table keyed on the approval
 * id, because `work_item_approvals.target_kind` carries a CHECK constraint the
 * exact-shape boot preflight covers: a MISSING additive table heals on boot, an
 * ALTERED one makes every existing database refuse to start. */
describe("POST /api/work-items/:id/approval — a native operator-only gate", () => {
  async function requestGate(body: Record<string, unknown>, headers = workerHeaders()) {
    const item = store.createWorkItem({
      title: "native reserved", status: "in_review", source: "human",
      assignee: "platform-worker", department: "platform",
    });
    const resp = await call("POST", `/api/work-items/${item.id}/approval/request`, body, headers);
    return { item, resp };
  }

  it("records the reservation on the Todo it was requested for", async () => {
    const { item, resp } = await requestGate({ request: "Ship it?", operatorOnly: true });
    expect(resp.status).toBe(200);
    expect(resp.body.workItem.approvalOperatorOnly).toBe(true);
    expect(approvals.currentApproval(item.id)!.operatorOnly).toBe(true);
  });

  it("refuses the routed manager, the COO, and the COO after an escalation", async () => {
    const { item } = await requestGate({ request: "Ship it?", operatorOnly: true });

    const manager = await decide(item.id, { decision: "approve" }, managerHeaders());
    expect(manager.status).toBe(403);
    expect(manager.body.error).toContain("operator-only");

    const coo = await decide(item.id, { decision: "approve" }, cooHeaders());
    expect(coo.status).toBe(403);

    // Escalation is refused too, so it cannot be used to reach the executive path.
    const escalate = await call("POST", `/api/work-items/${item.id}/approval/escalate`, {}, managerHeaders());
    expect(escalate.status).toBe(403);
    expect(store.getWorkItem(item.id)!.approvalEscalatedAt).toBeNull();

    const cooAgain = await decide(item.id, { decision: "approve" }, cooHeaders());
    expect(cooAgain.status).toBe(403);
    expect(store.getWorkItem(item.id)!.approvalState).toBe("pending");
  });

  it("lets the operator decide it", async () => {
    const { item } = await requestGate({ request: "Ship it?", operatorOnly: true });
    const operator = await decide(item.id, { decision: "approve", note: "shipped" }, {});
    expect(operator.status).toBe(200);
    expect(operator.body.workItem).toMatchObject({ approvalState: "approved", approvalDecidedBy: "operator" });
  });

  it("refuses a reservation that also names an employee target", async () => {
    const { resp } = await requestGate({ request: "Ship it?", operatorOnly: true, target: "platform-manager" });
    expect(resp.status).toBe(400);
    expect(resp.body.error).toContain("operator-only");
  });

  it("rejects a non-boolean operatorOnly", async () => {
    const { resp } = await requestGate({ request: "Ship it?", operatorOnly: "yes" });
    expect(resp.status).toBe(400);
  });

  it("defaults to ordinary routing, and re-requesting drops a reservation", async () => {
    const { item, resp } = await requestGate({ request: "Ship it?" });
    expect(resp.status).toBe(200);
    expect(resp.body.workItem.approvalOperatorOnly).toBe(false);

    await call("POST", `/api/work-items/${item.id}/approval/request`, { request: "Ship it?", operatorOnly: true }, workerHeaders());
    expect(approvals.currentApproval(item.id)!.operatorOnly).toBe(true);

    // Re-routing the one pending gate re-states the reservation rather than
    // leaving a stale row behind.
    await call("POST", `/api/work-items/${item.id}/approval/request`, { request: "Ship it?", target: "platform-manager" }, workerHeaders());
    expect(approvals.currentApproval(item.id)!.operatorOnly).toBe(false);
    const manager = await decide(item.id, { decision: "approve" }, managerHeaders());
    expect(manager.status).toBe(200);
  });
});
