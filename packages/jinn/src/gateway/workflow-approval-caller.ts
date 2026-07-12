import type { IncomingHttpHeaders } from 'node:http';
import { UNIDENTIFIED_TOOL_CALL_ERROR, verifySessionCapability } from '../mcp/identity.js';
import { getSession } from '../sessions/registry.js';
import { resolveCallerIdentity } from './session-comm-guards.js';

export type WorkflowApprovalCaller =
  | { kind: 'employee'; employee: string }
  | { kind: 'operator' }
  | { kind: 'denied'; error: string };

export function workflowInvocationEmployee(sessionId: string): string | null {
  return getSession(sessionId)?.employee ?? null;
}

export function resolveWorkflowApprovalCaller(
  headers: IncomingHttpHeaders,
  operatorAuthenticated: boolean,
): WorkflowApprovalCaller {
  const identity = resolveCallerIdentity(headers, {
    sessionExists: (sessionId) => !!getSession(sessionId),
    verifySessionCapability,
    requireCapability: true,
    operatorAuthenticated,
  });
  if (identity.kind === 'unidentified-tool' || identity.kind === 'unauthenticated') {
    return { kind: 'denied', error: UNIDENTIFIED_TOOL_CALL_ERROR };
  }
  if (identity.kind === 'operator') return { kind: 'operator' };
  const employee = getSession(identity.callerId)?.employee;
  return employee
    ? { kind: 'employee', employee }
    : { kind: 'denied', error: UNIDENTIFIED_TOOL_CALL_ERROR };
}
