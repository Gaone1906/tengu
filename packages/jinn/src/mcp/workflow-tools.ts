import { assertBoundCaller, gatewayRequest, JinnMcpToolError, type JinnMcpContext, type JinnMcpTool } from "./toolkit.js";
import type { WorkflowSopCompileResult } from "../workflows/sop.js";
import { autoPlaceWorkflowNodes, compileWorkflowAuthoringInput } from "../workflows/authoring.js";
import { MAX_WORKFLOW_STEP_PROMPT_CHARS } from "../workflows/run-store.js";

/**
 * GRS-015 — the WORKFLOW tool group of the `jinn` MCP server: agents create,
 * inspect, and run workflows through typed tools instead of curl or hand-written
 * JSON files. This is the second half of the product vision — the engine
 * (GRS-014a–e) executes sequential + looped + human-gated chains; these tools are
 * how an agent BUILDS and OPERATES them.
 *
 * Contract (catalog `GRS-012d-0` admission rules):
 *   - every tool is a thin DETERMINISTIC wrapper over ONE existing gateway route —
 *     no new gateway logic, no LLM inside the tool server, no second runtime;
 *   - outputs are decision-shaped: the raw record plus a `hint` naming the next
 *     tool call the state calls for (parked → resolve, running → poll, …);
 *   - validator errors pass through STRUCTURED so an agent can self-correct its
 *     definition and retry;
 *   - write tools act on the current gateway. Workflow runs are live operations
 *     that may spawn real sessions; experiments belong on an isolated instance.
 *
 * Wire-shape invariant (Codex GRS-014e structural rule): `run.steps[]` array order
 * IS execution order — loop rounds are spliced in place. Every tool passes run
 * records through VERBATIM (no re-sort, no re-shape of receipts).
 */

/* ── Small deterministic helpers ────────────────────────────────────────────── */

function requireString(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new JinnMcpToolError(`${name} is required and must be a non-empty string`);
  return s;
}

function requireObject(args: Record<string, unknown>, name: string): Record<string, unknown> {
  const v = args[name];
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new JinnMcpToolError(`${name} is required and must be a JSON object`);
  }
  return v as Record<string, unknown>;
}

function optionalObject(args: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  if (args[name] === undefined) return undefined;
  return requireObject(args, name);
}

function optionalString(args: Record<string, unknown>, name: string, max: number): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new JinnMcpToolError(`${name} must be a non-empty string when provided`);
  if (text.length > max) throw new JinnMcpToolError(`${name} is too long (max ${max} characters)`);
  return text;
}

/** Pretty-print a body for error text without flooding the model. */
function asText(body: unknown, max = 4000): string {
  const text = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Convert a non-2xx gateway response into a decision-shaped tool error. The
 * structured cases an agent must be able to act on:
 *   503 evidence-root → explain the gateway configuration failure;
 *   400 with errors[] → the validator's structured errors, verbatim, plus "retry";
 *   409 → conflict (stale version / not-parked) with the body's specifics;
 *   404 → not found, point at the discovery tool.
 */
function gatewayFailure(what: string, status: number, body: unknown): JinnMcpToolError {
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (status === 503) {
    return new JinnMcpToolError(
      `${what} refused (503): this gateway's workflow evidence root configuration is unavailable.` +
        ` Fix JINN_WORKFLOW_EVIDENCE_ROOT (or the default JINN_HOME workflow directory) and retry.`,
    );
  }
  if (status === 400 && Array.isArray(rec.errors) && rec.errors.length > 0) {
    return new JinnMcpToolError(
      `${what} rejected (400): the definition failed validation. Fix every listed issue and retry:\n` +
        asText(rec.errors),
    );
  }
  if (status === 413) {
    return new JinnMcpToolError(
      `${what} rejected (413): the request body exceeds the gateway's size cap for workflow definitions. Shrink the definition — very long instructions/notes are the usual culprit (reference files by path instead of inlining content) — and retry.`,
    );
  }
  if (status === 409) {
    const detail = typeof rec.error === "string" ? rec.error : asText(body);
    const runStatus = typeof rec.status === "string" ? ` (current status: ${rec.status})` : "";
    const code = typeof rec.code === "string" ? ` [${rec.code}]` : "";
    const runId = typeof rec.runId === "string" ? ` Existing run: ${rec.runId}.` : "";
    return new JinnMcpToolError(`${what} conflicted (409)${code}: ${detail}${runStatus}${runId}`);
  }
  if (status === 404) {
    const detail = typeof rec.error === "string" ? rec.error : "not found";
    return new JinnMcpToolError(`${what} failed (404): ${detail}. Use list_workflows to see existing workflow names.`);
  }
  const detail = typeof rec.error === "string" ? rec.error : asText(body);
  return new JinnMcpToolError(`${what} failed (HTTP ${status}): ${detail}`);
}

/** Minimal duck-typed view of a run record — only what the hint reads. The record
 *  itself is always passed through verbatim. */
interface RunView {
  runId?: string;
  status?: string;
  parked?: { scope?: string; nodeId?: string | null; ref?: string; description?: string } | null;
  errors?: unknown[];
}

/** The next-step hint for a run snapshot — deterministic text from status alone. */
function runHint(run: RunView): string {
  switch (run.status) {
    case "running":
      return "Run in flight. Next: get_workflow_run.";
    case "parked": {
      const g = run.parked ?? {};
      const node = String(g.nodeId ?? "?").slice(0, 24);
      const where = g.scope === "runGate" ? "workflow gate" : `gate node "${node}"`;
      const detail = g.description ? `: ${String(g.description).slice(0, 30)}` : "";
      return `Parked on ${where}${detail}. HUMAN decision. Next: get_workflow_run.`;
    }
    case "completed":
      return "Run completed.";
    case "failed":
      return "Run failed. See errors[] and failed step.";
    default:
      return "See status and steps[].";
  }
}

const wfPath = (id: string): string => `/api/workflow-definitions/${encodeURIComponent(id)}`;

/* ── The definition shape recipe (the one schema that must teach) ───────────── */

const closed = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, properties });
const schemaRef = (name: string) => ({ $ref: `#/$defs/${name}` });
const scalar = {};
const POSITION_SCHEMA = closed({ x: { type: "number" }, y: { type: "number" } });
const ACTOR_SCHEMA = closed({ kind: { type: "string", pattern: "^(employee|engine)$" }, ref: { type: "string" } });
const RETRY_SCHEMA = closed({ maxAttempts: { type: "integer" }, on: { type: "array", items: { type: "string" } } });
const SESSION_SCHEMA = closed({ mode: { type: "string", pattern: "^(fresh|workflow|existing)$" }, sessionId: { type: "string" } });
const OPTIONS_SCHEMA = closed({
  model: scalar, effort: scalar, output: scalar, retry: schemaRef("retry"),
  onError: { type: "string", pattern: "^(fail-run|continue|error-edge)$" }, timeoutMinutes: scalar, session: schemaRef("session"),
});
const FILTER_SCHEMA = closed({ source: scalar, department: scalar, assignee: scalar });
const TRIGGER_SCHEMA = closed({
  kind: { type: "string", pattern: "^(manual|schedule|todo-status-change)$" }, cron: scalar, timezone: scalar,
  until: scalar, cronJobId: scalar, toStatus: scalar, status: scalar, fromStatus: scalar, filter: schemaRef("filter"),
});
const GATE_SCHEMA = closed({ id: scalar, kind: { type: "string", pattern: "^(artifact|flag|approval)$" }, glob: scalar, flag: scalar, approvalRef: scalar, description: scalar });
const CONDITION_SCHEMA = closed({ path: scalar, op: { type: "string", pattern: "^(eq|ne|gt|gte|lt|lte|contains|startsWith|exists|absent)$" }, value: scalar });
const NODE_SCHEMA = closed({
  id: scalar, type: { type: "string", pattern: "^(trigger|step|gate|switch|fail|wait)$" }, label: scalar,
  position: schemaRef("position"), actor: schemaRef("actor"), role: scalar, trigger: schemaRef("trigger"), gate: schemaRef("gate"),
  gates: { type: "array", items: schemaRef("gate") }, optional: scalar, cadence: scalar, instructions: scalar, options: schemaRef("options"),
  todoTransition: scalar, switchMode: scalar, failMessage: scalar, waitMinutes: scalar, waitUntil: scalar,
});
const EDGE_SCHEMA = closed({
  id: scalar, from: scalar, to: scalar, kind: scalar, label: scalar, gate: schemaRef("gate"),
  when: { type: "array", items: schemaRef("condition") }, lane: { type: "string", pattern: "^error$" },
});
const RAW_DEFINITION_SCHEMA = closed({
  schemaVersion: scalar, id: scalar, name: scalar, title: scalar, description: scalar, version: scalar, status: scalar,
  orchestrator: scalar, nodes: { type: "array", items: NODE_SCHEMA }, edges: { type: "array", items: EDGE_SCHEMA },
  runGates: { type: "array", items: schemaRef("gate") }, loop: closed({ maxRuns: scalar, until: scalar, maxRoundsPerRun: scalar, stopWhen: scalar }),
  concurrency: scalar, evidenceRoot: scalar, updatedAt: scalar,
  layout: closed({ source: { type: "string", pattern: "^(generated|normalized|manual)$" }, version: { type: "integer" } }),
});
const BASE_WORKFLOW_SCHEMA_DEFS = {
  position: POSITION_SCHEMA, actor: ACTOR_SCHEMA, retry: RETRY_SCHEMA, session: SESSION_SCHEMA,
  options: OPTIONS_SCHEMA, filter: FILTER_SCHEMA, trigger: TRIGGER_SCHEMA, gate: GATE_SCHEMA, condition: CONDITION_SCHEMA,
};

const DEFINITION_SHAPE =
  "Prefer SOP {id,title,wakeUp,steps:[{employee|engine,instruction}]}. Raw nodes: trigger|step|gate|switch|wait|fail; edges: sequence|handoff|loop. " +
  "Failure routing requires source options.onError:'error-edge' plus edge lane:'error'; edge.on is unsupported. Text \"ERROR\" is output, not transport failure. " +
  "Switch uses edge.when; wait uses waitMinutes|waitUntil; fail uses failMessage. Missing positions are generated.";

const SOP_WAKE_UP_SCHEMA = closed({
  kind: { type: "string", pattern: "^(manual|schedule|todo-status|todo-status-change|event|poll)$" },
  cron: scalar, timezone: scalar, until: scalar, cronJobId: scalar, toStatus: scalar, status: scalar, fromStatus: scalar,
  filter: scalar, name: scalar, event: scalar, secretToken: scalar, command: scalar,
  intervalSeconds: scalar, timeoutMs: scalar, stdoutMaxBytes: scalar, stderrMaxBytes: scalar,
});
const SOP_STEP_SCHEMA = closed({
  id: scalar, title: scalar, label: scalar, employee: scalar, engine: scalar, role: scalar,
  instruction: scalar, instructions: scalar, optional: scalar, options: schemaRef("options"), todoTransition: scalar,
});
const WORKFLOW_SCHEMA_DEFS = {
  ...BASE_WORKFLOW_SCHEMA_DEFS,
  sopWakeUp: SOP_WAKE_UP_SCHEMA,
};
const SOP_SCHEMA = {
  ...closed({
    id: scalar, name: scalar, title: scalar, description: scalar,
    wakeUp: schemaRef("sopWakeUp"), wakeup: schemaRef("sopWakeUp"),
    steps: { type: "array", items: SOP_STEP_SCHEMA }, concurrency: scalar,
  }),
  description: DEFINITION_SHAPE,
};

const workflowAuthoringSchema = (definitionKey: "definition" | "patch", extra: Record<string, unknown> = {}) => ({
  type: "object" as const,
  additionalProperties: false,
  $defs: WORKFLOW_SCHEMA_DEFS,
  properties: { ...extra, sop: SOP_SCHEMA, [definitionKey]: RAW_DEFINITION_SCHEMA },
});

function compileInput(args: Record<string, unknown>): WorkflowSopCompileResult {
  try {
    return compileWorkflowAuthoringInput(args);
  } catch (e) {
    throw new JinnMcpToolError(e instanceof Error ? e.message : String(e));
  }
}

function compilePatchInput(args: Record<string, unknown>): { patch: Record<string, unknown>; triggerBindingPlan?: WorkflowSopCompileResult["triggerBindingPlan"]; sopAuthored: boolean } {
  if (args.sop !== undefined) {
    const compiled = compileInput(args);
    const { id: _id, schemaVersion: _schemaVersion, version: _version, status: _status, updatedAt: _updatedAt, ...patch } = compiled.definition;
    return { patch, triggerBindingPlan: compiled.triggerBindingPlan, sopAuthored: true };
  }
  if (args.patch !== undefined) return { patch: autoPlaceWorkflowNodes(requireObject(args, "patch")), sopAuthored: false };
  throw new JinnMcpToolError("sop or patch is required");
}

/* ── The tool group ─────────────────────────────────────────────────────────── */

export function buildWorkflowTools(): JinnMcpTool[] {
  const listWorkflows: JinnMcpTool = {
    name: "list_workflows",
    description: "List workflows.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) => {
      assertBoundCaller(ctx);
      const { status, body } = await gatewayRequest(ctx, "GET", "/api/workflow-definitions");
      if (status >= 400) throw gatewayFailure("listing workflows", status, body);
      const rec = (body ?? {}) as Record<string, unknown>;
      if (rec.evidenceConfigured === false) {
        const reason = typeof rec.evidenceReason === "string" ? rec.evidenceReason : undefined;
        return {
          ...rec,
          hint: reason
            ? `Workflow storage is misconfigured on this gateway: ${reason}`
            : "The workflow evidence root is misconfigured on this gateway — workflow storage is disabled here.",
        };
      }
      return body;
    },
  };

  const getWorkflow: JinnMcpTool = {
    name: "get_workflow",
    description: "Get workflow.",
    inputSchema: {
      type: "object",
      properties: { workflowId: { type: "string" } },
      required: ["workflowId"],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const id = requireString(args, "workflowId");
      const { status, body } = await gatewayRequest(ctx, "GET", wfPath(id));
      if (status >= 400) throw gatewayFailure(`getting workflow "${id}"`, status, body);
      return body;
    },
  };

  const listWorkflowRuns: JinnMcpTool = {
    name: "list_workflow_runs",
    description: "List workflow runs.",
    inputSchema: {
      type: "object",
      properties: { workflowId: { type: "string" } },
      required: ["workflowId"],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const id = requireString(args, "workflowId");
      const { status, body } = await gatewayRequest(ctx, "GET", `${wfPath(id)}/runs`);
      if (status >= 400) throw gatewayFailure(`listing runs of "${id}"`, status, body);
      return body;
    },
  };

  const getWorkflowRun: JinnMcpTool = {
    name: "get_workflow_run",
    description: "Get workflow run.",
    inputSchema: {
      type: "object",
      properties: {
        workflowId: { type: "string" },
        runId: { type: "string" },
      },
      required: ["workflowId", "runId"],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const id = requireString(args, "workflowId");
      const runId = requireString(args, "runId");
      const { status, body } = await gatewayRequest(ctx, "GET", `${wfPath(id)}/runs/${encodeURIComponent(runId)}`);
      if (status >= 400) throw gatewayFailure(`getting run "${runId}" of "${id}"`, status, body);
      // Verbatim record + a sibling hint — steps[] is NEVER re-sorted or reshaped.
      return { run: body, hint: runHint((body ?? {}) as RunView) };
    },
  };

  const planWorkflow: JinnMcpTool = {
    name: "plan_workflow",
    description: "Plan workflow without saving.",
    inputSchema: { ...workflowAuthoringSchema("definition"), required: [] },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const { status, body } = await gatewayRequest(ctx, "POST", "/api/workflow-definitions/plan", args);
      if (status >= 400) throw gatewayFailure("planning workflow", status, body);
      return body;
    },
  };

  const validateWorkflow: JinnMcpTool = {
    name: "validate_workflow",
    description: "Validate workflow without saving.",
    inputSchema: { ...workflowAuthoringSchema("definition"), required: [] },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const { status, body } = await gatewayRequest(ctx, "POST", "/api/workflow-definitions/plan", args);
      if (status >= 400) throw gatewayFailure("validating workflow", status, body);
      return body;
    },
  };

  const createWorkflow: JinnMcpTool = {
    name: "create_workflow",
    description: "Create workflow.",
    inputSchema: { ...workflowAuthoringSchema("definition"), required: [] },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const compiled = compileInput(args);
      const payload = {
        operation: "create",
        definition: compiled.definition,
        reconcileSopTriggers: args.sop !== undefined,
        ...(compiled.triggerBindingPlan ? { triggerBindingPlan: compiled.triggerBindingPlan } : {}),
      };
      const { status, body } = await gatewayRequest(ctx, "POST", "/api/workflow-definitions/mutate", payload);
      if (status >= 400) throw gatewayFailure("creating the workflow", status, body);
      const response = (body ?? {}) as Record<string, unknown>;
      const created = (response.definition ?? response) as Record<string, unknown>;
      return {
        definition: created,
        trigger: response.trigger,
        hint: `Created from ${args.sop !== undefined ? "SOP" : "raw graph"} v${String(created.version ?? 1)}. Next: run_workflow_by_name { name: "${String(created.name ?? created.id ?? "")}" }.`,
      };
    },
  };

  const updateWorkflow: JinnMcpTool = {
    name: "update_workflow",
    description: "Update workflow.",
    inputSchema: {
      ...workflowAuthoringSchema("patch", {
        workflowId: { type: "string" },
        expectedVersion: { type: "number" },
      }),
      required: ["workflowId"],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const id = requireString(args, "workflowId");
      const compiled = compilePatchInput(args);
      const patch = compiled.patch;
      const expectedVersion = typeof args.expectedVersion === "number" ? args.expectedVersion : undefined;
      const payload = {
        operation: "update",
        workflowId: id,
        patch,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
        reconcileSopTriggers: compiled.sopAuthored,
        ...(compiled.triggerBindingPlan ? { triggerBindingPlan: compiled.triggerBindingPlan } : {}),
      };
      const { status, body } = await gatewayRequest(ctx, "POST", "/api/workflow-definitions/mutate", payload);
      if (status >= 400) throw gatewayFailure(`updating workflow "${id}"`, status, body);
      const response = (body ?? {}) as Record<string, unknown>;
      const updated = (response.definition ?? response) as Record<string, unknown>;
      return { definition: updated, trigger: response.trigger, hint: `Updated to version ${String(updated.version ?? "?")}.` };
    },
  };

  const retireWorkflow: JinnMcpTool = {
    name: "retire_workflow",
    description: "Retire workflow.",
    inputSchema: {
      type: "object",
      properties: { workflowId: { type: "string" } },
      required: ["workflowId"],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const id = requireString(args, "workflowId");
      const { status, body } = await gatewayRequest(ctx, "POST", `${wfPath(id)}/retire`, {});
      if (status >= 400) throw gatewayFailure(`retiring workflow "${id}"`, status, body);
      return { definition: body, hint: `Workflow "${id}" retired.` };
    },
  };

  const startWorkflowRun: JinnMcpTool = {
    name: "start_workflow_run",
    description: "Live workflow run by id; may spawn real sessions on current gateway.",
    inputSchema: {
      type: "object",
      properties: {
        workflowId: { type: "string" },
        input: { type: "object" },
        stepOverrides: { type: "object", description: "Map stepId to {prompt}." },
        idempotencyKey: { type: "string", maxLength: 256 },
      },
      required: ["workflowId"],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const id = requireString(args, "workflowId");
      const input = optionalObject(args, "input");
      const stepOverrides = optionalObject(args, "stepOverrides");
      const idempotencyKey = optionalString(args, "idempotencyKey", 256);
      const requestBody = {
        ...(input ? { input } : {}),
        ...(stepOverrides ? { stepOverrides } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      };
      const { status, body } = await gatewayRequest(ctx, "POST", `${wfPath(id)}/run`, requestBody);
      if (status === 422) {
        // The route persists a FAILED run and returns it — surface its structured
        // errors (unsupported-cycle, unknown-actor, loop-unbounded, …) for self-correction.
        const failed = (body ?? {}) as RunView;
        throw new JinnMcpToolError(
          `run refused to start (422) — the definition cannot execute. Fix these and retry:\n${asText(failed.errors ?? body)}`,
        );
      }
      if (status >= 400) throw gatewayFailure(`starting a run of "${id}"`, status, body);
      const run = (body ?? {}) as RunView;
      return { run: body, hint: `Started ${String(run.runId ?? "?")}. ${runHint(run)}` };
    },
  };

  const runWorkflowByName: JinnMcpTool = {
    name: "run_workflow_by_name",
    description: "Live workflow run by name; may spawn real sessions on current gateway.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        input: { type: "object" },
        stepOverrides: { type: "object", description: "Map stepId to {prompt}." },
        idempotencyKey: { type: "string", maxLength: 256 },
      },
      required: ["name"],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const name = requireString(args, "name");
      const input = optionalObject(args, "input");
      const stepOverrides = optionalObject(args, "stepOverrides");
      const idempotencyKey = optionalString(args, "idempotencyKey", 256);
      const requestBody = {
        name,
        ...(input ? { input } : {}),
        ...(stepOverrides ? { stepOverrides } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      };
      const { status, body } = await gatewayRequest(ctx, "POST", "/api/workflow-runs/by-name", requestBody);
      if (status === 422) {
        const failed = (body ?? {}) as RunView;
        throw new JinnMcpToolError(
          `run refused to start (422) — the definition cannot execute. Fix these and retry:\n${asText(failed.errors ?? body)}`,
        );
      }
      if (status >= 400) throw gatewayFailure(`running workflow name "${name}"`, status, body);
      const run = (body ?? {}) as RunView;
      return { run: body, hint: `Started ${String(run.runId ?? "?")}. ${runHint(run)}` };
    },
  };

  const editWorkflowRunStepPrompt: JinnMcpTool = {
    name: "edit_workflow_run_step_prompt",
    description: "Audit-edit a pending phase prompt.",
    inputSchema: {
      type: "object",
      properties: {
        workflowId: { type: "string" },
        runId: { type: "string" },
        nodeId: { type: "string" },
        prompt: { type: "string", maxLength: MAX_WORKFLOW_STEP_PROMPT_CHARS },
      },
      required: ["workflowId", "runId", "nodeId", "prompt"],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const workflowId = requireString(args, "workflowId");
      const runId = requireString(args, "runId");
      const nodeId = requireString(args, "nodeId");
      const prompt = requireString(args, "prompt");
      if (prompt.length > MAX_WORKFLOW_STEP_PROMPT_CHARS) {
        throw new JinnMcpToolError(`prompt is too long (max ${MAX_WORKFLOW_STEP_PROMPT_CHARS} characters)`);
      }
      const route = `${wfPath(workflowId)}/runs/${encodeURIComponent(runId)}/pending-steps/${encodeURIComponent(nodeId)}`;
      const { status, body } = await gatewayRequest(ctx, "PATCH", route, { prompt });
      if (status >= 400) throw gatewayFailure(`editing pending step "${nodeId}" on run "${runId}"`, status, body);
      const run = (body ?? {}) as { stepPromptRevision?: unknown };
      return { run: body, hint: `Prompt edit recorded at revision ${String(run.stepPromptRevision ?? "?")}.` };
    },
  };

  const listTriggers: JinnMcpTool = {
    name: "list_triggers",
    description: "List workflow triggers.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) => {
      assertBoundCaller(ctx);
      const { status, body } = await gatewayRequest(ctx, "GET", "/api/workflow-triggers");
      if (status >= 400) throw gatewayFailure("listing workflow triggers", status, body);
      return body;
    },
  };

  const createTrigger: JinnMcpTool = {
    name: "create_trigger",
    description: "Create workflow trigger.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["webhook", "poll"] },
        name: { type: "string" },
        event: { type: "string" },
        targetWorkflowId: { type: "string" },
        filter: { type: "array" },
        secretToken: { type: "string" },
        command: { type: "string" },
        intervalSeconds: { type: "number" },
        timeoutMs: { type: "number" },
        stdoutMaxBytes: { type: "number" },
        stderrMaxBytes: { type: "number" },
      },
      required: ["kind", "name", "event", "targetWorkflowId"],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const payload: Record<string, unknown> = {
        kind: requireString(args, "kind"),
        name: requireString(args, "name"),
        event: requireString(args, "event"),
        targetWorkflowId: requireString(args, "targetWorkflowId"),
      };
      for (const key of ["filter", "secretToken", "command", "intervalSeconds", "timeoutMs", "stdoutMaxBytes", "stderrMaxBytes"]) {
        if (args[key] !== undefined) payload[key] = args[key];
      }
      const { status, body } = await gatewayRequest(ctx, "POST", "/api/workflow-triggers", payload);
      if (status >= 400) throw gatewayFailure("creating workflow trigger", status, body);
      const hint = payload.kind === "poll"
        ? "Poll trigger pending approval."
        : "Webhook trigger created. Next: POST /api/workflow-events.";
      return { ...(body as Record<string, unknown>), hint };
    },
  };

  const deleteTrigger: JinnMcpTool = {
    name: "delete_trigger",
    description: "Delete workflow trigger.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const name = requireString(args, "name");
      const { status, body } = await gatewayRequest(ctx, "DELETE", `/api/workflow-triggers/${encodeURIComponent(name)}`);
      if (status >= 400) throw gatewayFailure(`deleting workflow trigger "${name}"`, status, body);
      return body;
    },
  };

  // DELIBERATELY ABSENT: a gate-resolve tool (Codex GRS-015 finding 1). A run
  // parks on an approval gate precisely so a HUMAN decides; an agent-callable
  // resolve makes the doorbell theater. The 012d-0 catalog never admitted one —
  // approvals/gates are a §4 pending-primitive domain ("primitive first, wrapper
  // later") — so resolution stays on the HTTP route (web doorbell buttons,
  // operator curl) until the approvals-as-records primitive + 012d-3 write gates
  // exist. No policy/config substrate is invented here; absence IS the gate.

  return [
    listWorkflows,
    getWorkflow,
    listWorkflowRuns,
    getWorkflowRun,
    planWorkflow,
    validateWorkflow,
    createWorkflow,
    updateWorkflow,
    retireWorkflow,
    startWorkflowRun,
    runWorkflowByName,
    editWorkflowRunStepPrompt,
    listTriggers,
    createTrigger,
    deleteTrigger,
  ];
}
