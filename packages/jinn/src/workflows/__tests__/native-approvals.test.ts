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
});
