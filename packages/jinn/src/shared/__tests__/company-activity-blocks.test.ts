import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  blockFallbackText,
  mergeBlock,
  validateBlockEnvelope,
} from "../blocks.js";

interface CompanyActivityFixture {
  expectedFallback: string;
  envelope: unknown;
}

const fixturePath = fileURLToPath(new URL("./fixtures/company-activity-blocks.json", import.meta.url));
const fixtures = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as CompanyActivityFixture[];

function validatedFixtures() {
  return fixtures.map(({ expectedFallback, envelope }) => {
    const result = validateBlockEnvelope(envelope);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.error);
    return { expectedFallback, block: result.envelope.block };
  });
}

describe("company activity block contracts", () => {
  it("accepts the canonical cross-package fixtures with stable fallback text", () => {
    expect(validatedFixtures().map(({ expectedFallback, block }) => ({
      type: block.type,
      fallback: blockFallbackText(block),
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
    ]);
  });

  it("requires complete activity puts but permits partial patches", () => {
    expect(validateBlockEnvelope({
      op: "put",
      block: {
        id: "todo:wi_release",
        type: "todo-activity",
        version: 1,
        status: "waiting",
        payload: { todoId: "wi_release", action: "updated", status: "in_review" },
      },
    })).toMatchObject({ ok: false, error: "todo-activity put requires title" });

    expect(validateBlockEnvelope({
      op: "patch",
      block: {
        id: "todo:wi_release",
        type: "todo-activity",
        version: 2,
        payload: { status: "done" },
      },
    })).toMatchObject({ ok: true });
  });

  it("rejects mismatched receipts, unsafe JSON, and unbounded preview strings", () => {
    const base = {
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
      },
    };

    expect(validateBlockEnvelope({
      op: "put",
      block: {
        ...base,
        payload: {
          ...base.payload,
          activityReceipt: { id: "workflow-run:other", operationId: "op-1", toolName: "start_workflow_run" },
        },
      },
    })).toMatchObject({ ok: false, error: "activity receipt id must match block id" });

    expect(validateBlockEnvelope({
      op: "put",
      block: { ...base, payload: { ...base.payload, latestError: "javascript:alert(1)" } },
    })).toMatchObject({ ok: false, error: "block payload must be safe JSON" });

    expect(validateBlockEnvelope({
      op: "put",
      block: { ...base, payload: { ...base.payload, preview: "x".repeat(4_001) } },
    })).toMatchObject({ ok: false, error: "workflow-run payload preview is too long" });
  });

  it("ignores stale patches while equal-version patches remain mergeable", () => {
    const run = validatedFixtures().find(({ block }) => block.type === "workflow-run")?.block;
    expect(run).toBeDefined();
    if (!run) return;

    const stale = mergeBlock(run, {
      ...run,
      version: 2,
      status: "error",
      summary: "Failed",
      payload: { runStatus: "failed", latestError: "stale failure" },
    });
    expect(stale).toEqual(run);

    const equal = mergeBlock(run, {
      ...run,
      status: "completed",
      summary: "Completed",
      payload: { runStatus: "completed", completedSteps: 3 },
    });
    expect(equal).toMatchObject({
      version: 3,
      status: "completed",
      summary: "Completed",
      payload: { runStatus: "completed", completedSteps: 3, totalSteps: 3 },
    });
  });
});
