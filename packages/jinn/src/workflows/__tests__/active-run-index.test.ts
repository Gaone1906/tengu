import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  saveRun,
  listActiveRunRefs,
  rebuildActiveRunIndex,
  isTerminalRunStatus,
  WORKFLOW_RUN_SCHEMA_VERSION,
  type WorkflowRun,
  type WorkflowRunStatus,
} from '../run-store.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-active-idx-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function makeRun(workflowId: string, runId: string, status: WorkflowRunStatus): WorkflowRun {
  return {
    schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
    runId,
    workflowId,
    definitionVersion: 1,
    title: workflowId,
    trigger: { source: 'manual', event: 'workflow.manual_started', payload: {} },
    status,
    startedAt: '2026-07-06T06:00:00.000Z',
    endedAt: status === 'running' || status === 'parked' ? null : '2026-07-06T06:00:01.000Z',
    steps: [],
    parked: null,
  };
}

const key = (r: { workflowId: string; runId: string }) => `${r.workflowId}/${r.runId}`;

describe('active-run index', () => {
  it('classifies terminal vs active statuses', () => {
    expect(isTerminalRunStatus('completed')).toBe(true);
    expect(isTerminalRunStatus('failed')).toBe(true);
    expect(isTerminalRunStatus('cancelled')).toBe(true);
    expect(isTerminalRunStatus('running')).toBe(false);
    expect(isTerminalRunStatus('parked')).toBe(false);
    expect(isTerminalRunStatus('dispatched')).toBe(false);
  });

  it('saveRun adds non-terminal runs and drops them once terminal', () => {
    saveRun(root, makeRun('wf', 'r1', 'running'));
    saveRun(root, makeRun('wf', 'r2', 'parked'));
    saveRun(root, makeRun('wf', 'r3', 'completed'));

    expect(listActiveRunRefs(root).map(key).sort()).toEqual(['wf/r1', 'wf/r2']);

    // r1 reaches a terminal status → pruned from the index.
    saveRun(root, makeRun('wf', 'r1', 'completed'));
    expect(listActiveRunRefs(root).map(key)).toEqual(['wf/r2']);
  });

  it('rebuilds from a full scan when the index file is missing (crash recovery)', () => {
    saveRun(root, makeRun('wf', 'r1', 'running'));
    saveRun(root, makeRun('wf', 'r2', 'dispatched'));
    saveRun(root, makeRun('wf', 'r3', 'failed'));

    // Simulate a crash-truncated / never-written index.
    fs.rmSync(path.join(root, 'reports', 'runs', '_active-index.json'), { force: true });

    // Rebuild-on-miss: listActiveRunRefs re-derives the non-terminal set from disk.
    expect(listActiveRunRefs(root).map(key).sort()).toEqual(['wf/r1', 'wf/r2']);
  });

  it('corrects a stale index entry on explicit rebuild', () => {
    saveRun(root, makeRun('wf', 'r1', 'running'));
    // Hand-corrupt the index to claim a terminal/nonexistent run is active.
    fs.writeFileSync(
      path.join(root, 'reports', 'runs', '_active-index.json'),
      JSON.stringify([{ workflowId: 'wf', runId: 'ghost' }]),
    );
    const rebuilt = rebuildActiveRunIndex(root);
    expect(rebuilt.map(key)).toEqual(['wf/r1']);
    expect(listActiveRunRefs(root).map(key)).toEqual(['wf/r1']);
  });
});
