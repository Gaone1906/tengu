import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkflowEvidenceRoot } from '../index.js';

let originalCwd: string;
let originalEnv: string | undefined;
let tmp: string;

beforeEach(() => {
  originalCwd = process.cwd();
  originalEnv = process.env.JINN_WORKFLOW_EVIDENCE_ROOT;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-workflow-root-'));
  delete process.env.JINN_WORKFLOW_EVIDENCE_ROOT;
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalEnv === undefined) delete process.env.JINN_WORKFLOW_EVIDENCE_ROOT;
  else process.env.JINN_WORKFLOW_EVIDENCE_ROOT = originalEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('resolveWorkflowEvidenceRoot', () => {
  it('does not auto-enable workflows from a cwd-local evidence folder', () => {
    fs.mkdirSync(path.join(tmp, '.local-workflow-evidence', 'workflows'), { recursive: true });

    expect(resolveWorkflowEvidenceRoot()).toBeNull();
  });

  it('fails closed when the explicit workflow root is invalid', () => {
    fs.mkdirSync(path.join(tmp, '.local-workflow-evidence', 'workflows'), { recursive: true });
    process.env.JINN_WORKFLOW_EVIDENCE_ROOT = path.join(tmp, 'missing');

    expect(resolveWorkflowEvidenceRoot()).toBeNull();
  });

  it('uses the explicit workflow root when it exists', () => {
    const root = path.join(tmp, 'workflow-root');
    fs.mkdirSync(root, { recursive: true });
    process.env.JINN_WORKFLOW_EVIDENCE_ROOT = root;

    expect(resolveWorkflowEvidenceRoot()).toBe(root);
  });
});
