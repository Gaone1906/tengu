import { describe, expect, it } from 'vitest';
import {
  canonicalWorkflowRunJson,
  createWorkflowRunInvocationRequest,
  digestWorkflowDefinition,
  fingerprintWorkflowRunInvocationRequest,
  WORKFLOW_RUN_IDEMPOTENCY_CONFLICT,
} from '../run-idempotency.js';
import type { EditableWorkflowDefinition } from '../definition.js';

const definition = (version = 3): EditableWorkflowDefinition => ({
  schemaVersion: 1,
  id: 'deploy-app',
  name: 'deploy-app',
  title: 'Deploy app',
  version,
  status: 'active',
  nodes: [
    { id: 'trigger', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' } },
    { id: 'verify', type: 'step', label: 'Verify', position: { x: 320, y: 0 }, actor: { kind: 'engine', ref: 'codex' } },
  ],
  edges: [{ id: 'trigger-verify', from: 'trigger', to: 'verify', kind: 'sequence' }],
});

describe('workflow run invocation canonicalization', () => {
  it('sorts object keys recursively while preserving array order', () => {
    expect(canonicalWorkflowRunJson({ z: 1, a: { y: 2, x: 3 }, rows: [{ b: 2, a: 1 }, 4] }))
      .toBe('{"a":{"x":3,"y":2},"rows":[{"a":1,"b":2},4],"z":1}');
    expect(canonicalWorkflowRunJson({ rows: [2, 1] })).not.toBe(canonicalWorkflowRunJson({ rows: [1, 2] }));
  });

  it('normalizes omitted input and overrides without mutating caller objects', () => {
    const def = definition();
    const trigger = { source: 'manual', event: 'workflow.manual_started', payload: { requestedBy: 'api', workflowId: def.id } };
    const request = createWorkflowRunInvocationRequest({ definition: def, trigger, principal: 'employee:owner' });

    expect(request).toMatchObject({
      workflowId: def.id,
      definitionVersion: 3,
      input: {},
      initialStepOverrides: {},
      principal: 'employee:owner',
    });
    expect(trigger).toEqual({ source: 'manual', event: 'workflow.manual_started', payload: { requestedBy: 'api', workflowId: def.id } });
    expect(def).toEqual(definition());
  });

  it('produces stable SHA-256 definition and request fingerprints for equivalent key ordering', () => {
    const def = definition();
    const first = createWorkflowRunInvocationRequest({
      definition: def,
      trigger: { source: 'manual', event: 'workflow.manual_started', payload: { workflowId: def.id, requestedBy: 'api' } },
      input: { ticket: { priority: 2, id: 'ABC-42' } },
      initialStepOverrides: { verify: { prompt: 'Check migrations.' } },
      principal: 'employee:owner',
    });
    const second = createWorkflowRunInvocationRequest({
      definition: { ...def, nodes: def.nodes.map((node) => ({ ...node })) },
      trigger: { source: 'manual', event: 'workflow.manual_started', payload: { requestedBy: 'api', workflowId: def.id } },
      input: { ticket: { id: 'ABC-42', priority: 2 } },
      initialStepOverrides: { verify: { prompt: 'Check migrations.' } },
      principal: 'employee:owner',
    });

    expect(digestWorkflowDefinition(def)).toMatch(/^[0-9a-f]{64}$/);
    expect(first.definitionDigest).toBe(digestWorkflowDefinition(def));
    expect(fingerprintWorkflowRunInvocationRequest(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintWorkflowRunInvocationRequest(first)).toBe(fingerprintWorkflowRunInvocationRequest(second));
    expect(WORKFLOW_RUN_IDEMPOTENCY_CONFLICT).toBe('workflow-run-idempotency-conflict');
  });

  it.each([
    ['definition version', (r: ReturnType<typeof createWorkflowRunInvocationRequest>) => ({ ...r, definitionVersion: r.definitionVersion + 1 })],
    ['definition digest', (r: ReturnType<typeof createWorkflowRunInvocationRequest>) => ({ ...r, definitionDigest: '0'.repeat(64) })],
    ['trigger source', (r: ReturnType<typeof createWorkflowRunInvocationRequest>) => ({ ...r, trigger: { ...r.trigger, source: 'schedule' } })],
    ['trigger event', (r: ReturnType<typeof createWorkflowRunInvocationRequest>) => ({ ...r, trigger: { ...r.trigger, event: 'schedule.fire' } })],
    ['trigger payload', (r: ReturnType<typeof createWorkflowRunInvocationRequest>) => ({ ...r, trigger: { ...r.trigger, payload: { ...r.trigger.payload, changed: true } } })],
    ['input value', (r: ReturnType<typeof createWorkflowRunInvocationRequest>) => ({ ...r, input: { ticket: 'XYZ-7' } })],
    ['input array order', (r: ReturnType<typeof createWorkflowRunInvocationRequest>) => ({ ...r, input: { order: [2, 1] } })],
    ['initial override', (r: ReturnType<typeof createWorkflowRunInvocationRequest>) => ({ ...r, initialStepOverrides: { verify: { prompt: 'Different.' } } })],
    ['workflow id', (r: ReturnType<typeof createWorkflowRunInvocationRequest>) => ({ ...r, workflowId: 'other' })],
    ['principal', (r: ReturnType<typeof createWorkflowRunInvocationRequest>) => ({ ...r, principal: 'employee:other' })],
  ])('binds the fingerprint to %s', (_name, mutate) => {
    const def = definition();
    const base = createWorkflowRunInvocationRequest({
      definition: def,
      trigger: { source: 'manual', event: 'workflow.manual_started', payload: { workflowId: def.id } },
      input: { ticket: 'ABC-42', order: [1, 2] },
      initialStepOverrides: { verify: { prompt: 'Check.' } },
      principal: 'employee:owner',
    });
    expect(fingerprintWorkflowRunInvocationRequest(mutate(base))).not.toBe(fingerprintWorkflowRunInvocationRequest(base));
  });
});
