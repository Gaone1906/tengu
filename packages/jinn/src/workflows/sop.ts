import {
  WORKFLOW_DEFINITION_SCHEMA_VERSION,
  type EditableWorkflowDefinition,
  type StepNodeOptions,
  type WorkflowActor,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowTodoTransitionStatus,
} from './definition.js';
import type { WorkflowTrigger, TodoStatusChangeTriggerFilter } from './derive.js';
import type { CreateWorkflowTriggerBindingInput, WorkflowTriggerFilter } from './custom-triggers.js';

export type WorkflowSopWakeUpKind = 'manual' | 'schedule' | 'todo-status' | 'todo-status-change' | 'event' | 'poll';

export interface WorkflowSopWakeUp {
  kind: WorkflowSopWakeUpKind;
  cron?: string;
  timezone?: string;
  until?: string;
  cronJobId?: string;
  toStatus?: string;
  status?: string;
  fromStatus?: string;
  filter?: TodoStatusChangeTriggerFilter | WorkflowTriggerFilter[];
  name?: string;
  event?: string;
  secretToken?: string;
  command?: string;
  intervalSeconds?: number;
  timeoutMs?: number;
  stdoutMaxBytes?: number;
  stderrMaxBytes?: number;
}

export interface WorkflowSopStep {
  id?: string;
  title?: string;
  label?: string;
  employee?: string;
  engine?: string;
  role?: string;
  instruction?: string;
  instructions?: string;
  optional?: boolean;
  options?: StepNodeOptions;
  todoTransition?: WorkflowTodoTransitionStatus;
}

export interface WorkflowSop {
  id: string;
  title: string;
  description?: string;
  wakeUp?: WorkflowSopWakeUp;
  wakeup?: WorkflowSopWakeUp;
  steps: WorkflowSopStep[];
  concurrency?: number;
}

export interface WorkflowSopCompileResult {
  definition: EditableWorkflowDefinition;
  triggerBindingPlan?: CreateWorkflowTriggerBindingInput;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string;
function stringValue(value: unknown, label: string, required: true): string;
function stringValue(value: unknown, label: string, required: false): string | undefined;
function stringValue(value: unknown, label: string, required = true): string | undefined {
  if (value === undefined || value === null) {
    if (!required) return undefined;
    throw new Error(`${label} is required`);
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function numberValue(value: unknown, label: string): number | undefined;
function numberValue(value: unknown, label: string, required: true): number;
function numberValue(value: unknown, label: string, required: false): number | undefined;
function numberValue(value: unknown, label: string, required = false): number | undefined {
  if (value === undefined || value === null) {
    if (!required) return undefined;
    throw new Error(`${label} is required`);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function boolValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

const SAFE_ID = /^[A-Za-z0-9_](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/;
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);

function slug(value: string, fallback: string): string {
  const s = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 120);
  const id = s || fallback;
  if (SAFE_ID.test(id) && !RESERVED_IDS.has(id)) return id;
  return fallback;
}

function uniqueId(seed: string, used: Set<string>, fallback: string): string {
  const base = slug(seed, fallback);
  let id = base;
  let i = 2;
  while (used.has(id) || RESERVED_IDS.has(id)) {
    id = `${base}-${i}`;
    i += 1;
  }
  used.add(id);
  return id;
}

function normalizeFilter(value: unknown): WorkflowSopWakeUp['filter'] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value as WorkflowTriggerFilter[];
  if (typeof value === 'object') return value as TodoStatusChangeTriggerFilter;
  throw new Error('wakeUp.filter must be an object or array');
}

function buildWakeUp(
  workflowId: string,
  rawWakeUp: unknown,
): { trigger: WorkflowTrigger; triggerBindingPlan?: CreateWorkflowTriggerBindingInput } {
  const wakeUp = rawWakeUp === undefined ? { kind: 'manual' } : asRecord(rawWakeUp, 'sop.wakeUp');
  const kind = stringValue(wakeUp.kind, 'sop.wakeUp.kind') as WorkflowSopWakeUpKind;
  const filter = normalizeFilter(wakeUp.filter);

  if (kind === 'manual') return { trigger: { kind: 'manual' } };
  if (kind === 'schedule') {
    return {
      trigger: {
        kind: 'schedule',
        cron: stringValue(wakeUp.cron, 'sop.wakeUp.cron'),
        timezone: stringValue(wakeUp.timezone, 'sop.wakeUp.timezone', false),
        until: stringValue(wakeUp.until, 'sop.wakeUp.until', false),
        cronJobId: stringValue(wakeUp.cronJobId, 'sop.wakeUp.cronJobId', false),
      },
    };
  }
  if (kind === 'todo-status' || kind === 'todo-status-change') {
    return {
      trigger: {
        kind: 'todo-status-change',
        toStatus: stringValue(wakeUp.toStatus ?? wakeUp.status, 'sop.wakeUp.toStatus'),
        fromStatus: stringValue(wakeUp.fromStatus, 'sop.wakeUp.fromStatus', false),
        filter: filter && !Array.isArray(filter) ? filter : undefined,
      },
    };
  }
  if (kind === 'event') {
    const event = stringValue(wakeUp.event, 'sop.wakeUp.event');
    return {
      trigger: { kind: 'manual' },
      triggerBindingPlan: {
        kind: 'webhook',
        name: stringValue(wakeUp.name, 'sop.wakeUp.name', false) ?? `${workflowId}-event`,
        event,
        targetWorkflowId: workflowId,
        sopOwnerWorkflowId: workflowId,
        filter: Array.isArray(filter) ? filter : undefined,
        secretToken: stringValue(wakeUp.secretToken, 'sop.wakeUp.secretToken', false),
      },
    };
  }
  if (kind === 'poll') {
    const event = stringValue(wakeUp.event, 'sop.wakeUp.event');
    return {
      trigger: { kind: 'manual' },
      triggerBindingPlan: {
        kind: 'poll',
        name: stringValue(wakeUp.name, 'sop.wakeUp.name', false) ?? `${workflowId}-poll`,
        event,
        targetWorkflowId: workflowId,
        sopOwnerWorkflowId: workflowId,
        filter: Array.isArray(filter) ? filter : undefined,
        command: stringValue(wakeUp.command, 'sop.wakeUp.command'),
        intervalSeconds: numberValue(wakeUp.intervalSeconds, 'sop.wakeUp.intervalSeconds', true),
        timeoutMs: numberValue(wakeUp.timeoutMs, 'sop.wakeUp.timeoutMs'),
        stdoutMaxBytes: numberValue(wakeUp.stdoutMaxBytes, 'sop.wakeUp.stdoutMaxBytes'),
        stderrMaxBytes: numberValue(wakeUp.stderrMaxBytes, 'sop.wakeUp.stderrMaxBytes'),
      },
    };
  }
  throw new Error(`sop.wakeUp.kind must be manual, schedule, todo-status, event, or poll`);
}

function buildActor(step: Record<string, unknown>, label: string): WorkflowActor | undefined {
  const employee = stringValue(step.employee, `${label}.employee`, false);
  const engine = stringValue(step.engine, `${label}.engine`, false);
  if (employee && engine) throw new Error(`${label} must set employee or engine, not both`);
  if (employee) return { kind: 'employee', ref: employee };
  if (engine) return { kind: 'engine', ref: engine };
  return undefined;
}

function compileStep(raw: unknown, index: number, used: Set<string>): WorkflowNode {
  const label = `sop.steps[${index}]`;
  const step = asRecord(raw, label);
  const actor = buildActor(step, label);
  const role = stringValue(step.role, `${label}.role`, false);
  const title =
    stringValue(step.title, `${label}.title`, false) ??
    stringValue(step.label, `${label}.label`, false) ??
    role ??
    actor?.ref ??
    `Step ${index + 1}`;
  const id = uniqueId(
    stringValue(step.id, `${label}.id`, false) ?? title,
    used,
    `step-${index + 1}`,
  );
  const instructions = stringValue(step.instructions ?? step.instruction, `${label}.instruction`);
  const node: WorkflowNode = {
    id,
    type: 'step',
    label: title,
    position: { x: 0, y: 140 * (index + 1) },
    instructions,
  };
  if (actor) node.actor = actor;
  if (role) node.role = role;
  const optional = boolValue(step.optional);
  if (optional !== undefined) node.optional = optional;
  if (step.options !== undefined) node.options = asRecord(step.options, `${label}.options`) as unknown as StepNodeOptions;
  const todoTransition = stringValue(step.todoTransition, `${label}.todoTransition`, false);
  if (todoTransition) node.todoTransition = todoTransition as WorkflowTodoTransitionStatus;
  return node;
}

export function compileWorkflowSop(input: unknown): WorkflowSopCompileResult {
  const sop = asRecord(input, 'sop');
  const id = stringValue(sop.id, 'sop.id');
  const title = stringValue(sop.title, 'sop.title');
  const name = stringValue(sop.name, 'sop.name', false) ?? id;
  const rawSteps = sop.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new Error('sop.steps must be a non-empty array');
  }

  const { trigger, triggerBindingPlan } = buildWakeUp(id, sop.wakeUp ?? sop.wakeup);
  const used = new Set<string>(['wake']);
  const nodes: WorkflowNode[] = [
    {
      id: 'wake',
      type: 'trigger',
      label: 'Wake-up',
      position: { x: 0, y: 0 },
      trigger,
    },
    ...rawSteps.map((step, index) => compileStep(step, index, used)),
  ];
  const edges: WorkflowEdge[] = [];
  for (let i = 0; i < nodes.length - 1; i += 1) {
    edges.push({
      id: `edge-${nodes[i].id}-${nodes[i + 1].id}`,
      from: nodes[i].id,
      to: nodes[i + 1].id,
      kind: 'sequence',
    });
  }

  const definition: EditableWorkflowDefinition = {
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    id,
    name,
    title,
    version: 1,
    status: 'active',
    nodes,
    edges,
    layout: { source: 'generated', version: 1 },
  };
  const description = stringValue(sop.description, 'sop.description', false);
  if (description) definition.description = description;
  const concurrency = numberValue(sop.concurrency, 'sop.concurrency');
  if (concurrency !== undefined) definition.concurrency = concurrency;

  return { definition, triggerBindingPlan };
}
