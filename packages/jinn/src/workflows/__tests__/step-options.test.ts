import { describe, it, expect } from 'vitest';
import {
  MAX_STEP_RETRY_ATTEMPTS,
  MAX_STEP_TIMEOUT_MINUTES,
  STEP_EFFORT_LEVELS,
  STEP_RETRY_CAUSES,
  validateDefinition,
  WORKFLOW_DEFINITION_SCHEMA_VERSION,
  type EditableWorkflowDefinition,
  type StepNodeOptions,
  type WorkflowEdge,
  type WorkflowNode,
} from '../definition.js';
import { resolveExecutionPlan, type ExecutionPlan } from '../execution-plan.js';

/**
 * GRS-016b — engine-node OPTIONS: schema validation + plan compilation.
 *
 * The options block is ADDITIVE (schemaVersion stays 1): a definition without it
 * validates and compiles exactly as before (pinned by the parallel-compat golden
 * suite); a definition WITH it must be validated strictly — a typo'd option must
 * surface at authoring time, never silently degrade to the default behavior.
 * Deferred members are refused BY NAME: output "none" and onError "error-edge"
 * both land with GRS-016d (error lanes) and are validation errors until then.
 */

const trigger: WorkflowNode = {
  id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' },
};
function step(id: string, over: Partial<WorkflowNode> = {}): WorkflowNode {
  return { id, type: 'step', label: id.toUpperCase(), position: { x: 0, y: 0 }, actor: { kind: 'engine', ref: 'codex' }, ...over };
}
function def(nodes: WorkflowNode[], edges: WorkflowEdge[], over: Partial<EditableWorkflowDefinition> = {}): EditableWorkflowDefinition {
  return { schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION, id: 'wf', title: 'WF', version: 1, status: 'active', nodes, edges, ...over };
}
const e = (from: string, to: string, kind: WorkflowEdge['kind'] = 'sequence'): WorkflowEdge =>
  ({ id: `e_${from}__${to}`, from, to, kind });

/** trigger→a→b with a's options injectable. */
function chain(options?: StepNodeOptions, over: Partial<WorkflowNode> = {}): EditableWorkflowDefinition {
  return def(
    [trigger, step('a', { ...(options ? { options } : {}), ...over }), step('b')],
    [e('trg', 'a'), e('a', 'b')],
  );
}

function codesOf(d: EditableWorkflowDefinition): string[] {
  return validateDefinition(d).errors.map((x) => x.code);
}

function plan(d: EditableWorkflowDefinition): ExecutionPlan {
  const resolved = resolveExecutionPlan(d);
  if (!resolved.ok) throw new Error(`fixture failed to compile: ${JSON.stringify(resolved.errors)}`);
  return resolved.plan;
}

/* ── Validation ─────────────────────────────────────────────────────────────── */

describe('step options — validation (GRS-016b)', () => {
  it('accepts a fully-populated valid options block', () => {
    const d = chain({
      model: 'opus',
      effort: 'high',
      output: 'full',
      retry: { maxAttempts: 3, on: ['error', 'timeout'] },
      onError: 'continue',
      timeoutMinutes: 30,
    });
    expect(validateDefinition(d).ok).toBe(true);
  });

  it('accepts every documented effort level and retry cause', () => {
    for (const effort of STEP_EFFORT_LEVELS) {
      expect(validateDefinition(chain({ effort })).ok).toBe(true);
    }
    for (const cause of STEP_RETRY_CAUSES) {
      expect(validateDefinition(chain({ retry: { maxAttempts: 2, on: [cause] } })).ok).toBe(true);
    }
  });

  it('refuses options on non-step nodes (misplaced-options)', () => {
    const opts: StepNodeOptions = { model: 'opus' };
    const onTrigger = def(
      [{ ...trigger, options: opts } as WorkflowNode, step('a')],
      [e('trg', 'a')],
    );
    expect(codesOf(onTrigger)).toContain('misplaced-options');
    const gateNode: WorkflowNode = {
      id: 'g', type: 'gate', label: 'G', position: { x: 0, y: 0 },
      gate: { kind: 'approval', description: 'approve', approvalRef: 'ap-g' },
      options: opts,
    } as WorkflowNode;
    const onGate = def([trigger, step('a'), gateNode], [e('trg', 'a'), e('a', 'g')]);
    expect(codesOf(onGate)).toContain('misplaced-options');
  });

  it('refuses options on an ACTORLESS step — inline steps spawn nothing, so options would be silently dropped', () => {
    const d = chain({ model: 'opus' }, { actor: undefined });
    expect(codesOf(d)).toContain('misplaced-options');
  });

  it('refuses a non-object options value and unknown option keys (strict, typo-proof)', () => {
    expect(codesOf(chain('full' as unknown as StepNodeOptions))).toContain('bad-step-options');
    expect(codesOf(chain(['full'] as unknown as StepNodeOptions))).toContain('bad-step-options');
    expect(codesOf(chain({ modle: 'opus' } as unknown as StepNodeOptions))).toContain('bad-step-options');
    // the 016e deferral is LIFTED: `session` is a known key now — this line pins
    // that the refusal-by-name is gone (grs016e-schema.test.ts owns its matrix).
    expect(codesOf(chain({ session: { mode: 'workflow' } } as unknown as StepNodeOptions))).toEqual([]);
  });

  it('validates model (non-empty string) and effort (closed enum)', () => {
    expect(codesOf(chain({ model: '' }))).toContain('bad-step-options');
    expect(codesOf(chain({ model: 42 as unknown as string }))).toContain('bad-step-options');
    expect(codesOf(chain({ effort: 'ultra' }))).toContain('bad-step-options');
    expect(codesOf(chain({ effort: 'HIGH' }))).toContain('bad-step-options');
  });

  it('validates output: handoff|full|none (the 016d deferral is lifted); unknown values refused', () => {
    expect(validateDefinition(chain({ output: 'handoff' })).ok).toBe(true);
    expect(validateDefinition(chain({ output: 'full' })).ok).toBe(true);
    // GRS-016d: "none" is now a shipped mode (fire-and-forget → `fired`).
    expect(validateDefinition(chain({ output: 'none' })).ok).toBe(true);
    expect(codesOf(chain({ output: 'raw' as unknown as StepNodeOptions['output'] }))).toContain('bad-step-options');
  });

  it('validates onError: fail-run|continue|error-edge (016d lanes shipped); unknown values refused', () => {
    expect(validateDefinition(chain({ onError: 'fail-run' })).ok).toBe(true);
    expect(validateDefinition(chain({ onError: 'continue' })).ok).toBe(true);
    // GRS-016d: "error-edge" is legal but requires an error-lane out-edge — the
    // pairing (both directions) is pinned in grs016d-schema.test.ts.
    expect(codesOf(chain({ onError: 'error-edge' }))).toEqual(['error-edge-missing-lane']);
    expect(codesOf(chain({ onError: 'ignore' as unknown as StepNodeOptions['onError'] }))).toContain('bad-step-options');
  });

  it('validates retry: maxAttempts integer 1..ceiling, on = non-empty unique known causes', () => {
    expect(validateDefinition(chain({ retry: { maxAttempts: 1, on: ['error'] } })).ok).toBe(true);
    expect(validateDefinition(chain({ retry: { maxAttempts: MAX_STEP_RETRY_ATTEMPTS, on: ['interrupted'] } })).ok).toBe(true);
    for (const bad of [0, -1, MAX_STEP_RETRY_ATTEMPTS + 1, 1.5, '2' as unknown as number]) {
      expect(codesOf(chain({ retry: { maxAttempts: bad, on: ['error'] } }))).toContain('bad-step-options');
    }
    expect(codesOf(chain({ retry: { maxAttempts: 2, on: [] } }))).toContain('bad-step-options');
    expect(codesOf(chain({ retry: { maxAttempts: 2, on: ['error', 'error'] } }))).toContain('bad-step-options');
    expect(codesOf(chain({ retry: { maxAttempts: 2, on: ['crash'] } as unknown as StepNodeOptions['retry'] }))).toContain('bad-step-options');
    expect(codesOf(chain({ retry: { maxAttempts: 2 } as unknown as StepNodeOptions['retry'] }))).toContain('bad-step-options');
    expect(codesOf(chain({ retry: 3 as unknown as StepNodeOptions['retry'] }))).toContain('bad-step-options');
  });

  it('validates timeoutMinutes: integer 1..MAX_STEP_TIMEOUT_MINUTES', () => {
    expect(validateDefinition(chain({ timeoutMinutes: 1 })).ok).toBe(true);
    expect(validateDefinition(chain({ timeoutMinutes: MAX_STEP_TIMEOUT_MINUTES })).ok).toBe(true);
    for (const bad of [0, -5, MAX_STEP_TIMEOUT_MINUTES + 1, 2.5, '10' as unknown as number]) {
      expect(codesOf(chain({ timeoutMinutes: bad }))).toContain('bad-step-options');
    }
  });
});

/* ── Compilation ────────────────────────────────────────────────────────────── */

describe('step options — plan compilation (GRS-016b)', () => {
  it('carries model/effort into the SpawnSpec and the policies onto the StepPlan', () => {
    const p = plan(chain({
      model: 'gpt-5.5',
      effort: 'xhigh',
      output: 'full',
      retry: { maxAttempts: 3, on: ['error'] },
      onError: 'continue',
      timeoutMinutes: 45,
    }));
    const a = p.steps.find((s) => s.nodeId === 'a')!;
    expect(a.spawn).toEqual({ actorKind: 'engine', actorRef: 'codex', model: 'gpt-5.5', effort: 'xhigh' });
    expect(a.retry).toEqual({ maxAttempts: 3, on: ['error'] });
    expect(a.onError).toBe('continue');
    expect(a.output).toBe('full');
    expect(a.timeoutMinutes).toBe(45);
  });

  it('emits NO option fields for an option-less step (the plan shape stays v2)', () => {
    const p = plan(chain());
    const a = p.steps.find((s) => s.nodeId === 'a')!;
    expect(a.spawn).toEqual({ actorKind: 'engine', actorRef: 'codex' });
    expect('retry' in a).toBe(false);
    expect('onError' in a).toBe(false);
    expect('output' in a).toBe(false);
    expect('timeoutMinutes' in a).toBe(false);
  });

  it('emits only the declared subset (partial options)', () => {
    const p = plan(chain({ timeoutMinutes: 5 }));
    const a = p.steps.find((s) => s.nodeId === 'a')!;
    expect(a.spawn).toEqual({ actorKind: 'engine', actorRef: 'codex' });
    expect(a.timeoutMinutes).toBe(5);
    expect('retry' in a).toBe(false);
    expect('output' in a).toBe(false);
    expect('onError' in a).toBe(false);
  });
});
