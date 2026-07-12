import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-workflow-native-approval-'));
process.env.JINN_HOME = tmpHome;

const orgDir = path.join(tmpHome, 'org', 'platform');
fs.mkdirSync(orgDir, { recursive: true });
fs.writeFileSync(path.join(orgDir, 'department.yaml'), 'name: platform\n');
fs.writeFileSync(
  path.join(orgDir, 'root.yaml'),
  'name: root\ndisplayName: Root\ndepartment: platform\nrank: executive\nengine: codex\nmodel: test\npersona: Root.\n',
);
fs.writeFileSync(
  path.join(orgDir, 'manager.yaml'),
  'name: manager\ndisplayName: Manager\ndepartment: platform\nrank: manager\nreportsTo: root\nengine: codex\nmodel: test\npersona: Manager.\n',
);
fs.writeFileSync(
  path.join(orgDir, 'requester.yaml'),
  'name: requester\ndisplayName: Requester\ndepartment: platform\nrank: employee\nreportsTo: manager\nengine: codex\nmodel: test\npersona: Requester.\n',
);

const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-workflow-native-approval-evidence-'));

type DefinitionModule = typeof import('../definition.js');
type ReconcilerModule = typeof import('../run-reconciler.js');
type RegistryModule = typeof import('../../sessions/registry.js');
type WorkItemStoreModule = typeof import('../../work-items/store.js');

let definitionModule: DefinitionModule;
let reconciler: ReconcilerModule;
let registry: RegistryModule;
let workItems: WorkItemStoreModule;

beforeAll(async () => {
  definitionModule = await import('../definition.js');
  reconciler = await import('../run-reconciler.js');
  registry = await import('../../sessions/registry.js');
  workItems = await import('../../work-items/store.js');
  registry.initDb();
});

function approvalDefinition(id: string): import('../definition.js').EditableWorkflowDefinition {
  return {
    schemaVersion: definitionModule.WORKFLOW_DEFINITION_SCHEMA_VERSION,
    id,
    title: 'Native approval',
    version: 1,
    status: 'active',
    ownerEmployee: 'requester',
    nodes: [
      { id: 'trigger', type: 'trigger', label: 'Manual', position: { x: 0, y: 0 }, trigger: { kind: 'manual' } },
      {
        id: 'prepare',
        type: 'step',
        label: 'Prepare',
        position: { x: 0, y: 100 },
        actor: { kind: 'engine', ref: 'codex' },
        options: { output: 'none' },
      },
      {
        id: 'approval',
        type: 'gate',
        label: 'Approval',
        position: { x: 0, y: 200 },
        gate: { kind: 'approval', description: 'Approve the release?', approvalRef: 'release' },
      },
    ],
    edges: [
      { id: 'trigger-prepare', from: 'trigger', to: 'prepare', kind: 'sequence' },
      { id: 'prepare-approval', from: 'prepare', to: 'approval', kind: 'sequence' },
    ],
  };
}

describe('native Workflow gate approvals', () => {
  it('parks with a frozen native approval route and creates no Workflow Todo', async () => {
    const requesterSession = registry.createSession({
      engine: 'codex',
      source: 'web',
      sourceRef: 'native-approval-requester',
      title: 'Requester',
      employee: 'requester',
    });
    const definition = approvalDefinition('native-approval-record');
    const run = await reconciler.startWorkflowRun({
      root: evidenceRoot,
      getDefinition: () => definition,
      probeStepSession: () => ({ found: false }),
      spawnStep: async () => ({ sessionId: 'native-approval-step' }),
      now: () => '2026-07-12T12:00:00.000Z',
    }, definition, {
      invocation: { sessionId: requesterSession.id, reportMode: 'resume' },
    });

    expect(run.status).toBe('parked');
    expect((run.parked as unknown as { approval?: Record<string, unknown> } | null)?.approval).toMatchObject({
      state: 'pending',
      requestedBy: 'workflow-run',
      requesterEmployee: 'requester',
      target: 'manager',
      targetKind: 'employee',
    });
    expect(workItems.getWorkItemBySourceRef('workflow', `workflow:${run.workflowId}:${run.runId}`)).toBeUndefined();
  });

  function quietParkedRun(
    workflowId: string,
    runId: string,
    schemaVersion: 1 | 2 | 3,
    withDefinition = true,
  ): import('../run-store.js').WorkflowRun {
    const definition = approvalDefinition(workflowId);
    return {
      schemaVersion,
      ...(schemaVersion === 3 ? { revision: 1 } : {}),
      runId,
      workflowId,
      definitionVersion: 1,
      title: workflowId,
      trigger: { kind: 'manual' },
      status: 'parked',
      startedAt: '2026-07-12T11:00:00.000Z',
      endedAt: null,
      steps: [],
      parked: {
        scope: 'runGate',
        nodeId: null,
        kind: 'approval',
        evaluator: 'human-approval',
        ref: 'release',
        description: 'Approve the release?',
        at: '2026-07-12T11:05:00.000Z',
      },
      order: [],
      ...(withDefinition ? { definitionSnapshot: definition } : {}),
    };
  }

  it.each([1, 2, 3] as const)('explicitly adopts a quiet parked v%s run once with fresh pending authority', async (schemaVersion) => {
    const store = await import('../run-store.js');
    const workflowId = `legacy-adoption-v${schemaVersion}`;
    const runId = `run-legacy-v${schemaVersion}`;
    store.saveRun(evidenceRoot, quietParkedRun(workflowId, runId, schemaVersion));
    const deps = {
      root: evidenceRoot,
      getDefinition: () => approvalDefinition(workflowId),
      probeStepSession: () => ({ found: false as const }),
      spawnStep: async () => ({ sessionId: 'must-not-spawn' }),
      now: () => '2026-07-12T12:00:00.000Z',
    };

    const legacyDecision = await reconciler.resolveWorkflowRunGate(deps, workflowId, runId, 'approve', { decidedBy: 'manager' });
    expect(legacyDecision.outcome).toBe('not-parked');
    if (legacyDecision.outcome !== 'not-parked') throw new Error('expected legacy decision refusal');
    expect(legacyDecision.run.parked).not.toHaveProperty('approval');

    const adopted = await reconciler.adoptLegacyParkedWorkflowApproval(deps, workflowId, runId);
    if (adopted.outcome !== 'adopted') throw new Error(`expected adoption, got ${adopted.outcome}`);
    expect(adopted).toMatchObject({
      outcome: 'adopted',
      run: {
        schemaVersion: 3,
        status: 'parked',
        parked: {
          approval: {
            state: 'pending',
            target: 'manager',
            targetKind: 'employee',
            decidedBy: null,
            decidedAt: null,
          },
        },
        approvalAdoptions: [{
          legacySchemaVersion: schemaVersion,
          definitionSource: 'snapshot',
          adoptedAt: '2026-07-12T12:00:00.000Z',
          priorParked: expect.not.objectContaining({ approval: expect.anything() }),
          approval: expect.objectContaining({ state: 'pending', target: 'manager' }),
        }],
      },
    });
    const revision = adopted.run.revision;

    const duplicate = await reconciler.adoptLegacyParkedWorkflowApproval(deps, workflowId, runId);
    if (duplicate.outcome === 'not-found') throw new Error('adopted run disappeared');
    expect(duplicate).toMatchObject({ outcome: 'already-adopted', run: { revision } });
    expect(duplicate.run.approvalAdoptions).toHaveLength(1);

    const resolved = await reconciler.resolveWorkflowRunGate(deps, workflowId, runId, 'reject', { decidedBy: 'manager' });
    expect(resolved).toMatchObject({ outcome: 'resolved', run: { status: 'failed' } });
  });

  it('adopts missing-definition evidence through a fresh fail-closed root route', async () => {
    const store = await import('../run-store.js');
    const workflowId = 'legacy-adoption-missing-definition';
    const runId = 'run-legacy-missing-definition';
    store.saveRun(evidenceRoot, quietParkedRun(workflowId, runId, 1, false));
    const adopted = await reconciler.adoptLegacyParkedWorkflowApproval({
      root: evidenceRoot,
      getDefinition: () => null,
      probeStepSession: () => ({ found: false }),
      spawnStep: async () => ({ sessionId: 'must-not-spawn' }),
      now: () => '2026-07-12T12:00:00.000Z',
    }, workflowId, runId);

    expect(adopted).toMatchObject({
      outcome: 'adopted',
      run: {
        parked: { approval: { state: 'pending', target: 'root', targetKind: 'employee' } },
        approvalAdoptions: [{ definitionSource: 'missing-fallback' }],
      },
    });
  });

  it('adopts quiet legacy parked runs during a sweep without advancing or spawning them', async () => {
    const store = await import('../run-store.js');
    const workflowId = 'legacy-adoption-sweep';
    const runId = 'run-legacy-sweep';
    store.saveRun(evidenceRoot, quietParkedRun(workflowId, runId, 2));
    let spawns = 0;
    const examined = await reconciler.sweepWorkflowRuns({
      root: evidenceRoot,
      getDefinition: () => approvalDefinition(workflowId),
      probeStepSession: () => ({ found: false }),
      spawnStep: async () => { spawns++; return { sessionId: 'must-not-spawn' }; },
      now: () => '2026-07-12T12:00:00.000Z',
    });

    expect(examined).toBeGreaterThanOrEqual(1);
    expect(spawns).toBe(0);
    expect(store.getRun(evidenceRoot, workflowId, runId)).toMatchObject({
      status: 'parked',
      parked: { approval: { state: 'pending' } },
      approvalAdoptions: [{ definitionSource: 'snapshot' }],
    });
  });
});
