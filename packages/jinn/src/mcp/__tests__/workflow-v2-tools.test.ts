import { describe, expect, it, vi } from "vitest";
import { buildWorkflowTools } from "../workflow-tools.js";
import type { JinnMcpContext } from "../toolkit.js";

const attemptTools = () => buildWorkflowTools({ attemptCompletion: true });

const NAMES = [
  "list_workflows", "get_workflow", "create_workflow", "update_workflow", "duplicate_workflow",
  "retire_workflow", "enable_workflow", "disable_workflow", "start_workflow_run",
  "list_workflow_runs", "get_workflow_run", "cancel_workflow_run", "rerun_workflow_run",
  "decide_workflow_approval", "retry_workflow_node",
  "fire_workflow_event",
  "workflow_submit_output", "workflow_extend_deadline",
];

describe("Workflow v2 MCP tools", () => {
  it("exposes the Task13 operations plus Task14 durable control flow", () => {
    expect(attemptTools().map((tool) => tool.name)).toEqual(NAMES);
  });

  it("advertises completion controls only inside workflow attempt sessions", () => {
    expect(buildWorkflowTools().map((tool) => tool.name)).toEqual(NAMES.slice(0, -2));
  });

  it("keeps duplicate identity explicit", () => {
    const tool = buildWorkflowTools().find((candidate) => candidate.name === "duplicate_workflow")!;
    expect(tool.inputSchema.required).toEqual(["sourceId", "id", "title"]);
    expect(Object.keys(tool.inputSchema.properties)).toEqual(["sourceId", "id", "title"]);
  });

  it("projects every operation to its canonical REST method and route", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET",
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const context: JinnMcpContext = { gatewayUrl: "http://127.0.0.1:7811", token: "test-token",
      callerSessionId: "session-1", sessionCapability: "capability-1", fetchFn };
    const cases: Array<[string, Record<string, unknown>, string, string, unknown?]> = [
      ["list_workflows", { cursor: "next", limit: 10 }, "GET", "/api/workflows?cursor=next&limit=10"],
      ["get_workflow", { workflowId: "release-flow" }, "GET", "/api/workflows/release-flow"],
      ["create_workflow", { id: "release-flow", title: "Release" }, "POST", "/api/workflows", { id: "release-flow", title: "Release" }],
      ["update_workflow", { workflowId: "release-flow", definition: { id: "release-flow" }, expectedRevision: 1 }, "PUT", "/api/workflows/release-flow", { definition: { id: "release-flow" }, expectedRevision: 1 }],
      ["duplicate_workflow", { sourceId: "release-flow", id: "copy-flow", title: "Copy" }, "POST", "/api/workflows/release-flow/duplicate", { id: "copy-flow", title: "Copy" }],
      ["retire_workflow", { workflowId: "release-flow", expectedRevision: 1 }, "POST", "/api/workflows/release-flow/retire", { expectedRevision: 1 }],
      ["enable_workflow", { workflowId: "release-flow", expectedRevision: 1 }, "POST", "/api/workflows/release-flow/enable", { expectedRevision: 1 }],
      ["disable_workflow", { workflowId: "release-flow", expectedRevision: 1 }, "POST", "/api/workflows/release-flow/disable", { expectedRevision: 1 }],
      ["start_workflow_run", { workflowId: "release-flow", input: { topic: "release" }, idempotencyKey: "start-1" }, "POST", "/api/workflows/release-flow/runs", { input: { topic: "release" }, idempotencyKey: "start-1" }],
      ["list_workflow_runs", { workflowId: "release-flow", status: "failed" }, "GET", "/api/workflows/release-flow/runs?status=failed"],
      ["get_workflow_run", { workflowId: "release-flow", runId: "run-1" }, "GET", "/api/workflows/release-flow/runs/run-1"],
      ["cancel_workflow_run", { workflowId: "release-flow", runId: "run-1", reason: "stop" }, "POST", "/api/workflows/release-flow/runs/run-1/cancel", { reason: "stop" }],
      ["rerun_workflow_run", { workflowId: "release-flow", runId: "run-1", definition: "current", idempotencyKey: "again-1" }, "POST", "/api/workflows/release-flow/runs/run-1/rerun", { definition: "current", idempotencyKey: "again-1" }],
      ["decide_workflow_approval", { workflowId: "release-flow", runId: "run-1", nodeId: "review", decision: "reject", reason: "Revise", expectedRevision: 4 },
        "POST", "/api/workflows/release-flow/runs/run-1/nodes/review/approval", { decision: "reject", reason: "Revise", expectedRevision: 4 }],
      ["retry_workflow_node", { workflowId: "release-flow", runId: "run-1", nodeId: "write", idempotencyKey: "retry-1" },
        "POST", "/api/workflows/release-flow/runs/run-1/nodes/write/retry", { idempotencyKey: "retry-1" }],
      ["fire_workflow_event", { eventName: "build.finished", fireId: "build-1", payload: { ok: true } }, "POST", "/api/workflows/events/build.finished", { fireId: "build-1", payload: { ok: true } }],
      ["workflow_submit_output", { outcome: "success", fields: { result: "done" }, summary: "Finished" },
        "POST", "/api/workflows/attempts/submit", { outcome: "success", fields: { result: "done" }, summary: "Finished" }],
      ["workflow_extend_deadline", { reason: "Waiting on review" },
        "POST", "/api/workflows/attempts/extend", { reason: "Waiting on review" }],
    ];
    for (const [name, args, method, route, payload] of cases) {
      const candidate = attemptTools().find((tool) => tool.name === name)!; await candidate.handler(args, context);
      expect(calls.at(-1)).toEqual({ url: `http://127.0.0.1:7811${route}`, method, ...(payload === undefined ? {} : { body: payload }) });
    }
  });

  it("keeps both attempt-session tools optional and schema constrained", () => {
    const submit = attemptTools().find((tool) => tool.name === "workflow_submit_output")!;
    const extend = attemptTools().find((tool) => tool.name === "workflow_extend_deadline")!;

    expect(submit.inputSchema.required).toBeUndefined();
    expect(submit.inputSchema.properties).toEqual({
      outcome: { type: "string", enum: ["success", "failure"] },
      fields: { type: "object" },
      summary: { type: "string" },
    });
    expect(extend.inputSchema.required).toBeUndefined();
    expect(extend.inputSchema.properties).toEqual({ reason: { type: "string" } });
  });

  it("preserves REST code and message in MCP errors", async () => {
    const context: JinnMcpContext = { gatewayUrl: "http://127.0.0.1:7811", token: "test-token",
      callerSessionId: "session-1", sessionCapability: "capability-1",
      fetchFn: vi.fn(async () => new Response(JSON.stringify({ code: "revision-conflict", message: "Revision changed." }), { status: 409 })) as unknown as typeof fetch };
    const candidate = buildWorkflowTools().find((tool) => tool.name === "enable_workflow")!;
    await expect(candidate.handler({ workflowId: "release-flow", expectedRevision: 1 }, context))
      .rejects.toThrow("revision-conflict: Revision changed.");
  });
});
