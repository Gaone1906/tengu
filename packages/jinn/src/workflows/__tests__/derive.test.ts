import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { deriveRunState, loadWorkflowDefinition, artifactGatePasses } from '../derive.js';

// Build a throwaway evidenceRoot fixture that mimics the sprint's file layout.
let root: string;

const WORKFLOW_YAML = `
id: test-sprint
title: Test Sprint
version: 1
status: active
evidenceRoot: .
orchestrator: jimbo
trigger:
  kind: schedule
  cron: "0 */2 * * *"
  timezone: Europe/Sofia
  until: "2026-07-07T23:59:00+03:00"
  cronJobId: test-wave
steps:
  - id: select
    title: Select one item
    role: orchestrate
    employee: jimbo
  - id: implement
    title: Implement
    role: implement
    engine: claude
    gates:
      - id: impl-report
        kind: artifact
        glob: "reports/implementation/\${item}-*.md"
        description: Implementation report exists.
  - id: verify
    title: Verify
    role: verify
    engine: codex
    gates:
      - id: verifier-flag
        kind: flag
        flag: independentVerifier
        description: independentVerifier is true.
  - id: adversary
    title: Adversary
    role: adversary
    engine: codex
    optional: true
    gates:
      - id: adversary-artifact
        kind: artifact
        glob: "reports/adversarial/\${item}-*.txt"
        description: Adversarial review captured.
  - id: log
    title: Log
    role: package
    employee: jimbo
    gates:
      - id: wave-receipt
        kind: artifact
        glob: "reports/waves/wave-\${wave}.json"
        description: Per-wave receipt written.
runGates:
  - { kind: flag, flag: independentVerifier, description: verifier ok }
  - { kind: flag, flag: kissScopeCheck, description: kiss ok }
`;

function write(rel: string, content: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-wf-'));
  write('workflows/test-sprint.workflow.yaml', WORKFLOW_YAML);

  // state.json: latest wave = 2, its flags live here.
  write('state.json', JSON.stringify({
    waveCount: 2,
    lastWaveState: 'completed_verified',
    lastWaveGates: {
      independentVerifier: { value: true },
      kissScopeCheck: { value: true },
    },
  }));

  // Wave 1 (historical) — frozen receipt with all flags true.
  write('reports/waves/wave-1.json', JSON.stringify({
    wave: 1, item: 'GRS-A', fireIso: null, lastWaveState: 'completed_verified',
    gates: { independentVerifier: true, kissScopeCheck: true }, reports: [],
  }));
  // Wave 2 (latest) — receipt exists but flags read from live state.json.
  write('reports/waves/wave-2.json', JSON.stringify({
    wave: 2, item: 'GRS-B', fireIso: 'x', lastWaveState: 'completed_verified',
    gates: { independentVerifier: true, kissScopeCheck: true }, reports: [],
  }));

  // Artifacts for GRS-A (wave 1) and GRS-B (wave 2).
  write('reports/implementation/GRS-A-impl.md', '# impl A\n');
  write('reports/adversarial/GRS-A-review.txt', 'review A\n');
  write('reports/implementation/GRS-B-impl.md', '# impl B\n');
  // NOTE: no adversarial artifact for GRS-B → its (optional) adversary gate fails.
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('loadWorkflowDefinition', () => {
  it('parses the YAML definition', () => {
    const def = loadWorkflowDefinition(root, 'test-sprint');
    expect(def.id).toBe('test-sprint');
    expect(def.steps).toHaveLength(5);
    expect(def.runGates).toHaveLength(2);
  });
  it('throws on a missing/invalid file', () => {
    expect(() => loadWorkflowDefinition(root, 'nope')).toThrow();
  });
});

describe('artifactGatePasses', () => {
  it('matches a non-empty file and returns its relative path', () => {
    const hit = artifactGatePasses(root, 'reports/implementation/${item}-*.md', 'GRS-A', 1);
    expect(hit).toBe('reports/implementation/GRS-A-impl.md');
  });
  it('returns null when no file matches', () => {
    expect(artifactGatePasses(root, 'reports/implementation/${item}-*.md', 'GRS-ZZZ', 1)).toBeNull();
  });
  it('substitutes ${wave}', () => {
    expect(artifactGatePasses(root, 'reports/waves/wave-${wave}.json', null, 2)).toBe('reports/waves/wave-2.json');
  });
  it('treats an empty file as a non-match', () => {
    write('reports/implementation/GRS-EMPTY-impl.md', '');
    expect(artifactGatePasses(root, 'reports/implementation/${item}-*.md', 'GRS-EMPTY', 1)).toBeNull();
  });
});

describe('deriveRunState', () => {
  it('enumerates runs newest-first', () => {
    const d = deriveRunState(root, 'test-sprint');
    expect(d.runs.map((r) => r.wave)).toEqual([2, 1]);
    expect(d.latest?.wave).toBe(2);
    expect(d.generatedFrom.receiptsFound).toBe(2);
  });

  it('renders a plain-words trigger summary', () => {
    const d = deriveRunState(root, 'test-sprint');
    expect(d.triggerSummary).toContain('Every 2 hours');
    expect(d.triggerSummary).toContain('2026-07-07');
  });

  it('labels steps by who does them', () => {
    const d = deriveRunState(root, 'test-sprint');
    const latest = d.latest!;
    const byId = Object.fromEntries(latest.steps.map((s) => [s.id, s]));
    expect(byId.select.who).toBe('Jimbo');
    expect(byId.implement.who).toBe('Claude');
    expect(byId.verify.who).toBe('Codex');
  });

  it('treats gateless steps as pass-through (always passed)', () => {
    const d = deriveRunState(root, 'test-sprint');
    const select = d.latest!.steps.find((s) => s.id === 'select')!;
    expect(select.gates).toHaveLength(0);
    expect(select.passed).toBe(true);
    expect(select.isCurrent).toBe(false);
  });

  it('latest run reads flags from the live snapshot; flagSource=live', () => {
    const d = deriveRunState(root, 'test-sprint');
    expect(d.latest!.flagSource).toBe('live');
    const verify = d.latest!.steps.find((s) => s.id === 'verify')!;
    expect(verify.gates[0].passed).toBe(true); // independentVerifier live=true
  });

  it('historical run reads flags from its frozen receipt; flagSource=receipt', () => {
    const d = deriveRunState(root, 'test-sprint');
    const wave1 = d.runs.find((r) => r.wave === 1)!;
    expect(wave1.flagSource).toBe('receipt');
    const verify = wave1.steps.find((s) => s.id === 'verify')!;
    expect(verify.gates[0].passed).toBe(true); // from receipt gates
  });

  it('evaluates artifact gates against real files per run item', () => {
    const d = deriveRunState(root, 'test-sprint');
    const wave1 = d.runs.find((r) => r.wave === 1)!;
    const impl1 = wave1.steps.find((s) => s.id === 'implement')!;
    expect(impl1.gates[0].passed).toBe(true);
    expect(impl1.gates[0].evidence).toBe('reports/implementation/GRS-A-impl.md');
  });

  it('marks the current node = first gated step with an unmet gate (latest run only)', () => {
    // Latest run item = GRS-B has no adversarial artifact, but that step is optional,
    // so it does NOT block. All non-optional gated steps pass → no current node.
    const d = deriveRunState(root, 'test-sprint');
    const current = d.latest!.steps.find((s) => s.isCurrent);
    expect(current).toBeUndefined();
    expect(d.latest!.status).toBe('passed');
  });

  it('optional step failure does not fail the run, but is reported', () => {
    const d = deriveRunState(root, 'test-sprint');
    const adversary = d.latest!.steps.find((s) => s.id === 'adversary')!;
    expect(adversary.optional).toBe(true);
    expect(adversary.gates[0].passed).toBe(false); // no GRS-B adversarial file
    // optional → not counted toward step.passed
    expect(adversary.passed).toBe(true);
  });

  it('synthesizes the in-progress run when waveCount is ahead of receipts (Codex #1)', () => {
    // state.waveCount = 5, but only wave-1/2 receipts exist → wave 5 must appear,
    // sourced live from state.json, and be the latest.
    const r3 = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-wf3-'));
    fs.mkdirSync(path.join(r3, 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(r3, 'workflows', 'test-sprint.workflow.yaml'), WORKFLOW_YAML);
    fs.writeFileSync(path.join(r3, 'state.json'), JSON.stringify({
      waveCount: 5, currentItem: 'GRS-INPROGRESS', lastWaveState: undefined,
      lastWaveGates: { independentVerifier: { value: false }, kissScopeCheck: { value: true } },
    }));
    fs.mkdirSync(path.join(r3, 'reports', 'waves'), { recursive: true });
    fs.writeFileSync(path.join(r3, 'reports', 'waves', 'wave-1.json'), JSON.stringify({
      wave: 1, item: 'GRS-A', lastWaveState: 'completed_verified',
      gates: { independentVerifier: true, kissScopeCheck: true },
    }));
    const d = deriveRunState(r3, 'test-sprint');
    expect(d.runs.map((r) => r.wave)).toEqual([5, 1]);
    expect(d.latest!.wave).toBe(5);
    expect(d.latest!.item).toBe('GRS-INPROGRESS');
    expect(d.latest!.flagSource).toBe('live');
    expect(d.latest!.status).toBe('active'); // not completed_verified → never 'passed'
    fs.rmSync(r3, { recursive: true, force: true });
  });

  it('never labels a historical non-completed_verified run as passed (Codex #2)', () => {
    const r4 = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-wf4-'));
    fs.mkdirSync(path.join(r4, 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(r4, 'workflows', 'test-sprint.workflow.yaml'), WORKFLOW_YAML);
    fs.writeFileSync(path.join(r4, 'state.json'), JSON.stringify({
      waveCount: 2, lastWaveState: 'completed_verified',
      lastWaveGates: { independentVerifier: { value: true }, kissScopeCheck: { value: true } },
    }));
    fs.mkdirSync(path.join(r4, 'reports', 'waves'), { recursive: true });
    // historical wave 1 with a non-terminal-pass state and a red gate
    fs.writeFileSync(path.join(r4, 'reports', 'waves', 'wave-1.json'), JSON.stringify({
      wave: 1, item: 'GRS-OLD', lastWaveState: 'blocked_engine',
      gates: { independentVerifier: false, kissScopeCheck: true },
    }));
    fs.writeFileSync(path.join(r4, 'reports', 'waves', 'wave-2.json'), JSON.stringify({
      wave: 2, item: 'GRS-NEW', lastWaveState: 'completed_verified',
      gates: { independentVerifier: true, kissScopeCheck: true },
    }));
    const d = deriveRunState(r4, 'test-sprint');
    const old = d.runs.find((r) => r.wave === 1)!;
    expect(old.status).toBe('blocked'); // NOT passed
    fs.rmSync(r4, { recursive: true, force: true });
  });

  it('rejects artifact-glob path traversal via ${item} (Codex #3)', () => {
    expect(artifactGatePasses(root, 'reports/implementation/${item}-*.md', '../../etc/passwd', 1)).toBeNull();
    expect(artifactGatePasses(root, 'reports/implementation/${item}-*.md', '..', 1)).toBeNull();
  });

  it('surfaces a current node when a required flag gate is unmet', () => {
    // Point at a fresh root where independentVerifier is false live.
    const r2 = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-wf2-'));
    fs.mkdirSync(path.join(r2, 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(r2, 'workflows', 'test-sprint.workflow.yaml'), WORKFLOW_YAML);
    fs.writeFileSync(path.join(r2, 'state.json'), JSON.stringify({
      waveCount: 1, lastWaveState: 'needs_fix',
      lastWaveGates: { independentVerifier: { value: false }, kissScopeCheck: { value: true } },
    }));
    fs.mkdirSync(path.join(r2, 'reports', 'waves'), { recursive: true });
    fs.writeFileSync(path.join(r2, 'reports', 'waves', 'wave-1.json'), JSON.stringify({
      wave: 1, item: 'GRS-C', lastWaveState: 'needs_fix',
      gates: { independentVerifier: false, kissScopeCheck: true },
    }));
    fs.mkdirSync(path.join(r2, 'reports', 'implementation'), { recursive: true });
    fs.writeFileSync(path.join(r2, 'reports', 'implementation', 'GRS-C-impl.md'), '# c\n');

    const d = deriveRunState(r2, 'test-sprint');
    expect(d.latest!.status).toBe('needs_fix');
    const current = d.latest!.steps.find((s) => s.isCurrent)!;
    expect(current.id).toBe('verify'); // first gated step with an unmet gate
    fs.rmSync(r2, { recursive: true, force: true });
  });
});
