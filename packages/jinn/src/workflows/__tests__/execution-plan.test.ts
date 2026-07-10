import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type EditableWorkflowDefinition,
  WORKFLOW_DEFINITION_SCHEMA_VERSION,
} from '../definition.js';
import { resolveExecutionPlan } from '../execution-plan.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_DEF = path.resolve(
  here,
  'fixtures/sample-autonomy.definition.json',
);

/** A minimal well-formed editable definition: trigger → step → step. */
function validDef(): EditableWorkflowDefinition {
  return {
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    id: 'demo',
    title: 'Demo Workflow',
    version: 3,
    status: 'active',
    orchestrator: 'jimbo',
    nodes: [
      {
        id: 't',
        type: 'trigger',
        label: 'Every 2h',
        position: { x: 0, y: 0 },
        trigger: { kind: 'schedule', cron: '0 */2 * * *', timezone: 'Europe/Sofia', cronJobId: 'demo-job' },
      },
      { id: 'a', type: 'step', label: 'Implement', position: { x: 0, y: 140 }, actor: { kind: 'engine', ref: 'claude' }, role: 'implement' },
      { id: 'b', type: 'step', label: 'Verify', position: { x: 0, y: 280 }, actor: { kind: 'engine', ref: 'codex' } },
    ],
    edges: [
      { id: 'e1', from: 't', to: 'a', kind: 'sequence' },
      { id: 'e2', from: 'a', to: 'b', kind: 'handoff' },
    ],
  };
}

describe('resolveExecutionPlan — happy path', () => {
  it('compiles a well-formed definition into a plan', () => {
    const r = resolveExecutionPlan(validDef());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.workflowId).toBe('demo');
    expect(r.plan.version).toBe(3);
    // Trigger maps to a cron-job shape.
    expect(r.plan.trigger).toMatchObject({
      kind: 'schedule',
      cron: '0 */2 * * *',
      timezone: 'Europe/Sofia',
      cronJobId: 'demo-job',
      declaresCronJobId: true,
    });
    // Steps in declaration order, each with a spawn spec.
    expect(r.plan.stepOrder).toBe('declaration');
    expect(r.plan.steps.map((s) => s.nodeId)).toEqual(['a', 'b']);
    expect(r.plan.steps[0].spawn).toEqual({ actorKind: 'engine', actorRef: 'claude' });
    expect(r.plan.steps[0].role).toBe('implement');
    expect(r.plan.gateNodes).toEqual([]);
    expect(r.plan.hasApprovalGate).toBe(false);
  });

  it('marks a schedule trigger without a cronJobId as not declaring one', () => {
    const d = validDef();
    delete d.nodes[0].trigger!.cronJobId;
    const r = resolveExecutionPlan(d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.trigger.declaresCronJobId).toBe(false);
    expect(r.plan.trigger.cronJobId).toBeUndefined();
  });

  it('rejects a non-string optional schedule field before plan resolution', () => {
    const d = validDef();
    // A hand-crafted def with a bad optional field the validator does not type-check.
    (d.nodes[0].trigger as { timezone?: unknown }).timezone = 123;
    const r = resolveExecutionPlan(d);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toContainEqual(expect.objectContaining({
      code: 'definition-invalid',
      message: expect.stringContaining('trigger-schedule-bad-timezone'),
    }));
  });

  it('treats a manual trigger as not declaring a cron job', () => {
    const d = validDef();
    d.nodes[0].trigger = { kind: 'manual' };
    const r = resolveExecutionPlan(d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.trigger).toMatchObject({ kind: 'manual', declaresCronJobId: false });
    expect(r.plan.trigger.cron).toBeUndefined();
  });

  it('carries a todo-status-change trigger without schedule-only fields', () => {
    const d = validDef();
    d.nodes[0].trigger = { kind: 'todo-status-change', toStatus: 'in_review' } as never;
    const r = resolveExecutionPlan(d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.trigger).toEqual({
      kind: 'todo-status-change',
      toStatus: 'in_review',
      declaresCronJobId: false,
    });
  });

  it('strips schedule-only fields from a manual trigger (no contradictory cronJobId)', () => {
    const d = validDef();
    // A manual trigger carrying a stray cronJobId must not leak into the plan.
    d.nodes[0].trigger = { kind: 'manual', cronJobId: 'stray', cron: '* * * * *' } as never;
    const r = resolveExecutionPlan(d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.trigger.cronJobId).toBeUndefined();
    expect(r.plan.trigger.cron).toBeUndefined();
    expect(r.plan.trigger.declaresCronJobId).toBe(false);
  });

  it('rejects a step carrying a misplaced singular gate as definition-invalid (never silently dropped)', () => {
    const d = validDef();
    // A step with a singular `gate` (belongs on gate nodes) must be a validation error,
    // not a silently dropped approval. This closes the round-2 drop class at the source.
    (d.nodes[1] as { gate?: unknown }).gate = { kind: 'approval', approvalRef: 'x', description: 'sneaky approval' };
    const r = resolveExecutionPlan(d);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.every((e) => e.code === 'definition-invalid')).toBe(true);
    expect(r.errors.some((e) => e.message.startsWith('misplaced-gate-field'))).toBe(true);
  });

  it('resolves a step with no actor to a null spawn (orchestrator-inline), not an error', () => {
    const d = validDef();
    // Make 'b' actorless (like an inline review node).
    delete d.nodes[2].actor;
    const r = resolveExecutionPlan(d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = r.plan.steps.find((s) => s.nodeId === 'b')!;
    expect(b.spawn).toBeNull();
  });
});

describe('resolveExecutionPlan — gate evaluators', () => {
  it('maps artifact/flag/approval gates to their evaluators, and approval parks the run', () => {
    const d = validDef();
    d.nodes[1].gates = [
      { id: 'g-art', kind: 'artifact', glob: 'reports/x-*.md', description: 'report exists' },
      { id: 'g-flag', kind: 'flag', flag: 'tested', description: 'tests ran' },
    ];
    d.nodes[2].gates = [
      { id: 'g-appr', kind: 'approval', approvalRef: 'merge', description: 'human approves merge' },
    ];
    const r = resolveExecutionPlan(d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const stepA = r.plan.steps.find((s) => s.nodeId === 'a')!;
    expect(stepA.gates).toEqual([
      { id: 'g-art', kind: 'artifact', evaluator: 'artifact-glob', blocking: false, ref: 'reports/x-*.md', description: 'report exists' },
      { id: 'g-flag', kind: 'flag', evaluator: 'state-flag', blocking: false, ref: 'tested', description: 'tests ran' },
    ]);
    expect(stepA.parksOnApproval).toBe(false);

    const stepB = r.plan.steps.find((s) => s.nodeId === 'b')!;
    expect(stepB.gates[0]).toMatchObject({ kind: 'approval', evaluator: 'human-approval', blocking: true, ref: 'merge' });
    expect(stepB.parksOnApproval).toBe(true);

    // Any blocking gate anywhere flips the workflow-level flag.
    expect(r.plan.hasApprovalGate).toBe(true);
  });

  it('compiles standalone gate NODES (not just inline step gates) and counts their approvals', () => {
    // A graph: trigger → step → approval gate node → step. The gate node must NOT be dropped.
    const d: EditableWorkflowDefinition = {
      schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
      id: 'gatenode',
      title: 'Gate node graph',
      version: 1,
      status: 'active',
      nodes: [
        { id: 't', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' } },
        { id: 's', type: 'step', label: 'Do work', position: { x: 0, y: 140 }, actor: { kind: 'employee', ref: 'jimbo' } },
        { id: 'g', type: 'gate', label: 'Await merge', position: { x: 0, y: 280 }, gate: { id: 'gate-merge', kind: 'approval', approvalRef: 'merge', description: 'operator approves merge' } },
        { id: 's2', type: 'step', label: 'Ship', position: { x: 0, y: 420 }, actor: { kind: 'employee', ref: 'jimbo' } },
      ],
      edges: [
        { id: 'e1', from: 't', to: 's', kind: 'sequence' },
        { id: 'e2', from: 's', to: 'g', kind: 'sequence' },
        { id: 'e3', from: 'g', to: 's2', kind: 'sequence' },
      ],
    };
    const r = resolveExecutionPlan(d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.gateNodes).toHaveLength(1);
    expect(r.plan.gateNodes[0]).toMatchObject({
      nodeId: 'g',
      label: 'Await merge',
      kind: 'approval',
      evaluator: 'human-approval',
      blocking: true,
      ref: 'merge',
    });
    // The gate node's approval flips the workflow-level flag even though no STEP has an approval.
    expect(r.plan.hasApprovalGate).toBe(true);
    // Gate nodes are not steps.
    expect(r.plan.steps.map((s) => s.nodeId)).toEqual(['s', 's2']);
  });

  it('flips hasApprovalGate when a run-level gate is an approval', () => {
    const d = validDef();
    d.runGates = [{ kind: 'approval', approvalRef: 'release', description: 'human approves release' }];
    const r = resolveExecutionPlan(d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.runGates[0]).toMatchObject({ evaluator: 'human-approval', blocking: true });
    expect(r.plan.hasApprovalGate).toBe(true);
  });
});

describe('resolveExecutionPlan — execution errors', () => {
  it('returns definition-invalid (flat) for a structurally broken graph', () => {
    const d = validDef();
    d.nodes = d.nodes.filter((n) => n.type !== 'trigger'); // no trigger
    const r = resolveExecutionPlan(d);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.every((e) => e.code === 'definition-invalid')).toBe(true);
    // The underlying validation code is preserved in the message for the editor.
    expect(r.errors.some((e) => e.message.startsWith('missing-trigger'))).toBe(true);
  });

  it('reports no-executable-steps for a trigger-only workflow', () => {
    const d: EditableWorkflowDefinition = {
      schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
      id: 'empty',
      title: 'Trigger only',
      version: 1,
      status: 'active',
      nodes: [{ id: 't', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' } }],
      edges: [],
    };
    const r = resolveExecutionPlan(d);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.code)).toContain('no-executable-steps');
  });

  it('reports unknown-actor / unknown-engine only when a roster is injected', () => {
    const d = validDef(); // step a → engine claude, step b → engine codex
    d.nodes[1].actor = { kind: 'employee', ref: 'ghost' };

    // No roster → structural resolve, no roster error.
    expect(resolveExecutionPlan(d).ok).toBe(true);

    // Employee roster missing "ghost" → unknown-actor.
    const withEmp = resolveExecutionPlan(d, { knownEmployees: ['jimbo', 'fable-guide'] });
    expect(withEmp.ok).toBe(false);
    if (withEmp.ok) return;
    expect(withEmp.errors.map((e) => e.code)).toContain('unknown-actor');
    expect(withEmp.errors.find((e) => e.code === 'unknown-actor')?.ref).toBe('a');

    // Engine roster missing "codex" → unknown-engine on step b.
    const d2 = validDef();
    const withEng = resolveExecutionPlan(d2, { knownEngines: ['claude'] });
    expect(withEng.ok).toBe(false);
    if (withEng.ok) return;
    expect(withEng.errors.map((e) => e.code)).toContain('unknown-engine');
  });

  it('accepts known actors when the roster contains them', () => {
    const d = validDef();
    const r = resolveExecutionPlan(d, { knownEngines: ['claude', 'codex', 'grok'] });
    expect(r.ok).toBe(true);
  });
});

describe('resolveExecutionPlan — sample fixture', () => {
  it('compiles the migrated sample definition into a full plan', () => {
    const def = JSON.parse(fs.readFileSync(SAMPLE_DEF, 'utf-8')) as EditableWorkflowDefinition;
    const r = resolveExecutionPlan(def);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.plan.workflowId).toBe('sample-autonomy');
    expect(r.plan.trigger).toMatchObject({
      kind: 'manual',
    });
    expect(r.plan.gateNodes).toEqual([]);
    expect(r.plan.steps).toHaveLength(3);
    expect(r.plan.steps.map((s) => s.nodeId)).toEqual([
      'plan', 'implement', 'verify',
    ]);
    // "implement" runs on the claude engine.
    expect(r.plan.steps.find((s) => s.nodeId === 'implement')!.spawn).toEqual({ actorKind: 'engine', actorRef: 'claude' });
    expect(r.plan.steps.find((s) => s.nodeId === 'plan')!.spawn).toEqual({ actorKind: 'employee', actorRef: 'ops-lead' });
    expect(r.plan.hasApprovalGate).toBe(true);
  });
});

describe('bounded loop compilation (GRS-014e)', () => {
  function loopDef(over: {
    loopEdge?: Record<string, unknown>;
    loop?: Record<string, unknown> | undefined;
    extraEdges?: Record<string, unknown>[];
  } = {}): EditableWorkflowDefinition {
    const d = validDef();
    d.nodes.push({ id: 'c', type: 'step', label: 'Rework check', position: { x: 0, y: 420 }, actor: { kind: 'engine', ref: 'codex' } });
    d.edges = [
      { id: 'e1', from: 't', to: 'a', kind: 'sequence' },
      { id: 'e2', from: 'a', to: 'b', kind: 'handoff' },
      { id: 'e3', from: 'b', to: 'c', kind: 'sequence' },
      (over.loopEdge ?? { id: 'lp', from: 'c', to: 'a', kind: 'loop' }) as never,
      ...((over.extraEdges ?? []) as never[]),
    ];
    if ('loop' in over) {
      if (over.loop) d.loop = over.loop as never;
    } else {
      d.loop = { maxRoundsPerRun: 3 };
    }
    return d;
  }

  it('compiles a bounded loop with its exit gate into plan.loop', () => {
    const r = resolveExecutionPlan(loopDef({
      loopEdge: { id: 'lp', from: 'c', to: 'a', kind: 'loop', gate: { kind: 'artifact', glob: 'reports/approved-*.md', description: 'approved artifact' } },
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.loop).toEqual({
      edgeId: 'lp',
      sourceId: 'c',
      targetId: 'a',
      maxRoundsPerRun: 3,
      exitGate: expect.objectContaining({ kind: 'artifact', evaluator: 'artifact-glob', blocking: false, ref: 'reports/approved-*.md' }),
      // GRS-016a-fix: loop membership by REACHABILITY, compiled into the plan —
      // the body is the a→b→c path; nothing follows the source, so postLoop is empty.
      segmentNodeIds: ['a', 'b', 'c'],
      postLoopNodeIds: [],
    });
  });

  it('a loop-less definition compiles with loop:null', () => {
    const r = resolveExecutionPlan(validDef());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.loop).toBeNull();
  });

  it('refuses a loop edge with no maxRoundsPerRun (loop-unbounded — design D4 default-refuse)', () => {
    const r = resolveExecutionPlan(loopDef({ loop: undefined }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain('loop-unbounded');

    const zero = resolveExecutionPlan(loopDef({ loop: { maxRoundsPerRun: 0 } }));
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.errors.map((e) => e.code)).toContain('loop-unbounded');
  });

  it('refuses more than one loop edge (unsupported-multiple-loops)', () => {
    const r = resolveExecutionPlan(loopDef({ extraEdges: [{ id: 'lp2', from: 'b', to: 'a', kind: 'loop' }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain('unsupported-multiple-loops');
  });

  it('refuses a FORWARD "loop" edge (invalid-loop-edge — the segment must point backward)', () => {
    const r = resolveExecutionPlan(loopDef({ loopEdge: { id: 'lp', from: 'a', to: 'c', kind: 'loop' } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain('invalid-loop-edge');
  });

  it('refuses a loop edge targeting the trigger (a trigger cannot be re-run)', () => {
    const r = resolveExecutionPlan(loopDef({ loopEdge: { id: 'lp', from: 'c', to: 't', kind: 'loop' } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain('invalid-loop-edge');
  });
});
