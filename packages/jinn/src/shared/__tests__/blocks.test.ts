import { describe, expect, it } from "vitest";
import {
  blockFallbackText,
  mergeBlock,
  validateBlockEnvelope,
} from "../blocks.js";

describe("chat blocks", () => {
  it("accepts a minimal task-list put envelope", () => {
    const result = validateBlockEnvelope({
      op: "put",
      block: {
        id: "plan",
        type: "task-list",
        version: 1,
        title: "Plan",
        payload: {
          items: [
            { id: "a", text: "Read code", status: "done" },
            { id: "b", text: "Patch UI", status: "running" },
          ],
        },
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(blockFallbackText(result.envelope.block)).toBe("Plan: 2 items");
    }
  });

  it("accepts delegation puts and partial callback patches", () => {
    const put = validateBlockEnvelope({
      op: "put",
      block: {
        id: "dg-wi_123",
        type: "delegation",
        version: 1,
        status: "running",
        payload: {
          employee: "design-lead",
          employeeDisplay: "Design Lead",
          title: "Redesign the workflow canvas",
          childSessionId: "child-123",
          workItemId: "wi_123",
          dispatchedAt: 1_780_000_000_000,
        },
      },
    });

    expect(put.ok).toBe(true);
    if (put.ok) expect(blockFallbackText(put.envelope.block)).toBe("Redesign the workflow canvas");

    expect(validateBlockEnvelope({
      op: "patch",
      block: {
        id: "dg-wi_123",
        type: "delegation",
        version: 1,
        status: "done",
        payload: { repliedAt: 1_780_000_120_000 },
      },
    }).ok).toBe(true);
  });

  it("accepts waiting delegation patches as an active child state", () => {
    expect(validateBlockEnvelope({
      op: "patch",
      block: {
        id: "dg-wi_123",
        type: "delegation",
        version: 2,
        status: "waiting",
        payload: {},
      },
    })).toMatchObject({ ok: true, envelope: { block: { status: "waiting" } } });
  });

  it("rejects incomplete delegation puts", () => {
    expect(validateBlockEnvelope({
      op: "put",
      block: {
        id: "dg-wi_123",
        type: "delegation",
        version: 1,
        payload: { employee: "design-lead" },
      },
    })).toMatchObject({ ok: false, error: "delegation payload requires employeeDisplay" });
  });

  it("rejects unsupported block types", () => {
    const result = validateBlockEnvelope({
      op: "put",
      block: {
        id: "metric",
        type: "metric",
        version: 1,
        payload: { value: "43k" },
      },
    });

    expect(result.ok).toBe(false);
  });

  it("rejects executable markup and unsafe payload keys", () => {
    const result = validateBlockEnvelope({
      op: "put",
      block: {
        id: "bad",
        type: "task-list",
        version: 1,
        payload: {
          items: [{ id: "a", text: "Read code" }],
          dangerouslySetInnerHTML: "<script>alert(1)</script>",
        },
      },
    });

    expect(result.ok).toBe(false);
  });

  it("merges patches without dropping existing payload fields", () => {
    const merged = mergeBlock(
      {
        id: "plan",
        type: "task-list",
        version: 1,
        title: "Plan",
        status: "running",
        payload: { items: [{ id: "a", text: "Read code", status: "running" }] },
      },
      {
        id: "plan",
        type: "task-list",
        version: 1,
        status: "done",
        payload: { summary: "Complete" },
      },
    );

    expect(merged.status).toBe("done");
    expect(merged.payload).toEqual({
      items: [{ id: "a", text: "Read code", status: "running" }],
      summary: "Complete",
    });
  });

  it("does not let patches mutate the block type", () => {
    const merged = mergeBlock(
      {
        id: "plan",
        type: "task-list",
        version: 1,
        title: "Plan",
        status: "running",
        payload: { items: [{ id: "a", text: "Read code", status: "running" }] },
      },
      {
        id: "plan",
        type: "metric",
        version: 1,
        status: "done",
        payload: { resolved: true },
      } as any,
    );

    expect(merged.type).toBe("task-list");
    expect(merged.payload).toMatchObject({
      items: [{ id: "a", text: "Read code", status: "running" }],
      resolved: true,
    });
  });

  it("rejects obsolete diff and approval block types", () => {
    expect(validateBlockEnvelope({
      op: "put",
      block: {
        id: "diff",
        type: "diff",
        version: 1,
        payload: { hunks: [{ before: "old", after: "new" }] },
      },
    })).toMatchObject({ ok: false, error: "block type is invalid" });

    expect(validateBlockEnvelope({
      op: "put",
      block: {
        id: "approval",
        type: "approval",
        version: 1,
        payload: { actionId: "block.resolve" },
      },
    })).toMatchObject({ ok: false, error: "block type is invalid" });
  });
});
