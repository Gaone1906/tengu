import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { buildWorkflowTools } from "../workflow-tools.js";
import { handleMcpRequest, buildTools } from "../server.js";
import type { JinnMcpContext, JinnMcpTool } from "../toolkit.js";
import { planWorkflowAuthoringInput } from "../../workflows/authoring.js";

/**
 * GRS-015 — the workflow MCP tool group.
 *
 * Two tiers:
 *   1. UNIT — every tool against a stub fetch: exact route/method/body it sends,
 *      success passthrough + decision-shaped hints, structured validator-error
 *      passthrough, the 503 evidence-root safety, 409/404/422 shapes.
 *   2. INTEGRATION — the tools drive the REAL gateway routes (handleApiRequest via
 *      a fetch adapter, real definition/run stores on a temp evidence root): an
 *      agent's whole loop — create (invalid → structured errors → corrected),
 *      start, inspect (steps[] order verbatim), park on the gate, resolve — with
 *      no HTTP server and nothing live touched.
 */

// Isolated stores for the integration tier. Set BEFORE the dynamic api import.
const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-wf-int-"));
process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-wf-home-"));
process.env.JINN_WORKFLOW_EVIDENCE_ROOT = evidenceRoot;
const orgDir = path.join(process.env.JINN_HOME, "org", "platform");
fs.mkdirSync(orgDir, { recursive: true });
fs.writeFileSync(path.join(orgDir, "department.yaml"), "name: platform\n");
fs.writeFileSync(
  path.join(orgDir, "coo.yaml"),
  "name: coo\ndisplayName: COO\ndepartment: platform\nrank: executive\nengine: codex\nmodel: gpt-5.5\npersona: Runs the company.\n",
);

/* ── Unit-tier stub fetch ───────────────────────────────────────────────────── */

interface SeenCall {
  url: string;
  method: string;
  body?: unknown;
}

function stub(responder: (call: SeenCall) => { status: number; body: unknown }) {
  const calls: SeenCall[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const call: SeenCall = {
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const { status, body } = responder(call);
    return {
      status,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  const ctx: JinnMcpContext = {
    gatewayUrl: "http://127.0.0.1:7777",
    token: "tok",
    callerSessionId: "session-test",
    sessionCapability: "cap-test",
    fetchFn,
  };
  return { calls, ctx };
}

function tool(name: string): JinnMcpTool {
  const t = buildWorkflowTools().find((t) => t.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

describe("workflow tools — registry + schemas", () => {
  it("exposes the workflow and trigger tools with concise object schemas", () => {
    const tools = buildWorkflowTools();
    expect(tools.map((t) => t.name)).toEqual([
      "list_workflows",
      "get_workflow",
      "list_workflow_runs",
      "get_workflow_run",
      "plan_workflow",
      "validate_workflow",
      "create_workflow",
      "update_workflow",
      "retire_workflow",
      "start_workflow_run",
      "run_workflow_by_name",
      "list_triggers",
      "create_trigger",
      "delete_trigger",
    ]);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  it("does NOT expose a gate-resolve tool — human approvals stay off the agent toolbelt (Codex GRS-015 finding 1)", async () => {
    // A run parks precisely so a HUMAN decides; an agent that can approve makes
    // the doorbell theater. Resolution stays on the HTTP route (web doorbell /
    // operator). Calling the removed tool is an unknown-tool error the agent can read.
    expect(buildWorkflowTools().some((t) => t.name === "jinn_resolve_workflow_gate")).toBe(false);
    const { ctx } = stub(() => ({ status: 200, body: {} }));
    const resp = await handleMcpRequest(
      { id: 1, method: "tools/call", params: { name: "jinn_resolve_workflow_gate", arguments: { workflowId: "wf", runId: "r", decision: "approve" } } },
      buildTools(),
      ctx,
    );
    const result = resp!.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/unknown tool/i);
  });

  it("declares the required args each route needs", () => {
    expect(tool("get_workflow").inputSchema.required).toEqual(["workflowId"]);
    expect(tool("list_workflow_runs").inputSchema.required).toEqual(["workflowId"]);
    expect(tool("get_workflow_run").inputSchema.required).toEqual(["workflowId", "runId"]);
    expect(tool("plan_workflow").inputSchema.required).toEqual([]);
    expect(tool("validate_workflow").inputSchema.required).toEqual([]);
    expect(tool("create_workflow").inputSchema.required).toEqual([]);
    expect(tool("update_workflow").inputSchema.required).toEqual(["workflowId"]);
    expect(tool("retire_workflow").inputSchema.required).toEqual(["workflowId"]);
    expect(tool("start_workflow_run").inputSchema.required).toEqual(["workflowId"]);
    expect(tool("run_workflow_by_name").inputSchema.required).toEqual(["name"]);
    expect(tool("create_trigger").inputSchema.required).toEqual(["kind", "name", "event", "targetWorkflowId"]);
    expect(tool("delete_trigger").inputSchema.required).toEqual(["name"]);
  });

  it("declares structured optional run input and an optional bounded idempotency key", () => {
    const schema = tool("start_workflow_run").inputSchema as {
      properties: Record<string, { type?: string; maxLength?: number }>;
    };
    expect(schema.properties.input).toMatchObject({ type: "object" });
    expect(schema.properties.idempotencyKey).toMatchObject({ type: "string", maxLength: 256 });
    const byNameSchema = tool("run_workflow_by_name").inputSchema as {
      properties: Record<string, { type?: string; maxLength?: number }>;
    };
    expect(byNameSchema.properties.input).toMatchObject({ type: "object" });
    expect(byNameSchema.properties.idempotencyKey).toMatchObject({ type: "string", maxLength: 256 });
  });
});

describe("workflow tools — unit (stub gateway)", () => {
  it("list_workflows GETs the definitions route and passes summaries through", async () => {
    const { calls, ctx } = stub(() => ({
      status: 200,
      body: { definitions: [{ id: "wf-a", title: "A", version: 2, status: "active" }], evidenceConfigured: true },
    }));
    const out = (await tool("list_workflows").handler({}, ctx)) as Record<string, unknown>;
    expect(calls[0]).toMatchObject({ url: "http://127.0.0.1:7777/api/workflow-definitions", method: "GET" });
    expect((out.definitions as unknown[]).length).toBe(1);
    expect(out.hint).toBeUndefined(); // configured gateway → no warning hint
  });

  it("list_workflows surfaces the misconfigured-evidence-root state as a hint", async () => {
    const { ctx } = stub(() => ({ status: 200, body: { definitions: [], evidenceConfigured: false } }));
    const out = (await tool("list_workflows").handler({}, ctx)) as Record<string, unknown>;
    expect(String(out.hint)).toMatch(/misconfigured/i);
  });

  it("list_workflows includes the server-provided reason in the hint when present", async () => {
    const { ctx } = stub(() => ({
      status: 200,
      body: { definitions: [], evidenceConfigured: false, evidenceReason: 'JINN_WORKFLOW_EVIDENCE_ROOT is set to "/nope" but no such directory exists.' },
    }));
    const out = (await tool("list_workflows").handler({}, ctx)) as Record<string, unknown>;
    expect(String(out.hint)).toMatch(/no such directory exists/i);
  });

  it("list_workflow_runs GETs the runs route for the encoded id", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: { runs: [], evidenceConfigured: true } }));
    await tool("list_workflow_runs").handler({ workflowId: "my wf" }, ctx);
    expect(calls[0].url).toBe("http://127.0.0.1:7777/api/workflow-definitions/my%20wf/runs");
  });

  it("get_workflow_run wraps the VERBATIM record as {run, hint} — steps[] order untouched", async () => {
    // Loop-shaped receipts deliberately NOT in any sortable order: array order is
    // execution order (rounds spliced in place) and must survive the tool byte-for-byte.
    const record = {
      runId: "r1",
      status: "running",
      steps: [
        { nodeId: "z", round: undefined, status: "done" },
        { nodeId: "a", status: "done" },
        { nodeId: "z", round: 2, status: "running" },
        { nodeId: "a", round: 2, status: "pending" },
      ],
    };
    const { calls, ctx } = stub(() => ({ status: 200, body: record }));
    const out = (await tool("get_workflow_run").handler({ workflowId: "wf", runId: "r1" }, ctx)) as {
      run: { steps: Array<{ nodeId: string; round?: number }> };
      hint: string;
    };
    expect(calls[0].url).toBe("http://127.0.0.1:7777/api/workflow-definitions/wf/runs/r1");
    expect(out.run.steps.map((s) => `${s.nodeId}@${s.round ?? 1}`)).toEqual(["z@1", "a@1", "z@2", "a@2"]);
    expect(out.hint).toMatch(/in flight/i);
    expect(out.hint.length).toBeLessThanOrEqual(80);
  });

  it("a PARKED run's hint says a HUMAN decides — it never offers the agent a resolve tool", async () => {
    const { ctx } = stub(() => ({
      status: 200,
      body: { runId: "r2", status: "parked", parked: { scope: "gateNode", nodeId: "g", description: "operator sign-off" }, steps: [] },
    }));
    const out = (await tool("get_workflow_run").handler({ workflowId: "wf", runId: "r2" }, ctx)) as { hint: string };
    expect(out.hint).toMatch(/HUMAN decision/i);
    expect(out.hint).toContain("operator sign-off");
    expect(out.hint.length).toBeLessThanOrEqual(100);
    expect(out.hint).not.toContain("jinn_resolve_workflow_gate");
  });

  it("create_workflow POSTs the definition and auto-places nodes that omit position", async () => {
    const { calls, ctx } = stub(() => ({ status: 201, body: { id: "wf-new", version: 1 } }));
    await tool("create_workflow").handler(
      {
        definition: {
          id: "wf-new",
          title: "New",
          nodes: [
            { id: "t", type: "trigger", label: "Manual", trigger: { kind: "manual" } },
            { id: "s", type: "step", label: "Work", position: { x: 7, y: 7 } },
          ],
          edges: [{ id: "e", from: "t", to: "s", kind: "sequence" }],
        },
      },
      ctx,
    );
    expect(calls[0]).toMatchObject({ url: "http://127.0.0.1:7777/api/workflow-definitions", method: "POST" });
    const sent = calls[0].body as { nodes: Array<{ id: string; position: { x: number; y: number } }> };
    expect(sent.nodes[0].position).toEqual({ x: 0, y: 0 }); // auto-placed
    expect(sent.nodes[1].position).toEqual({ x: 7, y: 7 }); // explicit position kept
  });

  it("plan_workflow compiles an SOP wake-up and ordered steps into a valid graph without saving", async () => {
    const { calls, ctx } = stub((call) => {
      if (call.url.endsWith("/api/workflow-definitions/plan")) {
        return { status: 200, body: planWorkflowAuthoringInput(call.body as Record<string, unknown>) };
      }
      return { status: 500, body: { error: "unexpected route" } };
    });
    const out = (await tool("plan_workflow").handler(
      {
        sop: {
          id: "daily-brief",
          name: "daily-research-brief",
          title: "Daily brief",
          wakeUp: { kind: "schedule", cron: "0 9 * * *", timezone: "Europe/Sofia" },
          steps: [
            { id: "research", employee: "analyst", role: "research", instruction: "Collect the signals." },
            { id: "summarize", engine: "codex", role: "writer", instruction: "Write the summary." },
          ],
        },
      },
      ctx,
    )) as {
      ok: boolean;
      definition: { id: string; nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };
      validation: { ok: boolean };
      execution: { ok: boolean };
    };

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "http://127.0.0.1:7777/api/workflow-definitions/plan", method: "POST" });
    expect(calls[0].body).toMatchObject({ sop: { id: "daily-brief" } });
    expect(out.ok).toBe(true);
    expect(out.validation.ok).toBe(true);
    expect(out.execution.ok).toBe(true);
    expect(out.definition.id).toBe("daily-brief");
    expect((out.definition as { name?: string }).name).toBe("daily-research-brief");
    expect(out.definition.nodes.map((n) => n.id)).toEqual(["wake", "research", "summarize"]);
    expect(out.definition.nodes[0]).toMatchObject({ type: "trigger", trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "Europe/Sofia" } });
    expect(out.definition.nodes[1]).toMatchObject({ type: "step", actor: { kind: "employee", ref: "analyst" }, instructions: "Collect the signals." });
    expect(out.definition.nodes[2]).toMatchObject({ type: "step", actor: { kind: "engine", ref: "codex" }, instructions: "Write the summary." });
    expect(out.definition.edges.map((e) => [e.from, e.to])).toEqual([["wake", "research"], ["research", "summarize"]]);
  });

  it("plan_workflow and validate_workflow require a bound caller identity", async () => {
    const { calls, ctx } = stub(() => ({ status: 500, body: { error: "should not call gateway" } }));
    const unbound = { ...ctx, callerSessionId: undefined, sessionCapability: undefined };
    const sop = {
      id: "private-plan",
      title: "Private plan",
      wakeUp: { kind: "manual" },
      steps: [{ engine: "codex", instruction: "Plan privately." }],
    };

    await expect(tool("plan_workflow").handler({ sop }, unbound)).rejects.toThrow(/caller identity unavailable/i);
    await expect(tool("validate_workflow").handler({ sop }, unbound)).rejects.toThrow(/caller identity unavailable/i);
    expect(calls).toHaveLength(0);
  });

  it("plan_workflow compiles event and poll wake-ups to raw graph plus trigger binding plans", async () => {
    const { calls, ctx } = stub((call) => {
      if (call.url.endsWith("/api/workflow-definitions/plan")) {
        return { status: 200, body: planWorkflowAuthoringInput(call.body as Record<string, unknown>) };
      }
      return { status: 500, body: { error: "unexpected route" } };
    });
    const webhook = (await tool("plan_workflow").handler(
      {
        sop: {
          id: "lead-sop",
          title: "Lead SOP",
          wakeUp: { kind: "event", name: "lead-hook", event: "lead.created", filter: [{ path: "payload.kind", op: "equals", value: "trial" }] },
          steps: [{ employee: "sales", instruction: "Qualify the lead." }],
        },
      },
      ctx,
    )) as { triggerBindingPlan: Record<string, unknown>; definition: { nodes: Array<Record<string, unknown>> } };
    expect(calls).toHaveLength(1);
    expect(webhook.definition.nodes[0]).toMatchObject({ trigger: { kind: "manual" } });
    expect(webhook.triggerBindingPlan).toMatchObject({
      kind: "webhook",
      name: "lead-hook",
      event: "lead.created",
      targetWorkflowId: "lead-sop",
      filter: [{ path: "payload.kind", op: "equals", value: "trial" }],
    });

    const poll = (await tool("plan_workflow").handler(
      {
        sop: {
          id: "check-sop",
          title: "Check SOP",
          wakeUp: { kind: "poll", name: "check-feed", event: "feed.changed", command: "node scripts/check.js", intervalSeconds: 300 },
          steps: [{ engine: "codex", instruction: "Handle changed feed items." }],
        },
      },
      ctx,
    )) as { triggerBindingPlan: Record<string, unknown> };
    expect(poll.triggerBindingPlan).toMatchObject({
      kind: "poll",
      name: "check-feed",
      event: "feed.changed",
      targetWorkflowId: "check-sop",
      command: "node scripts/check.js",
      intervalSeconds: 300,
    });
    expect(calls).toHaveLength(2);
  });

  it("create_workflow accepts SOP input, saves the compiled graph, and binds custom wake-ups through gateway routes", async () => {
    const { calls, ctx } = stub((call) => {
      if (call.url.endsWith("/api/workflow-definitions")) return { status: 201, body: { id: "lead-sop", version: 1 } };
      if (call.url.endsWith("/api/workflow-triggers")) return { status: 201, body: { trigger: { name: "lead-hook", kind: "webhook" } } };
      return { status: 500, body: { error: "unexpected route" } };
    });
    const out = (await tool("create_workflow").handler(
      {
        sop: {
          id: "lead-sop",
          title: "Lead SOP",
          wakeUp: { kind: "event", name: "lead-hook", event: "lead.created" },
          steps: [{ employee: "sales", instruction: "Qualify the lead." }],
        },
      },
      ctx,
    )) as { definition: Record<string, unknown>; trigger?: Record<string, unknown>; hint: string };

    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["POST", "http://127.0.0.1:7777/api/workflow-definitions"],
      ["POST", "http://127.0.0.1:7777/api/workflow-triggers"],
    ]);
    expect((calls[0].body as { nodes: Array<Record<string, unknown>> }).nodes[0]).toMatchObject({ type: "trigger", trigger: { kind: "manual" } });
    expect(calls[1].body).toMatchObject({ kind: "webhook", name: "lead-hook", event: "lead.created", targetWorkflowId: "lead-sop" });
    expect(out.trigger).toMatchObject({ name: "lead-hook", kind: "webhook" });
    expect(out.hint).toContain("SOP");
  });

  it("retire_workflow POSTs the retire route and requires caller identity", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: { id: "wf", status: "retired", version: 2 } }));
    const unbound = { ...ctx, callerSessionId: undefined, sessionCapability: undefined };
    await expect(tool("retire_workflow").handler({ workflowId: "wf" }, unbound)).rejects.toThrow(/caller identity unavailable/i);
    const out = (await tool("retire_workflow").handler({ workflowId: "wf" }, ctx)) as { definition: { status: string }; hint: string };
    expect(calls[0]).toMatchObject({ url: "http://127.0.0.1:7777/api/workflow-definitions/wf/retire", method: "POST", body: {} });
    expect(out.definition.status).toBe("retired");
    expect(out.hint).toMatch(/retired/i);
  });

  it("create_workflow's success hint points at canonical run-by-name invocation", async () => {
    const { ctx } = stub(() => ({ status: 201, body: { id: "wf-new", name: "new-workflow", version: 1 } }));
    const out = (await tool("create_workflow").handler(
      { definition: { id: "wf-new", title: "New", nodes: [], edges: [] } },
      ctx,
    )) as { hint: string };
    expect(out.hint).toContain('run_workflow_by_name { name: "new-workflow" }');
  });

  it("create_workflow passes the validator's STRUCTURED errors through for self-correction", async () => {
    const { ctx } = stub(() => ({
      status: 400,
      body: {
        error: "definition failed validation",
        errors: [
          { code: "missing-trigger", message: "workflow needs exactly one trigger node" },
          { code: "dangling-edge", message: 'edge "e1" points at unknown node "ghost"', ref: "e1" },
        ],
      },
    }));
    await expect(
      tool("create_workflow").handler({ definition: { id: "bad", title: "Bad", nodes: [], edges: [] } }, ctx),
    ).rejects.toThrow(/retry[\s\S]*missing-trigger[\s\S]*dangling-edge/i);
  });

  it("write tools surface the 503 evidence-root refusal as the intended live-gateway safety", async () => {
    const { ctx } = stub(() => ({ status: 503, body: { error: "Workflow evidence root is not configured" } }));
    await expect(
      tool("create_workflow").handler({ definition: { id: "x", title: "X", nodes: [], edges: [] } }, ctx),
    ).rejects.toThrow(/evidence root.*intended safety.*JINN_WORKFLOW_EVIDENCE_ROOT/is);
    await expect(tool("start_workflow_run").handler({ workflowId: "x" }, ctx)).rejects.toThrow(/intended safety/i);
  });

  it("workflow write and run tools fail closed locally when MCP caller identity is missing", async () => {
    const { calls, ctx } = stub(() => ({ status: 201, body: { id: "wf" } }));
    const unbound = { ...ctx, callerSessionId: undefined, sessionCapability: undefined };

    await expect(
      tool("create_workflow").handler({ definition: { id: "wf", title: "WF", nodes: [], edges: [] } }, unbound),
    ).rejects.toThrow(/caller identity unavailable/i);
    await expect(tool("update_workflow").handler({ workflowId: "wf", patch: { title: "T" } }, unbound)).rejects.toThrow(
      /caller identity unavailable/i,
    );
    await expect(tool("start_workflow_run").handler({ workflowId: "wf" }, unbound)).rejects.toThrow(/caller identity unavailable/i);
    expect(calls).toHaveLength(0);
  });

  it("update_workflow PUTs {patch + expectedVersion} and maps a stale version to a readable 409", async () => {
    const { calls, ctx } = stub((call) =>
      call.method === "PUT"
        ? { status: 409, body: { error: "version conflict: expected 1, on disk 3" } }
        : { status: 200, body: {} },
    );
    await expect(
      tool("update_workflow").handler({ workflowId: "wf", patch: { title: "T2" }, expectedVersion: 1 }, ctx),
    ).rejects.toThrow(/conflicted \(409\).*expected 1, on disk 3/is);
    expect(calls[0]).toMatchObject({
      url: "http://127.0.0.1:7777/api/workflow-definitions/wf",
      method: "PUT",
      body: { title: "T2", expectedVersion: 1 },
    });
  });

  it("update_workflow omits expectedVersion from the body when not given", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: { id: "wf", version: 4 } }));
    const out = (await tool("update_workflow").handler({ workflowId: "wf", patch: { title: "T3" } }, ctx)) as { hint: string };
    expect(calls[0].body).toEqual({ title: "T3" });
    expect(out.hint).toContain("version 4");
  });

  it("start_workflow_run POSTs the run route and hints by run status", async () => {
    const { calls, ctx } = stub(() => ({
      status: 201,
      body: { runId: "run-1", status: "running", steps: [{ nodeId: "a", status: "running" }] },
    }));
    const out = (await tool("start_workflow_run").handler({ workflowId: "wf" }, ctx)) as { run: { runId: string }; hint: string };
    expect(calls[0]).toMatchObject({ url: "http://127.0.0.1:7777/api/workflow-definitions/wf/run", method: "POST" });
    expect(calls[0].body).toEqual({});
    expect(out.run.runId).toBe("run-1");
    expect(out.hint).toContain("run-1");
    expect(out.hint).toMatch(/get_workflow_run/);
  });

  it("start_workflow_run forwards structured input and idempotencyKey verbatim", async () => {
    const { calls, ctx } = stub(() => ({
      status: 201,
      body: { runId: "run-input", status: "completed", steps: [] },
    }));
    await tool("start_workflow_run").handler({
      workflowId: "wf",
      input: { ticket: { id: "ABC-42" }, priority: 2 },
      idempotencyKey: "request-42",
    }, ctx);
    expect(calls[0].body).toEqual({
      input: { ticket: { id: "ABC-42" }, priority: 2 },
      idempotencyKey: "request-42",
    });
  });

  it("run_workflow_by_name invokes the canonical-name route with input and idempotency", async () => {
    const { calls, ctx } = stub(() => ({
      status: 201,
      body: { runId: "run-by-name", workflowId: "record-42", status: "completed", steps: [] },
    }));
    const out = (await tool("run_workflow_by_name").handler({
      name: "full-cycle-workflow",
      input: { request: "implement this" },
      idempotencyKey: "request-42",
    }, ctx)) as { run: { runId: string }; hint: string };
    expect(calls[0]).toMatchObject({
      url: "http://127.0.0.1:7777/api/workflow-runs/by-name",
      method: "POST",
      body: {
        name: "full-cycle-workflow",
        input: { request: "implement this" },
        idempotencyKey: "request-42",
      },
    });
    expect(out.run.runId).toBe("run-by-name");
  });

  it("run_workflow_by_name surfaces an unknown canonical name clearly", async () => {
    const { ctx } = stub(() => ({ status: 404, body: { error: 'workflow name "missing-workflow" not found' } }));
    await expect(tool("run_workflow_by_name").handler({ name: "missing-workflow" }, ctx))
      .rejects.toThrow(/missing-workflow.*not found/i);
  });

  it("start_workflow_run surfaces a 422 failed-at-start run's structured errors", async () => {
    const { ctx } = stub(() => ({
      status: 422,
      body: { runId: "run-2", status: "failed", steps: [], errors: [{ code: "unsupported-cycle", message: "workflow edges form a cycle" }] },
    }));
    await expect(tool("start_workflow_run").handler({ workflowId: "wf" }, ctx)).rejects.toThrow(
      /refused to start \(422\)[\s\S]*unsupported-cycle/,
    );
  });

  it("trigger tools wrap list/create/delete routes and require identity for writes", async () => {
    const { calls, ctx } = stub((call) => {
      if (call.method === "GET") return { status: 200, body: { triggers: [{ name: "lead-hook", kind: "webhook" }] } };
      if (call.method === "POST") return { status: 201, body: { trigger: { name: "lead-hook", kind: "webhook" } } };
      if (call.method === "DELETE") return { status: 200, body: { deleted: true, name: "lead-hook" } };
      return { status: 500, body: {} };
    });

    await tool("list_triggers").handler({}, ctx);
    expect(calls[0]).toMatchObject({ url: "http://127.0.0.1:7777/api/workflow-triggers", method: "GET" });

    const unbound = { ...ctx, callerSessionId: undefined, sessionCapability: undefined };
    await expect(tool("create_trigger").handler({
      kind: "webhook",
      name: "lead-hook",
      event: "lead.created",
      targetWorkflowId: "lead-wf",
    }, unbound)).rejects.toThrow(/caller identity unavailable/i);

    const authedCtx = { ...ctx, callerSessionId: "sess-1", sessionCapability: "cap-1" };
    await tool("create_trigger").handler({
      kind: "webhook",
      name: "lead-hook",
      event: "lead.created",
      targetWorkflowId: "lead-wf",
      filter: [{ path: "payload.kind", op: "equals", value: "trial" }],
      secretToken: "binding-secret",
    }, authedCtx);
    expect(calls[1]).toMatchObject({
      url: "http://127.0.0.1:7777/api/workflow-triggers",
      method: "POST",
      body: {
        kind: "webhook",
        name: "lead-hook",
        event: "lead.created",
        targetWorkflowId: "lead-wf",
        filter: [{ path: "payload.kind", op: "equals", value: "trial" }],
        secretToken: "binding-secret",
      },
    });

    await tool("delete_trigger").handler({ name: "lead-hook" }, authedCtx);
    expect(calls[2]).toMatchObject({ url: "http://127.0.0.1:7777/api/workflow-triggers/lead-hook", method: "DELETE" });
  });

  it("a gateway 413 maps to a structured too-large error the agent can act on", async () => {
    const { ctx } = stub(() => ({ status: 413, body: { error: "Payload too large" } }));
    await expect(
      tool("create_workflow").handler({ definition: { id: "big", title: "Big", nodes: [], edges: [] } }, ctx),
    ).rejects.toThrow(/413.*size cap.*shrink/is);
  });

  it("missing required args fail fast with the arg name (no gateway call)", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: {} }));
    await expect(tool("get_workflow_run").handler({ workflowId: "wf" }, ctx)).rejects.toThrow(/runId is required/);
    await expect(tool("create_workflow").handler({}, ctx)).rejects.toThrow(/sop or definition is required/);
    await expect(tool("update_workflow").handler({ workflowId: "wf" }, ctx)).rejects.toThrow(/sop or patch is required/);
    expect(calls).toHaveLength(0);
  });
});

/* ── Integration: the tools drive the REAL gateway routes ───────────────────── */

type Api = typeof import("../../gateway/api.js");
let api: Api;
let cooHeaders: Record<string, string>;
let cooMcpIdentity: Pick<JinnMcpContext, "callerSessionId" | "sessionCapability">;

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
    get text() {
      return Buffer.concat(chunks).toString("utf-8");
    },
  };
}

const apiCtx = {
  getConfig: () => ({ gateway: {}, engines: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  // /run resolves the engine roster; the fixtures below are actorless (inline
  // steps), so nothing ever spawns and the empty roster is honest.
  sessionManager: { getEngines: () => new Map(), getEngine: () => undefined },
} as unknown as import("../../gateway/api.js").ApiContext;

/** A fetch that dispatches into handleApiRequest — the tools exercise the real
 *  routes + stores with no HTTP server and nothing live. */
function apiFetch(): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const body = typeof init?.body === "string" ? [Buffer.from(init.body)] : [];
    const incomingHeaders = new Headers(init?.headers);
    const req = Object.assign(Readable.from(body), {
      method: init?.method ?? "GET",
      url: url.pathname + url.search,
      headers: { host: url.host, ...Object.fromEntries(incomingHeaders.entries()) },
    });
    const cap = makeRes();
    await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, apiCtx);
    return { status: cap.status, text: async () => cap.text } as unknown as Response;
  }) as unknown as typeof fetch;
}

beforeAll(async () => {
  api = await import("../../gateway/api.js");
  const registry = await import("../../sessions/registry.js");
  const identity = await import("../identity.js");
  registry.initDb();
  const cooSession = registry.createSession({ engine: "codex", source: "web", sourceRef: "coo", title: "coo", employee: "coo" });
  const cooCapability = identity.ensureSessionCapability(cooSession.id);
  cooMcpIdentity = { callerSessionId: cooSession.id, sessionCapability: cooCapability };
  cooHeaders = {
    [identity.TOOL_CALL_HEADER]: identity.TOOL_CALL_HEADER_VALUE,
    [identity.CALLER_SESSION_HEADER]: cooSession.id,
    [identity.CALLER_SESSION_CAPABILITY_HEADER]: cooCapability,
  };
});

beforeEach(() => {
  fs.mkdirSync(path.join(evidenceRoot, "workflows"), { recursive: true });
});
afterEach(() => {
  fs.rmSync(path.join(evidenceRoot, "workflows"), { recursive: true, force: true });
  fs.rmSync(path.join(evidenceRoot, "workflow-triggers"), { recursive: true, force: true });
});

describe("workflow tools — integration against the real routes/stores", () => {
  it("an agent's whole loop: invalid create → structured errors → corrected create → start → park → inspect; the COO resolves over HTTP; the agent reads completed", async () => {
    const ctx: JinnMcpContext = { gatewayUrl: "http://gateway.test", fetchFn: apiFetch(), ...cooMcpIdentity };
    const tools = buildTools();
    const call = async (name: string, args: Record<string, unknown>) => {
      const resp = await handleMcpRequest({ id: 1, method: "tools/call", params: { name, arguments: args } }, tools, ctx);
      const result = resp!.result as { content: Array<{ text: string }>; isError?: boolean };
      return { isError: result.isError === true, text: result.content[0].text };
    };

    // 1. Invalid definition (no trigger) → the validator's structured errors reach the agent.
    const bad = await call("create_workflow", {
      definition: {
        id: "mcp-demo",
        title: "MCP Demo",
        nodes: [{ id: "a", type: "step", label: "Implement", instructions: "do the work" }],
        edges: [],
      },
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("missing-trigger");

    // 2. Corrected definition: trigger → a → gate(approval) → b. Inline steps (no
    //    actor) so the engine settles them without spawning sessions; positions omitted
    //    on purpose — the tool auto-places them.
    const good = await call("create_workflow", {
      definition: {
        id: "mcp-demo",
        title: "MCP Demo",
        nodes: [
          { id: "trg", type: "trigger", label: "Manual", trigger: { kind: "manual" } },
          { id: "a", type: "step", label: "Implement", instructions: "do the work" },
          { id: "g", type: "gate", label: "Operator", gate: { kind: "approval", approvalRef: "op-ok", description: "operator sign-off" } },
          { id: "b", type: "step", label: "Follow-up", instructions: "finish up" },
        ],
        edges: [
          { id: "e1", from: "trg", to: "a", kind: "sequence" },
          { id: "e2", from: "a", to: "g", kind: "sequence" },
          { id: "e3", from: "g", to: "b", kind: "sequence" },
        ],
      },
    });
    expect(good.isError).toBe(false);
    const created = JSON.parse(good.text) as { definition: { id: string; version: number; nodes: Array<{ position: unknown }> } };
    expect(created.definition.version).toBe(1);
    expect(created.definition.nodes.every((n) => n.position !== undefined)).toBe(true);

    // 3. Discoverable through the list tool.
    const listed = await call("list_workflows", {});
    expect(JSON.parse(listed.text).definitions.map((d: { id: string }) => d.id)).toContain("mcp-demo");

    // 4. Start a run: step a settles inline, the run PARKS on the approval gate.
    const started = await call("start_workflow_run", { workflowId: "mcp-demo" });
    expect(started.isError).toBe(false);
    const startedRun = JSON.parse(started.text) as { run: { runId: string; status: string }; hint: string };
    expect(startedRun.run.status).toBe("parked");
    expect(startedRun.hint).toMatch(/HUMAN decision/i);
    expect(startedRun.hint).not.toContain("jinn_resolve_workflow_gate");

    // 5. Inspect the run: receipts verbatim, execution order, downstream honestly pending.
    const inspected = await call("get_workflow_run", { workflowId: "mcp-demo", runId: startedRun.run.runId });
    const view = JSON.parse(inspected.text) as { run: { steps: Array<{ nodeId: string; status: string }> } };
    expect(view.run.steps.map((s) => [s.nodeId, s.status])).toEqual([
      ["a", "inline"],
      ["g", "pending"],
      ["b", "pending"],
    ]);

    // 6. The agent CANNOT resolve the gate — the tool does not exist on its belt.
    const denied = await call("jinn_resolve_workflow_gate", {
      workflowId: "mcp-demo",
      runId: startedRun.run.runId,
      decision: "approve",
    });
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/unknown tool/i);

    // 7. The COO resolves over HTTP (web doorbell / curl — the division of
    //    authority: agents build and observe, routed managers/COO approve).
    const doFetch = apiFetch();
    const resolved = await doFetch(
      `http://gateway.test/api/workflow-definitions/mcp-demo/runs/${startedRun.run.runId}/resolve-gate`,
      { method: "POST", headers: { "content-type": "application/json", ...cooHeaders }, body: JSON.stringify({ decision: "approve" }) },
    );
    expect(resolved.status).toBe(200);

    // 8. The agent reads the outcome through its read tool: completed, receipts honest.
    const after = await call("get_workflow_run", { workflowId: "mcp-demo", runId: startedRun.run.runId });
    const finalView = JSON.parse(after.text) as { run: { status: string; steps: Array<{ nodeId: string; status: string }> } };
    expect(finalView.run.status).toBe("completed");
    expect(finalView.run.steps.map((s) => [s.nodeId, s.status])).toEqual([
      ["a", "inline"],
      ["g", "checkpoint"],
      ["b", "inline"],
    ]);
  });

  it("an oversized definition over REAL HTTP fails as a structured 413, never a bare 'fetch failed' (Codex GRS-015 finding 2)", async () => {
    // The fake req/res adapter cannot reproduce the socket-destroy bug — this test
    // goes through a real HTTP server + real fetch, the same stack the live MCP
    // server uses.
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      void api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], res, apiCtx);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const ctx: JinnMcpContext = { gatewayUrl: `http://127.0.0.1:${port}`, ...cooMcpIdentity };
      const oversized = {
        id: "big-wf",
        title: "Big",
        nodes: [
          { id: "trg", type: "trigger", label: "Manual", trigger: { kind: "manual" } },
          { id: "a", type: "step", label: "Work", instructions: "x".repeat(600 * 1024) }, // > the 512 KiB route cap
        ],
        edges: [{ id: "e1", from: "trg", to: "a", kind: "sequence" }],
      };
      await expect(tool("create_workflow").handler({ definition: oversized }, ctx)).rejects.toThrow(
        /413[\s\S]*size cap[\s\S]*shrink/i,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("update_workflow round-trips the editable shape: get → patch with expectedVersion → version bump", async () => {
    const ctx: JinnMcpContext = { gatewayUrl: "http://gateway.test", fetchFn: apiFetch(), ...cooMcpIdentity };
    const create = tool("create_workflow");
    await create.handler(
      {
        definition: {
          id: "mcp-edit",
          title: "Before",
          nodes: [
            { id: "trg", type: "trigger", label: "Manual", trigger: { kind: "manual" } },
            { id: "a", type: "step", label: "Work" },
          ],
          edges: [{ id: "e1", from: "trg", to: "a", kind: "sequence" }],
        },
      },
      ctx,
    );
    const got = (await tool("get_workflow").handler({ workflowId: "mcp-edit" }, ctx)) as { title: string; version: number };
    expect(got).toMatchObject({ title: "Before", version: 1 });

    const updated = (await tool("update_workflow").handler(
      { workflowId: "mcp-edit", patch: { title: "After" }, expectedVersion: got.version },
      ctx,
    )) as { definition: { title: string; version: number } };
    expect(updated.definition).toMatchObject({ title: "After", version: 2 });

    // A stale expectedVersion is refused (optimistic lock through the tool).
    await expect(
      tool("update_workflow").handler({ workflowId: "mcp-edit", patch: { title: "Stale" }, expectedVersion: 1 }, ctx),
    ).rejects.toThrow(/409/);
  });

  it("SOP create through MCP round-trips to a persisted valid graph and dry-run plan", async () => {
    const ctx: JinnMcpContext = { gatewayUrl: "http://gateway.test", fetchFn: apiFetch(), ...cooMcpIdentity };
    const created = (await tool("create_workflow").handler(
      {
        sop: {
          id: "mcp-sop",
          title: "MCP SOP",
          wakeUp: { kind: "manual" },
          steps: [
            { id: "draft", role: "writer", instruction: "Draft the response." },
            { id: "review", role: "reviewer", instruction: "Review the response." },
          ],
        },
      },
      ctx,
    )) as { definition: { id: string; version: number } };
    expect(created.definition).toMatchObject({ id: "mcp-sop", version: 1 });

    const got = (await tool("get_workflow").handler({ workflowId: "mcp-sop" }, ctx)) as {
      nodes: Array<{ id: string; type: string; instructions?: string }>;
      edges: Array<{ from: string; to: string }>;
    };
    expect(got.nodes.map((n) => [n.id, n.type, n.instructions ?? null])).toEqual([
      ["wake", "trigger", null],
      ["draft", "step", "Draft the response."],
      ["review", "step", "Review the response."],
    ]);
    expect(got.edges.map((e) => [e.from, e.to])).toEqual([["wake", "draft"], ["draft", "review"]]);

    const planned = (await tool("plan_workflow").handler({ definition: got }, ctx)) as { ok: boolean; validation: { ok: boolean }; execution: { ok: boolean } };
    expect(planned).toMatchObject({ ok: true, validation: { ok: true }, execution: { ok: true } });
  });

  it("SOP update reconciles SOP-owned event trigger bindings without leaving orphans", async () => {
    const ctx: JinnMcpContext = { gatewayUrl: "http://gateway.test", fetchFn: apiFetch(), ...cooMcpIdentity };
    const baseStep = [{ id: "handle", engine: "codex", instruction: "Handle the event." }];

    await tool("create_workflow").handler(
      {
        sop: {
          id: "sop-trigger-reconcile",
          title: "Trigger reconcile",
          wakeUp: { kind: "event", name: "first-hook", event: "lead.created" },
          steps: baseStep,
        },
      },
      ctx,
    );
    let listed = (await tool("list_triggers").handler({}, ctx)) as { triggers: Array<{ name: string; event: string }> };
    expect(listed.triggers.map((t) => [t.name, t.event])).toEqual([["first-hook", "lead.created"]]);

    await tool("update_workflow").handler(
      {
        workflowId: "sop-trigger-reconcile",
        sop: {
          id: "sop-trigger-reconcile",
          title: "Trigger reconcile",
          wakeUp: { kind: "manual" },
          steps: baseStep,
        },
      },
      ctx,
    );
    listed = (await tool("list_triggers").handler({}, ctx)) as { triggers: Array<{ name: string; event: string }> };
    expect(listed.triggers.map((t) => t.name)).not.toContain("first-hook");
    expect(listed.triggers).toEqual([]);

    await tool("update_workflow").handler(
      {
        workflowId: "sop-trigger-reconcile",
        sop: {
          id: "sop-trigger-reconcile",
          title: "Trigger reconcile",
          wakeUp: { kind: "event", name: "second-hook", event: "lead.updated" },
          steps: baseStep,
        },
      },
      ctx,
    );
    listed = (await tool("list_triggers").handler({}, ctx)) as { triggers: Array<{ name: string; event: string }> };
    expect(listed.triggers.map((t) => [t.name, t.event])).toEqual([["second-hook", "lead.updated"]]);

    await tool("update_workflow").handler(
      {
        workflowId: "sop-trigger-reconcile",
        sop: {
          id: "sop-trigger-reconcile",
          title: "Trigger reconcile",
          wakeUp: { kind: "event", name: "third-hook", event: "lead.won" },
          steps: baseStep,
        },
      },
      ctx,
    );
    listed = (await tool("list_triggers").handler({}, ctx)) as { triggers: Array<{ name: string; event: string }> };
    expect(listed.triggers.map((t) => [t.name, t.event])).toEqual([["third-hook", "lead.won"]]);
  });

  it("SOP trigger reconcile is atomic when the replacement binding conflicts", async () => {
    const ctx: JinnMcpContext = { gatewayUrl: "http://gateway.test", fetchFn: apiFetch(), ...cooMcpIdentity };
    const baseStep = [{ id: "handle", engine: "codex", instruction: "Handle the event." }];

    await tool("create_workflow").handler(
      {
        sop: {
          id: "sop-conflict-owner",
          title: "Conflict owner",
          wakeUp: { kind: "event", name: "stable-hook", event: "lead.created" },
          steps: baseStep,
        },
      },
      ctx,
    );
    await tool("create_workflow").handler(
      {
        sop: {
          id: "sop-conflict-other",
          title: "Conflict other",
          wakeUp: { kind: "event", name: "taken-hook", event: "lead.updated" },
          steps: baseStep,
        },
      },
      ctx,
    );

    await expect(
      tool("update_workflow").handler(
        {
          workflowId: "sop-conflict-owner",
          sop: {
            id: "sop-conflict-owner",
            title: "Conflict owner",
            wakeUp: { kind: "event", name: "taken-hook", event: "lead.won" },
            steps: baseStep,
          },
        },
        ctx,
      ),
    ).rejects.toThrow(/409|conflict/i);

    const listed = (await tool("list_triggers").handler({}, ctx)) as {
      triggers: Array<{ name: string; event: string; sopOwnerWorkflowId?: string }>;
    };
    expect(listed.triggers.map((t) => [t.name, t.event, t.sopOwnerWorkflowId]).sort()).toEqual([
      ["stable-hook", "lead.created", "sop-conflict-owner"],
      ["taken-hook", "lead.updated", "sop-conflict-other"],
    ]);
  });
});
