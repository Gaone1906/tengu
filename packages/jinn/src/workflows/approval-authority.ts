import type { IncomingHttpHeaders } from 'node:http';
import type { Employee } from '../shared/types.js';
import { resolveRootApprovalTarget } from '../gateway/approval-authority.js';
import { resolveOrgHierarchy } from '../gateway/org-hierarchy.js';
import { scanOrg } from '../gateway/org.js';
import { resolveWorkflowApprovalCaller, workflowInvocationEmployee } from '../gateway/workflow-approval-caller.js';
import type { EditableWorkflowDefinition } from './definition.js';
import type { WorkflowRun } from './run-store.js';

export interface WorkflowApprovalRoute {
  requesterEmployee: string | null;
  target: string | null;
  targetKind: 'employee' | 'virtual' | 'none';
  /** Exact employee identities authorized when this route was created. */
  entitledEmployees: string[];
  /** Whether the authenticated operator is authorized by the frozen route. */
  operatorEntitled: boolean;
  /** Frozen explicit escalation destination, if escalation occurred. */
  escalation: {
    target: 'operator';
    targetKind: 'operator';
    at: string;
  } | null;
  requestedAt: string;
  requestedBy: string;
  escalatedAt: string | null;
}

export interface WorkflowGateApprovalRecord extends WorkflowApprovalRoute {
  state: 'pending' | 'approved' | 'rejected';
  decidedBy: string | null;
  decidedAt: string | null;
}

export interface PollActivationApprovalRecord extends WorkflowApprovalRoute {
  state: 'pending' | 'approved' | 'rejected';
  activationContractHash: string;
  decidedBy: string | null;
  decidedAt: string | null;
}

export interface WorkflowApprovalDecisionAuthority {
  actor: string;
  kind: 'employee' | 'operator';
  employee?: string;
}

export type WorkflowApprovalAuthorityResult =
  | { ok: true; authority: WorkflowApprovalDecisionAuthority }
  | { ok: false; status: 403; error: string };

function knownEmployee(value: unknown, registry: Map<string, Employee>): string | null {
  return typeof value === 'string' && registry.has(value) ? value : null;
}

function invocationEmployee(run: Pick<WorkflowRun, 'invocation'>, registry: Map<string, Employee>): string | null {
  if (!run.invocation) return null;
  return knownEmployee(workflowInvocationEmployee(run.invocation.sessionId), registry);
}

function authoredRequester(definition: EditableWorkflowDefinition, registry: Map<string, Employee>): string | null {
  for (const candidate of [
    definition.ownerEmployee,
    definition.owner,
    definition.createdBy,
    definition.workflowOwner,
    definition.creator,
    definition.author,
  ]) {
    const employee = knownEmployee(candidate, registry);
    if (employee) return employee;
  }
  return null;
}

export function createWorkflowApprovalRoute(
  run: Pick<WorkflowRun, 'invocation'>,
  definition: EditableWorkflowDefinition,
  requestedAt: string,
): WorkflowApprovalRoute {
  const registry = scanOrg();
  const requesterEmployee = invocationEmployee(run, registry) ?? authoredRequester(definition, registry);
  return createWorkflowApprovalRouteForRequester(requesterEmployee, requestedAt, 'workflow-run');
}

export function createWorkflowApprovalRouteForRequester(
  requester: string | null | undefined,
  requestedAt: string,
  requestedBy: string,
): WorkflowApprovalRoute {
  const registry = scanOrg();
  const hierarchy = resolveOrgHierarchy(registry);
  const root = resolveRootApprovalTarget();
  const requesterEmployee = knownEmployee(requester, registry);
  const manager = requesterEmployee ? hierarchy.nodes[requesterEmployee]?.parentName ?? null : null;
  const target = manager ?? root?.name ?? null;
  const targetKind: WorkflowApprovalRoute['targetKind'] = !target
    ? 'none'
    : registry.has(target)
      ? 'employee'
      : 'virtual';
  const entitledEmployees = [
    ...(targetKind === 'employee' && target ? [target] : []),
    ...(root?.kind === 'employee' ? [root.name] : []),
  ].filter((employee, index, all) => all.indexOf(employee) === index);
  return {
    requesterEmployee,
    target,
    targetKind,
    entitledEmployees,
    operatorEntitled: targetKind === 'virtual',
    escalation: null,
    requestedAt,
    requestedBy,
    escalatedAt: null,
  };
}

export function freezeWorkflowApprovalEscalation<T extends WorkflowApprovalRoute>(
  route: T,
  at: string,
): T {
  if (route.escalation?.target === 'operator' && route.operatorEntitled) return route;
  return {
    ...route,
    escalatedAt: route.escalatedAt ?? at,
    operatorEntitled: true,
    escalation: {
      target: 'operator',
      targetKind: 'operator',
      at: route.escalatedAt ?? at,
    },
  } as T;
}

export function decideWorkflowGateApproval(
  approval: WorkflowGateApprovalRecord,
  decision: 'approve' | 'reject',
  actor: string,
  at: string,
): WorkflowGateApprovalRecord {
  return {
    ...approval,
    state: decision === 'approve' ? 'approved' : 'rejected',
    decidedBy: actor,
    decidedAt: at,
  };
}

export function createPendingWorkflowGateApproval(
  run: Pick<WorkflowRun, 'invocation'>,
  definition: EditableWorkflowDefinition,
  requestedAt: string,
): WorkflowGateApprovalRecord {
  return {
    ...createWorkflowApprovalRoute(run, definition, requestedAt),
    state: 'pending',
    decidedBy: null,
    decidedAt: null,
  };
}

export function resolveWorkflowApprovalDecisionAuthority(
  headers: IncomingHttpHeaders,
  route: WorkflowApprovalRoute,
  opts: { operatorAuthenticated?: boolean; allowOperator?: boolean } = {},
): WorkflowApprovalAuthorityResult {
  const caller = resolveWorkflowApprovalCaller(headers, opts.operatorAuthenticated === true);
  if (caller.kind === 'denied') return { ok: false, status: 403, error: caller.error };
  if (caller.kind === 'operator') {
    const operatorEntitled = route.operatorEntitled === true
      || (route.targetKind === 'virtual' && route.target !== null);
    if (opts.allowOperator !== true || !operatorEntitled) {
      return {
        ok: false,
        status: 403,
        error: 'operator/aCEO Workflow approval decisions require a virtual-root route or explicit escalation',
      };
    }
    return { ok: true, authority: { actor: 'operator', kind: 'operator' } };
  }

  const employee = caller.employee;
  if (!employee) {
    return { ok: false, status: 403, error: 'Workflow approval decisions require a known employee identity' };
  }
  const frozenEntitlements = Array.isArray(route.entitledEmployees)
    ? route.entitledEmployees
    : route.targetKind === 'employee' && route.target
      ? [route.target]
      : [];
  if (route.requesterEmployee === employee && !frozenEntitlements.includes(employee)) {
    return { ok: false, status: 403, error: `employee "${employee}" cannot decide their own Workflow approval` };
  }
  if (frozenEntitlements.includes(employee)) {
    return { ok: true, authority: { actor: employee, kind: 'employee', employee } };
  }
  return {
    ok: false,
    status: 403,
    error: `employee "${employee}" is not in the frozen Workflow approval route${route.target ? ` for "${route.target}"` : ''}`,
  };
}
