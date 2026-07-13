import { describe, expect, it } from "vitest"
import fixtureJson from "../../../../jinn/src/shared/__tests__/fixtures/company-activity-blocks.json"
import {
  applyBlockEnvelopeToMessages,
  blockFallbackContent,
  isBlockEnvelope,
  mergeBlock,
} from "../blocks"

interface CompanyActivityFixture {
  expectedFallback: string
  envelope: unknown
}

const fixtures = fixtureJson as CompanyActivityFixture[]

function parsedFixtures() {
  return fixtures.map(({ expectedFallback, envelope }) => {
    expect(isBlockEnvelope(envelope)).toBe(true)
    if (!isBlockEnvelope(envelope)) throw new Error("fixture is not a block envelope")
    return { expectedFallback, block: envelope.block }
  })
}

describe("web company activity block contracts", () => {
  it("accepts the backend fixtures with identical fallback text", () => {
    expect(parsedFixtures().map(({ expectedFallback, block }) => ({
      type: block.type,
      fallback: blockFallbackContent(block),
      expectedFallback,
    }))).toEqual([
      {
        type: "todo-activity",
        fallback: "Todo “Prepare release” · in review",
        expectedFallback: "Todo “Prepare release” · in review",
      },
      {
        type: "workflow-definition",
        fallback: "Workflow “Release review” · updated to v4",
        expectedFallback: "Workflow “Release review” · updated to v4",
      },
      {
        type: "workflow-run",
        fallback: "Workflow “Release review” · waiting for approval",
        expectedFallback: "Workflow “Release review” · waiting for approval",
      },
    ])
  })

  it("mirrors backend activity put and payload guards", () => {
    expect(isBlockEnvelope({
      op: "put",
      block: {
        id: "todo:wi_release",
        type: "todo-activity",
        version: 1,
        status: "waiting",
        payload: { todoId: "wi_release", action: "updated", status: "in_review" },
      },
    })).toBe(false)

    expect(isBlockEnvelope({
      op: "put",
      block: {
        id: "workflow-run:release-review:run-1",
        type: "workflow-run",
        version: 1,
        status: "waiting",
        title: "Release review",
        payload: {
          workflowId: "release-review",
          runId: "run-1",
          action: "started",
          runStatus: "parked",
          activityReceipt: {
            id: "workflow-run:other",
            operationId: "op-1",
            toolName: "start_workflow_run",
          },
        },
      },
    })).toBe(false)

    expect(isBlockEnvelope({
      op: "put",
      block: {
        id: "workflow-run:release-review:run-1",
        type: "workflow-run",
        version: 1,
        status: "waiting",
        title: "Release review",
        payload: {
          workflowId: "release-review",
          runId: "run-1",
          action: "started",
          runStatus: "parked",
          preview: "x".repeat(4_001),
        },
      },
    })).toBe(false)
  })

  it("ignores stale patches while higher-order equal-version patches remain mergeable", () => {
    const run = parsedFixtures().find(({ block }) => block.type === "workflow-run")?.block
    expect(run).toBeDefined()
    if (!run) return

    expect(mergeBlock(run, {
      ...run,
      version: 2,
      status: "error",
      summary: "Failed",
      payload: { runStatus: "failed", latestError: "stale failure" },
    })).toEqual(run)

    expect(mergeBlock(run, {
      ...run,
      activityOrder: 1,
      status: "completed",
      summary: "Completed",
      payload: { runStatus: "completed", completedSteps: 3 },
    })).toMatchObject({
      version: 3,
      status: "completed",
      summary: "Completed",
      payload: { runStatus: "completed", completedSteps: 3, totalSteps: 3 },
    })

    const currentMessages = applyBlockEnvelopeToMessages([], {
      op: "put",
      block: run,
    }, "Current fallback", 100)
    const afterStalePatch = applyBlockEnvelopeToMessages(currentMessages, {
      op: "patch",
      block: {
        ...run,
        version: 2,
        status: "error",
        payload: { runStatus: "failed", latestError: "stale failure" },
      },
    }, "Stale fallback", 200)
    expect(afterStalePatch).toEqual(currentMessages)
  })

  it("uses activity order to reject out-of-order equal-version definition operations", () => {
    const envelope = (action: string, activityOrder: number) => ({
      op: "put" as const,
      block: {
        id: "workflow-definition:ordered",
        type: "workflow-definition" as const,
        version: 7,
        activityOrder,
        status: "done" as const,
        title: "Ordered workflow",
        summary: action,
        payload: {
          workflowId: "ordered",
          action,
          definitionStatus: "active",
          openPath: "/workflow/ordered",
        },
      },
    })
    const created = envelope("trigger-created", 10)
    const deleted = envelope("trigger-deleted", 20)
    const definitionUpdated = envelope("updated", 15)
    const approvalDecided = envelope("trigger-approval-decided", 30)

    let messages = applyBlockEnvelopeToMessages([], created, "created", 10)
    messages = applyBlockEnvelopeToMessages(messages, deleted, "deleted", 20)
    messages = applyBlockEnvelopeToMessages(messages, created, "late created", 30)
    messages = applyBlockEnvelopeToMessages(messages, definitionUpdated, "late update", 40)
    messages = applyBlockEnvelopeToMessages(messages, approvalDecided, "decided", 50)
    expect(messages.flatMap((message) => message.blocks ?? [])).toEqual([
      expect.objectContaining({
        version: 7,
        activityOrder: 30,
        payload: expect.objectContaining({ action: "trigger-approval-decided" }),
      }),
    ])

    expect(applyBlockEnvelopeToMessages(messages, approvalDecided, "decided", 60)).toEqual(messages)
  })
})
