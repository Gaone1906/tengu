import { describe, expect, it } from "vitest";
import { buildTools } from "../server.js";
import type { JinnMcpContext, JinnMcpTool } from "../toolkit.js";

type ExperimentTools = typeof import("../experiment-tools.js");

interface SeenCall {
  method: string;
  path: string;
  body?: unknown;
}

function stub(): { calls: SeenCall[]; ctx: JinnMcpContext } {
  const calls: SeenCall[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    calls.push({
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
    });
    return { status: 200, text: async () => JSON.stringify({ experiment: { id: "exp_123456789abc" } }) } as Response;
  }) as typeof fetch;
  return {
    calls,
    ctx: {
      gatewayUrl: "http://gateway.test",
      fetchFn,
      callerSessionId: "session-test",
      sessionCapability: "cap-test",
    },
  };
}

describe("experiment MCP tools", () => {
  it("registers all six tools, including get_experiment, in the built toolkit", async () => {
    const { buildExperimentTools } = await import("../experiment-tools.js") as ExperimentTools;
    expect(buildExperimentTools().map((tool) => tool.name)).toEqual([
      "create_experiment",
      "list_experiments",
      "get_experiment",
      "record_reading",
      "conclude_experiment",
      "update_experiment",
    ]);
    expect(buildTools().map((tool) => tool.name)).toContain("get_experiment");
  });

  it("uses the experiment REST routes and methods", async () => {
    const { buildExperimentTools } = await import("../experiment-tools.js") as ExperimentTools;
    const tools = buildExperimentTools();
    const byName = (name: string): JinnMcpTool => {
      const found = tools.find((tool) => tool.name === name);
      if (!found) throw new Error(`missing tool ${name}`);
      return found;
    };
    const { calls, ctx } = stub();
    const metrics = [{ name: "activation", unit: "%", howToMeasure: "Read the dashboard." }];

    await byName("create_experiment").handler({
      name: "Clarity",
      hypothesis: "A smaller step improves activation.",
      baseline: { activation: 20 },
      metrics,
      horizonDays: 14,
      checkIn: { schedule: "0 9 * * 1" },
    }, ctx);
    await byName("list_experiments").handler({ status: "running" }, ctx);
    await byName("get_experiment").handler({ id: "exp_123456789abc" }, ctx);
    await byName("record_reading").handler({
      id: "exp_123456789abc",
      at: "2026-08-03T12:00:00.000Z",
      metric: "activation",
      value: 24,
      note: "Weekly check-in",
    }, ctx);
    await byName("conclude_experiment").handler({
      id: "exp_123456789abc",
      outcome: "win",
      note: "Activation improved.",
    }, ctx);
    await byName("update_experiment").handler({
      id: "exp_123456789abc",
      name: "Clarity follow-up",
      horizonDays: 21,
      metrics,
    }, ctx);

    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ["POST", "/api/experiments"],
      ["GET", "/api/experiments?status=running"],
      ["GET", "/api/experiments/exp_123456789abc"],
      ["POST", "/api/experiments/exp_123456789abc/readings"],
      ["POST", "/api/experiments/exp_123456789abc/conclude"],
      ["PATCH", "/api/experiments/exp_123456789abc"],
    ]);
    expect(calls[0].body).toMatchObject({ baseline: { activation: 20 }, metrics, horizonDays: 14 });
    expect(calls[3].body).toEqual({
      at: "2026-08-03T12:00:00.000Z",
      metric: "activation",
      value: 24,
      note: "Weekly check-in",
    });
  });
});
