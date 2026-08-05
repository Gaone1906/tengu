import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as workflow from "../workflow.js";

const originalFetch = globalThis.fetch;

const server = net.createServer();
let runtimePort = 0;
let priorConfig: string | null = null;
let priorGatewayInfo: string | null = null;

beforeAll(async () => {
  const home = process.env.JINN_HOME!;
  fs.mkdirSync(home, { recursive: true });
  const configPath = path.join(home, "config.yaml");
  const gatewayInfoPath = path.join(home, "gateway.json");
  priorConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf-8") : null;
  priorGatewayInfo = fs.existsSync(gatewayInfoPath) ? fs.readFileSync(gatewayInfoPath, "utf-8") : null;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      runtimePort = typeof address === "object" && address ? address.port : 0;
      resolve();
    });
  });
});

beforeEach(() => {
  const home = process.env.JINN_HOME!;
  fs.writeFileSync(
    path.join(home, "config.yaml"),
    `engines:\n  default: claude\n  claude: {}\ngateway:\n  host: 127.0.0.1\n  port: ${runtimePort}\n`,
  );
  fs.writeFileSync(path.join(home, "gateway.json"), JSON.stringify({
    port: runtimePort,
    host: "127.0.0.1",
    pid: process.pid,
    secret: "test",
    token: "test-token",
  }));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const home = process.env.JINN_HOME!;
  const configPath = path.join(home, "config.yaml");
  const gatewayInfoPath = path.join(home, "gateway.json");
  if (priorConfig === null) fs.rmSync(configPath, { force: true });
  else fs.writeFileSync(configPath, priorConfig);
  if (priorGatewayInfo === null) fs.rmSync(gatewayInfoPath, { force: true });
  else fs.writeFileSync(gatewayInfoPath, priorGatewayInfo);
});

afterEach(() => { globalThis.fetch = originalFetch; process.exitCode = undefined; vi.restoreAllMocks(); });

describe("Workflow v2 CLI handlers", () => {
  it("applies JINN_HOST/JINN_PORT over config while ignoring stale runtime routing", async () => {
    const home = process.env.JINN_HOME!;
    fs.writeFileSync(
      path.join(home, "config.yaml"),
      "engines:\n  default: claude\n  claude: {}\ngateway:\n  host: 127.0.0.1\n  port: 7777\n",
    );
    fs.writeFileSync(path.join(home, "gateway.json"), JSON.stringify({
      port: 65529,
      host: "127.0.0.1",
      pid: process.pid,
      secret: "stale",
      token: "stale-workflow-bearer",
    }));
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })) as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const previousHost = process.env.JINN_HOST;
    const previousPort = process.env.JINN_PORT;
    process.env.JINN_HOST = "::1";
    process.env.JINN_PORT = "8893";

    try {
      await workflow.listWorkflows();

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://[::1]:8893/api/workflows",
        expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer stale-workflow-bearer" }) }),
      );
    } finally {
      if (previousHost === undefined) delete process.env.JINN_HOST;
      else process.env.JINN_HOST = previousHost;
      if (previousPort === undefined) delete process.env.JINN_PORT;
      else process.env.JINN_PORT = previousPort;
    }
  });

  it("exports one lazy handler for every Task13 command", () => {
    const names = Object.keys(workflow);
    for (const name of [
      "listWorkflows", "getWorkflow", "createWorkflow", "updateWorkflow", "duplicateWorkflow",
      "retireWorkflow", "enableWorkflow", "disableWorkflow", "startWorkflowRun", "listWorkflowRuns",
      "showWorkflowRun", "cancelWorkflowRun", "rerunWorkflowRun", "fireWorkflowEvent",
      "approveWorkflowApproval", "rejectWorkflowApproval",
      "retryWorkflowNode",
    ]) expect(names).toContain(name);
  });

  it("projects every handler to the canonical REST method, route, and body", async () => {
    const definitionFile = path.join(process.env.JINN_HOME!, "definition.json");
    fs.writeFileSync(definitionFile, JSON.stringify({ id: "release-flow", title: "Release" }));
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET",
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const cases: Array<[() => Promise<void>, string, string, unknown?]> = [
      [() => workflow.listWorkflows({ cursor: "next", limit: "10" }), "GET", "/api/workflows?cursor=next&limit=10"],
      [() => workflow.getWorkflow("release-flow"), "GET", "/api/workflows/release-flow"],
      [() => workflow.createWorkflow({ file: definitionFile }), "POST", "/api/workflows", { id: "release-flow", title: "Release" }],
      [() => workflow.updateWorkflow("release-flow", { file: definitionFile, expectedRevision: "2" }), "PUT", "/api/workflows/release-flow",
        { definition: { id: "release-flow", title: "Release" }, expectedRevision: 2 }],
      [() => workflow.duplicateWorkflow("release-flow", { id: "copy-flow", title: "Copy" }), "POST", "/api/workflows/release-flow/duplicate", { id: "copy-flow", title: "Copy" }],
      [() => workflow.retireWorkflow("release-flow", { expectedRevision: "2" }), "POST", "/api/workflows/release-flow/retire", { expectedRevision: 2 }],
      [() => workflow.enableWorkflow("release-flow", { expectedRevision: "2" }), "POST", "/api/workflows/release-flow/enable", { expectedRevision: 2 }],
      [() => workflow.disableWorkflow("release-flow", { expectedRevision: "2" }), "POST", "/api/workflows/release-flow/disable", { expectedRevision: 2 }],
      [() => workflow.startWorkflowRun("release-flow", { input: "{\"topic\":\"release\"}", idempotencyKey: "start-1" }), "POST", "/api/workflows/release-flow/runs",
        { input: { topic: "release" }, idempotencyKey: "start-1" }],
      [() => workflow.startWorkflowRun("release-flow", { todoId: "JIN-42" }), "POST", "/api/workflows/release-flow/runs",
        { input: {}, todoId: "JIN-42" }],
      [() => workflow.listWorkflowRuns("release-flow", { status: "failed" }), "GET", "/api/workflows/release-flow/runs?status=failed"],
      [() => workflow.showWorkflowRun("release-flow", "run-1"), "GET", "/api/workflows/release-flow/runs/run-1"],
      [() => workflow.showWorkflowRun("release-flow", "run-1", { full: true }), "GET", "/api/workflows/release-flow/runs/run-1?view=full"],
      [() => workflow.cancelWorkflowRun("release-flow", "run-1", { reason: "stop" }), "POST", "/api/workflows/release-flow/runs/run-1/cancel", { reason: "stop" }],
      [() => workflow.rerunWorkflowRun("release-flow", "run-1", { definition: "current", idempotencyKey: "again-1" }), "POST",
        "/api/workflows/release-flow/runs/run-1/rerun", { definition: "current", idempotencyKey: "again-1" }],
      [() => workflow.approveWorkflowApproval("release-flow", "run-1", "review", { expectedRevision: "4", reason: "Reviewed" }), "POST",
        "/api/workflows/release-flow/runs/run-1/nodes/review/approval", { decision: "approve", expectedRevision: 4, reason: "Reviewed" }],
      [() => workflow.rejectWorkflowApproval("release-flow", "run-1", "review", { expectedRevision: "5" }), "POST",
        "/api/workflows/release-flow/runs/run-1/nodes/review/approval", { decision: "reject", expectedRevision: 5 }],
      [() => workflow.retryWorkflowNode("release-flow", "run-1", "write", { idempotencyKey: "retry-1" }), "POST",
        "/api/workflows/release-flow/runs/run-1/nodes/write/retry", { idempotencyKey: "retry-1" }],
      [() => workflow.fireWorkflowEvent("build.finished", { fireId: "build-1", payload: "{\"ok\":true}" }), "POST",
        "/api/workflows/events/build.finished", { fireId: "build-1", payload: { ok: true } }],
    ];
    for (const [invoke, method, route, body] of cases) {
      await invoke();
      expect(calls.at(-1)).toEqual({ url: `http://127.0.0.1:${runtimePort}${route}`, method, ...(body === undefined ? {} : { body }) });
    }
  });

  it("preserves REST error codes and messages", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ code: "revision-conflict", message: "Revision changed." }), { status: 409 })) as unknown as typeof fetch;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await workflow.enableWorkflow("release-flow", { expectedRevision: "1" });
    expect(console.error).toHaveBeenCalledWith("revision-conflict: Revision changed.");
    expect(process.exitCode).toBe(1);
  });

  it("surfaces canonical bad-input when file import uses the reserved Event identity", async () => {
    const definitionFile = path.join(process.env.JINN_HOME!, "reserved-definition.json");
    fs.writeFileSync(definitionFile, JSON.stringify({ id: "events", title: "Reserved" }));
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ code: "bad-input", message: "Workflow definition is invalid." }), { status: 422 })) as unknown as typeof fetch;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await workflow.createWorkflow({ file: definitionFile });

    expect(console.error).toHaveBeenCalledWith("bad-input: Workflow definition is invalid.");
    expect(process.exitCode).toBe(1);
  });

  it("prints which node or edge failed validation, and the whole envelope under --json", async () => {
    const body = { code: "invalid-definition", message: "Workflow definition is invalid.", issues: [
      { code: "multiple-incoming", message: "Node accepts only one incoming edge.", nodeId: "review" },
      { code: "undeclared-input", message: "Binding references an undeclared input.", path: "nodes.1.config.employee" },
    ] };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 422 })) as unknown as typeof fetch;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await workflow.enableWorkflow("release-flow", { expectedRevision: "1" });
    expect(console.error).toHaveBeenCalledWith(
      "invalid-definition: Workflow definition is invalid."
      + "\n- multiple-incoming (node review): Node accepts only one incoming edge."
      + "\n- undeclared-input (nodes.1.config.employee): Binding references an undeclared input.",
    );

    await workflow.enableWorkflow("release-flow", { expectedRevision: "1", json: true });
    expect(console.error).toHaveBeenLastCalledWith(JSON.stringify(body, null, 2));
    expect(process.exitCode).toBe(1);
  });
});
