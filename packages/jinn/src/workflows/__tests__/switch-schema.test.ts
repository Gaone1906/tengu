import { describe, it, expect } from 'vitest';
import {
  validateDefinition,
  WORKFLOW_DEFINITION_SCHEMA_VERSION,
  type EditableWorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from '../definition.js';
import { MAX_EDGE_CONDITIONS, type WorkflowCondition } from '../condition.js';

/**
 * GRS-016c schema suite — switch/fail node types and edge `when` conditions. All
 * additive (schemaVersion stays 1); the strictness mirrors the misplaced-* precedent:
 * a field on the wrong node type, a condition on a non-switch edge, or a malformed
 * condition must fail at authoring time, never silently degrade.
 */

const trigger: WorkflowNode = {
  id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' },
};
const step = (id: string, over: Partial<WorkflowNode> = {}): WorkflowNode =>
  ({ id, type: 'step', label: id.toUpperCase(), position: { x: 0, y: 0 }, actor: { kind: 'engine', ref: 'codex' }, ...over });
const switchNode = (id: string, over: Partial<WorkflowNode> = {}): WorkflowNode =>
  ({ id, type: 'switch', label: 'Route', position: { x: 0, y: 0 }, ...over });
const failNode = (id: string, message = 'stopped by policy', over: Partial<WorkflowNode> = {}): WorkflowNode =>
  ({ id, type: 'fail', label: 'Stop', position: { x: 0, y: 0 }, failMessage: message, ...over });

const e = (from: string, to: string, over: Partial<WorkflowEdge> = {}): WorkflowEdge =>
  ({ id: `e_${from}__${to}`, from, to, kind: 'sequence', ...over });

function def(nodes: WorkflowNode[], edges: WorkflowEdge[], over: Partial<EditableWorkflowDefinition> = {}): EditableWorkflowDefinition {
  return { schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION, id: 'wf', title: 'WF', version: 1, status: 'active', nodes, edges, ...over };
}

const verdictShip: WorkflowCondition = { path: 'steps.review.outcome.fields.verdict', op: 'eq', value: 'ship' };

/** The canonical GRS-016c shape: review → switch → (ship | fail). */
function switchDef(over: { when?: WorkflowCondition[]; switchOver?: Partial<WorkflowNode>; edges?: WorkflowEdge[] } = {}): EditableWorkflowDefinition {
  return def(
    [trigger, step('review'), switchNode('sw', over.switchOver), step('ship'), failNode('stop')],
    over.edges ?? [
      e('trg', 'review'),
      e('review', 'sw'),
      e('sw', 'ship', { when: over.when ?? [verdictShip] }),
      e('sw', 'stop'),
    ],
  );
}

const codes = (d: EditableWorkflowDefinition) => validateDefinition(d).errors.map((x) => x.code);

describe('switch/fail node validation', () => {
  it('accepts the canonical switch definition (and both switch modes)', () => {
    expect(validateDefinition(switchDef()).errors).toEqual([]);
    expect(validateDefinition(switchDef({ switchOver: { switchMode: 'firstMatch' } })).errors).toEqual([]);
    expect(validateDefinition(switchDef({ switchOver: { switchMode: 'allMatches' } })).errors).toEqual([]);
  });

  it('refuses a bad or misplaced switchMode', () => {
    expect(codes(switchDef({ switchOver: { switchMode: 'any' as never } }))).toContain('bad-switch-mode');
    const misplaced = switchDef();
    (misplaced.nodes.find((n) => n.id === 'review') as WorkflowNode).switchMode = 'firstMatch';
    expect(codes(misplaced)).toContain('misplaced-switch-mode');
  });

  it('a fail node requires a non-empty failMessage within the cap', () => {
    const missing = switchDef();
    delete (missing.nodes.find((n) => n.id === 'stop') as WorkflowNode).failMessage;
    expect(codes(missing)).toContain('fail-node-missing-message');
    expect(codes(def(
      [trigger, step('a'), failNode('stop', '   ')],
      [e('trg', 'a'), e('a', 'stop')],
    ))).toContain('fail-node-missing-message');
    expect(codes(def(
      [trigger, step('a'), failNode('stop', 'x'.repeat(600))],
      [e('trg', 'a'), e('a', 'stop')],
    ))).toContain('bad-fail-message');
  });

  it('failMessage anywhere else is misplaced', () => {
    const d = switchDef();
    (d.nodes.find((n) => n.id === 'review') as WorkflowNode).failMessage = 'nope';
    expect(codes(d)).toContain('misplaced-fail-message');
  });

  it('switch/fail nodes never carry an actor, and existing step-only fields stay refused on them', () => {
    expect(codes(switchDef({ switchOver: { actor: { kind: 'engine', ref: 'codex' } } }))).toContain('misplaced-actor');
    const d = switchDef();
    (d.nodes.find((n) => n.id === 'stop') as WorkflowNode).actor = { kind: 'engine', ref: 'codex' };
    expect(codes(d)).toContain('misplaced-actor');
    expect(codes(switchDef({ switchOver: { instructions: 'do it' } }))).toContain('misplaced-instructions');
    expect(codes(switchDef({ switchOver: { options: { model: 'opus' } } }))).toContain('misplaced-options');
    expect(codes(switchDef({ switchOver: { gates: [] } }))).toContain('misplaced-gates-field');
  });
});

describe('edge `when` validation', () => {
  it('when is only legal on an edge whose source is a switch node', () => {
    const d = switchDef();
    // move the condition onto the review→sw edge (source is a step)
    d.edges = [
      e('trg', 'review'),
      e('review', 'sw', { when: [verdictShip] }),
      e('sw', 'ship'),
      e('sw', 'stop'),
    ];
    expect(codes(d)).toContain('misplaced-edge-when');
  });

  it('when must be a non-empty array within the cap', () => {
    expect(codes(switchDef({ when: [] }))).toContain('bad-edge-condition');
    expect(codes(switchDef({ when: 'junk' as never }))).toContain('bad-edge-condition');
    expect(codes(switchDef({ when: Array.from({ length: MAX_EDGE_CONDITIONS + 1 }, () => verdictShip) }))).toContain('bad-edge-condition');
    expect(validateDefinition(switchDef({ when: Array.from({ length: MAX_EDGE_CONDITIONS }, () => verdictShip) })).ok).toBe(true);
  });

  it('each condition is shape-checked (op, value kinds, grammar) and its stepPath node must exist', () => {
    expect(codes(switchDef({ when: [{ path: 'steps.review.status', op: 'matches' as never, value: '.*' }] }))).toContain('bad-edge-condition');
    expect(codes(switchDef({ when: [{ path: 'steps.review.bogus', op: 'eq', value: 'x' } as never] }))).toContain('bad-edge-condition');
    expect(codes(switchDef({ when: [{ path: 'run.rounds', op: 'gt', value: '2' as never }] }))).toContain('bad-edge-condition');
    expect(codes(switchDef({ when: [{ path: 'steps.ghost.outcome.fields.verdict', op: 'eq', value: 'x' }] }))).toContain('bad-edge-condition');
    // run/trigger paths need no node
    expect(validateDefinition(switchDef({ when: [{ path: 'run.rounds', op: 'gte', value: 2 }] })).ok).toBe(true);
    expect(validateDefinition(switchDef({ when: [{ path: 'trigger.kind', op: 'eq', value: 'schedule' }] })).ok).toBe(true);
  });

  it('when on a loop edge declares deterministic loop exit conditions', () => {
    const loopExit: WorkflowCondition = { path: 'steps.b.outcome.fields.verdict', op: 'eq', value: 'ship' };
    const d = def(
      [trigger, step('a'), step('b')],
      [e('trg', 'a'), e('a', 'b'), { id: 'loop', from: 'b', to: 'a', kind: 'loop', when: [loopExit] } as WorkflowEdge],
      { loop: { maxRoundsPerRun: 2 } },
    );
    expect(validateDefinition(d).errors).toEqual([]);
  });

  it('a loop edge cannot declare both a legacy gate and field conditions', () => {
    const loopExit: WorkflowCondition = { path: 'steps.b.outcome.fields.verdict', op: 'eq', value: 'ship' };
    const d = def(
      [trigger, step('a'), step('b')],
      [e('trg', 'a'), e('a', 'b'), {
        id: 'loop',
        from: 'b',
        to: 'a',
        kind: 'loop',
        when: [loopExit],
        gate: { kind: 'flag', flag: 'approved', description: 'approved flag exists' },
      } as WorkflowEdge],
      { loop: { maxRoundsPerRun: 2 } },
    );
    expect(codes(d)).toContain('bad-edge-condition');
  });

  it('a loop edge whose source is a switch is refused', () => {
    const d = def(
      [trigger, step('a'), switchNode('sw')],
      [e('trg', 'a'), e('a', 'sw'), { id: 'loop', from: 'sw', to: 'a', kind: 'loop' } as WorkflowEdge],
      { loop: { maxRoundsPerRun: 2 } },
    );
    expect(codes(d)).toContain('unsupported-switch-loop');
  });
});

/* ── GRS-016c-fix — authoring-side hardening (Codex findings 1+2) ───────────── */

describe('hostile definitions are refused at validation, never at runtime', () => {
  it('a condition object with a throwing accessor is a validation ERROR, not a throw', () => {
    const hostile = Object.defineProperty(
      { path: 'steps.review.outcome.fields.verdict', value: 'ship' },
      'op',
      { get() { throw new Error('op getter'); } },
    );
    const d = switchDef({ when: [hostile as never] });
    expect(() => validateDefinition(d)).not.toThrow();
    expect(codes(d)).toContain('bad-edge-condition');
  });

  it('non-plain condition shapes and null values are refused (op must be the closed enum, value a scalar)', () => {
    expect(codes(switchDef({ when: [new (class C { path = 'run.status'; op = 'eq'; value = 'x' })() as never] }))).toContain('bad-edge-condition');
    expect(codes(switchDef({ when: [{ path: 'run.status', op: 'eq', value: null } as never] }))).toContain('bad-edge-condition');
  });

  it('prototype-shaped and non-charset node/edge ids are refused', () => {
    const badNode = (id: string) => codes(def(
      [trigger, step(id)],
      [e('trg', id)],
    ));
    for (const id of ['__proto__', 'constructor', 'prototype', 'a b', 'a:b', 'a/b', '.lead']) {
      expect(badNode(id), `node id ${id}`).toContain('unsafe-node-id');
    }
    // leading underscore stays legal — fromLinearDefinition mints "__trigger"
    expect(badNode('_ok')).toEqual([]);
    const badEdge = codes(def(
      [trigger, step('a'), step('b')],
      [e('trg', 'a'), { id: '__proto__', from: 'a', to: 'b', kind: 'sequence' } as WorkflowEdge],
    ));
    expect(badEdge).toContain('unsafe-edge-id');
  });

  it('plan id-keyed records are null-prototype and safe under Object.prototype-colliding ids', async () => {
    const { resolveExecutionPlan } = await import('../execution-plan.js');
    // 'toString'/'hasOwnProperty' pass the charset (plain letters) — the maps must
    // still behave as own-property records, never reading through the prototype.
    const d = def(
      [trigger, step('toString'), step('hasOwnProperty')],
      [e('trg', 'toString'), e('toString', 'hasOwnProperty')],
    );
    const r = resolveExecutionPlan(d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.getPrototypeOf(r.plan.predecessors)).toBeNull();
    expect(Object.getPrototypeOf(r.plan.inEdges)).toBeNull();
    expect(r.plan.predecessors['toString']).toEqual([]);
    expect(r.plan.predecessors['hasOwnProperty']).toEqual(['toString']);
    expect(r.plan.inEdges['hasOwnProperty']).toEqual([{ edgeId: 'e_toString__hasOwnProperty', from: 'toString' }]);
    expect(JSON.parse(JSON.stringify(r.plan.predecessors))).toEqual({ toString: [], hasOwnProperty: ['toString'] });
  });
});
