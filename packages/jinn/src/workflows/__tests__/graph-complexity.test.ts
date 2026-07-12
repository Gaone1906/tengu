import { describe, expect, it } from 'vitest';
import {
  validateDefinition,
  type EditableWorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from '../definition.js';

const NODE_LIMIT = 96;

function denseDag(id: string, nodeCount: number, forwardWidth: number): EditableWorkflowDefinition {
  const nodes: WorkflowNode[] = Array.from({ length: nodeCount }, (_, index) => index === 0
    ? {
        id: 'n0',
        type: 'trigger',
        label: 'Manual',
        position: { x: 0, y: 0 },
        trigger: { kind: 'manual' },
      }
    : {
        id: `n${index}`,
        type: 'step',
        label: `Step ${index}`,
        position: { x: index * 320, y: (index % 4) * 180 },
      });
  const edges: WorkflowEdge[] = [];
  for (let from = 0; from < nodeCount; from += 1) {
    for (let distance = 1; distance <= forwardWidth && from + distance < nodeCount; distance += 1) {
      edges.push({
        id: `e-${from}-${from + distance}`,
        from: `n${from}`,
        to: `n${from + distance}`,
        kind: 'sequence',
      });
    }
  }
  return {
    schemaVersion: 1,
    id,
    title: id,
    version: 1,
    status: 'active',
    nodes,
    edges,
  };
}

describe('workflow graph complexity budget', () => {
  it('accepts a dense near-limit DAG inside a synchronous responsiveness budget', () => {
    const definition = denseDag('near-limit', NODE_LIMIT, 4);
    expect(definition.edges).toHaveLength(374);
    const started = performance.now();
    const result = validateDefinition(definition);
    const elapsedMs = performance.now() - started;

    expect(result.errors).toEqual([]);
    expect(elapsedMs).toBeLessThan(500);
  });

  it('rejects pathological complete graphs before they can monopolize the event loop', async () => {
    const definition = denseDag('over-limit', 120, 119);
    expect(definition.edges).toHaveLength(7_140);
    let timerDelayMs = Number.POSITIVE_INFINITY;
    const timerStarted = performance.now();
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        timerDelayMs = performance.now() - timerStarted;
        resolve();
      }, 0);
    });

    const started = performance.now();
    const result = validateDefinition(definition);
    const elapsedMs = performance.now() - started;
    await timer;

    const codes = result.errors.map((error) => error.code);
    expect(codes).toContain('too-many-nodes');
    expect(codes).toContain('too-many-edges');
    expect(codes).toContain('workflow-too-dense');
    expect(elapsedMs).toBeLessThan(800);
    expect(timerDelayMs).toBeLessThan(1_000);
  });

  it('rejects an oversized serialized definition even when its graph is small', () => {
    const definition = denseDag('large-input', 2, 1);
    definition.description = 'x'.repeat(257 * 1024);
    const result = validateDefinition(definition);
    expect(result.errors.map((error) => error.code)).toContain('definition-too-large');
  });
});
