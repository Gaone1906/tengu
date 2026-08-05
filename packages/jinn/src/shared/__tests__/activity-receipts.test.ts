import { describe, expect, it } from "vitest";
import {
  extractActivityReceiptId,
  workflowDefinitionActivityBlockId,
} from "../activity-receipts.js";
import type { GatewayEmit } from "../gateway-events.js";

// PLA-60 compile lock: widening `GatewayEmit` back to (string, unknown) leaves
// the expect-error directives below unsatisfied, which fails `tsc --noEmit`.
describe("GatewayEmit", () => {
  it("rejects an unknown event name and a wrong payload shape", () => {
    const emit = (() => {}) as GatewayEmit;
    // @ts-expect-error - not a member of GatewayEventMap
    emit("session:not-a-real-event", {});
    // @ts-expect-error - session:started carries { sessionId: string }
    emit("session:started", { sessionId: 1 });
    expect(typeof emit).toBe("function");
  });
});

describe("extractActivityReceiptId", () => {
  it("accepts only a bounded exact top-level JSON property from a successful result", () => {
    expect(extractActivityReceiptId('{"activityReceiptId":"todo:wi_release"}'))
      .toBe("todo:wi_release");
    expect(extractActivityReceiptId({ activityReceiptId: "workflow-definition:release" }))
      .toBe("workflow-definition:release");

    expect(extractActivityReceiptId('prefix {"activityReceiptId":"todo:forged"}'))
      .toBeUndefined();
    expect(extractActivityReceiptId({ nested: { activityReceiptId: "todo:forged" } }))
      .toBeUndefined();
    expect(extractActivityReceiptId({ activityReceiptId: "x".repeat(97) }))
      .toBeUndefined();
  });

  it("never extracts a receipt from an error result", () => {
    expect(extractActivityReceiptId(
      '{"activityReceiptId":"todo:wi_release"}',
      { isError: true },
    )).toBeUndefined();
  });
});

describe("workflowDefinitionActivityBlockId", () => {
  it("keeps the 76-character threshold readable and bounds 77/128-character ids", () => {
    const id76 = `w${"a".repeat(75)}`;
    const id77 = `w${"a".repeat(76)}`;
    const id128 = `w${"a".repeat(127)}`;

    expect(workflowDefinitionActivityBlockId(id76)).toBe(`workflow-definition:${id76}`);
    expect(workflowDefinitionActivityBlockId(id76)).toHaveLength(96);
    for (const id of [id77, id128]) {
      const blockId = workflowDefinitionActivityBlockId(id);
      expect(blockId.length).toBeLessThanOrEqual(96);
      expect(blockId).toMatch(/^workflow-definition:wa+:[0-9a-f]{16}$/);
    }
  });

  it("separates long ids that share the same readable prefix", () => {
    const shared = `w${"a".repeat(126)}`;
    expect(workflowDefinitionActivityBlockId(`${shared}x`))
      .not.toBe(workflowDefinitionActivityBlockId(`${shared}y`));
  });
});
