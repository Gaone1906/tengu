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

  function parkedRunWithInFlightReceipt(
    workflowId: string,
    runId: string,
    schemaVersion: 1 | 2 | 3,
    receiptStatus: 'running' | 'dispatching',
  ): import('../run-store.js').WorkflowRun {
    return {
      ...quietParkedRun(workflowId, runId, schemaVersion),
      steps: [
        {
          nodeId: 'prepare',
          label: 'Prepare',
          actor: { kind: 'engine', ref: 'codex' },
          status: receiptStatus,
          attempt: 1,
          at: '2026-07-12T11:01:00.000Z',
          dispatchedAt: '2026-07-12T11:01:00.000Z',
          ...(receiptStatus === 'running' ? { sessionId: 'legacy-running-session' } : {}),
        },
        {
          nodeId: 'approval',
          label: 'Approval',
          actor: null,
          status: 'pending',
          at: '2026-07-12T11:05:00.000Z',
        },
      ],
      order: ['prepare', 'approval'],
    };
  }

  it('mints approval only for a genuine running-to-parked transition, never an already-parked candidate', async () => {
    const store = await import('../run-store.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-workflow-park-transition-'));
    const definition = approvalDefinition('native-park-transition');
    const modern = await reconciler.startWorkflowRun({
      root,
      getDefinition: () => definition,
      probeStepSession: () => ({ found: false }),
      spawnStep: async () => ({ sessionId: 'native-park-transition-step' }),
      now: () => '2026-07-12T12:00:00.000Z',
    }, definition);
    expect(modern).toMatchObject({
      status: 'parked',
      parked: { approval: { state: 'pending', requestedBy: 'workflow-run' } },
    });

    const legacyRunId = 'run-already-parked-candidate';
    const legacy: import('../run-store.js').WorkflowRun = {
      ...quietParkedRun(definition.id, legacyRunId, 3),
      steps: [{
        nodeId: 'prepare',
        label: 'Prepare',
        actor: { kind: 'engine', ref: 'codex' },
        status: 'pending',
        at: '2026-07-12T11:00:00.000Z',
      }],
      order: ['prepare', 'approval'],
    };
    store.saveRun(root, legacy);
    const edited = await reconciler.editPendingWorkflowStepPrompt(
      {
        root,
        getDefinition: () => definition,
        probeStepSession: () => ({ found: false }),
        spawnStep: async () => ({ sessionId: 'must-not-spawn' }),
        now: () => '2026-07-12T12:00:00.000Z',
      },
      definition.id,
      legacyRunId,
      'prepare',
      'Updated while awaiting explicit adoption.',
      { actor: 'operator' },
    );

    expect(edited).toMatchObject({ outcome: 'edited', run: { status: 'parked' } });
    if (edited.outcome !== 'edited') throw new Error(`expected edit, got ${edited.outcome}`);
    expect(edited.run.parked).not.toHaveProperty('approval');
    expect(edited.run.approvalAdoptions).toBeUndefined();
  });

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

  const inertParkedCases = ([1, 2, 3] as const).flatMap((schemaVersion) =>
    (['running', 'dispatching'] as const).flatMap((receiptStatus) =>
      (['direct-sweep', 'startup', 'interval', 'direct-advance'] as const).map((entryPath) => ({
        schemaVersion,
        receiptStatus,
        entryPath,
      })),
    ),
  );

  it.each(inertParkedCases)(
    'keeps parked v$schemaVersion/$receiptStatus evidence byte-identical through $entryPath',
    async ({ schemaVersion, receiptStatus, entryPath }) => {
    const store = await import('../run-store.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-workflow-inert-parked-'));
    const workflowId = `legacy-inert-${entryPath}-${receiptStatus}-v${schemaVersion}`;
    const runId = `run-legacy-inert-${entryPath}-${receiptStatus}-v${schemaVersion}`;
    const legacy = parkedRunWithInFlightReceipt(workflowId, runId, schemaVersion, receiptStatus);
    const file = path.join(root, 'reports', 'runs', workflowId, `${runId}.json`);
    const original = `${JSON.stringify(legacy, null, 2)}\n`;
    const seed = () => {
      store.saveRun(root, legacy); // seeds the active index used by sweep paths
      fs.writeFileSync(file, original, 'utf8'); // restore the exact historical bytes after indexing
    };
    if (entryPath !== 'interval') seed();
    const originalHash = createHash('sha256').update(original).digest('hex');
    let spawns = 0;
    const deps = {
      root,
      getDefinition: () => approvalDefinition(workflowId),
      probeStepSession: () => receiptStatus === 'running'
        ? ({ found: true as const, sessionId: 'legacy-running-session', status: 'idle' as const, finalAssistantText: 'must not settle' })
        : ({ found: true as const, sessionId: 'legacy-dispatching-session', status: 'running' as const }),
      spawnStep: async () => { spawns++; return { sessionId: 'must-not-spawn' }; },
      now: () => '2026-07-12T12:00:00.000Z',
    };

    if (entryPath === 'direct-sweep') {
      await reconciler.sweepWorkflowRuns(deps);
    } else if (entryPath === 'direct-advance') {
      await reconciler.advanceWorkflowRunById(deps, workflowId, runId);
    } else if (entryPath === 'startup') {
      const stop = reconciler.startWorkflowRunReconciler(deps, { intervalMs: 60_000 });
      await new Promise<void>((resolve) => setImmediate(resolve));
      stop();
    } else {
      const stop = reconciler.startWorkflowRunReconciler(deps, { intervalMs: 5 });
      await new Promise<void>((resolve) => setImmediate(resolve)); // startup sweep completed with no run
      seed();
      await new Promise((resolve) => setTimeout(resolve, 20)); // at least one interval tick sees the indexed run
      stop();
    }

    expect(spawns).toBe(0);
    const after = fs.readFileSync(file, 'utf8');
    expect(createHash('sha256').update(after).digest('hex')).toBe(originalHash);
    expect(after).toBe(original);
    const persisted = JSON.parse(after) as Record<string, unknown>;
    expect(persisted.schemaVersion).toBe(schemaVersion);
    expect(persisted.revision).toBe(schemaVersion === 3 ? 1 : undefined);
    expect(persisted).not.toHaveProperty('approvalAdoptions');
    expect(persisted.parked).not.toHaveProperty('approval');
    },
  );
});
