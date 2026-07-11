import { beforeEach, describe, expect, it, vi } from "vitest"

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch }))

import { api, type EditableWorkflowDefinitionWire, type WorkflowRunWire } from "../api"

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
