import { assertBoundCaller, gatewayRequest, JinnMcpToolError, type JinnMcpContext, type JinnMcpTool } from "./toolkit.js";
import type { EditableWorkflowDefinition } from "../workflows/definition.js";
import type { WorkflowSopCompileResult } from "../workflows/sop.js";
import { autoPlaceWorkflowNodes, compileWorkflowAuthoringInput } from "../workflows/authoring.js";
import type { CreateWorkflowTriggerBindingInput } from "../workflows/custom-triggers.js";

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
 *   - write tools inherit the routes' evidence-root gating — a gateway without a
 *     workflow evidence root refuses writes with 503, which is the intended
 *     live-gateway safety (catalog §3: sandbox-gated).
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
 *   503 evidence-root → explain the live-gateway safety, name the fix;
 *   400 with errors[] → the validator's structured errors, verbatim, plus "retry";
 *   409 → conflict (stale version / not-parked) with the body's specifics;
 *   404 → not found, point at the discovery tool.
 */
function gatewayFailure(what: string, status: number, body: unknown): JinnMcpToolError {
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (status === 503) {
    return new JinnMcpToolError(
      `${what} refused (503): this gateway has no workflow evidence root configured — workflow storage is` +
        ` disabled here, which is the intended safety on a live gateway. Use a sandbox/isolated gateway` +
        ` started with JINN_WORKFLOW_EVIDENCE_ROOT set.`,
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
    return new JinnMcpToolError(`${what} conflicted (409): ${detail}${runStatus}`);
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

const DEFINITION_SHAPE =
  "Default authoring shape is SOP: { id, name?, title, wakeUp: { kind: 'manual'|'schedule'|'todo-status'|'event'|'poll', ... }, steps: [{ employee? | engine?, role?, instruction }] }. " +
  "The SOP compiles to the raw graph below. Power users may pass raw definition: { id, name?, title, nodes: [...], edges: [...], loop?, runGates? }. " +
  "Node: { id, type: 'trigger'|'step'|'gate', label, ... }. Exactly one trigger node " +
  "({ trigger: { kind: 'manual' } } or { kind: 'schedule', cron: '0 */2 * * *' }). " +
  "A step runs one AI session: actor { kind: 'engine'|'employee', ref: e.g. 'codex' }, " +
  "instructions = the step's task prompt; each step's output is handed off to its edge " +
  "successors automatically. A gate node { gate: { kind: 'approval', approvalRef, description } } " +
  "PARKS the run for a human decision; deterministic gates ({ kind: 'artifact', glob } / " +
  "{ kind: 'flag', flag }) auto-evaluate. Edge: { id, from, to, kind: 'sequence'|'handoff' }. " +
  "A { kind: 'loop' } back-edge repeats its segment up to loop.maxRoundsPerRun rounds " +
  "(required alongside a loop edge), with an optional deterministic exit gate on the edge itself. " +
  "Node position {x,y} is optional (auto-placed).";

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

async function bindTriggerIfNeeded(
  compiled: WorkflowSopCompileResult,
  ctx: JinnMcpContext,
  what: string,
): Promise<Record<string, unknown> | undefined> {
  if (!compiled.triggerBindingPlan) return undefined;
  const { status, body } = await gatewayRequest(ctx, "POST", "/api/workflow-triggers", compiled.triggerBindingPlan);
  if (status >= 400) throw gatewayFailure(`${what} custom wake-up trigger`, status, body);
  const rec = (body ?? {}) as Record<string, unknown>;
  return (rec.trigger ?? rec.binding ?? rec) as Record<string, unknown>;
}

function publicTriggerToCreateInput(trigger: Record<string, unknown>): CreateWorkflowTriggerBindingInput | undefined {
  const kind = trigger.kind;
  const name = typeof trigger.name === "string" ? trigger.name : "";
  const event = typeof trigger.event === "string" ? trigger.event : "";
  const targetWorkflowId = typeof trigger.targetWorkflowId === "string" ? trigger.targetWorkflowId : "";
  if ((kind !== "webhook" && kind !== "poll") || !name || !event || !targetWorkflowId) return undefined;
  const input: CreateWorkflowTriggerBindingInput = { kind, name, event, targetWorkflowId };
  if (typeof trigger.sopOwnerWorkflowId === "string") input.sopOwnerWorkflowId = trigger.sopOwnerWorkflowId;
  if (Array.isArray(trigger.filter)) input.filter = trigger.filter as CreateWorkflowTriggerBindingInput["filter"];
  if (kind === "poll") {
    if (typeof trigger.command !== "string" || typeof trigger.intervalSeconds !== "number") return undefined;
    input.command = trigger.command;
    input.intervalSeconds = trigger.intervalSeconds;
    for (const key of ["timeoutMs", "stdoutMaxBytes", "stderrMaxBytes"] as const) {
      if (typeof trigger[key] === "number") input[key] = trigger[key];
    }
    if (typeof trigger.approvalWorkItemId === "string") input.approvalWorkItemId = trigger.approvalWorkItemId;
    if (trigger.activation === "active" || trigger.activation === "pending_approval" || trigger.activation === "disabled") {
      input.activation = trigger.activation;
    }
  }
  return input;
}

async function reconcileSopTriggerBindings(
  ctx: JinnMcpContext,
  workflowId: string,
  nextPlan: CreateWorkflowTriggerBindingInput | undefined,
  what: string,
): Promise<Record<string, unknown> | undefined> {
  const listed = await gatewayRequest(ctx, "GET", "/api/workflow-triggers");
  if (listed.status >= 400) throw gatewayFailure(`${what} listing existing SOP wake-up triggers`, listed.status, listed.body);
  const rec = (listed.body ?? {}) as Record<string, unknown>;
  const triggers = Array.isArray(rec.triggers) ? rec.triggers as Array<Record<string, unknown>> : [];
  const owned = triggers.filter((t) => t.sopOwnerWorkflowId === workflowId);
  if (!nextPlan) {
    for (const trigger of owned) {
      if (typeof trigger.name !== "string" || !trigger.name) continue;
      const deleted = await gatewayRequest(ctx, "DELETE", `/api/workflow-triggers/${encodeURIComponent(trigger.name)}`);
      if (deleted.status >= 400) throw gatewayFailure(`${what} deleting stale SOP wake-up trigger "${trigger.name}"`, deleted.status, deleted.body);
    }
    return undefined;
  }

  const replacingSameName = owned.some((trigger) => trigger.name === nextPlan.name);
  if (!replacingSameName) {
    const created = await gatewayRequest(ctx, "POST", "/api/workflow-triggers", nextPlan);
    if (created.status >= 400) throw gatewayFailure(`${what} binding new SOP wake-up trigger`, created.status, created.body);
    const body = (created.body ?? {}) as Record<string, unknown>;
    const createdTrigger = (body.trigger ?? body.binding ?? body) as Record<string, unknown>;
    try {
      for (const trigger of owned) {
        if (typeof trigger.name !== "string" || !trigger.name) continue;
        const deleted = await gatewayRequest(ctx, "DELETE", `/api/workflow-triggers/${encodeURIComponent(trigger.name)}`);
        if (deleted.status >= 400) throw gatewayFailure(`${what} deleting stale SOP wake-up trigger "${trigger.name}"`, deleted.status, deleted.body);
      }
    } catch (err) {
      await gatewayRequest(ctx, "DELETE", `/api/workflow-triggers/${encodeURIComponent(nextPlan.name)}`);
      throw err;
    }
    return createdTrigger;
  }

  for (const trigger of owned) {
    if (typeof trigger.name !== "string" || !trigger.name) continue;
    const deleted = await gatewayRequest(ctx, "DELETE", `/api/workflow-triggers/${encodeURIComponent(trigger.name)}`);
    if (deleted.status >= 400) throw gatewayFailure(`${what} deleting stale SOP wake-up trigger "${trigger.name}"`, deleted.status, deleted.body);
  }
  const created = await gatewayRequest(ctx, "POST", "/api/workflow-triggers", nextPlan);
  if (created.status >= 400) {
    for (const trigger of owned) {
      const input = publicTriggerToCreateInput(trigger);
      if (input) await gatewayRequest(ctx, "POST", "/api/workflow-triggers", input);
    }
    throw gatewayFailure(`${what} binding new SOP wake-up trigger`, created.status, created.body);
  }
  const body = (created.body ?? {}) as Record<string, unknown>;
  return (body.trigger ?? body.binding ?? body) as Record<string, unknown>;
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
    inputSchema: {
      type: "object",
      properties: {
        sop: { type: "object" },
        definition: { type: "object" },
      },
      required: [],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        sop: { type: "object" },
        definition: { type: "object" },
      },
      required: [],
    },
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
    inputSchema: {
      type: "object",
      properties: {
        sop: { type: "object" },
        definition: { type: "object" },
      },
      required: [],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const compiled = compileInput(args);
      const { status, body } = await gatewayRequest(ctx, "POST", "/api/workflow-definitions", compiled.definition);
      if (status >= 400) throw gatewayFailure("creating the workflow", status, body);
      const created = (body ?? {}) as Record<string, unknown>;
      const trigger = await bindTriggerIfNeeded(compiled, ctx, "creating workflow");
      return {
        definition: body,
        trigger,
        hint: `Created from ${args.sop !== undefined ? "SOP" : "raw graph"} v${String(created.version ?? 1)}. Next: run_workflow_by_name { name: "${String(created.name ?? created.id ?? "")}" }.`,
      };
    },
  };

  const updateWorkflow: JinnMcpTool = {
    name: "update_workflow",
    description: "Update workflow.",
    inputSchema: {
      type: "object",
      properties: {
        workflowId: { type: "string" },
        sop: { type: "object" },
        patch: { type: "object" },
        expectedVersion: { type: "number" },
      },
      required: ["workflowId"],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const id = requireString(args, "workflowId");
      const compiled = compilePatchInput(args);
      const patch = compiled.patch;
      const expectedVersion = typeof args.expectedVersion === "number" ? args.expectedVersion : undefined;
      const payload = expectedVersion === undefined ? patch : { ...patch, expectedVersion };
      const { status, body } = await gatewayRequest(ctx, "PUT", wfPath(id), payload);
      if (status >= 400) throw gatewayFailure(`updating workflow "${id}"`, status, body);
      const updated = (body ?? {}) as Record<string, unknown>;
      const trigger = compiled.sopAuthored
        ? await reconcileSopTriggerBindings(ctx, id, compiled.triggerBindingPlan, `updating workflow "${id}"`)
        : await bindTriggerIfNeeded({ definition: body as EditableWorkflowDefinition, triggerBindingPlan: compiled.triggerBindingPlan }, ctx, `updating workflow "${id}"`);
      return { definition: body, trigger, hint: `Updated to version ${String(updated.version ?? "?")}.` };
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

  // Tier note (catalog §3 row `jinn_run_workflow_sandbox`: approval-required,
  // "sandbox-gated … keep gated until write-gates land"): this tool STAYS on the
  // belt because its gate is STRUCTURAL, not honorary — a production home resolves
  // no workflow evidence root by construction, so the wrapped route is inert (503)
  // everywhere except a deliberately configured sandbox. That is exactly the
  // sandbox-gating the catalog row asks for. Contrast gate RESOLUTION above, where
  // the missing check is actor authority (human vs agent) — an environment gate
  // cannot substitute for that, hence removal.
  const startWorkflowRun: JinnMcpTool = {
    name: "start_workflow_run",
    description: "Run workflow by id.",
    inputSchema: {
      type: "object",
      properties: {
        workflowId: { type: "string" },
        input: { type: "object" },
        idempotencyKey: { type: "string", maxLength: 256 },
      },
      required: ["workflowId"],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const id = requireString(args, "workflowId");
      const input = optionalObject(args, "input");
      const idempotencyKey = optionalString(args, "idempotencyKey", 256);
      const requestBody = {
        ...(input ? { input } : {}),
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
    description: "Run workflow by name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        input: { type: "object" },
        idempotencyKey: { type: "string", maxLength: 256 },
      },
      required: ["name"],
    },
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const name = requireString(args, "name");
      const input = optionalObject(args, "input");
      const idempotencyKey = optionalString(args, "idempotencyKey", 256);
      const requestBody = {
        name,
        ...(input ? { input } : {}),
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
    listTriggers,
    createTrigger,
    deleteTrigger,
  ];
}
