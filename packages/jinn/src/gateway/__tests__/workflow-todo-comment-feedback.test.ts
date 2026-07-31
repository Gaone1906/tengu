import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSessionCapability } from "../../mcp/identity.js";
import type { WorkItemComment } from "../../work-items/comments.js";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
} from "../../mcp/identity.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-todo-comments-"));
process.env.JINN_HOME = home;

const deliveryAttempts: string[] = [];
vi.mock("../../sessions/callbacks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sessions/callbacks.js")>();
  return {
    ...actual,
    deliverClaimedSessionDelivery: async (id: string) => {
      deliveryAttempts.push(id);
      return "accepted" as const;
    },
  };
});

type Api = typeof import("../api.js");
type Approvals = typeof import("../../work-items/approvals.js");
type Comments = typeof import("../../work-items/comments.js");
type Registry = typeof import("../../sessions/registry.js");
type Store = typeof import("../../work-items/store.js");
type Surface = typeof import("../workflow-todo-surface.js");

let api: Api;
let approvals: Approvals;
let comments: Comments;
let registry: Registry;
let store: Store;
let surface: Surface;
let database: import("better-sqlite3").Database;

const emitted: Array<{ event: string; payload: unknown }> = [];
const context = {
  getConfig: () => ({ gateway: {}, engines: {}, sessions: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
  sessionManager: {
    getQueue: () => ({
      getPendingCount: () => 0,
      getTransportState: (_key: string, status: string) => status,
    }),
  },
} as unknown as import("../api.js").ApiContext;

function responseCapture() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(nextStatus: number) {
      status = nextStatus;
      return this;
    },
    setHeader() {
      return this;
    },
    end(chunk?: Buffer | string) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get body() {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>;
    },
  };
}

function request(body: string, headers: Record<string, string>) {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify({ body }))]), {
    method: "POST",
    url: "",
    headers: { host: "localhost", "content-type": "application/json", ...headers },
  }) as unknown as Parameters<Api["handleApiRequest"]>[0];
}

const operatorHeaders = { authorization: "Bearer test-token" };

function sessionHeaders(sessionId: string): Record<string, string> {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: sessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
  };
}

async function postComment(
  todoId: string,
  body: string,
  headers: Record<string, string> = operatorHeaders,
) {
  const req = request(body, headers);
  req.url = `/api/work-items/${todoId}/comments`;
  const captured = responseCapture();
  await api.handleApiRequest(req, captured.res, context);
  expect(captured.status).toBe(201);
  return captured.body.comment as WorkItemComment;
}

function phaseSession(
  todoId: string,
  runId: string,
  nodeId: string,
  status: "idle" | "running" = "idle",
) {
  const key = `workflow:content-flow:${runId}:${nodeId}:1`;
  const session = registry.createSession({
    engine: "codex",
    source: "workflow",
    sourceRef: key,
    sessionKey: key,
    connector: "workflow",
    employee: "a-worker",
    prompt: `Complete ${nodeId}.`,
    workflowProvenance: {
      kind: "phase",
      workflowId: "content-flow",
      workflowName: "Content flow",
      runId,
      triggerSource: "todo-status",
      phase: { nodeId, name: nodeId, index: 1, round: 1, attempt: 1 },
    },
  });
  if (status === "running") registry.updateSession(session.id, { status });
  store.linkSession(todoId, session.id);
  return registry.getSession(session.id)!;
}

function plainSession(todoId: string) {
  const session = registry.createSession({
    engine: "codex",
    source: "web",
    sourceRef: `web:${crypto.randomUUID()}`,
    employee: "a-worker",
  });
  store.linkSession(todoId, session.id);
  return session;
}

beforeAll(async () => {
  api = await import("../api.js");
  approvals = await import("../../work-items/approvals.js");
  comments = await import("../../work-items/comments.js");
  registry = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  surface = await import("../workflow-todo-surface.js");
  database = registry.initDb();
});

beforeEach(() => {
  emitted.length = 0;
  deliveryAttempts.length = 0;
  database.exec("DELETE FROM callback_deliveries; DELETE FROM queue_items; DELETE FROM messages; DELETE FROM sessions;");
});

describe("operator Todo comments delivered to workflow phases", () => {
  it("delivers a parked-gate comment once to the newest linked phase and leaves the gate unchanged", async () => {
    const item = store.createWorkItem({
      title: "Explain the parked result",
      source: "workflow",
      status: "in_review",
    });
    phaseSession(item.id, "run-old", "draft");
    plainSession(item.id);
    const latest = phaseSession(item.id, "run-current", "verify");
    approvals.requestApproval(item.id, {
      request: "Approve the result?",
      ref: "workflow:content-flow:run-current:approval",
      actor: "workflow",
    });
    const approvalBefore = approvals.currentApproval(item.id);

    const comment = await postComment(item.id, "Why did verification choose this approach?");
    phaseSession(item.id, "run-current", "late-recovery");
    surface.forwardWorkflowTodoComment(comment);
    surface.forwardWorkflowTodoComment(comment);

    const deliveries = registry.listPendingSessionDeliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      targetSessionId: latest.id,
      sourceKind: "workflow-run",
      sourceId: "run-current",
      sourceAttempt: comment.id,
      sourceOutcome: "operator-comment",
      deliveryKind: "workflow-todo-comment",
    });
    expect(deliveries[0]!.payload.message).toContain("Why did verification choose this approach?");
    expect(deliveries[0]!.payload.message).toContain("comment_work_item");
    expect(deliveries[0]!.payload.message).toContain(comment.id);
    expect(store.getWorkItem(item.id)?.status).toBe("in_review");
    expect(approvals.currentApproval(item.id)).toEqual(approvalBefore);
  });

  it("queues feedback for a running phase without replacing workflow_submit_output", async () => {
    const item = store.createWorkItem({
      title: "Clarify active work",
      source: "workflow",
      status: "executing",
    });
    const running = phaseSession(item.id, "run-live", "build", "running");

    await postComment(item.id, "Please explain the migration choice while you continue.");

    const deliveries = registry.listPendingSessionDeliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.targetSessionId).toBe(running.id);
    expect(deliveries[0]!.payload.message).toContain("workflow_submit_output");
    expect(registry.getSession(running.id)?.status).toBe("running");
  });

  it("does not forward the phase answer or a workflow comment back into the phase", async () => {
    const item = store.createWorkItem({
      title: "Break the comment loop",
      source: "workflow",
      status: "executing",
    });
    const phase = phaseSession(item.id, "run-loop", "build", "running");
    const operatorComment = await postComment(item.id, "What remains?");
    expect(registry.listPendingSessionDeliveries()).toHaveLength(1);

    const answer = await postComment(
      item.id,
      "The final validation remains.",
      sessionHeaders(phase.id),
    );
    surface.forwardWorkflowTodoComment(answer);
    const workflowComment = comments.addComment({
      workItemId: item.id,
      body: "Workflow status note.",
      author: "workflow",
      authorKind: "system",
    });
    surface.forwardWorkflowTodoComment(workflowComment);

    expect(operatorComment.authorKind).toBe("operator");
    expect(answer.authorKind).toBe("employee");
    expect(registry.listPendingSessionDeliveries()).toHaveLength(1);
  });

  it("caps one run at five forwarded operator comments and explains the sixth on the Todo", async () => {
    const item = store.createWorkItem({
      title: "Bound operator follow-ups",
      source: "workflow",
      status: "executing",
    });
    phaseSession(item.id, "run-cap", "build", "running");

    const posted = [];
    for (let index = 1; index <= 6; index += 1) {
      posted.push(await postComment(item.id, `Operator question ${index}`));
    }

    expect(registry.listPendingSessionDeliveries()).toHaveLength(5);
    const page = comments.listComments(item.id, { limit: 50 });
    const notices = page.comments.filter((comment) => comment.authorKind === "system");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ parentCommentId: posted[5]!.id });
    expect(notices[0]!.body).toMatch(/not forwarded/i);
    expect(notices[0]!.body).toContain("5");
  });

  it("accepts an operator comment without error when no phase session was ever linked", async () => {
    const item = store.createWorkItem({
      title: "No workflow session",
      source: "workflow",
      status: "in_review",
    });
    plainSession(item.id);

    await postComment(item.id, "Can anyone answer this?");

    expect(registry.listPendingSessionDeliveries()).toEqual([]);
    expect(comments.listComments(item.id).total).toBe(1);
  });
});
