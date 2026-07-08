import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

/**
 * Workflow run-state derivation (GRS-009, contract in GRS-007-workflow-design.md §5).
 *
 * A workflow is a DERIVED VIEW over primitives that already exist, never a new
 * engine with its own run store. This module reads:
 *   - the declarative definition   `<evidenceRoot>/workflows/<id>.workflow.yaml`
 *   - the per-wave receipts        `<evidenceRoot>/reports/waves/wave-<N>.json`
 *   - the live snapshot            `<evidenceRoot>/state.json` (lastWaveGates only)
 *   - evidence artifacts           `<evidenceRoot>/reports/**` (gate globs)
 * and computes each run's status, per-step gate results, and the current node.
 * It writes NOTHING. `state.json` holds only the LATEST wave's flags; every
 * historical run's flags come from its FROZEN receipt (§5.2). That split is the
 * whole reason the receipt file exists — deriving an old run from state.json
 * would report latest-wave truth.
 *
 * The module is deliberately fs-reading (not DB-backed): the Sample Autonomy's
 * durable substrate is its report files, so derivation reads files. This also
 * keeps it testable with a throwaway evidenceRoot fixture (no JINN_HOME coupling).
 */

/* ── Definition schema (subset of GRS-007 §3 that the UI renders) ───────────── */

export interface WorkflowGate {
  id?: string;
  kind: 'artifact' | 'flag' | 'approval';
  glob?: string;
  flag?: string;
  approvalRef?: string;
  description: string;
}

export interface WorkflowStep {
  id: string;
  title: string;
  role: string;
  engine?: string;
  employee?: string;
  handoffTo?: string[];
  gates?: WorkflowGate[];
  optional?: boolean;
  cadence?: string;
}

export interface TodoStatusChangeTriggerFilter {
  source?: string;
  department?: string;
  assignee?: string;
}

export interface WorkflowTrigger {
  kind: 'schedule' | 'manual' | 'todo-status-change';
  cron?: string;
  timezone?: string;
  until?: string;
  cronJobId?: string;
  /** Canonical target status for todo-status-change triggers. */
  toStatus?: string;
  /** Back-compat alias accepted at validation/read boundaries. */
  status?: string;
  fromStatus?: string;
  filter?: TodoStatusChangeTriggerFilter;
}

export interface WorkflowLoop {
  maxRuns?: number;
  until?: string;
  maxRoundsPerRun?: number;
  stopWhen?: string;
}

export interface WorkflowDefinition {
  id: string;
  title: string;
  description?: string;
  version: number;
  status: 'active' | 'paused' | 'retired';
  trigger: WorkflowTrigger;
  orchestrator?: string;
  steps: WorkflowStep[];
  runGates?: WorkflowGate[];
  loop?: WorkflowLoop;
  evidenceRoot?: string;
}

/* ── Derived view types (what the endpoint/UI consumes) ─────────────────────── */

export type RunStatus = 'pending' | 'active' | 'passed' | 'blocked' | 'needs_fix';

export interface GateResult {
  id?: string;
  kind: WorkflowGate['kind'];
  description: string;
  passed: boolean;
  /** Evidence path (artifact gate) or flag name (flag gate); for UI links. */
  evidence?: string;
}

export interface StepView {
  id: string;
  title: string;
  role: string;
  /** Human "who does this" label, e.g. "Codex" or "Fable Guide". */
  who: string;
  optional: boolean;
  cadence?: string;
  gates: GateResult[];
  /** True when every non-optional gate passed (gateless steps are always passed). */
  passed: boolean;
  /** True for the first gated step in the latest run whose gates aren't all green. */
  isCurrent: boolean;
}

export interface RunView {
  wave: number;
  item: string | null;
  fireIso: string | null;
  status: RunStatus;
  lastWaveState: string | null;
  startedAt: string | null;
  endedAt: string | null;
  steps: StepView[];
  /** runGates evaluated for this run (the 8 wave-level receipts). */
  runGates: GateResult[];
  /** Whether this run's flags came from the live snapshot or a frozen receipt. */
  flagSource: 'live' | 'receipt';
}

export interface DerivedWorkflow {
  definition: WorkflowDefinition;
  /** Runs newest-first. */
  runs: RunView[];
  /** The latest run (index 0 of runs), or null if none. */
  latest: RunView | null;
  /** Plain-words trigger sentence for the UI header. */
  triggerSummary: string;
  evidenceRoot: string;
  generatedFrom: {
    receiptsFound: number;
    stateJsonPresent: boolean;
  };
}

/* ── Wave receipt (frozen per-run record, GRS-007 §5.4) ─────────────────────── */

interface WaveReceipt {
  wave: number;
  item: string | null;
  fireIso?: string | null;
  lastWaveState: string | null;
  gates: Record<string, boolean>;
  reports?: string[];
  startedAt?: string | null;
  endedAt?: string | null;
  reconstructed?: boolean;
}

/* ── Loaders ────────────────────────────────────────────────────────────────── */

export function loadWorkflowDefinition(evidenceRoot: string, workflowId: string): WorkflowDefinition {
  const file = path.join(evidenceRoot, 'workflows', `${workflowId}.workflow.yaml`);
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = yaml.load(raw) as WorkflowDefinition;
  if (!parsed || typeof parsed !== 'object' || !parsed.id) {
    throw new Error(`Invalid workflow definition at ${file}`);
  }
  return parsed;
}

function readWaveReceipts(evidenceRoot: string): WaveReceipt[] {
  const dir = path.join(evidenceRoot, 'reports', 'waves');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const receipts: WaveReceipt[] = [];
  for (const name of names) {
    const m = /^wave-(\d+)\.json$/.exec(name);
    if (!m) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as WaveReceipt;
      if (typeof parsed.wave === 'number') receipts.push(parsed);
    } catch {
      // Tolerate a corrupt/partial receipt — skip it rather than fail the whole view.
    }
  }
  // Newest wave first.
  return receipts.sort((a, b) => b.wave - a.wave);
}

interface LiveState {
  waveCount?: number;
  lastWaveState?: string;
  currentItem?: string | null;
  nextSuggestedItem?: string | null;
  lastCompletedItem?: string | null;
  lastWaveGates?: Record<string, { value?: boolean }>;
}

function readLiveState(evidenceRoot: string): LiveState | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(evidenceRoot, 'state.json'), 'utf8')) as LiveState;
  } catch {
    return null;
  }
}

/**
 * True iff the named flag is set in the evidence root's live state
 * (`state.json.lastWaveGates`). Exported for the run engine's loop exit-gate
 * evaluation (GRS-014e) — the same flag source the derive path reads.
 */
export function stateFlagPasses(evidenceRoot: string, flag: string): boolean {
  return liveGateFlags(readLiveState(evidenceRoot))[flag] === true;
}

/** Flatten `state.json.lastWaveGates` ({flag:{value}}) → {flag:boolean}. */
function liveGateFlags(state: LiveState | null): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const g = state?.lastWaveGates ?? {};
  for (const [k, v] of Object.entries(g)) out[k] = v?.value === true;
  return out;
}

/* ── Gate evaluation ────────────────────────────────────────────────────────── */

/** Substitute ${item} / ${wave} tokens in an artifact glob. */
function substitute(glob: string, item: string | null, wave: number): string {
  return glob.replace(/\$\{item\}/g, item ?? '*').replace(/\$\{wave\}/g, String(wave));
}

/**
 * True iff a NON-EMPTY file matching `glob` exists under evidenceRoot. Globs in
 * the sample definition are single-directory with `*` wildcards (e.g.
 * `reports/verification/${item}-*.md`), so we split into dir + filename regex.
 *
 * Hardened (Codex GRS-009 [Major]): `${item}` is substituted into the path, so a
 * malicious/malformed item containing `..` or an absolute path could make the dir
 * escape evidenceRoot. We reject traversal and require the resolved directory to
 * stay under `path.resolve(evidenceRoot)` before touching the filesystem.
 */
export function artifactGatePasses(evidenceRoot: string, glob: string, item: string | null, wave: number): string | null {
  const resolved = substitute(glob, item, wave);
  // Defense-in-depth: no absolute paths, no parent-dir escapes.
  if (path.isAbsolute(resolved) || resolved.split(/[\\/]/).includes('..')) return null;
  const rootAbs = path.resolve(evidenceRoot);
  const dir = path.resolve(rootAbs, path.dirname(resolved));
  if (dir !== rootAbs && !dir.startsWith(rootAbs + path.sep)) return null;
  const pattern = path.basename(resolved);
  // Escape ALL regex metachars (incl. `?`), then treat only `*` as a wildcard.
  const rx = new RegExp('^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*') + '$');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!rx.test(name)) continue;
    try {
      if (fs.statSync(path.join(dir, name)).size > 0) {
        return path.join(path.dirname(resolved), name);
      }
    } catch {
      // ignore unreadable entry
    }
  }
  return null;
}

function evaluateGate(
  gate: WorkflowGate,
  evidenceRoot: string,
  item: string | null,
  wave: number,
  flags: Record<string, boolean>,
): GateResult {
  if (gate.kind === 'flag' && gate.flag) {
    return { id: gate.id, kind: 'flag', description: gate.description, passed: flags[gate.flag] === true, evidence: gate.flag };
  }
  if (gate.kind === 'artifact' && gate.glob) {
    const hit = artifactGatePasses(evidenceRoot, gate.glob, item, wave);
    return { id: gate.id, kind: 'artifact', description: gate.description, passed: hit !== null, evidence: hit ?? substitute(gate.glob, item, wave) };
  }
  // approval or malformed gate → treated as not-yet-passed (no approval gates in the sample def today).
  return { id: gate.id, kind: gate.kind, description: gate.description, passed: false, evidence: gate.approvalRef };
}

/* ── Who-label ──────────────────────────────────────────────────────────────── */

const ENGINE_LABEL: Record<string, string> = {
  claude: 'Claude', codex: 'Codex', grok: 'Grok', gemini: 'Gemini', antigravity: 'Antigravity',
};

function whoLabel(step: WorkflowStep): string {
  if (step.employee === 'jimbo') return 'Jimbo';
  if (step.employee === 'fable-guide') return 'Fable Guide';
  if (step.employee) return step.employee;
  if (step.engine) return ENGINE_LABEL[step.engine] ?? step.engine;
  return '—';
}

/* ── Trigger summary (plain words) ──────────────────────────────────────────── */

function triggerSummary(t: WorkflowTrigger): string {
  if (t.kind === 'manual') return 'Runs on manual request (manual trigger).';
  const every = t.cron === '0 */2 * * *' ? 'Every 2 hours' : `On cron \`${t.cron}\``;
  const tz = t.timezone ? ` (${t.timezone})` : '';
  const until = t.until ? `, until ${new Date(t.until).toISOString().slice(0, 10)}` : '';
  return `${every}${until}${tz}.`;
}

/* ── Per-run derivation ─────────────────────────────────────────────────────── */

function deriveRun(
  definition: WorkflowDefinition,
  evidenceRoot: string,
  wave: number,
  item: string | null,
  fireIso: string | null,
  lastWaveState: string | null,
  startedAt: string | null,
  endedAt: string | null,
  flags: Record<string, boolean>,
  flagSource: 'live' | 'receipt',
  isLatest: boolean,
): RunView {
  const steps: StepView[] = definition.steps.map((step) => {
    const gates = (step.gates ?? []).map((g) => evaluateGate(g, evidenceRoot, item, wave, flags));
    // A gateless step (select/plan/decide) carries no receipt → always "passed"
    // (pass-through node, never a progress blocker — GRS-007 §5.3).
    const nonOptionalGates = step.optional ? [] : gates;
    const passed = nonOptionalGates.every((g) => g.passed);
    return {
      id: step.id, title: step.title, role: step.role, who: whoLabel(step),
      optional: step.optional === true, cadence: step.cadence,
      gates, passed, isCurrent: false,
    };
  });

  // current-node = first GATED step whose gates are not all green (latest run only).
  if (isLatest) {
    const current = steps.find((s) => s.gates.length > 0 && !s.passed);
    if (current) current.isCurrent = true;
  }

  const runGates = (definition.runGates ?? []).map((g) => evaluateGate(g, evidenceRoot, item, wave, flags));

  // Per-run status (§5.3). Hardened (Codex GRS-009 [Major]): `passed` requires the
  // terminal state to be `completed_verified` AND every REQUIRED gate green —
  // non-optional step gates (StepView.passed already excludes optional steps) plus
  // runGates. A historical run is NEVER labeled `passed` just because it is old, and
  // an unrecognized non-pass terminal state falls through to `active`, never `passed`.
  const allRequiredGreen = steps.every((s) => s.passed) && runGates.every((g) => g.passed);
  let status: RunStatus;
  if (lastWaveState === 'needs_fix') status = 'needs_fix';
  else if (lastWaveState === 'blocked_approval' || lastWaveState === 'blocked_engine') status = 'blocked';
  else if (lastWaveState === 'completed_verified' && allRequiredGreen) status = 'passed';
  else status = 'active';

  return { wave, item, fireIso, status, lastWaveState, startedAt, endedAt, steps, runGates, flagSource };
}

/* ── Public entry point ─────────────────────────────────────────────────────── */

export function deriveRunState(evidenceRoot: string, workflowId: string): DerivedWorkflow {
  const definition = loadWorkflowDefinition(evidenceRoot, workflowId);
  const state = readLiveState(evidenceRoot);
  const receipts = readWaveReceipts(evidenceRoot);
  const liveFlags = liveGateFlags(state);

  // The CURRENT wave is state.waveCount (the live snapshot's wave), NOT merely the
  // newest receipt (Codex GRS-009 [Major] #1): mid-wave, the receipt for the
  // in-progress wave isn't written yet, so keying "latest/live" off the newest
  // receipt would overlay THIS wave's live flags onto the PREVIOUS wave's run.
  const currentWave = state?.waveCount ?? (receipts.length > 0 ? receipts[0].wave : 0);

  const runs: RunView[] = receipts.map((r) => {
    const isLatest = r.wave === currentWave;
    // The current wave reads the live snapshot (identical to its receipt once
    // written); every other run reads its frozen receipt flags (§5.2).
    const flags = isLatest ? { ...r.gates, ...liveFlags } : (r.gates ?? {});
    return deriveRun(
      definition, evidenceRoot, r.wave, r.item ?? null, r.fireIso ?? null,
      r.lastWaveState, r.startedAt ?? null, r.endedAt ?? null,
      flags, isLatest ? 'live' : 'receipt', isLatest,
    );
  });

  // Synthesize the in-progress run when the current wave has no receipt yet, so the
  // UI shows the wave that is running right now (Codex GRS-009 [Major] #1). Its
  // flags come straight from the live snapshot.
  if (currentWave > 0 && !receipts.some((r) => r.wave === currentWave)) {
    const item = state?.currentItem ?? state?.nextSuggestedItem ?? state?.lastCompletedItem ?? null;
    runs.push(deriveRun(
      definition, evidenceRoot, currentWave, item, null,
      state?.lastWaveState ?? null, null, null, liveFlags, 'live', true,
    ));
  }

  runs.sort((a, b) => b.wave - a.wave); // newest-first (synthetic run may not be newest by push order)

  return {
    definition,
    runs,
    latest: runs.find((r) => r.wave === currentWave) ?? runs[0] ?? null,
    triggerSummary: triggerSummary(definition.trigger),
    evidenceRoot,
    generatedFrom: { receiptsFound: receipts.length, stateJsonPresent: state !== null },
  };
}
