import { describe, it, expect } from 'vitest';
import { impliedExecutionOrder } from '../order.js';
import {
  WORKFLOW_DEFINITION_SCHEMA_VERSION,
  type EditableWorkflowDefinition,
  type WorkflowNode,
  type WorkflowEdge,
} from '../definition.js';

function node(id: string, type: WorkflowNode['type'] = 'step'): WorkflowNode {
  return {
    id,
    type,
    label: id.toUpperCase(),
    position: { x: 0, y: 0 },
    ...(type === 'trigger' ? { trigger: { kind: 'manual' as const } } : {}),
  };
}

function edge(from: string, to: string, kind: WorkflowEdge['kind'] = 'sequence'): WorkflowEdge {
  return { id: `e_${from}__${to}`, from, to, kind };
}

function def(nodes: WorkflowNode[], edges: WorkflowEdge[]): EditableWorkflowDefinition {
  return {
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    id: 'wf',
    title: 'WF',
    version: 1,
    status: 'active',
    nodes,
    edges,
  };
}

describe('impliedExecutionOrder — Kahn with declaration tiebreak', () => {
  it('reproduces declaration order for a linear chain', () => {
    const d = def(
      [node('t', 'trigger'), node('a'), node('b')],
      [edge('t', 'a'), edge('a', 'b')],
    );
    expect(impliedExecutionOrder(d)).toEqual(['t', 'a', 'b']);
  });

  it('reproduces declaration order for a branching graph declared in a valid topo order (diamond)', () => {
    // The sample fixture shape: fan-out + fan-in, edges all pointing declaration-forward.
    const d = def(
      [node('t', 'trigger'), node('a'), node('b'), node('c'), node('d')],
      [edge('t', 'a'), edge('a', 'b', 'handoff'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd', 'handoff')],
    );
    expect(impliedExecutionOrder(d)).toEqual(['t', 'a', 'b', 'c', 'd']);
  });

  it('tie-breaks a fan-out by declaration index', () => {
    const d = def(
      [node('t', 'trigger'), node('b'), node('a')],
      [edge('t', 'b'), edge('t', 'a')],
    );
    // Both a and b become ready together; declaration order (b before a) wins.
    expect(impliedExecutionOrder(d)).toEqual(['t', 'b', 'a']);
  });

  it('honors a declaration-backward edge (edges win over declaration)', () => {
    // Declared [t, a, b] but the edges say t→b→a.
    const d = def(
      [node('t', 'trigger'), node('a'), node('b')],
      [edge('t', 'b'), edge('b', 'a')],
    );
    expect(impliedExecutionOrder(d)).toEqual(['t', 'b', 'a']);
  });

  it('returns null for a cycle (no topological order exists)', () => {
    const d = def(
      [node('t', 'trigger'), node('a'), node('b')],
      [edge('t', 'a'), edge('a', 'b'), edge('b', 'a')],
    );
    expect(impliedExecutionOrder(d)).toBeNull();
  });
});

// (The GRS-014a declarationOrderWarning guard was deleted in GRS-014b — the engine
// now EXECUTES the edge-implied order above, so there is nothing left to warn about.
// Legacy stamped records keep rendering via the OrderWarning type.)

describe('loop edges (GRS-014e) — excluded from the sort', () => {
  it('a cycle closed by a loop edge still yields a topological order; an unmarked cycle stays null', () => {
    const nodes = [node('t', 'trigger'), node('a'), node('b')];
    const looped = def(nodes, [edge('t', 'a'), edge('a', 'b'), edge('b', 'a', 'loop')]);
    expect(impliedExecutionOrder(looped)).toEqual(['t', 'a', 'b']);

    const unmarked = def(nodes, [edge('t', 'a'), edge('a', 'b'), edge('b', 'a', 'sequence')]);
    expect(impliedExecutionOrder(unmarked)).toBeNull();
  });
});
