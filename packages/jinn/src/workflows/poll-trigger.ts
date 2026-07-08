import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { getWorkItem } from '../work-items/store.js';
import {
  createWorkflowTriggerBinding,
  listWorkflowTriggerBindings,
  pollActivationContractMatches,
  POLL_DEFAULT_STDERR_MAX_BYTES,
  POLL_DEFAULT_STDOUT_MAX_BYTES,
  POLL_DEFAULT_TIMEOUT_MS,
  sanitizeWorkflowTriggerPayload,
  updateWorkflowTriggerBinding,
  type PollWorkflowTriggerBinding,
  type WorkflowTriggerBinding,
} from './custom-triggers.js';
import { startWorkflowRunFromTrigger, type RunDriverDeps } from './run-reconciler.js';
import type { WorkflowRun, WorkflowTriggerEvent } from './run-store.js';

export { createWorkflowTriggerBinding };

const RUNNER_TICK_MS = 1_000;

export type PollTriggerOutcome =
  | 'fired'
  | 'disabled'
  | 'not-approved'
  | 'missing-workflow'
  | 'nonzero'
  | 'no-fire'
  | 'no-output'
  | 'invalid-json'
  | 'timeout'
  | 'output-too-large'
  | 'error';

export interface PollTriggerRunResult {
  outcome: PollTriggerOutcome;
  run?: WorkflowRun;
  detail?: string;
}

export interface PollTriggerRunOptions {
  now?: () => string;
  knownEmployees?: Iterable<string>;
  knownEngines?: Iterable<string>;
}

interface CommandResult {
  outcome: 'ok' | 'nonzero' | 'timeout' | 'output-too-large' | 'error';
  stdout: string;
  stderr: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  detail?: string;
}

function approvalSatisfied(binding: PollWorkflowTriggerBinding): boolean {
  if (binding.activation === 'disabled') return false;
  if (!binding.approvalWorkItemId) return false;
  if (!pollActivationContractMatches(binding)) return false;
  const item = getWorkItem(binding.approvalWorkItemId);
  return item?.approvalState === 'approved';
}

function killCommandProcess(child: ReturnType<typeof spawn>): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
      return;
    }
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

function runCommand(binding: PollWorkflowTriggerBinding): Promise<CommandResult> {
  const timeoutMs = binding.timeoutMs ?? POLL_DEFAULT_TIMEOUT_MS;
  const stdoutMaxBytes = binding.stdoutMaxBytes ?? POLL_DEFAULT_STDOUT_MAX_BYTES;
  const stderrMaxBytes = binding.stderrMaxBytes ?? POLL_DEFAULT_STDERR_MAX_BYTES;
  return new Promise((resolve) => {
    const child = spawn(binding.command, {
      shell: true,
      cwd: process.env.JINN_HOME || process.cwd(),
      env: process.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      killCommandProcess(child);
      resolve(result);
    };
    timer = setTimeout(() => {
      settle({ outcome: 'timeout', stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > stdoutMaxBytes) {
        settle({ outcome: 'output-too-large', stdout: stdout.slice(0, stdoutMaxBytes).toString('utf8'), stderr: stderr.toString('utf8') });
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > stderrMaxBytes) {
        settle({ outcome: 'output-too-large', stdout: stdout.toString('utf8'), stderr: stderr.slice(0, stderrMaxBytes).toString('utf8') });
      }
    });
    child.on('error', (err) => {
      settle({ outcome: 'error', stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), detail: err.message });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      if (timer) clearTimeout(timer);
      const out = stdout.toString('utf8');
      const err = stderr.toString('utf8');
      if (code !== 0) {
        resolve({ outcome: 'nonzero', stdout: out, stderr: err, code, signal });
        return;
      }
      resolve({ outcome: 'ok', stdout: out, stderr: err, code, signal });
    });
  });
}

function parsePollPayload(stdout: string): { ok: true; payload: Record<string, unknown>; fireRef?: string } | { ok: false; outcome: 'no-output' | 'no-fire' | 'invalid-json' } {
  const trimmed = stdout.trim();
  if (!trimmed) return { ok: false, outcome: 'no-output' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, outcome: 'invalid-json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, outcome: 'invalid-json' };
  }
  const rec = parsed as Record<string, unknown>;
  if (rec.fire !== true) return { ok: false, outcome: 'no-fire' };
  if (!rec.payload || typeof rec.payload !== 'object' || Array.isArray(rec.payload)) {
    return { ok: false, outcome: 'invalid-json' };
  }
  const rawPayload = rec.payload;
  try {
    const payload = sanitizeWorkflowTriggerPayload(rawPayload);
    const fireRef = typeof rec.fireRef === 'string' && rec.fireRef.trim() ? rec.fireRef.trim().slice(0, 256) : undefined;
    return { ok: true, payload, ...(fireRef ? { fireRef } : {}) };
  } catch {
    return { ok: false, outcome: 'invalid-json' };
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function derivePollFireRef(binding: PollWorkflowTriggerBinding, payload: Record<string, unknown>): string {
  const digest = crypto
    .createHash('sha256')
    .update(binding.name)
    .update('\0')
    .update(binding.targetWorkflowId)
    .update('\0')
    .update(binding.event)
    .update('\0')
    .update(stableJson(payload))
    .digest('hex')
    .slice(0, 32);
  return `poll:${binding.name}:${digest}`;
}

function asPollBinding(binding: WorkflowTriggerBinding): PollWorkflowTriggerBinding | null {
  return binding.kind === 'poll' ? binding : null;
}

/**
 * Trust boundary: activating a poll trigger means the gateway will execute a command
 * authored through an agent-facing surface. That is intentionally gated by a COO
 * approval work item before the command can run, and every invocation is bounded by
 * a hard timeout plus stdout/stderr caps so a loop or noisy script cannot wedge the
 * gateway process. Approval is the authorization decision; these runtime bounds are
 * the blast-radius limits after that decision.
 */
export async function runPollTriggerOnce(
  deps: RunDriverDeps,
  binding: PollWorkflowTriggerBinding,
  opts: PollTriggerRunOptions = {},
): Promise<PollTriggerRunResult> {
  if (binding.activation === 'disabled') return { outcome: 'disabled' };
  if (!approvalSatisfied(binding)) return { outcome: 'not-approved' };

  const command = await runCommand(binding);
  if (command.outcome !== 'ok') {
    return { outcome: command.outcome, detail: command.detail ?? command.stderr.slice(0, 500) };
  }
  const parsed = parsePollPayload(command.stdout);
  if (!parsed.ok) return { outcome: parsed.outcome };

  const def = deps.getDefinition(deps.root, binding.targetWorkflowId);
  if (!def) return { outcome: 'missing-workflow', detail: `workflow "${binding.targetWorkflowId}" not found` };

  const trigger: WorkflowTriggerEvent = {
    source: 'poll',
    event: binding.event,
    payload: parsed.payload,
    fireRef: parsed.fireRef ?? derivePollFireRef(binding, parsed.payload),
  };
  const run = await startWorkflowRunFromTrigger(deps, def, trigger, {
    ...(opts.knownEmployees ? { knownEmployees: opts.knownEmployees } : {}),
    ...(opts.knownEngines ? { knownEngines: opts.knownEngines } : {}),
  });
  return { outcome: 'fired', run };
}

export function startPollTriggerRunner(
  deps: RunDriverDeps,
  opts: { tickMs?: number; now?: () => string } = {},
): () => void {
  const running = new Set<string>();
  const now = opts.now ?? (() => new Date().toISOString());
  const tickMs = opts.tickMs ?? RUNNER_TICK_MS;

  const due = (binding: PollWorkflowTriggerBinding, at: Date): boolean => {
    if (binding.activation === 'disabled') return false;
    if (!binding.lastCheckedAt) return true;
    const last = new Date(binding.lastCheckedAt);
    if (Number.isNaN(last.getTime())) return true;
    return at.getTime() - last.getTime() >= binding.intervalSeconds * 1000;
  };

  const tick = () => {
    try {
      const atIso = now();
      const at = new Date(atIso);
      if (Number.isNaN(at.getTime())) return;
      for (const raw of listWorkflowTriggerBindings(deps.root)) {
        const binding = asPollBinding(raw);
        if (!binding || !due(binding, at) || running.has(binding.name)) continue;
        running.add(binding.name);
        const checked: PollWorkflowTriggerBinding = { ...binding, lastCheckedAt: atIso };
        try {
          updateWorkflowTriggerBinding(deps.root, checked);
        } catch {
          running.delete(binding.name);
          continue;
        }
        void runPollTriggerOnce(deps, checked, opts)
          .then((result) => {
            const latestRaw = listWorkflowTriggerBindings(deps.root).find((t) => t.name === binding.name);
            if (!latestRaw) return;
            const latest = asPollBinding(latestRaw);
            if (!latest) return;
            updateWorkflowTriggerBinding(deps.root, {
              ...latest,
              lastOutcome: result.outcome,
              ...(result.outcome === 'fired' ? { lastFiredAt: now() } : {}),
            });
          })
          .catch((err) => {
            deps.log?.('warn', `[workflow-triggers] poll trigger "${binding.name}" failed: ${(err as Error).message}`);
          })
          .finally(() => running.delete(binding.name));
      }
    } catch (err) {
      deps.log?.('warn', `[workflow-triggers] poll runner tick failed: ${(err as Error).message}`);
    }
  };

  const timer = setInterval(tick, tickMs);
  tick();
  return () => clearInterval(timer);
}
