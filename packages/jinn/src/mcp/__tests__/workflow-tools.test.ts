import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildWorkflowTools } from "../workflow-tools.js";
import type { JinnMcpContext, JinnMcpTool } from "../toolkit.js";

const EXACT_NAMES = [
  "list_workflows",
  "get_workflow",
  "create_workflow",
  "update_workflow",
  "duplicate_workflow",
  "retire_workflow",
  "enable_workflow",
  "disable_workflow",
  "start_workflow_run",
  "list_workflow_runs",
  "get_workflow_run",
  "cancel_workflow_run",
  "rerun_workflow_run",
  "decide_workflow_approval",
  "retry_workflow_node",
  "fire_workflow_event",
] as const;

const RETIRED_NAMES = [
  "plan_workflow",
  "validate_workflow",
  "run_workflow_by_name",
  "edit_workflow_run_step_prompt",
  "escalate_workflow_gate",
  "list_triggers",
  "create_trigger",
  "decide_poll_activation",
  "escalate_poll_activation",
  "delete_trigger",
] as const;

const REQUIRED = {
  list_workflows: [],
  get_workflow: ["workflowId"],
  create_workflow: ["id", "title"],
  update_workflow: ["workflowId", "definition", "expectedRevision"],
  duplicate_workflow: ["sourceId", "id", "title"],
  retire_workflow: ["workflowId", "expectedRevision"],
  enable_workflow: ["workflowId", "expectedRevision"],
  disable_workflow: ["workflowId", "expectedRevision"],
  start_workflow_run: ["workflowId"],
  list_workflow_runs: ["workflowId"],
  get_workflow_run: ["workflowId", "runId"],
  cancel_workflow_run: ["workflowId", "runId"],
  rerun_workflow_run: ["workflowId", "runId", "definition", "idempotencyKey"],
  decide_workflow_approval: ["workflowId", "runId", "nodeId", "decision", "expectedRevision"],
  retry_workflow_node: ["workflowId", "runId", "nodeId", "idempotencyKey"],
  fire_workflow_event: ["eventName", "fireId", "payload"],
} as const;

const VALID_ARGS: Record<(typeof EXACT_NAMES)[number], Record<string, unknown>> = {
  list_workflows: {},
  get_workflow: { workflowId: "release-flow" },
  create_workflow: { id: "release-flow", title: "Release" },
  update_workflow: { workflowId: "release-flow", definition: { id: "release-flow" }, expectedRevision: 1 },
  duplicate_workflow: { sourceId: "release-flow", id: "release-copy", title: "Release copy" },
  retire_workflow: { workflowId: "release-flow", expectedRevision: 1 },
  enable_workflow: { workflowId: "release-flow", expectedRevision: 1 },
  disable_workflow: { workflowId: "release-flow", expectedRevision: 1 },
  start_workflow_run: { workflowId: "release-flow" },
  list_workflow_runs: { workflowId: "release-flow" },
  get_workflow_run: { workflowId: "release-flow", runId: "run-1" },
  cancel_workflow_run: { workflowId: "release-flow", runId: "run-1" },
  rerun_workflow_run: {
    workflowId: "release-flow",
    runId: "run-1",
    definition: "original",
    idempotencyKey: "rerun-1",
  },
  decide_workflow_approval: {
    workflowId: "release-flow",
    runId: "run-1",
    nodeId: "review",
    decision: "approve",
    reason: "Reviewed",
    expectedRevision: 2,
  },
  retry_workflow_node: {
    workflowId: "release-flow",
    runId: "run-1",
    nodeId: "write",
    idempotencyKey: "retry-1",
  },
  fire_workflow_event: { eventName: "build.finished", fireId: "build-1", payload: { status: "passed" } },
};

function tool(name: (typeof EXACT_NAMES)[number]): JinnMcpTool {
  return buildWorkflowTools().find((candidate) => candidate.name === name)!;
}

function noNetworkContext(extra: Partial<JinnMcpContext> = {}): { context: JinnMcpContext; fetchFn: ReturnType<typeof vi.fn> } {
  const fetchFn = vi.fn(async () => {
    throw new Error("Workflow tool reached the gateway before caller capability validation");
  });
  return {
    context: {
      gatewayUrl: "http://gateway.test",
      fetchFn: fetchFn as unknown as typeof fetch,
      ...extra,
    },
    fetchFn,
  };
}

describe("Workflow MCP tools — canonical v2 contract", () => {
  it("exposes exactly the sixteen Task14 tools and explicitly omits retired Workflow verbs", () => {
    const names = buildWorkflowTools().map((candidate) => candidate.name);
    expect(names).toEqual(EXACT_NAMES);
    for (const retired of RETIRED_NAMES) expect(names).not.toContain(retired);
  });

  it("advertises closed, compilable top-level schemas with every required argument", () => {
    for (const candidate of buildWorkflowTools()) {
      expect(candidate.inputSchema.additionalProperties, candidate.name).toBe(false);
      expect(() => z.fromJSONSchema(candidate.inputSchema as Parameters<typeof z.fromJSONSchema>[0]), candidate.name)
        .not.toThrow();
      expect(candidate.inputSchema.required ?? [], candidate.name)
        .toEqual(REQUIRED[candidate.name as keyof typeof REQUIRED]);
      const validator = z.fromJSONSchema(candidate.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
      expect(validator.safeParse(VALID_ARGS[candidate.name as keyof typeof VALID_ARGS]).success, candidate.name).toBe(true);
      for (const required of candidate.inputSchema.required ?? []) {
        const missing = { ...VALID_ARGS[candidate.name as keyof typeof VALID_ARGS] };
        delete missing[required];
        expect(validator.safeParse(missing).success, `${candidate.name}.${required}`).toBe(false);
      }
    }
  });

  it("keeps duplicate identity explicit and rerun definition choice closed", () => {
    const duplicate = tool("duplicate_workflow").inputSchema;
    expect(Object.keys(duplicate.properties)).toEqual(["sourceId", "id", "title"]);
    expect(duplicate.required).toEqual(["sourceId", "id", "title"]);
    expect(tool("rerun_workflow_run").inputSchema.properties.definition)
      .toEqual({ type: "string", enum: ["original", "current"] });
  });

  it("keeps approval authority server-owned and requires durable control-flow guards", () => {
    const approval = tool("decide_workflow_approval").inputSchema;
    expect(Object.keys(approval.properties)).toEqual([
      "workflowId", "runId", "nodeId", "decision", "reason", "expectedRevision",
    ]);
    expect(approval.properties).not.toHaveProperty("decidedBy");
    expect(approval.properties.decision).toEqual({ type: "string", enum: ["approve", "reject"] });
    expect(approval.required).toEqual(["workflowId", "runId", "nodeId", "decision", "expectedRevision"]);
    expect(tool("retry_workflow_node").inputSchema.required)
      .toEqual(["workflowId", "runId", "nodeId", "idempotencyKey"]);
  });

  it("rejects every tool before fetch when caller identity or capability is missing", async () => {
    for (const name of EXACT_NAMES) {
      const missingIdentity = noNetworkContext();
      await expect(tool(name).handler(VALID_ARGS[name], missingIdentity.context), name)
        .rejects.toThrow(/caller identity unavailable/i);
      expect(missingIdentity.fetchFn, name).not.toHaveBeenCalled();

      const missingCapability = noNetworkContext({ callerSessionId: "session-1" });
      await expect(tool(name).handler(VALID_ARGS[name], missingCapability.context), name)
        .rejects.toThrow(/caller identity unavailable/i);
      expect(missingCapability.fetchFn, name).not.toHaveBeenCalled();
    }
  });

  it("labels every mutating tool as a live operation on the current gateway", () => {
    const mutations = EXACT_NAMES.filter((name) => ![
      "list_workflows", "get_workflow", "list_workflow_runs", "get_workflow_run",
    ].includes(name));
    for (const name of mutations) {
      expect(tool(name).description, name).toMatch(/live operation on the current gateway/i);
    }
    for (const name of ["start_workflow_run", "rerun_workflow_run", "retry_workflow_node", "fire_workflow_event"] as const) {
      expect(tool(name).description, name).toMatch(/may spawn real sessions/i);
    }
  });

  it.each([
    [404, "not-found", "Workflow definition was not found."],
    [409, "revision-conflict", "Workflow revision changed."],
    [422, "bad-input", "Workflow request is invalid."],
    [500, "internal-error", "Workflow operation failed."],
  ])("projects a sanitized typed %i gateway error", async (status, code, message) => {
    const context: JinnMcpContext = {
      gatewayUrl: "http://gateway.test",
      callerSessionId: "session-1",
      sessionCapability: "capability-1",
      fetchFn: vi.fn(async () => new Response(JSON.stringify({
        code,
        message,
        details: { workflowId: "release-flow" },
        stack: "must-not-leak",
        request: { token: "must-not-leak" },
      }), { status })) as unknown as typeof fetch,
    };
    const error = await tool("get_workflow").handler({ workflowId: "release-flow" }, context)
      .then(() => "resolved", (reason: Error) => reason.message);
    expect(error).toBe(`${code}: ${message}`);
    expect(error).not.toContain("must-not-leak");
  });

  it("surfaces canonical bad-input for the reserved Event identity at MCP write boundaries", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const context: JinnMcpContext = {
      gatewayUrl: "http://gateway.test",
      callerSessionId: "session-1",
      sessionCapability: "capability-1",
      fetchFn: vi.fn(async (input: string | URL, init?: RequestInit) => {
        requests.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ code: "bad-input", message: "Workflow definition is invalid." }), { status: 422 });
      }) as unknown as typeof fetch,
    };

    await expect(tool("create_workflow").handler({ id: "events", title: "Reserved" }, context))
      .rejects.toThrow("bad-input: Workflow definition is invalid.");
    await expect(tool("duplicate_workflow").handler({ sourceId: "source", id: "events", title: "Reserved" }, context))
      .rejects.toThrow("bad-input: Workflow definition is invalid.");
    expect(requests).toEqual([
      { path: "/api/workflows", body: { id: "events", title: "Reserved" } },
      { path: "/api/workflows/source/duplicate", body: { id: "events", title: "Reserved" } },
    ]);
  });
});
