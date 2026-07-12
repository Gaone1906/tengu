import type { IncomingHttpHeaders } from 'node:http';
import { UNIDENTIFIED_TOOL_CALL_ERROR, verifySessionCapability } from '../mcp/identity.js';
import { getSession } from '../sessions/registry.js';
import type { Employee, Session } from '../shared/types.js';
import { resolveRootApprovalTarget } from '../gateway/approval-authority.js';
import { resolveOrgHierarchy } from '../gateway/org-hierarchy.js';
import { scanOrg } from '../gateway/org.js';
import { resolveCallerIdentity } from '../gateway/session-comm-guards.js';
import type { EditableWorkflowDefinition } from './definition.js';
import type { WorkflowRun } from './run-store.js';

export interface WorkflowApprovalRoute {
  requesterEmployee: string | null;
  target: string | null;
  targetKind: 'employee' | 'virtual' | 'none';
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
  return knownEmployee(getSession(run.invocation.sessionId)?.employee, registry);
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
  return {
    requesterEmployee,
    target,
    targetKind,
    requestedAt,
    requestedBy,
    escalatedAt: null,
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

function callerSession(
  headers: IncomingHttpHeaders,
  operatorAuthenticated: boolean,
): { ok: true; session: Session } | { ok: true; operator: true } | { ok: false; error: string } {
  const identity = resolveCallerIdentity(headers, {
    sessionExists: (sessionId) => !!getSession(sessionId),
    verifySessionCapability,
    requireCapability: true,
    operatorAuthenticated,
  });
  if (identity.kind === 'unidentified-tool' || identity.kind === 'unauthenticated') {
    return { ok: false, error: UNIDENTIFIED_TOOL_CALL_ERROR };
  }
  if (identity.kind === 'operator') return { ok: true, operator: true };
  const session = getSession(identity.callerId);
  return session ? { ok: true, session } : { ok: false, error: UNIDENTIFIED_TOOL_CALL_ERROR };
}

export function resolveWorkflowApprovalDecisionAuthority(
  headers: IncomingHttpHeaders,
  route: WorkflowApprovalRoute,
  opts: { operatorAuthenticated?: boolean; allowOperator?: boolean } = {},
): WorkflowApprovalAuthorityResult {
  const caller = callerSession(headers, opts.operatorAuthenticated === true);
  if (!caller.ok) return { ok: false, status: 403, error: caller.error };
  if ('operator' in caller) {
    if (opts.allowOperator !== true || (route.targetKind !== 'virtual' && !route.escalatedAt)) {
      return {
        ok: false,
        status: 403,
        error: 'operator/aCEO Workflow approval decisions require a virtual-root route or explicit escalation',
      };
    }
    return { ok: true, authority: { actor: 'operator', kind: 'operator' } };
  }

  const employee = caller.session.employee;
  const registry = scanOrg();
  const current = employee ? registry.get(employee) : undefined;
  if (!employee || !current) {
    return { ok: false, status: 403, error: 'Workflow approval decisions require a known employee identity' };
  }
  const root = resolveRootApprovalTarget();
  const employeeIsRoot = root?.kind === 'employee' && root.name === employee;
  if (route.requesterEmployee === employee && !employeeIsRoot) {
    return { ok: false, status: 403, error: `employee "${employee}" cannot decide their own Workflow approval` };
  }
  if ((route.targetKind === 'employee' && route.target === employee) || employeeIsRoot) {
    return { ok: true, authority: { actor: employee, kind: 'employee', employee } };
  }
  if (route.escalatedAt && current.rank === 'executive') {
    return { ok: true, authority: { actor: employee, kind: 'employee', employee } };
  }
  return {
    ok: false,
    status: 403,
    error: `employee "${employee}" is not the routed Workflow approval target${route.target ? ` "${route.target}"` : ''} or org root`,
  };
}
