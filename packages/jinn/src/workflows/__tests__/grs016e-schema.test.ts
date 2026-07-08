import { describe, it, expect } from 'vitest';
import {
  validateDefinition,
  WORKFLOW_DEFINITION_SCHEMA_VERSION,
  type EditableWorkflowDefinition,
  type StepNodeOptions,
  type WorkflowEdge,
  type WorkflowNode,
} from '../definition.js';
import { resolveExecutionPlan } from '../execution-plan.js';

/**
 * GRS-016e schema tier — the `options.session` block (fresh | workflow | existing).
 *
 * Contract under test:
 *   - the three modes validate; `existing` REQUIRES a sessionId, the others refuse one;
 *   - unknown modes/keys are refused loudly (never silently ignored);
 *   - cross-field refusals: follow-up modes (workflow/existing) refuse output:'none',
 *     timeoutMinutes, model, and effort — each would be silently inert or unsafe
 *     against a session the workflow does not own;
 *   - all workflow-mode steps in one definition must declare the SAME actor
 *     (`workflow-shared-actor-mismatch`) — the shared session is created by whichever
 *     workflow-mode node dispatches first, so a differing actor would be silently ignored;
 *   - the compiled plan carries sessionMode/sessionTarget only when declared —
 *     an option-less step's plan keeps the exact v2 shape.
 */

const trigger: WorkflowNode = {
  id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' },
};
const step = (id: string, over: Partial<WorkflowNode> = {}): WorkflowNode =>
  ({ id, type: 'step', label: id.toUpperCase(), position: { x: 0, y: 0 }, actor: { kind: 'engine', ref: 'codex' }, ...over });
const e = (from: string, to: string, over: Partial<WorkflowEdge> = {}): WorkflowEdge =>
  ({ id: `e_${from}__${to}`, from, to, kind: 'sequence', ...over });

function makeDef(nodes: WorkflowNode[], edges: WorkflowEdge[]): EditableWorkflowDefinition {
  return { schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION, id: 'wf016e', title: 'wf016e', version: 1, status: 'active', nodes, edges };
}
function chainDef(options: StepNodeOptions): EditableWorkflowDefinition {
  return makeDef([trigger, step('a', { options })], [e('trg', 'a')]);
}
const codesOf = (def: EditableWorkflowDefinition) => {
  const r = validateDefinition(def);
  return r.ok ? [] : r.errors.map((x) => x.code);
};
const messagesOf = (def: EditableWorkflowDefinition) => {
  const r = validateDefinition(def);
  return r.ok ? [] : r.errors.map((x) => x.message);
};

describe('GRS-016e session option validation', () => {
  it('accepts all three declared modes (existing with a sessionId)', () => {
    expect(codesOf(chainDef({ session: { mode: 'fresh' } }))).toEqual([]);
    expect(codesOf(chainDef({ session: { mode: 'workflow' } }))).toEqual([]);
    expect(codesOf(chainDef({ session: { mode: 'existing', sessionId: 'op-123' } }))).toEqual([]);
  });

  it('refuses a non-object session and unknown modes/keys', () => {
    expect(codesOf(chainDef({ session: 'workflow' as unknown as StepNodeOptions['session'] }))).toContain('bad-step-options');
    expect(codesOf(chainDef({ session: { mode: 'shared' } as unknown as StepNodeOptions['session'] }))).toContain('bad-step-options');
    expect(codesOf(chainDef({ session: {} as unknown as StepNodeOptions['session'] }))).toContain('bad-step-options');
    expect(codesOf(chainDef({ session: { mode: 'fresh', turbo: true } as unknown as StepNodeOptions['session'] }))).toContain('bad-step-options');
  });

  it("mode 'existing' requires a non-empty string sessionId; other modes refuse one", () => {
    expect(codesOf(chainDef({ session: { mode: 'existing' } as unknown as StepNodeOptions['session'] }))).toContain('bad-step-options');
    expect(codesOf(chainDef({ session: { mode: 'existing', sessionId: '  ' } }))).toContain('bad-step-options');
    expect(codesOf(chainDef({ session: { mode: 'existing', sessionId: 42 } as unknown as StepNodeOptions['session'] }))).toContain('bad-step-options');
    expect(codesOf(chainDef({ session: { mode: 'fresh', sessionId: 'op-1' } }))).toContain('bad-step-options');
    expect(codesOf(chainDef({ session: { mode: 'workflow', sessionId: 'op-1' } }))).toContain('bad-step-options');
  });

  it("follow-up modes refuse output:'none' (an unawaited turn would break marker serialization)", () => {
    expect(codesOf(chainDef({ session: { mode: 'workflow' }, output: 'none' }))).toContain('bad-step-options');
    expect(codesOf(chainDef({ session: { mode: 'existing', sessionId: 'op-1' }, output: 'none' }))).toContain('bad-step-options');
    // fresh keeps the 016d behavior — none stays legal
    expect(codesOf(chainDef({ session: { mode: 'fresh' }, output: 'none' }))).toEqual([]);
  });

  it('follow-up modes refuse timeoutMinutes (the stop would kill a session the workflow does not own)', () => {
    expect(codesOf(chainDef({ session: { mode: 'workflow' }, timeoutMinutes: 5 }))).toContain('bad-step-options');
    expect(codesOf(chainDef({ session: { mode: 'existing', sessionId: 'op-1' }, timeoutMinutes: 5 }))).toContain('bad-step-options');
    expect(codesOf(chainDef({ session: { mode: 'fresh' }, timeoutMinutes: 5 }))).toEqual([]);
  });

  it('follow-up modes refuse model/effort overrides (silently-inert config: the target session already has an engine + model)', () => {
    expect(codesOf(chainDef({ session: { mode: 'workflow' }, model: 'opus' }))).toContain('bad-step-options');
    expect(codesOf(chainDef({ session: { mode: 'workflow' }, effort: 'high' }))).toContain('bad-step-options');
    expect(codesOf(chainDef({ session: { mode: 'existing', sessionId: 'op-1' }, model: 'opus' }))).toContain('bad-step-options');
    expect(codesOf(chainDef({ session: { mode: 'existing', sessionId: 'op-1' }, effort: 'high' }))).toContain('bad-step-options');
    expect(codesOf(chainDef({ session: { mode: 'fresh' }, model: 'opus', effort: 'high' }))).toEqual([]);
  });

  it('retry stays legal on follow-up modes (a repost is the retry)', () => {
    expect(codesOf(chainDef({ session: { mode: 'workflow' }, retry: { maxAttempts: 3, on: ['error'] } }))).toEqual([]);
    expect(codesOf(chainDef({ session: { mode: 'existing', sessionId: 'op-1' }, retry: { maxAttempts: 2, on: ['interrupted'] } }))).toEqual([]);
  });

  it('all workflow-mode steps must share ONE actor (workflow-shared-actor-mismatch)', () => {
    const mismatched = makeDef([
      trigger,
      step('a', { options: { session: { mode: 'workflow' } } }),
      step('b', { actor: { kind: 'engine', ref: 'claude' }, options: { session: { mode: 'workflow' } } }),
    ], [e('trg', 'a'), e('a', 'b')]);
    expect(codesOf(mismatched)).toContain('workflow-shared-actor-mismatch');

    const matched = makeDef([
      trigger,
      step('a', { options: { session: { mode: 'workflow' } } }),
      step('b', { options: { session: { mode: 'workflow' } } }),
    ], [e('trg', 'a'), e('a', 'b')]);
    expect(codesOf(matched)).toEqual([]);

    // A fresh-mode step with a different actor is unaffected — the rule binds
    // workflow-mode steps only.
    const mixed = makeDef([
      trigger,
      step('a', { options: { session: { mode: 'workflow' } } }),
      step('c', { actor: { kind: 'engine', ref: 'claude' } }),
    ], [e('trg', 'a'), e('a', 'c')]);
    expect(codesOf(mixed)).toEqual([]);
  });

  it('the actor-mismatch message names both nodes', () => {
    const mismatched = makeDef([
      trigger,
      step('a', { options: { session: { mode: 'workflow' } } }),
      step('b', { actor: { kind: 'employee', ref: 'jimbo' }, options: { session: { mode: 'workflow' } } }),
    ], [e('trg', 'a'), e('a', 'b')]);
    const messages = messagesOf(mismatched).join('\n');
    expect(messages).toContain('"a"');
    expect(messages).toContain('"b"');
  });
});

describe('GRS-016e plan compilation', () => {
  it('copies sessionMode + sessionTarget onto the step plan when declared', () => {
    const def = makeDef([
      trigger,
      step('a', { options: { session: { mode: 'workflow' } } }),
      step('b', { options: { session: { mode: 'workflow' } } }),
      step('c', { options: { session: { mode: 'existing', sessionId: 'op-9' } } }),
      step('d'),
    ], [e('trg', 'a'), e('a', 'b'), e('b', 'c'), e('c', 'd')]);
    const resolved = resolveExecutionPlan(def);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const byId = new Map(resolved.plan.steps.map((s) => [s.nodeId, s]));
    expect(byId.get('a')!.sessionMode).toBe('workflow');
    expect(byId.get('c')!.sessionMode).toBe('existing');
    expect(byId.get('c')!.sessionTarget).toBe('op-9');
    // Option-less step: the exact v2 plan shape — neither key exists.
    expect('sessionMode' in byId.get('d')!).toBe(false);
    expect('sessionTarget' in byId.get('d')!).toBe(false);
  });

  it("a declared 'fresh' mode compiles to sessionMode:'fresh' with no target", () => {
    const def = makeDef([trigger, step('a', { options: { session: { mode: 'fresh' } } })], [e('trg', 'a')]);
    const resolved = resolveExecutionPlan(def);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.plan.steps[0].sessionMode).toBe('fresh');
    expect('sessionTarget' in resolved.plan.steps[0]).toBe(false);
  });
});
