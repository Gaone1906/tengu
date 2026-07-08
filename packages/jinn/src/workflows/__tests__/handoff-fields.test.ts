import { describe, it, expect } from 'vitest';
import {
  MAX_HANDOFF_FIELDS,
  buildStepPrompt,
  extractHandoff,
  referencedHandoffFieldKeys,
  type StepPromptContext,
} from '../handoff.js';
import {
  WORKFLOW_DEFINITION_SCHEMA_VERSION,
  type EditableWorkflowDefinition,
  type WorkflowNode,
} from '../definition.js';

/**
 * GRS-016c handoff `fields` suite — the machine-readable enabler for Switch/IF
 * routing. A step may declare a flat scalar map in its ```handoff block; it is
 * parsed deterministically, bounded, hostile-key-proof, persisted on the outcome,
 * and advertised in the step prompt when (and only when) a downstream switch
 * references the node.
 */

const block = (json: string) => `did the work\n\n\`\`\`handoff\n${json}\n\`\`\`\n`;

describe('extractHandoff — declared fields', () => {
  it('parses flat scalar fields alongside summary/artifacts/notes', () => {
    const out = extractHandoff(block(
      '{ "summary": "reviewed", "fields": { "verdict": "ship", "bugCount": 3, "needsHuman": false } }',
    ));
    expect(out.extractedFrom).toBe('handoff-block');
    expect(out.summary).toBe('reviewed');
    expect(out.fields).toEqual({ verdict: 'ship', bugCount: 3, needsHuman: false });
  });

  it('a block declaring ONLY fields is a usable declared handoff', () => {
    const out = extractHandoff(block('{ "fields": { "verdict": "reject" } }'));
    expect(out.extractedFrom).toBe('handoff-block');
    expect(out.fields).toEqual({ verdict: 'reject' });
    expect(out.summary).toBeUndefined();
  });

  it('absent fields member → no fields key on the outcome (v2 byte-shape)', () => {
    const out = extractHandoff(block('{ "summary": "reviewed" }'));
    expect(out.extractedFrom).toBe('handoff-block');
    expect('fields' in out).toBe(false);
  });

  it('drops hostile/malformed keys: bad charset, over-length, prototype-shaped, nested paths', () => {
    const out = extractHandoff(block(JSON.stringify({
      summary: 's',
      fields: {
        ok: 'yes',
        'has space': 'dropped',
        'dotted.key': 'dropped',
        ['k'.repeat(65)]: 'dropped',
        '__proto__': 'dropped',
        'constructor': 'dropped',
        '-lead': 'dropped',
        '': 'dropped',
      },
    })));
    expect(out.fields).toEqual({ ok: 'yes' });
  });

  it('drops non-scalar and non-finite values; sanitizes + caps string values', () => {
    const out = extractHandoff(block(JSON.stringify({
      fields: {
        obj: { nested: true },
        arr: [1, 2],
        nil: null,
        inf: null, // placeholder — JSON cannot carry Infinity; NaN path covered below via parse impossibility
        long: 'x'.repeat(400),
        multi: 'line one\nline two\ttabbed',
        ansi: 'ok[31mred',
        emptyish: '   ',
        num: 7,
        flag: true,
      },
    })));
    expect(out.fields).toEqual({
      long: `${'x'.repeat(255)}…`,
      multi: 'line one line two tabbed',
      ansi: 'okred',
      num: 7,
      flag: true,
    });
    expect((out.fields!.long as string).length).toBeLessThanOrEqual(256);
  });

  it('caps the map at MAX_HANDOFF_FIELDS keys (first N valid, declaration order)', () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < MAX_HANDOFF_FIELDS + 5; i++) many[`k${String(i).padStart(2, '0')}`] = i;
    const out = extractHandoff(block(JSON.stringify({ fields: many })));
    expect(Object.keys(out.fields ?? {})).toHaveLength(MAX_HANDOFF_FIELDS);
    expect(out.fields!.k00).toBe(0);
    expect(out.fields![`k${MAX_HANDOFF_FIELDS - 1}`]).toBe(MAX_HANDOFF_FIELDS - 1);
    expect(out.fields![`k${MAX_HANDOFF_FIELDS}`]).toBeUndefined();
  });

  it('a fields member that is not a flat object is ignored (block still extracts)', () => {
    for (const bad of ['"fields": [1,2]', '"fields": "ship"', '"fields": 4']) {
      const out = extractHandoff(block(`{ "summary": "s", ${bad} }`));
      expect(out.summary).toBe('s');
      expect('fields' in out).toBe(false);
    }
    // fields present but EVERY entry invalid → treated as absent, and a block with
    // nothing else usable falls back to the final message.
    const out = extractHandoff(block('{ "fields": { "a b": "x" } }'));
    expect(out.extractedFrom).toBe('final-message');
  });
});

/* ── Prompt rendering + advertising ─────────────────────────────────────────── */

function ctx(over: Partial<StepPromptContext> = {}): StepPromptContext {
  const node: WorkflowNode = {
    id: 'ship', type: 'step', label: 'Ship it', position: { x: 0, y: 0 },
    actor: { kind: 'engine', ref: 'codex' },
  };
  return {
    workflowId: 'wf', workflowTitle: 'WF', runId: 'run-1', node, predecessors: [], ...over,
  };
}

describe('buildStepPrompt — fields rendering + instruction advertising', () => {
  it('renders declared fields inside the predecessor data fence', () => {
    const prompt = buildStepPrompt(ctx({
      predecessors: [{
        nodeId: 'review', label: 'Review', actorRef: 'claude',
        outcome: {
          sessionId: 's1', summary: 'reviewed', finalMessage: 'done', extractedFrom: 'handoff-block',
          fields: { verdict: 'ship', bugCount: 3 },
        },
      }],
    }));
    expect(prompt).toContain('Fields:');
    expect(prompt).toContain('- verdict: "ship"');
    expect(prompt).toContain('- bugCount: 3');
  });

  it('default instruction is unchanged when nothing downstream references fields', () => {
    const prompt = buildStepPrompt(ctx());
    expect(prompt).toContain('```handoff');
    expect(prompt).not.toContain('"fields"');
  });

  it('advertises the referenced keys when a downstream switch routes on this node', () => {
    const prompt = buildStepPrompt(ctx({ advertisedFieldKeys: ['verdict', 'bugCount'] }));
    expect(prompt).toContain('"fields"');
    expect(prompt).toContain('verdict');
    expect(prompt).toContain('bugCount');
    expect(prompt).toContain('routes on');
  });
});

describe('referencedHandoffFieldKeys — which keys downstream conditions read', () => {
  it('collects fields keys from switch out-edge conditions targeting the node, deduped, in edge order', () => {
    const def: EditableWorkflowDefinition = {
      schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
      id: 'wf', title: 'WF', version: 1, status: 'active',
      nodes: [
        { id: 'trg', type: 'trigger', label: 'T', position: { x: 0, y: 0 }, trigger: { kind: 'manual' } },
        { id: 'review', type: 'step', label: 'Review', position: { x: 0, y: 0 }, actor: { kind: 'engine', ref: 'claude' } },
        { id: 'sw', type: 'switch', label: 'Route', position: { x: 0, y: 0 } },
        { id: 'ship', type: 'step', label: 'Ship', position: { x: 0, y: 0 }, actor: { kind: 'engine', ref: 'codex' } },
        { id: 'stop', type: 'fail', label: 'Stop', position: { x: 0, y: 0 }, failMessage: 'rejected' },
      ],
      edges: [
        { id: 'e1', from: 'trg', to: 'review', kind: 'sequence' },
        { id: 'e2', from: 'review', to: 'sw', kind: 'sequence' },
        { id: 'e3', from: 'sw', to: 'ship', kind: 'sequence', when: [
          { path: 'steps.review.outcome.fields.verdict', op: 'eq', value: 'ship' },
          { path: 'steps.review.outcome.fields.bugCount', op: 'lte', value: 5 },
          { path: 'steps.review.outcome.fields.verdict', op: 'ne', value: 'reject' }, // dupe key
          { path: 'steps.review.outcome.summary', op: 'contains', value: 'ok' },      // not a fields path
          { path: 'steps.other.outcome.fields.score', op: 'gt', value: 1 },           // different node
        ] },
        { id: 'e4', from: 'sw', to: 'stop', kind: 'sequence' },
      ],
    };
    expect(referencedHandoffFieldKeys(def, 'review')).toEqual(['verdict', 'bugCount']);
    expect(referencedHandoffFieldKeys(def, 'other')).toEqual(['score']);
    expect(referencedHandoffFieldKeys(def, 'ship')).toEqual([]);
  });
});
