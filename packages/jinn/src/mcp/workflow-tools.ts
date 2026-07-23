import {
  assertBoundCaller,
  gatewayRequest,
  JinnMcpToolError,
  type JinnMcpContext,
  type JinnMcpTool,
} from "./toolkit.js";

type Args = Record<string, unknown>;
type Method = "GET" | "POST" | "PUT";
type ToolSpec = {
  name: string;
  description: string;
  method: Method;
  properties: Record<string, unknown>;
  required?: string[];
  path: (args: Args) => string;
  body?: (args: Args) => unknown;
};

const string = { type: "string" } as const;
const integer = { type: "integer", minimum: 1 } as const;
const object = { type: "object" } as const;

function value(args: Args, key: string): string {
  const candidate = args[key];
  if (typeof candidate !== "string" || !candidate) throw new JinnMcpToolError(`${key} is required`);
  return candidate;
}

function path(value: string): string { return encodeURIComponent(value); }
function workflow(args: Args): string { return `/api/workflows/${path(value(args, "workflowId"))}`; }
function run(args: Args): string { return `${workflow(args)}/runs/${path(value(args, "runId"))}`; }

function query(args: Args, keys: string[]): string {
  const params = new URLSearchParams();
  for (const key of keys) if (args[key] !== undefined) params.set(key, String(args[key]));
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

function gatewayError(status: number, body: unknown): JinnMcpToolError {
  const envelope = body && typeof body === "object" ? body as { code?: unknown; message?: unknown } : {};
  const code = typeof envelope.code === "string" ? envelope.code : `http-${status}`;
  const message = typeof envelope.message === "string" ? envelope.message : "Workflow operation failed.";
  return new JinnMcpToolError(`${code}: ${message}`);
}

function tool(spec: ToolSpec): JinnMcpTool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: spec.properties,
      ...(spec.required ? { required: spec.required } : {}),
    },
    handler: async (args: Args, ctx: JinnMcpContext) => {
      assertBoundCaller(ctx);
      const result = await gatewayRequest(ctx, spec.method, spec.path(args), spec.body?.(args));
      if (result.status >= 400) throw gatewayError(result.status, result.body);
      return result.body;
    },
  };
}

const specs: ToolSpec[] = [
  {
    name: "list_workflows", description: "List canonical Workflows.", method: "GET",
    properties: { cursor: string, limit: integer }, path: (args) => `/api/workflows${query(args, ["cursor", "limit"])}`,
  },
  {
    name: "get_workflow", description: "Get one canonical Workflow.", method: "GET",
    properties: { workflowId: string }, required: ["workflowId"], path: workflow,
  },
  {
    name: "create_workflow", description: "Create a disabled Workflow draft; a live operation on the current gateway.", method: "POST",
    properties: { id: string, title: string, description: string }, required: ["id", "title"], path: () => "/api/workflows",
    body: ({ id, title, description }) => ({ id, title, ...(description === undefined ? {} : { description }) }),
  },
  {
    name: "update_workflow", description: "Save a Workflow revision; a live operation on the current gateway.", method: "PUT",
    properties: { workflowId: string, definition: object, expectedRevision: integer },
    required: ["workflowId", "definition", "expectedRevision"], path: workflow,
    body: ({ definition, expectedRevision }) => ({ definition, expectedRevision }),
  },
  {
    name: "duplicate_workflow", description: "Duplicate a Workflow to an explicit identity; a live operation on the current gateway.", method: "POST",
    properties: { sourceId: string, id: string, title: string }, required: ["sourceId", "id", "title"],
    path: (args) => `/api/workflows/${path(value(args, "sourceId"))}/duplicate`, body: ({ id, title }) => ({ id, title }),
  },
  {
    name: "retire_workflow", description: "Retire a Workflow revision; a live operation on the current gateway.", method: "POST",
    properties: { workflowId: string, expectedRevision: integer }, required: ["workflowId", "expectedRevision"],
    path: (args) => `${workflow(args)}/retire`, body: ({ expectedRevision }) => ({ expectedRevision }),
  },
  ...(["enable", "disable"] as const).map((action): ToolSpec => ({
    name: `${action}_workflow`, description: `${action === "enable" ? "Enable" : "Disable"} a Workflow revision; a live operation on the current gateway.`, method: "POST",
    properties: { workflowId: string, expectedRevision: integer }, required: ["workflowId", "expectedRevision"],
    path: (args) => `${workflow(args)}/${action}`, body: ({ expectedRevision }) => ({ expectedRevision }),
  })),
  {
    name: "start_workflow_run", description: "Start a manual Workflow run; a live operation on the current gateway that may spawn real sessions.", method: "POST",
    properties: { workflowId: string, input: object, idempotencyKey: string }, required: ["workflowId"],
    path: (args) => `${workflow(args)}/runs`, body: ({ input, idempotencyKey }) => ({ input: input ?? {}, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) }),
  },
  {
    name: "list_workflow_runs", description: "List Workflow run history.", method: "GET",
    properties: { workflowId: string, cursor: string, limit: integer, status: string }, required: ["workflowId"],
    path: (args) => `${workflow(args)}/runs${query(args, ["cursor", "limit", "status"])}`,
  },
  {
    name: "get_workflow_run", description: "Get one Workflow run.", method: "GET",
    properties: { workflowId: string, runId: string }, required: ["workflowId", "runId"], path: run,
  },
  {
    name: "cancel_workflow_run", description: "Cancel a Workflow run; a live operation on the current gateway.", method: "POST",
    properties: { workflowId: string, runId: string, reason: string }, required: ["workflowId", "runId"],
    path: (args) => `${run(args)}/cancel`, body: ({ reason }) => ({ ...(reason === undefined ? {} : { reason }) }),
  },
  {
    name: "rerun_workflow_run", description: "Rerun with the original or current definition; a live operation on the current gateway that may spawn real sessions.", method: "POST",
    properties: { workflowId: string, runId: string, definition: { type: "string", enum: ["original", "current"] }, idempotencyKey: string },
    required: ["workflowId", "runId", "definition", "idempotencyKey"], path: (args) => `${run(args)}/rerun`,
    body: ({ definition, idempotencyKey }) => ({ definition, idempotencyKey }),
  },
  {
    name: "decide_workflow_approval", description: "Approve or reject a pending Workflow approval as the authenticated caller; a live operation on the current gateway.", method: "POST",
    properties: { workflowId: string, runId: string, nodeId: string,
      decision: { type: "string", enum: ["approve", "reject"] }, reason: string, expectedRevision: integer },
    required: ["workflowId", "runId", "nodeId", "decision", "expectedRevision"],
    path: (args) => `${run(args)}/nodes/${path(value(args, "nodeId"))}/approval`,
    body: ({ decision, reason, expectedRevision }) => ({ decision, ...(reason === undefined ? {} : { reason }), expectedRevision }),
  },
  {
    name: "retry_workflow_node", description: "Retry an eligible failed Workflow Employee node; a live operation on the current gateway that may spawn real sessions.", method: "POST",
    properties: { workflowId: string, runId: string, nodeId: string, idempotencyKey: string },
    required: ["workflowId", "runId", "nodeId", "idempotencyKey"],
    path: (args) => `${run(args)}/nodes/${path(value(args, "nodeId"))}/retry`,
    body: ({ idempotencyKey }) => ({ idempotencyKey }),
  },
  {
    name: "fire_workflow_event", description: "Fire an authenticated Workflow Event; a live operation on the current gateway that may spawn real sessions.", method: "POST",
    properties: { eventName: string, fireId: string, payload: object }, required: ["eventName", "fireId", "payload"],
    path: (args) => `/api/workflows/events/${path(value(args, "eventName"))}`, body: ({ fireId, payload }) => ({ fireId, payload }),
  },
  {
    name: "workflow_submit_output",
    description: "Complete the current Workflow step with your result. Only valid inside a workflow attempt session; fields are validated against the step's output schema.",
    method: "POST",
    properties: {
      outcome: { type: "string", enum: ["success", "failure"] },
      fields: object,
      summary: string,
    },
    path: () => "/api/workflows/attempts/submit",
    body: ({ outcome, fields, summary }) => ({
      ...(outcome === undefined ? {} : { outcome }),
      ...(fields === undefined ? {} : { fields }),
      ...(summary === undefined ? {} : { summary }),
    }),
  },
  {
    name: "workflow_extend_deadline",
    description: "Request more time for the current Workflow step (resets the reminder ladder). Only valid inside a workflow attempt session.",
    method: "POST",
    properties: { reason: string },
    path: () => "/api/workflows/attempts/extend",
    body: ({ reason }) => ({ ...(reason === undefined ? {} : { reason }) }),
  },
];

export const workflowAdvertisedComponentSchemas: Record<string, Record<string, unknown>> = {};
export function buildWorkflowTools(options?: { attemptCompletion?: boolean }): JinnMcpTool[] {
  const visible = options?.attemptCompletion
    ? specs
    : specs.filter((spec) => spec.name !== "workflow_submit_output" && spec.name !== "workflow_extend_deadline");
  return visible.map(tool);
}
