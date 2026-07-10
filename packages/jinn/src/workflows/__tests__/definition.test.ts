import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import type { WorkflowDefinition as LinearWorkflowDefinition } from '../derive.js';
import {
  type EditableWorkflowDefinition,
  WORKFLOW_DEFINITION_SCHEMA_VERSION,
  validateDefinition,
  serializeDefinition,
  parseDefinition,
  fromLinearDefinition,
} from '../definition.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** A minimal well-formed editable definition: trigger → step → step. */
function validDef(): EditableWorkflowDefinition {
  return {
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    id: 'demo',
    name: 'demo-workflow',
    title: 'Demo Workflow',
    version: 1,
    status: 'active',
    orchestrator: 'jimbo',
    nodes: [
      { id: 't', type: 'trigger', label: 'Every 2h', position: { x: 0, y: 0 }, trigger: { kind: 'schedule', cron: '0 */2 * * *' } },
      { id: 'a', type: 'step', label: 'Implement', position: { x: 0, y: 140 }, actor: { kind: 'engine', ref: 'claude' } },
      { id: 'b', type: 'step', label: 'Verify', position: { x: 0, y: 280 }, actor: { kind: 'engine', ref: 'codex' } },
    ],
    edges: [
      { id: 'e1', from: 't', to: 'a', kind: 'sequence' },
      { id: 'e2', from: 'a', to: 'b', kind: 'handoff' },
    ],
  };
}

describe('validateDefinition', () => {
  it('accepts a well-formed definition', () => {
    const r = validateDefinition(validDef());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it.each([
    'Full-Cycle-Workflow',
    'full_cycle_workflow',
    'full cycle workflow',
    '-full-cycle',
    'full-cycle-',
    'full--cycle',
    '',
  ])('rejects non-canonical workflow name %j', (name) => {
    const d = validDef();
    d.name = name;
    const r = validateDefinition(d);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain('bad-name');
  });

  it('rejects schedule cron, timezone, and until values that runtime cannot execute', () => {
    const invalidCron = validDef();
    invalidCron.nodes[0].trigger = { kind: 'schedule', cron: 'not a cron' };
    expect(validateDefinition(invalidCron).errors.map((e) => e.code)).toContain('trigger-schedule-bad-cron');

    const invalidTimezone = validDef();
    invalidTimezone.nodes[0].trigger = { kind: 'schedule', cron: '0 * * * *', timezone: 'Mars/Olympus' };
    expect(validateDefinition(invalidTimezone).errors.map((e) => e.code)).toContain('trigger-schedule-bad-timezone');

    const invalidUntil = validDef();
    invalidUntil.nodes[0].trigger = { kind: 'schedule', cron: '0 * * * *', until: 'eventually' };
    expect(validateDefinition(invalidUntil).errors.map((e) => e.code)).toContain('trigger-schedule-bad-until');

    const nonStringTimezone = validDef();
    (nonStringTimezone.nodes[0].trigger as { timezone?: unknown }).timezone = 7;
    expect(validateDefinition(nonStringTimezone).errors.map((e) => e.code)).toContain('trigger-schedule-bad-timezone');

    const nonStringCron = validDef();
    (nonStringCron.nodes[0].trigger as { cron?: unknown }).cron = 7;
    expect(validateDefinition(nonStringCron).errors.map((e) => e.code)).toContain('trigger-schedule-bad-cron');

    const nonStringUntil = validDef();
    (nonStringUntil.nodes[0].trigger as { until?: unknown }).until = 7;
    expect(validateDefinition(nonStringUntil).errors.map((e) => e.code)).toContain('trigger-schedule-bad-until');
  });

  it('rejects a missing trigger', () => {
    const d = validDef();
    d.nodes = d.nodes.filter((n) => n.type !== 'trigger');
    // 'a' now unreachable too, but the trigger error must be present.
    const r = validateDefinition(d);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain('missing-trigger');
  });

  it('rejects more than one trigger', () => {
    const d = validDef();
    d.nodes.push({ id: 't2', type: 'trigger', label: 'Manual', position: { x: 200, y: 0 }, trigger: { kind: 'manual' } });
    d.edges.push({ id: 'e3', from: 't2', to: 'b' });
    const r = validateDefinition(d);
    expect(r.errors.map((e) => e.code)).toContain('multiple-triggers');
  });

  it('rejects a step node carrying a singular gate field (misplaced-gate-field)', () => {
    const d = validDef();
    (d.nodes[1] as { gate?: unknown }).gate = { kind: 'flag', flag: 'x', description: 'on a step' };
    const r = validateDefinition(d);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain('misplaced-gate-field');
  });

  it('rejects a gate node carrying a gates[] array (misplaced-gates-field)', () => {
    const d = validDef();
    d.nodes.push({
      id: 'g',
      type: 'gate',
      label: 'Gate',
      position: { x: 0, y: 420 },
      gate: { kind: 'flag', flag: 'ok', description: 'the node gate' },
      gates: [{ kind: 'flag', flag: 'bad', description: 'array on a gate node' }],
    });
    d.edges.push({ id: 'e3', from: 'b', to: 'g', kind: 'sequence' });
    const r = validateDefinition(d);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain('misplaced-gates-field');
  });

  it('rejects duplicate node ids', () => {
    const d = validDef();
    d.nodes.push({ id: 'a', type: 'step', label: 'Dup', position: { x: 0, y: 420 }, actor: { kind: 'engine', ref: 'codex' } });
    const r = validateDefinition(d);
    expect(r.errors.map((e) => e.code)).toContain('duplicate-node-id');
  });

  it('rejects a dangling edge (missing from/to node)', () => {
    const d = validDef();
    d.edges.push({ id: 'bad', from: 'a', to: 'ghost' });
    const r = validateDefinition(d);
    const dangling = r.errors.find((e) => e.code === 'dangling-edge');
    expect(dangling?.ref).toBe('bad');
  });

  it('rejects a duplicate edge id', () => {
    const d = validDef();
    d.edges.push({ id: 'e1', from: 'a', to: 'b' });
    const r = validateDefinition(d);
    expect(r.errors.map((e) => e.code)).toContain('duplicate-edge-id');
  });

  it('rejects a self-loop', () => {
    const d = validDef();
    d.edges.push({ id: 'loop', from: 'b', to: 'b' });
    const r = validateDefinition(d);
    expect(r.errors.map((e) => e.code)).toContain('self-loop');
  });

  it('rejects an unreachable non-trigger node', () => {
    const d = validDef();
    d.nodes.push({ id: 'orphan', type: 'step', label: 'Orphan', position: { x: 400, y: 140 }, actor: { kind: 'engine', ref: 'grok' } });
    const r = validateDefinition(d);
    const orphan = r.errors.find((e) => e.code === 'unreachable-node');
    expect(orphan?.ref).toBe('orphan');
  });

  it('rejects an unknown node type', () => {
    const d = validDef();
    (d.nodes[1] as unknown as { type: string }).type = 'wormhole';
    const r = validateDefinition(d);
    expect(r.errors.map((e) => e.code)).toContain('unknown-node-type');
  });

  it('rejects an unknown actor kind and an empty actor ref', () => {
    const d = validDef();
    (d.nodes[1] as unknown as { actor: { kind: string; ref: string } }).actor = { kind: 'robot', ref: '' };
    const r = validateDefinition(d);
    const codes = r.errors.map((e) => e.code);
    expect(codes).toContain('unknown-actor-kind');
    expect(codes).toContain('empty-actor-ref');
  });

  it('rejects a bad version and bad status', () => {
    const d = validDef();
    d.version = 0;
    (d as unknown as { status: string }).status = 'live';
    const r = validateDefinition(d);
    const codes = r.errors.map((e) => e.code);
    expect(codes).toContain('bad-version');
    expect(codes).toContain('bad-status');
  });

  it('rejects a bad schema version', () => {
    const d = validDef();
    d.schemaVersion = 99;
    const r = validateDefinition(d);
    expect(r.errors.map((e) => e.code)).toContain('bad-schema-version');
  });

  it('rejects a gate node without a gate spec and a bad gate kind', () => {
    const d = validDef();
    d.nodes.push({ id: 'g1', type: 'gate', label: 'Tests pass', position: { x: 0, y: 420 } });
    d.edges.push({ id: 'eg', from: 'b', to: 'g1' });
    d.nodes.push({
      id: 'g2',
      type: 'gate',
      label: 'Bad gate',
      position: { x: 0, y: 560 },
      // @ts-expect-error deliberately invalid kind
      gate: { kind: 'telepathy', description: 'nope' },
    });
    d.edges.push({ id: 'eg2', from: 'g1', to: 'g2' });
    const r = validateDefinition(d);
    const codes = r.errors.map((e) => e.code);
    expect(codes).toContain('gate-node-missing-gate');
    expect(codes).toContain('bad-gate-kind');
  });

  it('rejects an unknown trigger kind and a schedule trigger missing cron', () => {
    const d = validDef();
    (d.nodes[0] as unknown as { trigger: { kind: string } }).trigger = { kind: 'webhook' };
    const r1 = validateDefinition(d);
    expect(r1.errors.map((e) => e.code)).toContain('bad-trigger-kind');

    const d2 = validDef();
    d2.nodes[0].trigger = { kind: 'schedule' }; // no cron
    const r2 = validateDefinition(d2);
    expect(r2.errors.map((e) => e.code)).toContain('trigger-schedule-missing-cron');
  });

  it('accepts the additive todo-status-change trigger kind with target status and filters', () => {
    const d = validDef();
    d.nodes[0].trigger = {
      kind: 'todo-status-change',
      toStatus: 'in_review',
      fromStatus: 'executing',
      filter: { source: 'human', department: 'platform', assignee: 'reviewer' },
    } as never;
    const r = validateDefinition(d);
    expect(r.ok).toBe(true);
  });

  it('rejects a todo-status-change trigger with no target status or an invalid status', () => {
    const missing = validDef();
    missing.nodes[0].trigger = { kind: 'todo-status-change' } as never;
    const bad = validDef();
    bad.nodes[0].trigger = { kind: 'todo-status-change', toStatus: 'reviewing' } as never;

    expect(validateDefinition(missing).errors.map((e) => e.code)).toContain('trigger-todo-missing-status');
    expect(validateDefinition(bad).errors.map((e) => e.code)).toContain('trigger-todo-bad-status');
  });

  it('rejects unknown or prototype-pollution keys in a todo-status-change trigger filter', () => {
    for (const key of ['unexpected', '__proto__', 'constructor', 'prototype']) {
      const d = validDef();
      d.nodes[0].trigger = {
        kind: 'todo-status-change',
        toStatus: 'in_review',
        filter: { source: 'human', [key]: 'hostile' },
      } as never;

      expect(validateDefinition(d).errors.map((e) => e.code)).toContain('trigger-todo-bad-filter');
    }
  });

  it('accepts step todoTransition and refuses it on non-step nodes or with invalid statuses', () => {
    const ok = validDef();
    ok.nodes[1].todoTransition = 'executing';
    expect(validateDefinition(ok).ok).toBe(true);

    const misplaced = validDef();
    misplaced.nodes[0].todoTransition = 'executing';
    expect(validateDefinition(misplaced).errors.map((e) => e.code)).toContain('misplaced-todo-transition');

    const bad = validDef();
    bad.nodes[1].todoTransition = 'reviewing' as never;
    expect(validateDefinition(bad).errors.map((e) => e.code)).toContain('bad-todo-transition');
  });

  it('rejects an unknown edge kind', () => {
    const d = validDef();
    (d.edges[1] as unknown as { kind: string }).kind = 'teleport';
    const r = validateDefinition(d);
    expect(r.errors.map((e) => e.code)).toContain('bad-edge-kind');
  });

  it('rejects a disconnected island even when its nodes have incoming edges (true reachability)', () => {
    const d = validDef();
    // Two nodes that point at each other but are never reached from the trigger.
    d.nodes.push({ id: 'p', type: 'step', label: 'P', position: { x: 400, y: 0 }, actor: { kind: 'engine', ref: 'grok' } });
    d.nodes.push({ id: 'q', type: 'step', label: 'Q', position: { x: 400, y: 140 }, actor: { kind: 'engine', ref: 'grok' } });
    d.edges.push({ id: 'pq', from: 'p', to: 'q' });
    d.edges.push({ id: 'qp', from: 'q', to: 'p' });
    const r = validateDefinition(d);
    const unreachable = r.errors.filter((e) => e.code === 'unreachable-node').map((e) => e.ref).sort();
    expect(unreachable).toEqual(['p', 'q']);
  });

  it('allows a reachable cycle (bounded loop back-edge)', () => {
    const d = validDef();
    d.edges.push({ id: 'back', from: 'b', to: 'a', kind: 'sequence' }); // b → a, both reachable
    const r = validateDefinition(d);
    expect(r.ok).toBe(true);
  });

  it('rejects impossible gates (kind-specific missing field) on nodes and runGates', () => {
    const d = validDef();
    d.nodes[1].gates = [{ kind: 'flag', description: 'no flag name' }]; // flag gate w/o flag
    d.runGates = [{ kind: 'artifact', description: 'no glob' }]; // artifact runGate w/o glob
    const r = validateDefinition(d);
    expect(r.errors.filter((e) => e.code === 'gate-missing-field').length).toBeGreaterThanOrEqual(2);
  });

  it('refuses duplicate approvalRefs across runGates — one ref must mean ONE gate (Codex GRS-014e finding 2)', () => {
    const d = validDef();
    d.runGates = [
      { kind: 'approval', description: 'first approval', approvalRef: 'same-ref' },
      { kind: 'approval', description: 'second approval', approvalRef: 'same-ref' },
    ];
    const r = validateDefinition(d);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === 'duplicate-rungate-ref' && e.ref === 'same-ref')).toBe(true);
  });

  it('distinct approvalRefs — and repeated refs on NON-approval runGates — stay valid', () => {
    const d = validDef();
    d.runGates = [
      { kind: 'approval', description: 'first approval', approvalRef: 'ref-1' },
      { kind: 'approval', description: 'second approval', approvalRef: 'ref-2' },
      // Non-approval gates never enter the resolve record (they cannot park) —
      // a repeated artifact glob is legitimate, not an identity collision.
      { kind: 'artifact', description: 'report exists', glob: 'reports/*.md' },
      { kind: 'artifact', description: 'report exists (postlude)', glob: 'reports/*.md' },
    ];
    expect(validateDefinition(d).ok).toBe(true);
  });

  it('collects ALL errors, not just the first', () => {
    const d = validDef();
    d.nodes = d.nodes.filter((n) => n.type !== 'trigger'); // missing-trigger + unreachable
    d.edges.push({ id: 'x', from: 'a', to: 'ghost' }); // dangling
    const r = validateDefinition(d);
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe('serialize/parse round-trip', () => {
  it('round-trips a valid definition through JSON', () => {
    const d = validDef();
    const parsed = parseDefinition(serializeDefinition(d));
    expect(parsed).toEqual(d);
  });

  it('parseDefinition throws on malformed JSON', () => {
    expect(() => parseDefinition('{ not json')).toThrow(/not valid JSON/);
  });

  it('parseDefinition throws on a schema-invalid definition', () => {
    const d = validDef();
    d.nodes = d.nodes.filter((n) => n.type !== 'trigger');
    expect(() => parseDefinition(serializeDefinition(d))).toThrow(/failed validation/);
  });
});

describe('fromLinearDefinition (migration)', () => {
  const linear: LinearWorkflowDefinition = {
    id: 'mini',
    title: 'Mini',
    version: 2,
    status: 'active',
    orchestrator: 'jimbo',
    trigger: { kind: 'schedule', cron: '0 */2 * * *', timezone: 'Europe/Sofia' },
    steps: [
      { id: 'select', title: 'Select', role: 'orchestrate', employee: 'jimbo' },
      { id: 'implement', title: 'Implement', role: 'implement', engine: 'claude', handoffTo: ['verify'] },
      { id: 'verify', title: 'Verify', role: 'verify', engine: 'codex' },
    ],
  };

  it('produces a valid graph from a linear definition', () => {
    const editable = fromLinearDefinition(linear);
    const r = validateDefinition(editable);
    expect(r.ok).toBe(true);
  });

  it('creates one trigger node + one step node per linear step', () => {
    const editable = fromLinearDefinition(linear);
    expect(editable.nodes.filter((n) => n.type === 'trigger')).toHaveLength(1);
    expect(editable.nodes.filter((n) => n.type === 'step')).toHaveLength(3);
    expect(editable.id).toBe('mini');
    expect(editable.version).toBe(2);
  });

  it('maps employee/engine to the right actor kind', () => {
    const editable = fromLinearDefinition(linear);
    const select = editable.nodes.find((n) => n.id === 'select');
    const implement = editable.nodes.find((n) => n.id === 'implement');
    expect(select?.actor).toEqual({ kind: 'employee', ref: 'jimbo' });
    expect(implement?.actor).toEqual({ kind: 'engine', ref: 'claude' });
  });

  it('does not emit a duplicate sequence edge when a handoff already covers the pair', () => {
    const editable = fromLinearDefinition(linear);
    // implement → verify is a declared handoff; there must be exactly one edge for that pair.
    const pair = editable.edges.filter((e) => e.from === 'implement' && e.to === 'verify');
    expect(pair).toHaveLength(1);
    expect(pair[0].kind).toBe('handoff');
  });

  it('connects the trigger to the first step and keeps the chain reachable', () => {
    const editable = fromLinearDefinition(linear);
    const fromTrigger = editable.edges.find((e) => e.from === editable.nodes[0].id);
    expect(fromTrigger?.to).toBe('select');
  });

  it('preserves ALL step gates (loss-free) and the loop metadata', () => {
    const withGatesAndLoop: LinearWorkflowDefinition = {
      id: 'g',
      title: 'G',
      version: 1,
      status: 'active',
      trigger: { kind: 'schedule', cron: '0 * * * *' },
      steps: [
        {
          id: 'verify',
          title: 'Verify',
          role: 'verify',
          engine: 'codex',
          gates: [
            { id: 'verify-report', kind: 'artifact', glob: 'reports/verification/*.md', description: 'report' },
            { id: 'verifier-flag', kind: 'flag', flag: 'independentVerifier', description: 'flag set' },
          ],
        },
      ],
      loop: { until: '2026-07-07T23:59:00+03:00', maxRoundsPerRun: 12, stopWhen: 'boundary' },
    };
    const editable = fromLinearDefinition(withGatesAndLoop);
    const verify = editable.nodes.find((n) => n.id === 'verify');
    expect(verify?.gates).toHaveLength(2);
    expect(editable.loop).toEqual(withGatesAndLoop.loop);
    expect(validateDefinition(editable).ok).toBe(true);
  });

  it('keeps a collision-safe trigger id when a step is literally named __trigger', () => {
    const collide: LinearWorkflowDefinition = {
      id: 'c',
      title: 'C',
      version: 1,
      status: 'active',
      trigger: { kind: 'manual' },
      steps: [{ id: '__trigger', title: 'Weirdly named', role: 'x', employee: 'jimbo' }],
    };
    const editable = fromLinearDefinition(collide);
    const ids = editable.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
    expect(validateDefinition(editable).ok).toBe(true);
  });
});

describe('sample workflow definition migrates + validates', () => {
  it('the committed fixture equals a fresh migration of the YAML and is valid', () => {
    const yamlPath = path.resolve(here, 'fixtures/sample-autonomy.workflow.yaml');
    const linear = yaml.load(fs.readFileSync(yamlPath, 'utf8')) as LinearWorkflowDefinition;
    const editable = fromLinearDefinition(linear);

    const r = validateDefinition(editable);
    expect(r.ok).toBe(true);
    // 1 trigger + 3 steps (plan, implement, verify).
    expect(editable.nodes.filter((n) => n.type === 'trigger')).toHaveLength(1);
    expect(editable.nodes.filter((n) => n.type === 'step')).toHaveLength(3);

    const fixturePath = path.resolve(here, 'fixtures/sample-autonomy.definition.json');
    const fixture = parseDefinition(fs.readFileSync(fixturePath, 'utf8'));
    expect(fixture).toEqual(editable);
  });
});

describe('loop edges (GRS-014e) — kind + exit gate validation', () => {
  const node = (id: string, type: 'trigger' | 'step' = 'step') => ({
    id, type, label: id.toUpperCase(), position: { x: 0, y: 0 },
    ...(type === 'trigger' ? { trigger: { kind: 'manual' as const } } : {}),
  });
  const edge = (from: string, to: string, kind: 'sequence' | 'loop' = 'sequence') =>
    ({ id: `e_${from}__${to}`, from, to, kind });
  const def = (nodes: unknown[], edges: unknown[]) => ({
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    id: 'wf', title: 'WF', version: 1, status: 'active', nodes, edges,
  }) as unknown as Parameters<typeof validateDefinition>[0];

  it('accepts kind:"loop" and a deterministic exit gate on it', () => {
    const d = def(
      [node('t', 'trigger'), node('a'), node('b')],
      [edge('t', 'a'), edge('a', 'b'), { ...edge('b', 'a', 'loop'), gate: { kind: 'artifact', glob: 'reports/done-*.md', description: 'done artifact exists' } }],
    );
    expect(validateDefinition(d).ok).toBe(true);
  });

  it('rejects a gate on a non-loop edge (misplaced-edge-gate)', () => {
    const d = def(
      [node('t', 'trigger'), node('a')],
      [{ ...edge('t', 'a'), gate: { kind: 'artifact', glob: 'x-*.md', description: 'x' } }],
    );
    const r = validateDefinition(d);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain('misplaced-edge-gate');
  });

  it('rejects an approval exit gate on a loop edge (continuation must be deterministic)', () => {
    const d = def(
      [node('t', 'trigger'), node('a'), node('b')],
      [edge('t', 'a'), edge('a', 'b'), { ...edge('b', 'a', 'loop'), gate: { kind: 'approval', approvalRef: 'boss', description: 'ok?' } }],
    );
    const r = validateDefinition(d);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain('bad-loop-gate-kind');
  });

  it('still validates the exit gate shape (artifact gate needs a glob)', () => {
    const d = def(
      [node('t', 'trigger'), node('a'), node('b')],
      [edge('t', 'a'), edge('a', 'b'), { ...edge('b', 'a', 'loop'), gate: { kind: 'artifact', description: 'no glob' } }],
    );
    const r = validateDefinition(d);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain('gate-missing-field');
  });
});
