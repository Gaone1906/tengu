import { validateDefinition, type EditableWorkflowDefinition } from "./definition.js";
import { resolveExecutionPlan } from "./execution-plan.js";
import { compileWorkflowSop, type WorkflowSopCompileResult } from "./sop.js";
import {
  prepareWorkflowLayoutForWrite,
  type WorkflowLayoutDiagnostics,
  type WorkflowLayoutIntent,
} from "./layout.js";

export interface WorkflowAuthoringPlan {
  ok: boolean;
  definition: EditableWorkflowDefinition;
  triggerBindingPlan?: WorkflowSopCompileResult["triggerBindingPlan"];
  layout: {
    diagnostics: WorkflowLayoutDiagnostics;
    normalizedPreview: EditableWorkflowDefinition;
  };
  validation: ReturnType<typeof validateDefinition>;
  execution: ReturnType<typeof resolveExecutionPlan>;
}

export function autoPlaceWorkflowNodes(def: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(def.nodes)) return def;
  let changed = false;
  const nodes = def.nodes.map((node, i) => {
    if (node && typeof node === "object" && !Array.isArray(node) && (node as Record<string, unknown>).position === undefined) {
      changed = true;
      return { ...(node as Record<string, unknown>), position: { x: 0, y: 140 * i } };
    }
    return node;
  });
  return changed ? { ...def, nodes } : def;
}

function requireObject(args: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = args[name];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} is required and must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function compileWorkflowAuthoringInput(args: Record<string, unknown>): WorkflowSopCompileResult {
  if (args.sop !== undefined) return compileWorkflowSop(args.sop);
  if (args.definition !== undefined) {
    const placed = autoPlaceWorkflowNodes(requireObject(args, "definition"));
    return {
      definition: {
        ...placed,
        // Raw MCP/AI input is generated regardless of any caller-supplied metadata.
        layout: { source: "generated", version: 1 },
      } as unknown as EditableWorkflowDefinition,
    };
  }
  throw new Error("sop or definition is required");
}

export function planWorkflowAuthoringInput(args: Record<string, unknown>): WorkflowAuthoringPlan {
  const compiled = compileWorkflowAuthoringInput(args);
  const validation = validateDefinition(compiled.definition);
  const execution = resolveExecutionPlan(compiled.definition);
  const requestedIntent = args.layoutIntent;
  const intent: Exclude<WorkflowLayoutIntent, "manual"> = requestedIntent === "normalize" ? "normalize" : "generated";
  const layout = prepareWorkflowLayoutForWrite(compiled.definition, intent);
  return {
    ok: validation.ok && execution.ok,
    definition: compiled.definition,
    layout: { diagnostics: layout.diagnostics, normalizedPreview: layout.definition },
    ...(compiled.triggerBindingPlan ? { triggerBindingPlan: compiled.triggerBindingPlan } : {}),
    validation,
    execution,
  };
}
