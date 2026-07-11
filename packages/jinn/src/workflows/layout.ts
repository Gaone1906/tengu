import type {
  EditableWorkflowDefinition,
  WorkflowEdge,
  WorkflowLayoutMetadata,
  WorkflowLayoutSource,
  WorkflowNode,
} from './definition.js';
import { MAX_WORKFLOW_EDGES } from './definition.js';

export type { WorkflowLayoutMetadata, WorkflowLayoutSource } from './definition.js';

export const LAYOUT_GRID = 20;
export const LAYOUT_HORIZONTAL_CLEARANCE = 120;
export const LAYOUT_VERTICAL_CLEARANCE = 80;
export const LAYOUT_PORT_DIAMETER = 8;

export type WorkflowLayoutIntent = 'generated' | 'manual' | 'normalize';

export interface LayoutEnvelope {
  nodeId: string;
  width: number;
  height: number;
}

export interface LayoutReason {
  code: string;
  message: string;
  refs?: string[];
}

export interface WorkflowLayoutDiagnostics {
  source: WorkflowLayoutSource;
  version: 1;
  normalized: boolean;
  reasons: LayoutReason[];
  quality: { valid: boolean; score: number };
  envelopes: LayoutEnvelope[];
  loopRoutes: Record<string, { side: 'below'; lane: number }>;
}

export interface WorkflowLayoutResult {
  definition: EditableWorkflowDefinition;
  diagnostics: WorkflowLayoutDiagnostics;
}

export class WorkflowLayoutError extends Error {
  readonly reasons: LayoutReason[];

  constructor(reasons: LayoutReason[]) {
    const detail = reasons.map((reason) => reason.message).join(' ');
    super(`${detail} Use Tidy to repair the layout before saving.`);
    this.name = 'WorkflowLayoutError';
    this.reasons = reasons;
  }
}

function snap(value: number): number {
  const snapped = Math.round(value / LAYOUT_GRID) * LAYOUT_GRID;
  return Object.is(snapped, -0) ? 0 : snapped;
}

function ceilToGrid(value: number): number {
  const snapped = Math.ceil(value / LAYOUT_GRID) * LAYOUT_GRID;
  return Object.is(snapped, -0) ? 0 : snapped;
}

/** Fixed visible envelope matching the canvas card families. Its width also
 * reserves the source and target port overhangs between adjacent nodes. Dock-
 * bearing AI cards reserve the underside discs, dashed connector lane, and
 * captions. */
export function nodeLayoutEnvelope(node: WorkflowNode, nonErrorOutgoingRows = 0): LayoutEnvelope {
  if (node.type === 'trigger') return { nodeId: node.id, width: 188 + LAYOUT_PORT_DIAMETER, height: 56 };
  if (node.type === 'gate') return { nodeId: node.id, width: 232 + LAYOUT_PORT_DIAMETER, height: 72 };
  if (node.type === 'switch') {
    const rows = Math.max(2, nonErrorOutgoingRows);
    return { nodeId: node.id, width: 220 + LAYOUT_PORT_DIAMETER, height: ceilToGrid(50 + rows * 32 + 8) };
  }

  const taskBearing = node.type === 'step' && typeof node.instructions === 'string' && node.instructions.trim().length > 0;
  const hasDocks = taskBearing && !!node.actor && (node.actor.kind === 'employee' || !!node.options?.model);
  const width = (taskBearing ? 300 : 220) + LAYOUT_PORT_DIAMETER;
  const cardHeight = taskBearing ? 118 : 64;
  return { nodeId: node.id, width, height: cardHeight + (hasDocks ? 156 : 0) };
}

function structuralEdges(definition: EditableWorkflowDefinition, ids: Set<string>): WorkflowEdge[] {
  return (Array.isArray(definition.edges) ? definition.edges : [])
    .filter((edge) => edge && typeof edge === 'object' && edge.kind !== 'loop' && ids.has(edge.from) && ids.has(edge.to));
}

function authoredOrder(nodes: WorkflowNode[], edges: WorkflowEdge[]): Map<string, number> {
  const ids = new Set(nodes.map((node) => node.id));
  const outgoing = new Map<string, string[]>();
  const hasIncoming = new Set<string>();
  for (const edge of edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
    hasIncoming.add(edge.to);
  }
  const order = new Map<string, number>();
  const visit = (id: string): void => {
    if (order.has(id)) return;
    order.set(id, order.size);
    for (const target of outgoing.get(id) ?? []) {
      if (ids.has(target)) visit(target);
    }
  };
  for (const node of nodes) if (!hasIncoming.has(node.id)) visit(node.id);
  for (const node of nodes) visit(node.id);
  return order;
}

function longestPathRanks(nodes: WorkflowNode[], edges: WorkflowEdge[], order: Map<string, number>): Map<string, number> {
  const rank = new Map(nodes.map((node) => [node.id, 0]));
  const incomingCount = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, WorkflowEdge[]>();
  for (const edge of edges) {
    incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  }
  const queue = nodes
    .filter((node) => incomingCount.get(node.id) === 0)
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    seen.add(current.id);
    for (const edge of outgoing.get(current.id) ?? []) {
      rank.set(edge.to, Math.max(rank.get(edge.to) ?? 0, (rank.get(current.id) ?? 0) + 1));
      const remaining = (incomingCount.get(edge.to) ?? 0) - 1;
      incomingCount.set(edge.to, remaining);
      if (remaining === 0) {
        const target = nodes.find((node) => node.id === edge.to);
        if (target) {
          queue.push(target);
          queue.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
        }
      }
    }
  }
  // Invalid non-loop cycles are rejected by execution validation. Keeping their
  // authored fallback rank deterministic makes planning diagnostics safe anyway.
  for (const node of nodes) if (!seen.has(node.id)) rank.set(node.id, 0);
  return rank;
}

function loopRoutes(definition: EditableWorkflowDefinition): Record<string, { side: 'below'; lane: number }> {
  const routes: Record<string, { side: 'below'; lane: number }> = {};
  let lane = 0;
  for (const edge of Array.isArray(definition.edges) ? definition.edges : []) {
    if (edge?.kind === 'loop' && typeof edge.id === 'string') routes[edge.id] = { side: 'below', lane: lane++ };
  }
  return routes;
}

function diagnosticSource(source: WorkflowLayoutSource, normalized: boolean): Pick<WorkflowLayoutDiagnostics, 'source' | 'version' | 'normalized'> {
  return { source, version: 1, normalized };
}

function evaluateWithSource(definition: EditableWorkflowDefinition, source: WorkflowLayoutSource): WorkflowLayoutDiagnostics {
  const nodes = Array.isArray(definition.nodes) ? definition.nodes : [];
  const ids = new Set(nodes.map((node) => node.id));
  const edges = structuralEdges(definition, ids);
  const outgoingRows = new Map<string, number>();
  for (const edge of Array.isArray(definition.edges) ? definition.edges : []) {
    if (edge && typeof edge === 'object' && edge.lane !== 'error' && typeof edge.from === 'string') {
      outgoingRows.set(edge.from, (outgoingRows.get(edge.from) ?? 0) + 1);
    }
  }
  const envelopes = nodes.map((node) => nodeLayoutEnvelope(node, outgoingRows.get(node.id) ?? 0));
  const envelopeById = new Map(envelopes.map((envelope) => [envelope.nodeId, envelope]));
  const reasons: LayoutReason[] = [];
  const positionValid = new Set<string>();

  for (const node of nodes) {
    const position = node.position as { x?: unknown; y?: unknown } | undefined;
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
      reasons.push({ code: 'missing-position', message: `Node "${node.id}" needs a finite position.`, refs: [node.id] });
      continue;
    }
    positionValid.add(node.id);
    if ((position.x as number) % LAYOUT_GRID !== 0 || (position.y as number) % LAYOUT_GRID !== 0) {
      reasons.push({ code: 'off-grid', message: `Node "${node.id}" is off the ${LAYOUT_GRID}px grid.`, refs: [node.id] });
    }
  }

  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    const left = nodes[leftIndex];
    if (!positionValid.has(left.id)) continue;
    const leftEnvelope = envelopeById.get(left.id)!;
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const right = nodes[rightIndex];
      if (!positionValid.has(right.id)) continue;
      const rightEnvelope = envelopeById.get(right.id)!;
      const disjoint =
        left.position.x + leftEnvelope.width <= right.position.x ||
        right.position.x + rightEnvelope.width <= left.position.x ||
        left.position.y + leftEnvelope.height <= right.position.y ||
        right.position.y + rightEnvelope.height <= left.position.y;
      if (!disjoint) {
        reasons.push({
          code: 'overlap',
          message: `Layout overlap between nodes "${left.id}" and "${right.id}".`,
          refs: [left.id, right.id],
        });
      }
    }
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const edge of edges) {
    const from = nodeById.get(edge.from)!;
    const to = nodeById.get(edge.to)!;
    if (!positionValid.has(from.id) || !positionValid.has(to.id)) continue;
    const minimumX = from.position.x + envelopeById.get(from.id)!.width + 96;
    if (to.position.x < minimumX) {
      reasons.push({
        code: 'backtracking-or-clearance',
        message: `Edge "${edge.id}" must run left-to-right with at least 96px clearance from "${from.id}" to "${to.id}".`,
        refs: [from.id, to.id, edge.id],
      });
    }
  }

  const sourcePort = (node: WorkflowNode): { x: number; y: number } => ({
    x: node.position.x + envelopeById.get(node.id)!.width,
    y: node.position.y + envelopeById.get(node.id)!.height / 2,
  });
  const targetPort = (node: WorkflowNode): { x: number; y: number } => ({
    x: node.position.x,
    y: node.position.y + envelopeById.get(node.id)!.height / 2,
  });
  const orientation = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }): number =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const crossingEdges = edges.length <= MAX_WORKFLOW_EDGES ? edges : [];
  if (edges.length > MAX_WORKFLOW_EDGES) {
    reasons.push({
      code: 'graph-too-complex',
      message: `Layout crossing analysis supports at most ${MAX_WORKFLOW_EDGES} non-loop edges.`,
    });
  }
  const segments = crossingEdges.flatMap((edge) => {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to || !positionValid.has(from.id) || !positionValid.has(to.id)) return [];
    const start = sourcePort(from);
    const end = targetPort(to);
    return [{
      edge,
      start,
      end,
      minX: Math.min(start.x, end.x),
      maxX: Math.max(start.x, end.x),
      minY: Math.min(start.y, end.y),
      maxY: Math.max(start.y, end.y),
    }];
  });
  for (let leftIndex = 0; leftIndex < segments.length; leftIndex += 1) {
    const left = segments[leftIndex];
    const leftEdge = left.edge;
    for (let rightIndex = leftIndex + 1; rightIndex < segments.length; rightIndex += 1) {
      const right = segments[rightIndex];
      const rightEdge = right.edge;
      const refs = new Set([leftEdge.from, leftEdge.to, rightEdge.from, rightEdge.to]);
      if (refs.size < 4) continue;
      // Cheap bounding-box rejection keeps the supported 384-edge ceiling
      // responsive while still testing every non-adjacent pair that can meet.
      if (left.maxX < right.minX || right.maxX < left.minX || left.maxY < right.minY || right.maxY < left.minY) continue;
      const crosses = orientation(left.start, left.end, right.start) * orientation(left.start, left.end, right.end) < 0 &&
        orientation(right.start, right.end, left.start) * orientation(right.start, right.end, left.end) < 0;
      if (crosses) {
        reasons.push({
          code: 'edge-crossing',
          message: `Edges "${leftEdge.id}" and "${rightEdge.id}" intersect.`,
          refs: [leftEdge.id, rightEdge.id, leftEdge.from, leftEdge.to, rightEdge.from, rightEdge.to],
        });
      }
    }
  }

  const byX = new Map<number, WorkflowNode[]>();
  for (const node of nodes) {
    if (!positionValid.has(node.id)) continue;
    byX.set(node.position.x, [...(byX.get(node.position.x) ?? []), node]);
  }
  for (const group of byX.values()) {
    const ordered = [...group].sort((a, b) => a.position.y - b.position.y || a.id.localeCompare(b.id));
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      const gap = current.position.y - (previous.position.y + envelopeById.get(previous.id)!.height);
      if (gap < 64) {
        reasons.push({
          code: 'vertical-clearance',
          message: `Nodes "${previous.id}" and "${current.id}" need at least 64px same-rank clearance.`,
          refs: [previous.id, current.id],
        });
      }
    }
  }

  for (const node of nodes) {
    if (!positionValid.has(node.id)) continue;
    const predecessors = edges
      .filter((edge) => edge.to === node.id)
      .map((edge) => nodeById.get(edge.from))
      .filter((candidate): candidate is WorkflowNode => !!candidate && positionValid.has(candidate.id));
    if (predecessors.length < 2) continue;
    const preferredCenter = predecessors.reduce(
      (sum, predecessor) => sum + predecessor.position.y + envelopeById.get(predecessor.id)!.height / 2,
      0,
    ) / predecessors.length;
    const actualCenter = node.position.y + envelopeById.get(node.id)!.height / 2;
    if (Math.abs(actualCenter - preferredCenter) > LAYOUT_GRID) {
      reasons.push({
        code: 'merge-placement',
        message: `Merge node "${node.id}" should be centered on predecessors ${predecessors.map((item) => `"${item.id}"`).join(', ')}.`,
        refs: [node.id, ...predecessors.map((item) => item.id)],
      });
    }
  }

  const uniqueReasons = reasons.filter((reason, index) =>
    reasons.findIndex((candidate) => candidate.code === reason.code && candidate.message === reason.message) === index);
  return {
    ...diagnosticSource(source, false),
    reasons: uniqueReasons,
    quality: { valid: uniqueReasons.length === 0, score: Math.max(0, 100 - uniqueReasons.length * 10) },
    envelopes,
    loopRoutes: loopRoutes(definition),
  };
}

export function evaluateWorkflowLayout(definition: EditableWorkflowDefinition): WorkflowLayoutDiagnostics {
  return evaluateWithSource(definition, 'generated');
}

function normalizedLayout(definition: EditableWorkflowDefinition, source: WorkflowLayoutSource): WorkflowLayoutResult {
  const nodes = Array.isArray(definition.nodes) ? definition.nodes : [];
  const ids = new Set(nodes.map((node) => node.id));
  const edges = structuralEdges(definition, ids);
  const order = authoredOrder(nodes, edges);
  const ranks = longestPathRanks(nodes, edges, order);
  const outgoingRows = new Map<string, number>();
  for (const edge of Array.isArray(definition.edges) ? definition.edges : []) {
    if (edge && typeof edge === 'object' && edge.lane !== 'error' && typeof edge.from === 'string') {
      outgoingRows.set(edge.from, (outgoingRows.get(edge.from) ?? 0) + 1);
    }
  }
  const envelopeById = new Map(nodes.map((node) => [
    node.id,
    nodeLayoutEnvelope(node, outgoingRows.get(node.id) ?? 0),
  ]));
  const groups = new Map<number, WorkflowNode[]>();
  for (const node of nodes) groups.set(ranks.get(node.id) ?? 0, [...(groups.get(ranks.get(node.id) ?? 0) ?? []), node]);
  for (const group of groups.values()) group.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  const orderedRanks = [...groups.keys()].sort((a, b) => a - b);
  const xByRank = new Map<number, number>();
  let cursorX = 0;
  for (const rank of orderedRanks) {
    xByRank.set(rank, cursorX);
    const widest = Math.max(...(groups.get(rank) ?? []).map((node) => envelopeById.get(node.id)!.width), 0);
    cursorX = ceilToGrid(cursorX + widest + LAYOUT_HORIZONTAL_CLEARANCE);
  }

  const positions = new Map<string, { x: number; y: number }>();
  const incoming = new Map<string, string[]>();
  for (const edge of edges) incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
  for (const rank of orderedRanks) {
    const group = groups.get(rank) ?? [];
    if (rank > 0) {
      const predecessorCenter = (node: WorkflowNode): number => {
        const centers = (incoming.get(node.id) ?? []).flatMap((id) => {
          const position = positions.get(id);
          return position ? [position.y + envelopeById.get(id)!.height / 2] : [];
        });
        return centers.length > 0 ? centers.reduce((sum, value) => sum + value, 0) / centers.length : 0;
      };
      group.sort((a, b) => predecessorCenter(a) - predecessorCenter(b) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    }
    const heights = group.map((node) => envelopeById.get(node.id)!.height);
    const packedHeight = heights.reduce((sum, height) => sum + height, 0) + Math.max(0, group.length - 1) * LAYOUT_VERTICAL_CLEARANCE;
    const predecessorCenters = group.flatMap((node) =>
      (incoming.get(node.id) ?? []).flatMap((id) => {
        const position = positions.get(id);
        return position ? [position.y + envelopeById.get(id)!.height / 2] : [];
      }));
    const targetCenter = predecessorCenters.length > 0
      ? predecessorCenters.reduce((sum, center) => sum + center, 0) / predecessorCenters.length
      : packedHeight / 2;
    let cursorY = snap(targetCenter - packedHeight / 2);
    for (const node of group) {
      const predecessors = (incoming.get(node.id) ?? []).flatMap((id) => {
        const position = positions.get(id);
        return position ? [{ id, position }] : [];
      });
      if (group.length === 1 && predecessors.length >= 2) {
        const centered = predecessors.reduce(
          (sum, predecessor) => sum + predecessor.position.y + envelopeById.get(predecessor.id)!.height / 2,
          0,
        ) / predecessors.length - envelopeById.get(node.id)!.height / 2;
        cursorY = snap(centered);
      }
      positions.set(node.id, { x: xByRank.get(rank) ?? 0, y: cursorY });
      cursorY = ceilToGrid(cursorY + envelopeById.get(node.id)!.height + LAYOUT_VERTICAL_CLEARANCE);
    }
  }

  const positionedNodes = nodes.map((node) => ({ ...node, position: positions.get(node.id) ?? { x: 0, y: 0 } }));
  const normalized: EditableWorkflowDefinition = {
    ...structuredClone(definition),
    nodes: positionedNodes,
    layout: { source: 'normalized', version: 1 },
  };
  const evaluated = evaluateWithSource(normalized, source);
  return {
    definition: normalized,
    diagnostics: { ...evaluated, ...diagnosticSource(source, true) },
  };
}

export function normalizeWorkflowLayout(definition: EditableWorkflowDefinition): WorkflowLayoutResult {
  return normalizedLayout(definition, 'generated');
}

export function prepareWorkflowLayoutForWrite(
  definition: EditableWorkflowDefinition,
  intent: WorkflowLayoutIntent = 'generated',
): WorkflowLayoutResult {
  if (intent === 'manual') {
    const diagnostics = evaluateWithSource(definition, 'manual');
    if (!diagnostics.quality.valid) throw new WorkflowLayoutError(diagnostics.reasons);
    return {
      definition: { ...structuredClone(definition), layout: { source: 'manual', version: 1 } },
      diagnostics,
    };
  }
  return normalizedLayout(definition, intent === 'normalize' ? 'normalized' : 'generated');
}
