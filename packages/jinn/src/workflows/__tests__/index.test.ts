import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultWorkflowEvidenceRoot,
  resolveWorkflowEvidence,
  resolveWorkflowEvidenceRoot,
} from '../index.js';

let originalCwd: string;
let originalEvidenceEnv: string | undefined;
let originalHomeEnv: string | undefined;
let tmp: string;
let home: string;

beforeEach(() => {
  originalCwd = process.cwd();
  originalEvidenceEnv = process.env.JINN_WORKFLOW_EVIDENCE_ROOT;
  originalHomeEnv = process.env.JINN_HOME;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-workflow-root-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-workflow-home-'));
  delete process.env.JINN_WORKFLOW_EVIDENCE_ROOT;
  process.env.JINN_HOME = home;
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalEvidenceEnv === undefined) delete process.env.JINN_WORKFLOW_EVIDENCE_ROOT;
  else process.env.JINN_WORKFLOW_EVIDENCE_ROOT = originalEvidenceEnv;
  if (originalHomeEnv === undefined) delete process.env.JINN_HOME;
  else process.env.JINN_HOME = originalHomeEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe('resolveWorkflowEvidence', () => {
  it('defaults to <JINN_HOME>/workflow-evidence and creates it (with workflows/) when the env var is unset', () => {
    const expected = path.join(home, 'workflow-evidence');
    expect(defaultWorkflowEvidenceRoot()).toBe(expected);

    const res = resolveWorkflowEvidence();

    expect(res).toEqual({ root: expected, configured: true });
    expect(fs.statSync(expected).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(expected, 'workflows')).isDirectory()).toBe(true);
  });

  it('does not auto-enable workflows from a cwd-local evidence folder', () => {
    fs.mkdirSync(path.join(tmp, '.local-workflow-evidence', 'workflows'), { recursive: true });

    // With the env var unset the root is the JINN_HOME default, never the cwd folder.
    expect(resolveWorkflowEvidenceRoot()).toBe(path.join(home, 'workflow-evidence'));
  });

  it('uses the explicit workflow root when it exists', () => {
    const root = path.join(tmp, 'workflow-root');
    fs.mkdirSync(root, { recursive: true });
    process.env.JINN_WORKFLOW_EVIDENCE_ROOT = root;

    expect(resolveWorkflowEvidence()).toEqual({ root, configured: true });
  });

  it('is a config error (no silent fallback) when the explicit root is missing', () => {
    const missing = path.join(tmp, 'missing');
    process.env.JINN_WORKFLOW_EVIDENCE_ROOT = missing;

    const res = resolveWorkflowEvidence();

    expect(res.root).toBeNull();
    expect(res.configured).toBe(false);
    expect(res.reason).toContain(missing);
    // Must NOT quietly create/serve the default root instead.
    expect(fs.existsSync(path.join(home, 'workflow-evidence'))).toBe(false);
  });

  it('is a config error when the explicit root is a file, not a directory', () => {
    const file = path.join(tmp, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    process.env.JINN_WORKFLOW_EVIDENCE_ROOT = file;

    const res = resolveWorkflowEvidence();

    expect(res.root).toBeNull();
    expect(res.configured).toBe(false);
    expect(res.reason).toMatch(/not a directory/i);
  });

  it('is a config error when the default root cannot be created (JINN_HOME is a file)', () => {
    const badHome = path.join(tmp, 'home-is-a-file');
    fs.writeFileSync(badHome, 'x');
    process.env.JINN_HOME = badHome;

    const res = resolveWorkflowEvidence();

    expect(res.root).toBeNull();
    expect(res.configured).toBe(false);
    expect(res.reason).toMatch(/could not be created/i);
  });
});
