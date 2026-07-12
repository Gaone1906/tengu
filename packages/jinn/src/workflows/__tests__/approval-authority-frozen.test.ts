import type { IncomingHttpHeaders } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Employee } from '../../shared/types.js';

let caller: { kind: 'employee'; employee: string } | { kind: 'operator' } = {
  kind: 'employee',
  employee: 'platform-manager',
};
let employees = new Map<string, Employee>();

vi.mock('../../gateway/workflow-approval-caller.js', () => ({
  resolveWorkflowApprovalCaller: () => caller,
  workflowInvocationEmployee: () => null,
}));

vi.mock('../../gateway/org.js', () => ({
  scanOrg: () => employees,
}));

vi.mock('../../gateway/org-hierarchy.js', () => ({
  resolveOrgHierarchy: () => ({
    nodes: {
      'platform-worker': { parentName: 'platform-manager' },
      'platform-manager': { parentName: 'coo' },
      coo: { parentName: null },
    },
  }),
}));

vi.mock('../../gateway/approval-authority.js', () => ({
  resolveRootApprovalTarget: () => ({ kind: 'employee', name: 'coo' }),
}));

import {
  createWorkflowApprovalRouteForRequester,
  freezeWorkflowApprovalEscalation,
  resolveWorkflowApprovalDecisionAuthority,
} from '../approval-authority.js';

function employee(name: string, rank: Employee['rank'], reportsTo?: string): Employee {
  return {
    name,
    displayName: name,
    department: 'platform',
    rank,
    engine: 'codex',
    model: 'gpt-5.5',
    persona: name,
    ...(reportsTo ? { reportsTo } : {}),
  };
}

const headers = {} as IncomingHttpHeaders;

beforeEach(() => {
  employees = new Map([
    ['coo', employee('coo', 'executive')],
    ['platform-manager', employee('platform-manager', 'manager', 'coo')],
    ['platform-worker', employee('platform-worker', 'employee', 'platform-manager')],
  ]);
  caller = { kind: 'employee', employee: 'platform-manager' };
});

describe('frozen native Workflow approval authority', () => {
  it('freezes the exact routed target and root without consulting later org state', () => {
    const route = createWorkflowApprovalRouteForRequester(
      'platform-worker',
      '2026-07-12T12:00:00.000Z',
      'workflow-run',
    );

    expect(route).toMatchObject({
      requesterEmployee: 'platform-worker',
      target: 'platform-manager',
      targetKind: 'employee',
      entitledEmployees: ['platform-manager', 'coo'],
      operatorEntitled: false,
      escalation: null,
    });

    employees.delete('platform-manager');
    expect(resolveWorkflowApprovalDecisionAuthority(headers, route)).toMatchObject({
      ok: true,
      authority: { employee: 'platform-manager' },
    });
  });

  it('does not grant a promoted requester or a newly added root/executive', () => {
    const route = createWorkflowApprovalRouteForRequester(
      'platform-worker',
      '2026-07-12T12:00:00.000Z',
      'workflow-run',
    );
    const escalated = freezeWorkflowApprovalEscalation(route, '2026-07-12T12:05:00.000Z');

    employees = new Map([
      ['platform-worker', employee('platform-worker', 'executive')],
      ['new-root', employee('new-root', 'executive')],
    ]);

    caller = { kind: 'employee', employee: 'platform-worker' };
    expect(resolveWorkflowApprovalDecisionAuthority(headers, escalated).ok).toBe(false);

    caller = { kind: 'employee', employee: 'new-root' };
    expect(resolveWorkflowApprovalDecisionAuthority(headers, escalated).ok).toBe(false);
  });

  it('freezes operator escalation and cannot be confused by an employee with the virtual target name', () => {
    const route = createWorkflowApprovalRouteForRequester(
      'platform-worker',
      '2026-07-12T12:00:00.000Z',
      'workflow-run',
    );
    const escalated = freezeWorkflowApprovalEscalation(route, '2026-07-12T12:05:00.000Z');

    expect(escalated).toMatchObject({
      escalatedAt: '2026-07-12T12:05:00.000Z',
      operatorEntitled: true,
      escalation: {
        target: 'operator',
        targetKind: 'operator',
        at: '2026-07-12T12:05:00.000Z',
      },
    });

    employees.set('operator', employee('operator', 'executive'));
    caller = { kind: 'employee', employee: 'operator' };
    expect(resolveWorkflowApprovalDecisionAuthority(headers, escalated).ok).toBe(false);

    caller = { kind: 'operator' };
    expect(resolveWorkflowApprovalDecisionAuthority(headers, escalated, { allowOperator: true }).ok).toBe(true);
  });
});
