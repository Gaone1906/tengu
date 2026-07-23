import type { JsonValue, WorkflowDefinition, WorkflowNode, WorkflowNodeOutput } from './model.js';

export const WORKFLOW_RUN_STATUSES = ['pending', 'running', 'waiting', 'completed', 'failed', 'cancelled'] as const;
export const WORKFLOW_NODE_RUN_STATUSES = [
  'pending', 'ready', 'dispatching', 'running', 'waiting', 'completed', 'failed', 'skipped', 'cancelled',
] as const;
export const WORKFLOW_ATTEMPT_STATUSES = [
  'dispatching', 'running', 'completed', 'failed', 'timed-out', 'cancelled',
] as const;

export type WorkflowRunStatus = typeof WORKFLOW_RUN_STATUSES[number];
export type WorkflowNodeRunStatus = typeof WORKFLOW_NODE_RUN_STATUSES[number];
export type WorkflowAttemptStatus = typeof WORKFLOW_ATTEMPT_STATUSES[number];

export interface ResolvedEmployeeConfig {
  employeeId: string;
  engine: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  retry: { attempts: number; delaySeconds: number; backoff: 'fixed' | 'exponential' };
  timeoutMinutes?: number;
}

export interface WorkflowError {
  code: string;
  message: string;
  retryable: boolean;
  nodeId?: string;
  attempt?: number;
  details?: Record<string, JsonValue>;
}

export interface WorkflowRunRecord {
  id: string;
  workflowId: string;
  workflowTitle: string;
  definitionRevision: number;
  definition: WorkflowDefinition;
  input: Record<string, JsonValue>;
  trigger: {
    nodeId: string;
    kind: 'manual' | 'schedule' | 'event' | 'todo-status' | 'workflow-call';
    fireId?: string;
    payload: Record<string, JsonValue>;
  };
  status: WorkflowRunStatus;
  revision: number;
  idempotencyKey?: string;
  invocationSessionId?: string;
  cancelRequestedAt?: string;
  startedAt: string;
  endedAt?: string;
  error?: WorkflowError;
}

export interface WorkflowNodeRunRecord {
  runId: string;
  nodeId: string;
  nodeType: WorkflowNode['type'];
  status: WorkflowNodeRunStatus;
  activated: boolean;
  resolvedConfig?: Record<string, JsonValue>;
  input?: JsonValue;
  output?: WorkflowNodeOutput;
  error?: WorkflowError;
  resumeAt?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface WorkflowAttemptRecord {
  runId: string;
  nodeId: string;
  attempt: number;
  sessionId?: string;
  status: WorkflowAttemptStatus;
  resolvedConfig: ResolvedEmployeeConfig;
  input: JsonValue;
  output?: WorkflowNodeOutput;
  error?: WorkflowError;
  startedAt: string;
  endedAt?: string;
  remindersSent: number;
  nextReminderAt?: string;
  extensions: number;
  lastExtensionReason?: string;
  pendingOutputError?: string;
  lastProcessedTurn: number;
}

export interface WorkflowApprovalRecord {
  runId: string;
  nodeId: string;
  status: 'pending' | 'approved' | 'rejected';
  requestedAt: string;
  approverRef?: string;
  decidedAt?: string;
  decidedBy?: string;
  decision?: 'approve' | 'reject';
  reason?: string;
}

export interface WorkflowRunDetail extends WorkflowRunRecord {
  nodeRuns: WorkflowNodeRunRecord[];
  attempts: WorkflowAttemptRecord[];
  approvals: WorkflowApprovalRecord[];
}
