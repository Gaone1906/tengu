import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-workflow-provenance-'));
process.env.JINN_HOME = home;

type Registry = typeof import('../registry.js');
let registry: Registry;

beforeAll(async () => {
  registry = await import('../registry.js');
  registry.initDb();
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('workflow session provenance', () => {
  it('persists queryable run/phase provenance and enumerates phases through the parent', () => {
    const parent = registry.createSession({
      engine: 'workflow',
      source: 'web',
      sourceRef: 'workflow-run:run-reg-1:parent',
      sessionKey: 'workflow-run:run-reg-1:parent',
      title: 'Workflow: release-check · run run-reg-1',
      workflowProvenance: {
        kind: 'run',
        workflowId: 'wf-release',
        workflowName: 'release-check',
        runId: 'run-reg-1',
        triggerSource: 'manual',
      },
    });
    const phase = registry.createSession({
      engine: 'codex',
      source: 'web',
      sourceRef: 'workflow-run:run-reg-1:verify:1',
      sessionKey: 'workflow-run:run-reg-1:verify:1',
      title: '[Workflow] release-check / VERIFY',
      parentSessionId: parent.id,
      workflowProvenance: {
        kind: 'phase',
        workflowId: 'wf-release',
        workflowName: 'release-check',
        runId: 'run-reg-1',
        triggerSource: 'manual',
        phase: {
          nodeId: 'verify',
          name: 'VERIFY',
          index: 2,
          round: 1,
          attempt: 1,
        },
      },
    });

    expect(registry.getSession(parent.id)?.workflowProvenance).toEqual({
      kind: 'run',
      workflowId: 'wf-release',
      workflowName: 'release-check',
      runId: 'run-reg-1',
      triggerSource: 'manual',
    });
    expect(registry.getSession(phase.id)).toMatchObject({
      parentSessionId: parent.id,
      workflowProvenance: {
        kind: 'phase',
        workflowId: 'wf-release',
        workflowName: 'release-check',
        runId: 'run-reg-1',
        triggerSource: 'manual',
        phase: { nodeId: 'verify', name: 'VERIFY', index: 2, round: 1, attempt: 1 },
      },
    });

    expect(registry.searchSessionsFiltered({ workflowRunId: 'run-reg-1' }).map((s) => s.id).sort())
      .toEqual([parent.id, phase.id].sort());
    expect(registry.searchSessionsFiltered({ workflowId: 'wf-release', workflowPhaseName: 'VERIFY' }).map((s) => s.id))
      .toEqual([phase.id]);
    expect(registry.listChildSessions(parent.id).map((s) => s.id)).toEqual([phase.id]);
  });
});
