import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listDefinitions,
  getDefinition,
  getDefinitionByName,
  createDefinition,
  updateDefinition,
  duplicateDefinition,
  retireDefinition,
  WorkflowStoreError,
} from '../definition-store.js';
import {
  WORKFLOW_DEFINITION_SCHEMA_VERSION,
  serializeDefinition,
  type EditableWorkflowDefinition,
} from '../definition.js';

/** A minimal VALID editable definition: one trigger → one step. */
function makeDef(id: string, over: Partial<EditableWorkflowDefinition> = {}): EditableWorkflowDefinition {
  return {
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    id,
    name: id,
    title: `Workflow ${id}`,
    version: 1,
    status: 'active',
    nodes: [
      { id: 'trg', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' } },
      {
        id: 's1',
        type: 'step',
        label: 'Do work',
        position: { x: 0, y: 140 },
        actor: { kind: 'employee', ref: 'jimbo' },
      },
    ],
    edges: [{ id: 'e1', from: 'trg', to: 's1', kind: 'sequence' }],
    ...over,
  };
}

const FIXED = '2026-07-03T15:00:00.000Z';
const now = () => FIXED;

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-defstore-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('createDefinition', () => {
  it('writes a validated file, stamping version 1 / schemaVersion / updatedAt', () => {
    const def = createDefinition(root, makeDef('alpha', { version: 99, updatedAt: 'stale' }), { now });
    expect(def.version).toBe(1);
    expect(def.schemaVersion).toBe(WORKFLOW_DEFINITION_SCHEMA_VERSION);
    expect(def.updatedAt).toBe(FIXED);
    expect(def.status).toBe('active');

    const onDisk = path.join(root, 'workflows', 'alpha.definition.json');
    expect(fs.existsSync(onDisk)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(onDisk, 'utf8'));
    expect(parsed.id).toBe('alpha');
    expect(parsed.name).toBe('alpha');
    expect(parsed.version).toBe(1);
  });

  it('normalizes generated geometry and persists the returned coordinates atomically', () => {
    const generated = makeDef('generated-layout');
    generated.nodes[1].position = { x: 0, y: 0 };

    const writeOptions = { now, layoutIntent: 'generated' } as Parameters<typeof createDefinition>[2];
    const created = createDefinition(root, generated, writeOptions);
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(root, 'workflows', 'generated-layout.definition.json'), 'utf8'),
    ) as EditableWorkflowDefinition;

    expect(created.layout).toEqual({ source: 'normalized', version: 1 });
    expect(created.nodes[1].position).not.toEqual(created.nodes[0].position);
    expect(onDisk.nodes).toEqual(created.nodes);
    expect(onDisk.layout).toEqual(created.layout);
  });

  it('rejects duplicate canonical names even when storage ids differ', () => {
    createDefinition(root, makeDef('record-a', { name: 'full-cycle-workflow' }), { now });
    try {
      createDefinition(root, makeDef('record-b', { name: 'full-cycle-workflow' }), { now });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(WorkflowStoreError);
      expect((e as WorkflowStoreError).code).toBe('conflict');
      expect((e as Error).message).toMatch(/name.*full-cycle-workflow.*already/i);
    }
  });

  it('rejects an invalid graph with a validation error carrying every problem', () => {
    const bad = makeDef('bad', { nodes: [], edges: [] }); // no trigger
    try {
      createDefinition(root, bad, { now });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(WorkflowStoreError);
      const err = e as WorkflowStoreError;
      expect(err.code).toBe('validation');
      expect(err.errors?.some((x) => x.code === 'missing-trigger')).toBe(true);
    }
    expect(fs.existsSync(path.join(root, 'workflows', 'bad.definition.json'))).toBe(false);
  });

  it('refuses a duplicate id with a conflict', () => {
    createDefinition(root, makeDef('dup'), { now });
    expect(() => createDefinition(root, makeDef('dup'), { now })).toThrowError(/already exists/);
    try {
      createDefinition(root, makeDef('dup'), { now });
    } catch (e) {
      expect((e as WorkflowStoreError).code).toBe('conflict');
    }
  });

  it.each(['../evil', 'a/b', 'a\\b', '..', '.', 'has space', ''])(
    'rejects unsafe id %j',
    (id) => {
      try {
        createDefinition(root, makeDef(id as string), { now });
        throw new Error('should have thrown');
      } catch (e) {
        expect((e as WorkflowStoreError).code).toBe('invalid-id');
      }
    },
  );
});

describe('getDefinition', () => {
  it('returns the stored definition and null for a missing one', () => {
    createDefinition(root, makeDef('present'), { now });
    const got = getDefinition(root, 'present');
    expect(got?.id).toBe('present');
    expect(getDefinition(root, 'absent')).toBeNull();
  });

  it('round-trips exactly through serialize/parse on disk', () => {
    const created = createDefinition(root, makeDef('rt', { description: 'a desc', orchestrator: 'jimbo' }), { now });
    const got = getDefinition(root, 'rt');
    expect(got).toEqual(created);
    // File content equals canonical serialization of the returned object.
    const onDisk = fs.readFileSync(path.join(root, 'workflows', 'rt.definition.json'), 'utf8');
    expect(onDisk).toBe(serializeDefinition(created));
  });
});

describe('getDefinitionByName', () => {
  it('resolves a stored workflow by canonical name rather than storage id', () => {
    createDefinition(root, makeDef('record-42', { name: 'full-cycle-workflow' }), { now });
    expect(getDefinitionByName(root, 'full-cycle-workflow')?.id).toBe('record-42');
    expect(getDefinitionByName(root, 'missing-workflow')).toBeNull();
  });
});

describe('listDefinitions', () => {
  it('returns sorted summaries and tolerates a corrupt file', () => {
    createDefinition(root, makeDef('bbb'), { now });
    createDefinition(root, makeDef('aaa'), { now });
    // Drop a corrupt file into the dir — it must be skipped, not fatal.
    fs.writeFileSync(path.join(root, 'workflows', 'broken.definition.json'), '{ not json', 'utf8');

    const list = listDefinitions(root);
    expect(list.map((d) => d.id)).toEqual(['aaa', 'bbb']);
    expect(list[0]).toMatchObject({ id: 'aaa', title: 'Workflow aaa', status: 'active', version: 1, nodeCount: 2, edgeCount: 1 });
    expect(list[0].updatedAt).toBe(FIXED);
  });

  it('returns [] when the workflows dir does not exist', () => {
    expect(listDefinitions(path.join(root, 'nope'))).toEqual([]);
  });
});

describe('updateDefinition', () => {
  it('bumps version, sets updatedAt, and shallow-merges the patch', () => {
    createDefinition(root, makeDef('u1'), { now });
    const updated = updateDefinition(root, 'u1', { title: 'Renamed', description: 'new' }, { now: () => '2026-07-03T16:00:00.000Z' });
    expect(updated.version).toBe(2);
    expect(updated.title).toBe('Renamed');
    expect(updated.description).toBe('new');
    expect(updated.updatedAt).toBe('2026-07-03T16:00:00.000Z');
    // persisted
    expect(getDefinition(root, 'u1')?.version).toBe(2);
  });

  it('replaces the nodes/edges arrays wholesale (canvas save semantics)', () => {
    createDefinition(root, makeDef('u2'), { now });
    const newNodes = makeDef('u2').nodes.concat({
      id: 's2',
      type: 'step',
      label: 'Second',
      position: { x: 0, y: 280 },
    });
    const newEdges = makeDef('u2').edges.concat({ id: 'e2', from: 's1', to: 's2', kind: 'sequence' });
    const updated = updateDefinition(root, 'u2', { nodes: newNodes, edges: newEdges }, { now });
    expect(updated.nodes).toHaveLength(3);
    expect(updated.edges).toHaveLength(2);
  });

  it('rejects a stale expectedVersion with a conflict', () => {
    createDefinition(root, makeDef('u3'), { now }); // version 1
    try {
      updateDefinition(root, 'u3', { title: 'x' }, { expectedVersion: 5, now });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WorkflowStoreError).code).toBe('conflict');
    }
    // matching version succeeds
    const ok = updateDefinition(root, 'u3', { title: 'x' }, { expectedVersion: 1, now });
    expect(ok.version).toBe(2);
  });

  it('404s a missing id and refuses an id change', () => {
    expect(() => updateDefinition(root, 'ghost', { title: 'x' }, { now })).toThrowError(/not found/);
    createDefinition(root, makeDef('u4'), { now });
    try {
      updateDefinition(root, 'u4', { id: 'renamed' } as Partial<EditableWorkflowDefinition>, { now });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WorkflowStoreError).code).toBe('bad-input');
    }
  });

  it('refuses changing the stable canonical name', () => {
    createDefinition(root, makeDef('stable-name'), { now });
    expect(() => updateDefinition(root, 'stable-name', { name: 'renamed-workflow' }, { now }))
      .toThrowError(/workflow name cannot be changed/i);
  });

  it('rejects a patch that makes the graph invalid and leaves the file unchanged', () => {
    createDefinition(root, makeDef('u5'), { now });
    try {
      updateDefinition(root, 'u5', { nodes: [], edges: [] }, { now });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WorkflowStoreError).code).toBe('validation');
    }
    // untouched: still version 1, still 2 nodes
    const still = getDefinition(root, 'u5');
    expect(still?.version).toBe(1);
    expect(still?.nodes).toHaveLength(2);
  });
});

describe('duplicateDefinition', () => {
  it('copies to <id>-copy, resetting version/status and titling (copy)', () => {
    createDefinition(root, makeDef('d1', { status: 'paused' }), { now });
    const dup = duplicateDefinition(root, 'd1', { now });
    expect(dup.id).toBe('d1-copy');
    expect(dup.version).toBe(1);
    expect(dup.status).toBe('active');
    expect(dup.title).toBe('Workflow d1 (copy)');
    expect(getDefinition(root, 'd1-copy')?.id).toBe('d1-copy');
    // original untouched
    expect(getDefinition(root, 'd1')?.status).toBe('paused');
  });

  it('auto-disambiguates the default copy id', () => {
    createDefinition(root, makeDef('d2'), { now });
    const first = duplicateDefinition(root, 'd2', { now });
    expect(first.id).toBe('d2-copy');
    const second = duplicateDefinition(root, 'd2', { now });
    expect(second.id).toBe('d2-copy-2');
  });

  it('honors an explicit newId and rejects a taken explicit newId', () => {
    createDefinition(root, makeDef('d3'), { now });
    const dup = duplicateDefinition(root, 'd3', { newId: 'fresh', title: 'Fresh', now });
    expect(dup.id).toBe('fresh');
    expect(dup.title).toBe('Fresh');
    try {
      duplicateDefinition(root, 'd3', { newId: 'fresh', now });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WorkflowStoreError).code).toBe('conflict');
    }
  });

  it('404s a missing source', () => {
    expect(() => duplicateDefinition(root, 'ghost', { now })).toThrowError(/not found/);
  });
});

describe('structural validation (never writes a schema-invalid file)', () => {
  it('rejects a node missing position and writes nothing', () => {
    const bad = makeDef('nopos');
    (bad.nodes[1] as { position?: unknown }).position = undefined;
    try {
      createDefinition(root, bad, { now });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WorkflowStoreError).code).toBe('validation');
      expect((e as WorkflowStoreError).errors?.some((x) => x.code === 'missing-node-position')).toBe(true);
    }
    expect(fs.existsSync(path.join(root, 'workflows', 'nopos.definition.json'))).toBe(false);
  });

  it('rejects a missing edges array (structural, not silently coerced)', () => {
    const bad = makeDef('noedges') as Partial<EditableWorkflowDefinition>;
    delete bad.edges;
    try {
      createDefinition(root, bad as EditableWorkflowDefinition, { now });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WorkflowStoreError).code).toBe('validation');
      expect((e as WorkflowStoreError).errors?.some((x) => x.code === 'edges-not-array')).toBe(true);
    }
  });

  it('rejects a non-array node.gates instead of silently coercing it', () => {
    const bad = makeDef('badgates');
    (bad.nodes[1] as { gates?: unknown }).gates = {};
    try {
      createDefinition(root, bad, { now });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WorkflowStoreError).code).toBe('validation');
      expect((e as WorkflowStoreError).errors?.some((x) => x.code === 'gates-not-array')).toBe(true);
    }
    expect(fs.existsSync(path.join(root, 'workflows', 'badgates.definition.json'))).toBe(false);
  });

  it('rejects non-string scalar fields (title/id) without throwing a TypeError', () => {
    const numericTitle = makeDef('numtitle') as unknown as Record<string, unknown>;
    numericTitle.title = 123;
    try {
      createDefinition(root, numericTitle as unknown as EditableWorkflowDefinition, { now });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WorkflowStoreError).code).toBe('validation');
      expect((e as WorkflowStoreError).errors?.some((x) => x.code === 'missing-title')).toBe(true);
    }
  });

  it('does not throw on nodes:[null] / runGates:{} — surfaces a validation error', () => {
    for (const mangle of [
      (d: Record<string, unknown>) => (d.nodes = [null]),
      (d: Record<string, unknown>) => (d.edges = [null]),
      (d: Record<string, unknown>) => (d.runGates = {}),
    ]) {
      const bad = makeDef(`m${Math.floor(Math.random() * 1e6)}`) as unknown as Record<string, unknown>;
      mangle(bad);
      expect(() => createDefinition(root, bad as unknown as EditableWorkflowDefinition, { now })).toThrowError(
        WorkflowStoreError,
      );
      try {
        createDefinition(root, bad as unknown as EditableWorkflowDefinition, { now });
      } catch (e) {
        expect((e as WorkflowStoreError).code).toBe('validation');
      }
    }
  });
});

describe('retireDefinition', () => {
  it('sets status=retired, bumps version, keeps the file', () => {
    createDefinition(root, makeDef('r1'), { now });
    const retired = retireDefinition(root, 'r1', { now: () => '2026-07-03T17:00:00.000Z' });
    expect(retired.status).toBe('retired');
    expect(retired.version).toBe(2);
    expect(retired.updatedAt).toBe('2026-07-03T17:00:00.000Z');
    expect(getDefinition(root, 'r1')?.status).toBe('retired');
    // retire is reversible via update
    const revived = updateDefinition(root, 'r1', { status: 'active' }, { now });
    expect(revived.status).toBe('active');
    expect(revived.version).toBe(3);
  });

  it('404s a missing id', () => {
    expect(() => retireDefinition(root, 'ghost', { now })).toThrowError(/not found/);
  });
});
