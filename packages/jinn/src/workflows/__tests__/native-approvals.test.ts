import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
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

  it.each([
    { schemaVersion: 1 as const, sweep: 'direct' as const },
    { schemaVersion: 2 as const, sweep: 'direct' as const },
    { schemaVersion: 1 as const, sweep: 'startup' as const },
    { schemaVersion: 2 as const, sweep: 'startup' as const },
    { schemaVersion: 1 as const, sweep: 'interval' as const },
    { schemaVersion: 2 as const, sweep: 'interval' as const },
  ])('keeps quiet parked v$schemaVersion evidence byte-identical during a $sweep sweep', async ({ schemaVersion, sweep }) => {
    const store = await import('../run-store.js');
    const workflowId = `legacy-inert-${sweep}-v${schemaVersion}`;
    const runId = `run-legacy-inert-${sweep}-v${schemaVersion}`;
    const legacy = quietParkedRun(workflowId, runId, schemaVersion);
    store.saveRun(evidenceRoot, legacy); // seeds the active index used by every sweep path
    const file = path.join(evidenceRoot, 'reports', 'runs', workflowId, `${runId}.json`);
    const original = `${JSON.stringify(legacy, null, 2)}\n`;
    fs.writeFileSync(file, original, 'utf8');
    const originalHash = createHash('sha256').update(original).digest('hex');
    let spawns = 0;
    const deps = {
      root: evidenceRoot,
      getDefinition: () => approvalDefinition(workflowId),
      probeStepSession: () => ({ found: false }),
      spawnStep: async () => { spawns++; return { sessionId: 'must-not-spawn' }; },
      now: () => '2026-07-12T12:00:00.000Z',
    };

    if (sweep === 'direct') {
      await reconciler.sweepWorkflowRuns(deps);
    } else {
      const stop = reconciler.startWorkflowRunReconciler(deps, {
        intervalMs: sweep === 'startup' ? 60_000 : 5,
      });
      await new Promise((resolve) => setTimeout(resolve, sweep === 'startup' ? 30 : 35));
      stop();
    }

    expect(spawns).toBe(0);
    const after = fs.readFileSync(file, 'utf8');
    expect(createHash('sha256').update(after).digest('hex')).toBe(originalHash);
    expect(after).toBe(original);
    const persisted = JSON.parse(after) as Record<string, unknown>;
    expect(persisted.schemaVersion).toBe(schemaVersion);
    expect(persisted).not.toHaveProperty('revision');
    expect(persisted).not.toHaveProperty('approvalAdoptions');
    expect(persisted.parked).not.toHaveProperty('approval');
  });
});
