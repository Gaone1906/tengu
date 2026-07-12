import fs from 'node:fs';
import { gatewayBaseUrl, readGatewayInfo } from '../gateway/gateway-info.js';
import { loadConfig } from '../shared/config.js';
import { GATEWAY_INFO_FILE, JINN_HOME } from '../shared/paths.js';

export interface WorkflowRunResult {
  runId: string;
  workflowId: string;
  status: string;
  [key: string]: unknown;
}

export interface WorkflowRunRequestOptions {
  baseUrl: string;
  token: string;
  name: string;
  input?: Record<string, unknown>;
  idempotencyKey?: string;
  fetchImpl?: typeof fetch;
}

export interface WorkflowRunCancellationRequestOptions {
  baseUrl: string;
  token: string;
  workflowId: string;
  runId: string;
  reason?: string;
  fetchImpl?: typeof fetch;
}

export interface RunWorkflowByNameOptions {
  input?: string;
  idempotencyKey?: string;
  json?: boolean;
}

export interface CancelWorkflowRunOptions {
  reason?: string;
  json?: boolean;
}

export function parseWorkflowInput(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`workflow input must be valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('workflow input must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

async function responseJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function requestWorkflowRunByName(opts: WorkflowRunRequestOptions): Promise<WorkflowRunResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const payload = {
    name: opts.name,
    ...(opts.input ? { input: opts.input } : {}),
    ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
  };
  const res = await fetchImpl(`${opts.baseUrl}/api/workflow-runs/by-name`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const body = await responseJson(res);
  if (!res.ok) {
    const detail = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `gateway returned HTTP ${res.status}`;
    throw new Error(`workflow run failed: ${detail}`);
  }
  return body as WorkflowRunResult;
}

export async function requestWorkflowRunCancellation(
  opts: WorkflowRunCancellationRequestOptions,
): Promise<WorkflowRunResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(
    `${opts.baseUrl}/api/workflow-definitions/${encodeURIComponent(opts.workflowId)}/runs/${encodeURIComponent(opts.runId)}/cancel`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(opts.reason ? { reason: opts.reason } : {}),
    },
  );
  const body = await responseJson(res);
  if (!res.ok) {
    const detail = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `gateway returned HTTP ${res.status}`;
    throw new Error(`workflow cancellation failed: ${detail}`);
  }
  return body as WorkflowRunResult;
}

function gatewayConnection(): { baseUrl: string; token: string } | null {
  if (!fs.existsSync(JINN_HOME)) return null;
  const info = readGatewayInfo(GATEWAY_INFO_FILE);
  let port: number | undefined;
  let host: string | undefined;
  try {
    const config = loadConfig();
    port = config.gateway.port;
    host = config.gateway.host;
  } catch {
    // gateway.json is enough while config.yaml is temporarily unreadable.
  }
  if (!info?.token) return null;
  return {
    baseUrl: gatewayBaseUrl({ port: info.port ?? port ?? 7777, host: info.host ?? host }),
    token: info.token,
  };
}

export async function runWorkflowByName(name: string, opts: RunWorkflowByNameOptions = {}): Promise<void> {
  const connection = gatewayConnection();
  if (!connection) {
    console.error('Gateway auth token was not found. Start Jinn first, then run the workflow.');
    process.exitCode = 1;
    return;
  }
  try {
    const input = opts.input === undefined ? undefined : parseWorkflowInput(opts.input);
    const run = await requestWorkflowRunByName({
      ...connection,
      name,
      ...(input ? { input } : {}),
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    });
    if (opts.json) console.log(JSON.stringify(run, null, 2));
    else console.log(`Started ${run.runId} for ${run.workflowId} (${run.status}).`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function cancelWorkflowRunFromCli(
  workflowId: string,
  runId: string,
  opts: CancelWorkflowRunOptions = {},
): Promise<void> {
  const connection = gatewayConnection();
  if (!connection) {
    console.error('Gateway auth token was not found. Start Jinn first, then cancel the workflow run.');
    process.exitCode = 1;
    return;
  }
  try {
    const run = await requestWorkflowRunCancellation({
      ...connection,
      workflowId,
      runId,
      ...(opts.reason ? { reason: opts.reason } : {}),
    });
    if (opts.json) console.log(JSON.stringify(run, null, 2));
    else console.log(`Cancelled ${run.runId} for ${run.workflowId} (${run.status}).`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
