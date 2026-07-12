import { createHash } from 'node:crypto';
import type { EditableWorkflowDefinition } from './definition.js';
import type { WorkflowRunInvocation } from './run-store.js';

export const WORKFLOW_RUN_IDEMPOTENCY_CONFLICT = 'workflow-run-idempotency-conflict' as const;
export const WORKFLOW_RUN_IDEMPOTENCY_CONFLICT_MESSAGE =
  'This idempotency key is already bound to a different workflow run request.';

export interface CanonicalWorkflowRunTrigger {
  source: string;
  event: string;
  payload: Record<string, unknown>;
  fireRef?: string;
}

export interface WorkflowRunInvocationRequest {
  workflowId: string;
  definitionVersion: number;
  definitionDigest: string;
  trigger: CanonicalWorkflowRunTrigger;
  input: Record<string, unknown>;
  invocation?: WorkflowRunInvocation;
  initialStepOverrides: Record<string, unknown>;
  principal: string;
}

export interface WorkflowRunInvocationClaim {
  schemaVersion: 1;
  workflowId: string;
  principal: string;
  idempotencyKey: string;
  runId: string;
  fingerprint: string;
  request: WorkflowRunInvocationRequest;
  createdAt: string;
}

export class WorkflowRunIdempotencyConflict extends Error {
  readonly code = WORKFLOW_RUN_IDEMPOTENCY_CONFLICT;
  constructor(readonly runId: string) {
    super(WORKFLOW_RUN_IDEMPOTENCY_CONFLICT_MESSAGE);
    this.name = 'WorkflowRunIdempotencyConflict';
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = canonicalValue(item);
    }
    return out;
  }
  return value;
}

export function canonicalWorkflowRunJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function digestWorkflowDefinition(definition: EditableWorkflowDefinition): string {
  return sha256(canonicalWorkflowRunJson(definition));
}

export function createWorkflowRunInvocationRequest(args: {
  definition: EditableWorkflowDefinition;
  trigger: CanonicalWorkflowRunTrigger;
  input?: Record<string, unknown>;
  invocation?: WorkflowRunInvocation;
  initialStepOverrides?: Record<string, unknown>;
  principal: string;
}): WorkflowRunInvocationRequest {
  return JSON.parse(canonicalWorkflowRunJson({
    workflowId: args.definition.id,
    definitionVersion: args.definition.version,
    definitionDigest: digestWorkflowDefinition(args.definition),
    trigger: args.trigger,
    input: args.input ?? {},
    ...(args.invocation ? { invocation: args.invocation } : {}),
    initialStepOverrides: args.initialStepOverrides ?? {},
    principal: args.principal,
  })) as WorkflowRunInvocationRequest;
}

export function fingerprintWorkflowRunInvocationRequest(request: WorkflowRunInvocationRequest): string {
  return sha256(canonicalWorkflowRunJson(request));
}

export function workflowRunPrincipal(actor: string | undefined, triggerSource: string): string {
  if (actor === 'operator') return 'operator';
  if (actor) return `employee:${actor}`;
  return `system:${triggerSource}`;
}
