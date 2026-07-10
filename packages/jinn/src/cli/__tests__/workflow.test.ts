import { describe, expect, it, vi } from 'vitest';
import { parseWorkflowInput, requestWorkflowRunByName } from '../workflow.js';

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
});
