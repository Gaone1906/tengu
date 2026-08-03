import {
  assertBoundCaller,
  gatewayGet,
  gatewayRequest,
  JinnMcpToolError,
  type JinnMcpContext,
  type JinnMcpTool,
} from "./toolkit.js";

const metricSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    unit: { type: "string" },
    howToMeasure: { type: "string" },
  },
  required: ["name", "howToMeasure"],
};

const metricsSchema = { type: "array", minItems: 1, items: metricSchema };
const baselineSchema = { type: "object", additionalProperties: { type: "number" } };

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new JinnMcpToolError(`${name} is required and must be a non-empty string`);
  return value.trim();
}

function experimentId(args: Record<string, unknown>): string {
  const id = requiredString(args, "id");
  if (!/^exp_[0-9a-f]{12}$/.test(id)) throw new JinnMcpToolError("id must be an experiment id returned by create_experiment or list_experiments");
  return id;
}

function failureDetail(body: unknown): string {
  if (!body || typeof body !== "object") return typeof body === "string" ? body : JSON.stringify(body);
  const error = (body as Record<string, unknown>).error;
  return typeof error === "string" ? error : JSON.stringify(body);
}

async function checkedRequest(
  ctx: JinnMcpContext,
  method: "GET" | "POST" | "PATCH",
  route: string,
  action: string,
  body?: unknown,
): Promise<unknown> {
  const response = method === "GET" ? await gatewayGet(ctx, route) : await gatewayRequest(ctx, method, route, body);
  if (response.status >= 400) {
    throw new JinnMcpToolError(`${action} ${response.status === 409 ? "conflict" : "failed"} (${response.status}): ${failureDetail(response.body)}`);
  }
  return response.body;
}

export function buildExperimentTools(): JinnMcpTool[] {
  return [
    {
      name: "create_experiment",
      description: "Create a tracked experiment, optionally with scheduled check-ins.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          hypothesis: { type: "string" },
          baseline: baselineSchema,
          metrics: metricsSchema,
          horizonDays: { type: "number" },
          checkIn: {
            type: "object",
            additionalProperties: false,
            properties: {
              schedule: { type: "string" },
              employee: { type: "string" },
              timezone: { type: "string" },
            },
            required: ["schedule"],
          },
        },
        required: ["name", "hypothesis", "baseline", "metrics", "horizonDays"],
      },
      handler: async (args, ctx) => {
        assertBoundCaller(ctx);
        requiredString(args, "name");
        requiredString(args, "hypothesis");
        if (!args.baseline || typeof args.baseline !== "object" || Array.isArray(args.baseline)) throw new JinnMcpToolError("baseline must be an object");
        if (!Array.isArray(args.metrics) || args.metrics.length === 0) throw new JinnMcpToolError("metrics must contain at least one metric");
        if (typeof args.horizonDays !== "number") throw new JinnMcpToolError("horizonDays must be a number");
        return checkedRequest(ctx, "POST", "/api/experiments", "creating experiment", args);
      },
    },
    {
      name: "list_experiments",
      description: "List experiments, optionally by status.",
      inputSchema: {
        type: "object",
        properties: { status: { type: "string", enum: ["running", "concluded"] } },
        required: [],
      },
      handler: async (args, ctx) => {
        assertBoundCaller(ctx);
        const status = args.status;
        if (status !== undefined && status !== "running" && status !== "concluded") throw new JinnMcpToolError("status must be running or concluded");
        return checkedRequest(ctx, "GET", status ? `/api/experiments?status=${status}` : "/api/experiments", "listing experiments");
      },
    },
    {
      name: "get_experiment",
      description: "Get one experiment with metrics and readings.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      handler: async (args, ctx) => {
        assertBoundCaller(ctx);
        const id = experimentId(args);
        return checkedRequest(ctx, "GET", `/api/experiments/${encodeURIComponent(id)}`, "getting experiment");
      },
    },
    {
      name: "record_reading",
      description: "Append one metric reading to a running experiment.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          at: { type: "string" },
          metric: { type: "string" },
          value: { type: "number" },
          note: { type: "string" },
        },
        required: ["id", "at", "metric", "value"],
      },
      handler: async (args, ctx) => {
        assertBoundCaller(ctx);
        const id = experimentId(args);
        const body = { at: requiredString(args, "at"), metric: requiredString(args, "metric"), value: args.value, ...(typeof args.note === "string" ? { note: args.note } : {}) };
        if (typeof body.value !== "number" || !Number.isFinite(body.value)) throw new JinnMcpToolError("value must be a finite number");
        return checkedRequest(ctx, "POST", `/api/experiments/${encodeURIComponent(id)}/readings`, "recording reading", body);
      },
    },
    {
      name: "conclude_experiment",
      description: "Conclude an experiment with a verdict.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          outcome: { type: "string", enum: ["win", "loss", "inconclusive"] },
          note: { type: "string" },
        },
        required: ["id", "outcome", "note"],
      },
      handler: async (args, ctx) => {
        assertBoundCaller(ctx);
        const id = experimentId(args);
        const outcome = requiredString(args, "outcome");
        if (outcome !== "win" && outcome !== "loss" && outcome !== "inconclusive") throw new JinnMcpToolError("outcome must be win, loss, or inconclusive");
        return checkedRequest(ctx, "POST", `/api/experiments/${encodeURIComponent(id)}/conclude`, "concluding experiment", {
          outcome,
          note: requiredString(args, "note"),
        });
      },
    },
    {
      name: "update_experiment",
      description: "Edit a running experiment's definition.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          hypothesis: { type: "string" },
          metrics: metricsSchema,
          horizonDays: { type: "number" },
        },
        required: ["id"],
      },
      handler: async (args, ctx) => {
        assertBoundCaller(ctx);
        const id = experimentId(args);
        const body = Object.fromEntries(Object.entries(args).filter(([key]) => key !== "id"));
        if (Object.keys(body).length === 0) throw new JinnMcpToolError("at least one editable field is required");
        return checkedRequest(ctx, "PATCH", `/api/experiments/${encodeURIComponent(id)}`, "updating experiment", body);
      },
    },
  ];
}
