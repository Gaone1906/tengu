import { describe, expect, it, vi } from 'vitest';
import {
  formatWorkflowRunCancellationResult,
  parseWorkflowInput,
  requestWorkflowRunByName,
  requestWorkflowRunCancellation,
} from '../workflow.js';

describe('workflow CLI', () => {
  it('parses a JSON object for invocation input and rejects non-objects', () => {
    expect(parseWorkflowInput('{"ticket":"ABC-42"}')).toEqual({ ticket: 'ABC-42' });
    expect(() => parseWorkflowInput('["ABC-42"]')).toThrow(/JSON object/i);
    expect(() => parseWorkflowInput('not-json')).toThrow(/valid JSON/i);
  });

  it('runs a canonical workflow name with input and idempotency through the gateway', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      runId: 'run-42',
      workflowId: 'record-42',
      status: 'running',
    }), { status: 201, headers: { 'content-type': 'application/json' } }));

    const run = await requestWorkflowRunByName({
      baseUrl: 'http://127.0.0.1:7780',
      token: 'gateway-token',
      name: 'full-cycle-workflow',
      input: { ticket: 'ABC-42' },
      idempotencyKey: 'request-42',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(run).toMatchObject({ runId: 'run-42', workflowId: 'record-42' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:7780/api/workflow-runs/by-name',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer gateway-token' }),
        body: JSON.stringify({
          name: 'full-cycle-workflow',
          input: { ticket: 'ABC-42' },
          idempotencyKey: 'request-42',
        }),
      }),
    );
  });

  it('cancels a positional workflow/run pair with an optional reason through the gateway', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      runId: 'run-20260712010101-abcd1234',
      workflowId: 'release-review',
      status: 'cancelled',
      cancellation: {
        requestedAt: '2026-07-12T12:00:00.000Z',
        requestedBy: 'operator',
        reason: 'superseded',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const run = await requestWorkflowRunCancellation({
      baseUrl: 'http://127.0.0.1:7780',
      token: 'gateway-token',
      workflowId: 'release-review',
      runId: 'run-20260712010101-abcd1234',
      reason: 'superseded',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(run).toMatchObject({ status: 'cancelled' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:7780/api/workflow-definitions/release-review/runs/run-20260712010101-abcd1234/cancel',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer gateway-token' }),
        body: JSON.stringify({ reason: 'superseded' }),
      }),
    );
  });

  it('surfaces a conflicting cancellation intent without claiming success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'run cancellation intent conflicts with the persisted request',
      code: 'workflow-run-cancellation-conflict',
    }), { status: 409, headers: { 'content-type': 'application/json' } }));

    await expect(requestWorkflowRunCancellation({
      baseUrl: 'http://127.0.0.1:7780',
      token: 'gateway-token',
      workflowId: 'release-review',
      runId: 'run-1',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })).rejects.toThrow(/cancellation failed.*conflicts/i);
  });

  it('reports a non-terminal drain as requested instead of claiming cancellation finished', () => {
    expect(formatWorkflowRunCancellationResult({
      runId: 'run-1',
      workflowId: 'release-review',
      status: 'running',
      stopping: { to: 'cancelled' },
    })).toBe('Cancellation requested for run-1 in release-review (running).');
  });

  it('reports cancellation as complete only for a terminal cancelled response', () => {
    expect(formatWorkflowRunCancellationResult({
      runId: 'run-1',
      workflowId: 'release-review',
      status: 'cancelled',
      stopping: { to: 'cancelled' },
    })).toBe('Cancelled run-1 for release-review (cancelled).');
  });
});
