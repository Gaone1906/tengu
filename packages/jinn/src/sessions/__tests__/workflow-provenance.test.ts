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
  it('groups a new phase attempt by workflowRunId without a conversational parent', () => {
    const phase = registry.createSession({
      engine: 'codex',
      source: 'web',
      sourceRef: 'workflow-run:run-reg-2:verify:1',
      sessionKey: 'workflow-run:run-reg-2:verify:1',
      title: '[Workflow] release-check / VERIFY',
      workflowProvenance: {
        kind: 'phase',
        workflowId: 'wf-release',
        workflowName: 'release-check',
        runId: 'run-reg-2',
        triggerSource: 'manual',
        phase: { nodeId: 'verify', name: 'VERIFY', index: 2, round: 1, attempt: 1 },
      },
    });

    expect(registry.getSession(phase.id)).toMatchObject({
      parentSessionId: null,
      workflowProvenance: { kind: 'phase', runId: 'run-reg-2' },
    });
    expect(registry.searchSessionsFiltered({ workflowRunId: 'run-reg-2' }).map((session) => session.id))
      .toEqual([phase.id]);
  });
});
