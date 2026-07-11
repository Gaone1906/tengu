import { beforeAll, describe, expect, it } from 'vitest';
import {
  WORKFLOW_DEFINITION_SCHEMA_VERSION,
  type EditableWorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from '../definition.js';

type LayoutMetadata = { source: 'generated' | 'normalized' | 'manual'; version: 1 };
type LayoutDefinition = EditableWorkflowDefinition & { layout?: LayoutMetadata };
interface WorkflowLayoutDiagnostics {
  source: LayoutMetadata['source'];
  version: 1;
  normalized: boolean;
  reasons: Array<{ code: string; message: string; refs?: string[] }>;
  quality: { valid: boolean; score: number };
  envelopes: Array<{ nodeId: string; width: number; height: number }>;
  loopRoutes: Record<string, { side: 'below'; lane: number }>;
}
interface LayoutResult {
  definition: LayoutDefinition;
  diagnostics: WorkflowLayoutDiagnostics;
}
interface LayoutModule {
  normalizeWorkflowLayout(definition: EditableWorkflowDefinition): LayoutResult;
  evaluateWorkflowLayout(definition: EditableWorkflowDefinition): WorkflowLayoutDiagnostics;
  prepareWorkflowLayoutForWrite(definition: EditableWorkflowDefinition, intent?: 'generated' | 'manual'): LayoutResult;
}

let layoutModule: LayoutModule | undefined;
let layoutImportError: unknown;

beforeAll(async () => {
  // Keep this runtime-resolved during RED so the package build succeeds before the
  // wished-for production module exists. Vitest then reports the missing contract,
  // not a TypeScript parse failure, and automatically exercises the real exports in GREEN.
  const modulePath = '../layout.js';
  try {
    layoutModule = await import(modulePath) as unknown as LayoutModule;
  } catch (error) {
    layoutImportError = error;
  }
});

function requireLayout(): LayoutModule {
  expect(layoutImportError, 'workflow layout module should load').toBeUndefined();
  expect(layoutModule, 'workflow layout module should exist').toBeDefined();
  expect(layoutModule?.normalizeWorkflowLayout, 'normalizeWorkflowLayout should exist').toEqual(expect.any(Function));
  expect(layoutModule?.evaluateWorkflowLayout, 'evaluateWorkflowLayout should exist').toEqual(expect.any(Function));
  expect(layoutModule?.prepareWorkflowLayoutForWrite, 'prepareWorkflowLayoutForWrite should exist')
    .toEqual(expect.any(Function));
  return layoutModule as LayoutModule;
}

type LayoutEnvelope = WorkflowLayoutDiagnostics['envelopes'][number];

const trigger = (position = { x: 0, y: 0 }): WorkflowNode => ({
  id: 'wake',
  type: 'trigger',
  label: 'Manual',
  position,
  trigger: { kind: 'manual' },
});

const step = (
  id: string,
  position: { x: number; y: number },
  over: Partial<WorkflowNode> = {},
): WorkflowNode => ({
  id,
  type: 'step',
  label: id[0].toUpperCase() + id.slice(1),
  position,
  actor: { kind: 'engine', ref: 'codex' },
  instructions: `Complete ${id}.`,
  ...over,
});

const edge = (
  id: string,
  from: string,
  to: string,
  over: Partial<WorkflowEdge> = {},
): WorkflowEdge => ({ id, from, to, kind: 'sequence', ...over });

function definition(
  id: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  over: Partial<EditableWorkflowDefinition> = {},
): EditableWorkflowDefinition {
  return {
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    id,
    name: id,
    title: id,
    version: 1,
    status: 'active',
    nodes,
    edges,
    ...over,
  };
}

function linearDefinition(): EditableWorkflowDefinition {
  return definition(
    'layout-linear',
    [trigger(), step('build', { x: 0, y: 140 }), step('verify', { x: 0, y: 280 })],
    [edge('wake-build', 'wake', 'build'), edge('build-verify', 'build', 'verify')],
  );
}

function branchDefinition(): EditableWorkflowDefinition {
  return definition(
    'layout-branch',
    [
      trigger(),
      step('route', { x: 0, y: 140 }),
      step('alpha', { x: -140, y: 280 }),
      step('beta', { x: 300, y: 280 }),
      step('join', { x: 80, y: 420 }),
    ],
    [
      edge('wake-route', 'wake', 'route'),
      edge('route-alpha', 'route', 'alpha'),
      edge('route-beta', 'route', 'beta'),
      edge('alpha-join', 'alpha', 'join'),
      edge('beta-join', 'beta', 'join'),
    ],
  );
}

function mergeDefinition(): EditableWorkflowDefinition {
  return definition(
    'layout-merge',
    [
      trigger({ x: 80, y: 80 }),
      step('left', { x: 40, y: 240 }),
      step('right', { x: 320, y: 240 }),
      step('merge', { x: 180, y: 420 }),
    ],
    [
      edge('wake-left', 'wake', 'left'),
      edge('wake-right', 'wake', 'right'),
      edge('left-merge', 'left', 'merge'),
      edge('right-merge', 'right', 'merge'),
    ],
  );
}

function approvalDefinition(): EditableWorkflowDefinition {
  return definition(
    'layout-approval',
    [
      trigger(),
      step('prepare', { x: 0, y: 140 }),
      {
        id: 'approve',
        type: 'gate',
        label: 'Approve',
        position: { x: 0, y: 280 },
        gate: { kind: 'approval', approvalRef: 'publish', description: 'Approve publishing.' },
      },
      step('publish', { x: 0, y: 420 }),
    ],
    [
      edge('wake-prepare', 'wake', 'prepare'),
      edge('prepare-approve', 'prepare', 'approve'),
      edge('approve-publish', 'approve', 'publish'),
    ],
  );
}

function errorLaneDefinition(): EditableWorkflowDefinition {
  return definition(
    'layout-error',
    [
      trigger(),
      step('risky', { x: 0, y: 140 }, { options: { onError: 'error-edge' } }),
      step('success', { x: 80, y: 280 }),
      step('recover', { x: 360, y: 280 }),
    ],
    [
      edge('wake-risky', 'wake', 'risky'),
      edge('risky-success', 'risky', 'success'),
      edge('risky-recover', 'risky', 'recover', { lane: 'error' }),
    ],
  );
}

function boundedLoopDefinition(): EditableWorkflowDefinition {
  return definition(
    'layout-loop',
    [trigger(), step('build', { x: 0, y: 140 }), step('verify', { x: 0, y: 280 }), step('ship', { x: 0, y: 420 })],
    [
      edge('wake-build', 'wake', 'build'),
      edge('build-verify', 'build', 'verify'),
      edge('verify-ship', 'verify', 'ship'),
      edge('retry', 'verify', 'build', { kind: 'loop' }),
    ],
    { loop: { maxRoundsPerRun: 3 } },
  );
}

const shapes: Record<string, EditableWorkflowDefinition> = {
  linear: linearDefinition(),
  branch: branchDefinition(),
  merge: mergeDefinition(),
  approval: approvalDefinition(),
  error: errorLaneDefinition(),
  loop: boundedLoopDefinition(),
};

function generatedDag(seed: number): EditableWorkflowDefinition {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const count = 4 + Math.floor(next() * 8);
  const nodes: WorkflowNode[] = [trigger({ x: Math.floor(next() * 37), y: Math.floor(next() * 91) })];
  for (let index = 1; index < count; index += 1) {
    nodes.push(step(`step-${index}`, {
      x: Math.floor(next() * 700) - 200,
      y: Math.floor(next() * 700) - 200,
    }, index % 3 === 0
      ? { actor: { kind: 'employee', ref: `worker-${index}` }, instructions: `Complete generated step ${index}.` }
      : index % 4 === 0
        ? { options: { model: 'gpt-5.5' } }
        : {}));
  }
  const edges: WorkflowEdge[] = [];
  for (let index = 1; index < count; index += 1) {
    const parent = Math.floor(next() * index);
    edges.push(edge(`edge-${parent}-${index}`, nodes[parent].id, nodes[index].id));
    if (index > 2 && next() > 0.7) {
      const second = Math.floor(next() * index);
      if (second !== parent) edges.push(edge(`edge-${second}-${index}`, nodes[second].id, nodes[index].id));
    }
  }
  return definition(`generated-dag-${seed}`, nodes, edges);
}

function gridViolations(def: EditableWorkflowDefinition): string[] {
  return def.nodes
    .filter((node) => node.position.x % 20 !== 0 || node.position.y % 20 !== 0)
    .map((node) => node.id);
}

function envelopeMap(result: LayoutResult): Map<string, LayoutEnvelope> {
  return new Map(result.diagnostics.envelopes.map((envelope) => [envelope.nodeId, envelope]));
}

function expandedEnvelopeOverlaps(result: LayoutResult): string[] {
  const nodes = result.definition.nodes;
  const envelopes = envelopeMap(result);
  const overlaps: string[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      const ae = envelopes.get(a.id)!;
      const be = envelopes.get(b.id)!;
      const disjoint =
        a.position.x + ae.width <= b.position.x ||
        b.position.x + be.width <= a.position.x ||
        a.position.y + ae.height <= b.position.y ||
        b.position.y + be.height <= a.position.y;
      if (!disjoint) overlaps.push(`${a.id}:${b.id}`);
    }
  }
  return overlaps;
}

function nonLoopClearanceViolations(result: LayoutResult, clearance: number): string[] {
  const byId = new Map(result.definition.nodes.map((node) => [node.id, node]));
  const envelopes = envelopeMap(result);
  return result.definition.edges
    .filter((candidate) => candidate.kind !== 'loop')
    .filter((candidate) => {
      const from = byId.get(candidate.from)!;
      const to = byId.get(candidate.to)!;
      return to.position.x < from.position.x + envelopes.get(from.id)!.width + clearance;
    })
    .map((candidate) => candidate.id);
}

function verticalClearanceViolations(result: LayoutResult, clearance: number): string[] {
  const envelopes = envelopeMap(result);
  const byRank = new Map<number, WorkflowNode[]>();
  for (const node of result.definition.nodes) {
    byRank.set(node.position.x, [...(byRank.get(node.position.x) ?? []), node]);
  }
  const violations: string[] = [];
  for (const nodes of byRank.values()) {
    const ordered = [...nodes].sort((a, b) => a.position.y - b.position.y || a.id.localeCompare(b.id));
    for (let i = 1; i < ordered.length; i += 1) {
      const previous = ordered[i - 1];
      const current = ordered[i];
      const gap = current.position.y - (previous.position.y + envelopes.get(previous.id)!.height);
      if (gap < clearance) violations.push(`${previous.id}:${current.id}`);
    }
  }
  return violations;
}

function badLayout(kind: string): EditableWorkflowDefinition {
  const base = structuredClone(kind === 'bad-merge' || kind === 'tangled' ? branchDefinition() : linearDefinition());
  switch (kind) {
    case 'missing':
      delete (base.nodes[1] as { position?: unknown }).position;
      break;
    case 'overlap':
      base.nodes[1].position = { ...base.nodes[0].position };
      break;
    case 'backtracking':
      base.nodes[0].position = { x: 400, y: 0 };
      base.nodes[1].position = { x: 0, y: 0 };
      break;
    case 'index-like':
      base.nodes.forEach((node, index) => { node.position = { x: 0, y: index * 140 }; });
      break;
    case 'poor-clearance':
      base.nodes.forEach((node, index) => { node.position = { x: index * 200, y: 0 }; });
      break;
    case 'bad-merge':
      base.nodes.find((node) => node.id === 'join')!.position = { x: 0, y: 0 };
      break;
    case 'tangled':
      base.nodes.find((node) => node.id === 'alpha')!.position = { x: 600, y: 400 };
      base.nodes.find((node) => node.id === 'beta')!.position = { x: 200, y: 0 };
      break;
  }
  return base;
}

function validManualDefinition(): EditableWorkflowDefinition {
  return definition(
    'layout-manual',
    [trigger(), step('build', { x: 400, y: 0 }), step('verify', { x: 820, y: 0 })],
    [edge('wake-build', 'wake', 'build'), edge('build-verify', 'build', 'verify')],
  );
}

function overlappingManualDefinition(): EditableWorkflowDefinition {
  const manual = validManualDefinition();
  manual.nodes.find((node) => node.id === 'build')!.position = { x: 400, y: 0 };
  manual.nodes.find((node) => node.id === 'verify')!.position = { x: 400, y: 0 };
  return manual;
}

function fourWayBranchWithDocks(): EditableWorkflowDefinition {
  return definition(
    'layout-four-way-docks',
    [
      trigger(),
      step('route', { x: 0, y: 140 }),
      step('author', { x: 200, y: 0 }, { actor: { kind: 'employee', ref: 'writer' }, instructions: 'Write the draft.' }),
      step('modeled', { x: 200, y: 140 }, { options: { model: 'gpt-5.5' } }),
      step('plain', { x: 200, y: 280 }),
      step('fourth', { x: 200, y: 420 }),
      step('join', { x: 400, y: 200 }),
    ],
    [
      edge('wake-route', 'wake', 'route'),
      ...['author', 'modeled', 'plain', 'fourth'].map((id) => edge(`route-${id}`, 'route', id)),
      ...['author', 'modeled', 'plain', 'fourth'].map((id) => edge(`${id}-join`, id, 'join')),
    ],
  );
}

function fourRouteSwitchDefinition(): EditableWorkflowDefinition {
  const destinations = ['north', 'east', 'south', 'west'];
  return definition(
    'layout-four-route-switch',
    [
      trigger(),
      { id: 'route', type: 'switch', label: 'Route', position: { x: 200, y: 0 } },
      ...destinations.map((id, index) => step(id, { x: 500, y: index * 240 })),
    ],
    [
      edge('wake-route', 'wake', 'route'),
      ...destinations.map((id) => edge(`route-${id}`, 'route', id)),
    ],
  );
}

function clearCrossingDefinition(): EditableWorkflowDefinition {
  return definition(
    'layout-clear-crossing',
    [
      trigger({ x: 0, y: 200 }),
      step('upper-source', { x: 400, y: 0 }),
      step('lower-source', { x: 400, y: 400 }),
      step('upper-target', { x: 800, y: 0 }),
      step('lower-target', { x: 800, y: 400 }),
    ],
    [
      edge('wake-upper', 'wake', 'upper-source'),
      edge('wake-lower', 'wake', 'lower-source'),
      edge('upper-lower', 'upper-source', 'lower-target'),
      edge('lower-upper', 'lower-source', 'upper-target'),
    ],
  );
}

describe('workflow layout normalization invariants', () => {
  for (const [name, input] of Object.entries(shapes)) {
    it(`${name}: is deterministic, idempotent, snapped, clear, and strict-LTR`, () => {
      const { normalizeWorkflowLayout } = requireLayout();
      const once = normalizeWorkflowLayout(structuredClone(input));
      const replay = normalizeWorkflowLayout(structuredClone(input));
      const twice = normalizeWorkflowLayout(structuredClone(once.definition));

      expect(replay.definition.nodes).toEqual(once.definition.nodes);
      expect(twice.definition.nodes).toEqual(once.definition.nodes);
      expect(once.diagnostics.reasons).toEqual(twice.diagnostics.reasons);
      expect(gridViolations(once.definition)).toEqual([]);
      expect(expandedEnvelopeOverlaps(once)).toEqual([]);
      expect(nonLoopClearanceViolations(once, 96)).toEqual([]);
      expect(verticalClearanceViolations(once, 64)).toEqual([]);
    });
  }

  it('holds determinism, idempotency, clearance, and snapping across generated DAG properties', () => {
    const { normalizeWorkflowLayout } = requireLayout();
    for (let seed = 1; seed <= 64; seed += 1) {
      const input = generatedDag(seed);
      const once = normalizeWorkflowLayout(structuredClone(input));
      const replay = normalizeWorkflowLayout(structuredClone(input));
      const twice = normalizeWorkflowLayout(structuredClone(once.definition));
      expect(replay.definition.nodes, `determinism seed ${seed}`).toEqual(once.definition.nodes);
      expect(twice.definition.nodes, `idempotency seed ${seed}`).toEqual(once.definition.nodes);
      expect(gridViolations(once.definition), `grid seed ${seed}`).toEqual([]);
      expect(expandedEnvelopeOverlaps(once), `overlaps seed ${seed}`).toEqual([]);
      expect(nonLoopClearanceViolations(once, 96), `LTR seed ${seed}`).toEqual([]);
      expect(verticalClearanceViolations(once, 64), `vertical seed ${seed}`).toEqual([]);
      expect(once.diagnostics.reasons.filter((reason) => reason.code === 'edge-crossing'), `crossings seed ${seed}`).toEqual([]);
    }
  });
});

describe('workflow layout write policy and quality diagnostics', () => {
  it.each(['missing', 'overlap', 'backtracking', 'index-like', 'poor-clearance', 'bad-merge', 'tangled'])(
    'normalizes %s generated/unknown layouts',
    (kind) => {
      const { evaluateWorkflowLayout, prepareWorkflowLayoutForWrite } = requireLayout();
      const input = badLayout(kind);
      const before = evaluateWorkflowLayout(input);
      const prepared = prepareWorkflowLayoutForWrite(input, 'generated');

      expect(before.quality.valid).toBe(false);
      expect(before.reasons.length).toBeGreaterThan(0);
      expect(prepared.definition.layout).toEqual({ source: 'normalized', version: 1 });
      expect(prepared.diagnostics.normalized).toBe(true);
    },
  );

  it('preserves valid manual coordinates', () => {
    const { prepareWorkflowLayoutForWrite } = requireLayout();
    const manual = validManualDefinition();
    const prepared = prepareWorkflowLayoutForWrite(manual, 'manual');
    expect(prepared.definition.nodes).toEqual(manual.nodes);
    expect(prepared.definition.layout).toEqual({ source: 'manual', version: 1 });
  });

  it('rejects manual edge clearance that ignores the visible port overhangs', () => {
    const { prepareWorkflowLayoutForWrite } = requireLayout();
    const manual = validManualDefinition();
    manual.nodes.find((node) => node.id === 'verify')!.position = { x: 800, y: 0 };

    expect(() => prepareWorkflowLayoutForWrite(manual, 'manual'))
      .toThrow(/clearance.*build.*verify.*Tidy/i);
  });

  it('rejects overlapping manual coordinates with node ids and a Tidy instruction', () => {
    const { prepareWorkflowLayoutForWrite } = requireLayout();
    expect(() => prepareWorkflowLayoutForWrite(overlappingManualDefinition(), 'manual'))
      .toThrow(/overlap.*build.*verify.*Tidy/i);
  });
});

describe('expanded envelopes and bounded-loop routing', () => {
  it('reserves model/employee dock discs and caption lanes', () => {
    const { normalizeWorkflowLayout } = requireLayout();
    const result = normalizeWorkflowLayout(fourWayBranchWithDocks());
    expect(expandedEnvelopeOverlaps(result)).toEqual([]);
    const author = result.diagnostics.envelopes.find((item) => item.nodeId === 'author')!;
    const modeled = result.diagnostics.envelopes.find((item) => item.nodeId === 'modeled')!;
    const plain = result.diagnostics.envelopes.find((item) => item.nodeId === 'plain')!;
    expect(author.height).toBeGreaterThan(plain.height);
    expect(modeled.height).toBeGreaterThan(plain.height);
  });

  it('excludes bounded loop back-edges from rank and emits a stable below-graph route', () => {
    const { normalizeWorkflowLayout } = requireLayout();
    const result = normalizeWorkflowLayout(boundedLoopDefinition());
    expect(nonLoopClearanceViolations(result, 96)).toEqual([]);
    expect(result.diagnostics.loopRoutes).toEqual({ retry: { side: 'below', lane: 0 } });
  });

  it('derives a switch envelope from all non-error outgoing route rows', () => {
    const { normalizeWorkflowLayout } = requireLayout();
    const result = normalizeWorkflowLayout(fourRouteSwitchDefinition());
    expect(result.diagnostics.envelopes.find((item) => item.nodeId === 'route')?.height).toBe(200);
  });

  it('diagnoses an avoidable clear edge crossing and normalizes it away', () => {
    const { evaluateWorkflowLayout, normalizeWorkflowLayout } = requireLayout();
    const crossing = clearCrossingDefinition();
    expect(evaluateWorkflowLayout(crossing).reasons).toContainEqual(expect.objectContaining({
      code: 'edge-crossing',
      refs: expect.arrayContaining(['upper-lower', 'lower-upper']),
    }));

    const normalized = normalizeWorkflowLayout(crossing);
    expect(normalized.diagnostics.reasons.filter((reason) => reason.code === 'edge-crossing')).toEqual([]);
  });
});
