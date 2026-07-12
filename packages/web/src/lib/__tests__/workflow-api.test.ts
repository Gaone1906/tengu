import { beforeEach, describe, expect, it, vi } from "vitest"

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch }))

import { api, WorkflowApiError, type EditableWorkflowDefinitionWire, type WorkflowRunWire } from "../api"

const definition = (): EditableWorkflowDefinitionWire => ({
  schemaVersion: 1,
  id: "sample",
  title: "Sample",
  version: 3,
  status: "active",
  nodes: [
    { id: "trigger", type: "trigger", label: "Trigger", position: { x: 0, y: 0 } },
    { id: "build", type: "step", label: "Build", position: { x: 320, y: 0 } },
  ],
  edges: [{ id: "trigger-build", from: "trigger", to: "build", kind: "sequence" }],
})

beforeEach(() => authFetch.mockReset())

describe("workflow run API", () => {
  it("returns a durable failed run from the gateway's 422 evidence response", async () => {
    const failed: WorkflowRunWire = {
      runId: "run-failed",
      workflowId: "sample",
      definitionVersion: 3,
      title: "Sample",
      trigger: { kind: "manual" },
      status: "failed",
      startedAt: "2026-07-11T10:00:00.000Z",
      endedAt: "2026-07-11T10:00:01.000Z",
      steps: [],
      parked: null,
      errors: [{ code: "spawn-failed", message: "worker failed" }],
    }
    authFetch.mockResolvedValue(new Response(JSON.stringify(failed), {
      status: 422,
      headers: { "Content-Type": "application/json" },
    }))

    await expect(api.startWorkflowRun("sample", {}, "stable-key")).resolves.toEqual(failed)
    expect(authFetch).toHaveBeenCalledWith(
      "/api/workflow-definitions/sample/run",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ input: {}, idempotencyKey: "stable-key" }),
      }),
    )
  })

  it("preserves typed idempotency conflict status, code, and safe run id", async () => {
    authFetch.mockResolvedValue(new Response(JSON.stringify({
      error: "This idempotency key is already bound to a different workflow run request.",
      code: "workflow-run-idempotency-conflict",
      runId: "run-existing",
    }), { status: 409, headers: { "Content-Type": "application/json" } }))

    const error = await api.startWorkflowRun("sample", { secret: "must-not-leak" }, "secret-key")
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(WorkflowApiError)
    expect(error).toMatchObject({
      status: 409,
      code: "workflow-run-idempotency-conflict",
      runId: "run-existing",
      message: "This idempotency key is already bound to a different workflow run request.",
    })
    expect(String(error)).not.toContain("must-not-leak")
    expect(String(error)).not.toContain("secret-key")
  })

  it("posts native cancellation and preserves typed conflict errors", async () => {
    const cancelled = {
      runId: "run-1",
      workflowId: "sample",
      definitionVersion: 3,
      title: "Sample",
      trigger: { kind: "manual" as const },
      status: "cancelled" as const,
      startedAt: "2026-07-11T10:00:00.000Z",
      endedAt: "2026-07-11T10:00:01.000Z",
      steps: [],
      parked: null,
      cancellation: {
        requestedAt: "2026-07-11T10:00:01.000Z",
        requestedBy: "operator",
        reason: "superseded",
      },
    }
    authFetch.mockResolvedValueOnce(new Response(JSON.stringify(cancelled), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }))

    await expect(api.cancelWorkflowRun("sample", "run-1", "superseded")).resolves.toEqual(cancelled)
    expect(authFetch).toHaveBeenCalledWith(
      "/api/workflow-definitions/sample/runs/run-1/cancel",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ reason: "superseded" }) }),
    )

    authFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      error: "run cancellation intent conflicts with the persisted request",
      code: "workflow-run-cancellation-conflict",
      runId: "run-1",
    }), { status: 409, headers: { "Content-Type": "application/json" } }))
    const error = await api.cancelWorkflowRun("sample", "run-1").catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(WorkflowApiError)
    expect(error).toMatchObject({ status: 409, code: "workflow-run-cancellation-conflict", runId: "run-1" })
  })
})

describe("workflow layout intent API", () => {
  it("sends normalize intent beside a definition without client-authored provenance", async () => {
    const def = definition()
    authFetch.mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      layout: {
        diagnostics: { source: "generated", version: 1, normalized: true, reasons: [], quality: { valid: true, score: 100 }, envelopes: [], loopRoutes: {} },
        normalizedPreview: def,
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } }))

    await api.planWorkflowDefinition(def, { layoutIntent: "normalize" })

    const body = JSON.parse(String(authFetch.mock.calls[0][1]?.body))
    expect(body.layoutIntent).toBe("normalize")
    expect(body.definition).not.toHaveProperty("layout")
  })

  it("sends manual intent beside a save patch without client-authored provenance", async () => {
    const def = definition()
    authFetch.mockResolvedValue(new Response(JSON.stringify(def), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }))

    await api.updateWorkflowDefinition(
      def.id,
      { nodes: def.nodes, edges: def.edges },
      def.version,
      { layoutIntent: "manual" },
    )

    const body = JSON.parse(String(authFetch.mock.calls[0][1]?.body))
    expect(body).toMatchObject({ expectedVersion: 3, layoutIntent: "manual" })
    expect(body).not.toHaveProperty("layout")
  })
})
