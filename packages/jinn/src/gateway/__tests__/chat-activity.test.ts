import { describe, expect, it } from "vitest";
import { todoActivityBlock } from "../chat-activity.js";
import type { WorkItem } from "../../work-items/store.js";

describe("todoActivityBlock", () => {
  it("carries Todo hierarchy metadata into the chat receipt", () => {
    const item = {
      id: "ACM-43",
      title: "Verify the release",
      status: "assigned",
      assignee: "release-engineer",
      approvalState: null,
      parentId: "ACM-42",
      rootId: "ACM-42",
      depth: 1,
      version: 3,
      updatedAt: "2026-07-27T09:30:00.000Z",
    } as WorkItem;

    const envelope = todoActivityBlock(item, "created");

    expect(envelope.block.payload).toMatchObject({
      todoId: "ACM-43",
      parentId: "ACM-42",
      rootId: "ACM-42",
      depth: 1,
    });
  });
});
