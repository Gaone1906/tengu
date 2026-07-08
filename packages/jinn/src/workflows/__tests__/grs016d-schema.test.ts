import { describe, it, expect } from 'vitest';
import {
  MAX_WAIT_MINUTES,
  validateDefinition,
  WORKFLOW_DEFINITION_SCHEMA_VERSION,
  type EditableWorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from '../definition.js';
import { resolveExecutionPlan } from '../execution-plan.js';

/**
 * GRS-016d schema suite — error-lane edges (`lane:'error'` ⇔ onError:'error-edge'
 * pairing), output:'none' (+ the none-output dependency refusals), the wait node,
 * and the SAFE_GRAPH_ID trailing-dot carryover regression (016c round-2 residual).
 */

const trigger: WorkflowNode = {
  id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' },
};
const step = (id: string, over: Partial<WorkflowNode> = {}): WorkflowNode =>
  ({ id, type: 'step', label: id.toUpperCase(), position: { x: 0, y: 0 }, actor: { kind: 'engine', ref: 'codex' }, ...over });
const waitNode = (id: string, over: Partial<WorkflowNode> = {}): WorkflowNode =>
  ({ id, type: 'wait', label: 'Wait', position: { x: 0, y: 0 }, ...over });
const e = (from: string, to: string, over: Partial<WorkflowEdge> = {}): WorkflowEdge =>
  ({ id: `e_${from}__${to}`, from, to, kind: 'sequence', ...over });

function def(nodes: WorkflowNode[], edges: WorkflowEdge[], over: Partial<EditableWorkflowDefinition> = {}): EditableWorkflowDefinition {
  return { schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION, id: 'wf', title: 'WF', version: 1, status: 'active', nodes, edges, ...over };
}

const codesOf = (d: EditableWorkflowDefinition) => validateDefinition(d).errors.map((x) => x.code);

/* ── Carryover: SAFE_GRAPH_ID must refuse a trailing dot ────────────────────── */

describe('SAFE_GRAPH_ID trailing dot (016c round-2 residual)', () => {
  it("refuses a node id ending in '.' — such a node is unaddressable by condition paths", () => {
    const d = def([trigger, step('a.')], [e('trg', 'a.')]);
    expect(codesOf(d)).toContain('unsafe-node-id');
  });

  it("refuses an edge id ending in '.'", () => {
    const d = def([trigger, step('a')], [{ id: 'edge.', from: 'trg', to: 'a', kind: 'sequence' }]);
    expect(codesOf(d)).toContain('unsafe-edge-id');
  });

  it("still accepts dotted interior ids ('a.b'), single chars, and '__trigger'", () => {
    const d = def(
      [{ ...trigger, id: '__trigger' }, step('a.b'), step('c')],
      [{ id: 'e1', from: '__trigger', to: 'a.b', kind: 'sequence' }, { id: 'e2', from: 'a.b', to: 'c', kind: 'sequence' }],
    );
    expect(validateDefinition(d).ok).toBe(true);
  });
});

/* ── Error-output lanes ─────────────────────────────────────────────────────── */

describe('error-lane edges ⇔ onError:error-edge pairing', () => {
  const errorEdgeStep = (id: string, over: Partial<WorkflowNode> = {}) =>
    step(id, { options: { onError: 'error-edge' }, ...over });

  it('accepts the paired shape: onError error-edge + one error-lane out-edge', () => {
    const d = def(
      [trigger, errorEdgeStep('a'), step('ok'), step('rescue')],
      [e('trg', 'a'), e('a', 'ok'), e('a', 'rescue', { lane: 'error' })],
    );
    expect(validateDefinition(d).ok).toBe(true);
  });

  it('onError:error-edge with NO error-lane out-edge is refused (the declared lane must exist)', () => {
    const d = def([trigger, errorEdgeStep('a'), step('ok')], [e('trg', 'a'), e('a', 'ok')]);
    expect(codesOf(d)).toContain('error-edge-missing-lane');
  });

  it('a lane on an edge whose source has no onError:error-edge is refused', () => {
    const d = def([trigger, step('a'), step('b')], [e('trg', 'a'), e('a', 'b', { lane: 'error' })]);
    expect(codesOf(d)).toContain('misplaced-edge-lane');
  });

  it('a lane on an edge whose source is not a step (trigger/switch/gate) is refused', () => {
    const d = def(
      [trigger, step('a')],
      [e('trg', 'a', { lane: 'error' })],
    );
    expect(codesOf(d)).toContain('misplaced-edge-lane');
  });

  it('a lane on a loop edge is refused (the loop machinery owns cross-round decisions)', () => {
    const d = def(
      [trigger, step('a', { options: { onError: 'error-edge' } }), step('b'), step('rescue')],
      [e('trg', 'a'), e('a', 'b'), e('a', 'rescue', { lane: 'error' }), e('b', 'a', { kind: 'loop', lane: 'error' })],
      { loop: { maxRoundsPerRun: 2 } },
    );
    expect(codesOf(d)).toContain('misplaced-edge-lane');
  });

  it('a lane value other than "error" is refused', () => {
    const d = def(
      [trigger, step('a', { options: { onError: 'error-edge' } }), step('b')],
      [e('trg', 'a'), e('a', 'b', { lane: 'success' as unknown as 'error' })],
    );
    expect(codesOf(d)).toContain('bad-edge-lane');
  });

  it('optional + onError:error-edge is refused — optional absorbs failures before onError, so the lane could never activate', () => {
    const d = def(
      [trigger, errorEdgeStep('a', { optional: true }), step('ok'), step('rescue')],
      [e('trg', 'a'), e('a', 'ok'), e('a', 'rescue', { lane: 'error' })],
    );
    expect(codesOf(d)).toContain('bad-step-options');
  });

  it('the compiled plan carries onError:error-edge and the in-edge lane', () => {
    const d = def(
      [trigger, errorEdgeStep('a'), step('ok'), step('rescue')],
      [e('trg', 'a'), e('a', 'ok'), e('a', 'rescue', { lane: 'error' })],
    );
    const resolved = resolveExecutionPlan(d);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.plan.steps.find((s) => s.nodeId === 'a')?.onError).toBe('error-edge');
    expect(resolved.plan.inEdges['rescue']).toEqual([{ edgeId: 'e_a__rescue', from: 'a', lane: 'error' }]);
    expect(resolved.plan.inEdges['ok']).toEqual([{ edgeId: 'e_a__ok', from: 'a' }]);
  });
});

/* ── output:'none' (fire-and-forget) ────────────────────────────────────────── */

describe("output:'none' validation", () => {
  const noneStep = (id: string, over: Partial<WorkflowNode> = {}) =>
    step(id, { options: { output: 'none' }, ...over });

  it('output:none is now a legal option (the 016b deferral is lifted)', () => {
    const d = def([trigger, noneStep('fire')], [e('trg', 'fire')]);
    expect(validateDefinition(d).ok).toBe(true);
  });

  it('retry on a none node is refused — a fire-and-forget session is never awaited, so retry causes can never fire', () => {
    const d = def(
      [trigger, noneStep('fire', { options: { output: 'none', retry: { maxAttempts: 3, on: ['error'] } } })],
      [e('trg', 'fire')],
    );
    expect(codesOf(d)).toContain('bad-step-options');
  });

  it('timeoutMinutes on a none node is refused — nothing ever probes the session', () => {
    const d = def(
      [trigger, noneStep('fire', { options: { output: 'none', timeoutMinutes: 5 } })],
      [e('trg', 'fire')],
    );
    expect(codesOf(d)).toContain('bad-step-options');
  });

  it("a kind:'handoff' edge FROM a none node is refused (declared handoff from output that is never captured)", () => {
    const d = def(
      [trigger, noneStep('fire'), step('next')],
      [e('trg', 'fire'), e('fire', 'next', { kind: 'handoff' })],
    );
    expect(codesOf(d)).toContain('none-output-dependency');
  });

  it("a sequence edge from a none node stays legal (ordering only, no output dependency)", () => {
    const d = def(
      [trigger, noneStep('fire'), step('next')],
      [e('trg', 'fire'), e('fire', 'next')],
    );
    expect(validateDefinition(d).ok).toBe(true);
  });

  it("a switch condition on steps.<none>.outcome.* is refused; steps.<none>.status stays legal (status IS captured — 'fired')", () => {
    const outcomeCond = def(
      [trigger, noneStep('fire'), { id: 'sw', type: 'switch', label: 'SW', position: { x: 0, y: 0 } }, step('b'), step('c')],
      [
        e('trg', 'fire'), e('fire', 'sw'),
        e('sw', 'b', { when: [{ path: 'steps.fire.outcome.summary', op: 'exists' }] }),
        e('sw', 'c'),
      ],
    );
    expect(codesOf(outcomeCond)).toContain('none-output-dependency');

    const statusCond = def(
      [trigger, noneStep('fire'), { id: 'sw', type: 'switch', label: 'SW', position: { x: 0, y: 0 } }, step('b'), step('c')],
      [
        e('trg', 'fire'), e('fire', 'sw'),
        e('sw', 'b', { when: [{ path: 'steps.fire.status', op: 'eq', value: 'fired' }] }),
        e('sw', 'c'),
      ],
    );
    expect(validateDefinition(statusCond).ok).toBe(true);
  });
});

/* ── Wait node ──────────────────────────────────────────────────────────────── */

describe('wait node validation', () => {
  it('accepts waitMinutes in range and compiles a wait plan', () => {
    const d = def([trigger, waitNode('w', { waitMinutes: 30 }), step('b')], [e('trg', 'w'), e('w', 'b')]);
    expect(validateDefinition(d).ok).toBe(true);
    const resolved = resolveExecutionPlan(d);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.plan.waitNodes).toEqual([{ nodeId: 'w', label: 'Wait', minutes: 30 }]);
  });

  it('accepts waitUntil as a parseable ISO time and compiles it', () => {
    const d = def([trigger, waitNode('w', { waitUntil: '2026-07-06T09:00:00.000Z' }), step('b')], [e('trg', 'w'), e('w', 'b')]);
    expect(validateDefinition(d).ok).toBe(true);
    const resolved = resolveExecutionPlan(d);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.plan.waitNodes).toEqual([{ nodeId: 'w', label: 'Wait', untilIso: '2026-07-06T09:00:00.000Z' }]);
  });

  it('refuses a wait node with neither duration nor deadline', () => {
    const d = def([trigger, waitNode('w'), step('b')], [e('trg', 'w'), e('w', 'b')]);
    expect(codesOf(d)).toContain('wait-node-missing-duration');
  });

  it('refuses a wait node declaring BOTH waitMinutes and waitUntil', () => {
    const d = def([trigger, waitNode('w', { waitMinutes: 5, waitUntil: '2026-07-06T09:00:00.000Z' }), step('b')], [e('trg', 'w'), e('w', 'b')]);
    expect(codesOf(d)).toContain('bad-wait-duration');
  });

  it(`bounds waitMinutes to 1..${MAX_WAIT_MINUTES}`, () => {
    for (const bad of [0, -1, 1.5, MAX_WAIT_MINUTES + 1, 'x' as unknown as number]) {
      const d = def([trigger, waitNode('w', { waitMinutes: bad }), step('b')], [e('trg', 'w'), e('w', 'b')]);
      expect(codesOf(d)).toContain('bad-wait-duration');
    }
  });

  it('refuses an unparseable waitUntil', () => {
    const d = def([trigger, waitNode('w', { waitUntil: 'not-a-time' }), step('b')], [e('trg', 'w'), e('w', 'b')]);
    expect(codesOf(d)).toContain('bad-wait-duration');
  });

  it('refuses wait fields on non-wait nodes', () => {
    const d = def([trigger, step('a', { waitMinutes: 5 } as Partial<WorkflowNode>)], [e('trg', 'a')]);
    expect(codesOf(d)).toContain('misplaced-wait-field');
  });

  it('refuses an actor on a wait node (it spawns nothing)', () => {
    const d = def(
      [trigger, { ...waitNode('w', { waitMinutes: 5 }), actor: { kind: 'engine', ref: 'codex' } }, step('b')],
      [e('trg', 'w'), e('w', 'b')],
    );
    expect(codesOf(d)).toContain('misplaced-actor');
  });
});
