import { describe, expect, it } from "vitest";
import { extractActivityReceiptId } from "../activity-receipts.js";

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
