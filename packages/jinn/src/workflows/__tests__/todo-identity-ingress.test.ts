import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createWorkflowTriggerBinding,
  fireWorkflowEvent,
  sanitizeWorkflowTriggerPayload,
} from "../custom-triggers.js";
import { evaluateCondition, validateConditionShape, type ConditionEvidence } from "../condition.js";
import { fireTodoStatusChangeWorkflows } from "../todo-status-trigger.js";
import type { RunDriverDeps } from "../run-reconciler.js";

describe("structured Workflow Todo identity ingress", () => {
  it.each(["wi_0123456789ab", "JIN-0", "JIN-01", "garbage"])(
    "rejects an own malformed payload.todoId before sanitizing: %s",
    (todoId) => {
      expect(() => sanitizeWorkflowTriggerPayload({ todoId, note: "inert" })).toThrow(/Todo ID/i);
    },
  );

  it("rejects inherited and accessor todoId without invoking the getter", () => {
    const inherited = Object.create({ todoId: "JIN-1" }) as Record<string, unknown>;
    inherited.note = "inert";
    expect(() => sanitizeWorkflowTriggerPayload(inherited)).toThrow(/own.*todoId/i);

    let reads = 0;
    const accessor = { note: "inert" } as Record<string, unknown>;
    Object.defineProperty(accessor, "todoId", { enumerable: true, get: () => { reads += 1; return "JIN-1"; } });
    expect(() => sanitizeWorkflowTriggerPayload(accessor)).toThrow(/data property/i);
    expect(reads).toBe(0);
  });

  it("keeps absent Todo structure and unrelated legacy prose inert", () => {
    const payload = { note: "literal wi_0123456789ab stays prose" };
    expect(sanitizeWorkflowTriggerPayload(payload)).toEqual(payload);
  });

  it("rejects noncanonical authored payload.todoId filters before persistence", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-phase-a-filter-"));
    expect(() => createWorkflowTriggerBinding(root, {
      kind: "webhook",
      name: "todo-filter",
      event: "demo.ready",
      targetWorkflowId: "demo",
      filter: [{ path: "payload.todoId", op: "matches", value: "^JIN-" }],
      activation: "active",
    })).toThrow(/payload\.todoId/i);
    expect(fs.existsSync(path.join(root, "workflow-triggers", "triggers.json"))).toBe(false);
  });

  it.each([
    { op: "equals", value: "wi_0123456789ab" },
    { op: "notEquals", value: "JIN-0" },
    { op: "matches", value: "^JIN-" },
    { op: "exists", value: undefined },
  ])("rejects invalid authored Todo filter $op/$value with no persisted artifact", (filter) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-phase-a-filter-matrix-"));
    expect(() => createWorkflowTriggerBinding(root, {
      kind: "webhook",
      name: "todo-filter",
      event: "demo.ready",
      targetWorkflowId: "demo",
      filter: [{ path: "payload.todoId", ...filter }] as never,
      activation: "active",
    })).toThrow(/payload\.todoId|takes no value/i);
    expect(fs.existsSync(path.join(root, "workflow-triggers", "triggers.json"))).toBe(false);
  });

  it("accepts canonical exact Todo filters and a truly valueless exists filter", () => {
    for (const [index, filter] of [
      { path: "payload.todoId", op: "equals", value: "JIN-1" },
      { path: "payload.todoId", op: "notEquals", value: "JIN-2" },
      { path: "payload.todoId", op: "exists" },
    ].entries()) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-phase-a-filter-valid-"));
      expect(() => createWorkflowTriggerBinding(root, {
        kind: "webhook",
        name: `todo-filter-${index}`,
        event: "demo.ready",
        targetWorkflowId: "demo",
        filter: [filter] as never,
        activation: "active",
      })).not.toThrow();
    }
  });

  it("rejects a malformed persisted payload.todoId filter before matching or starting a run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-phase-a-filter-runtime-"));
    createWorkflowTriggerBinding(root, {
      kind: "webhook",
      name: "todo-filter",
      event: "demo.ready",
      targetWorkflowId: "missing-workflow",
      filter: [{ path: "payload.todoId", op: "equals", value: "JIN-1" }],
      activation: "active",
    });
    const storeFile = path.join(root, "workflow-triggers", "triggers.json");
    const stored = JSON.parse(fs.readFileSync(storeFile, "utf8")) as {
      triggers: Array<{ filter: Array<Record<string, unknown>> }>;
    };
    stored.triggers[0].filter[0] = { path: "payload.todoId", op: "matches", value: "^JIN-" };
    fs.writeFileSync(storeFile, JSON.stringify(stored));
    const deps: RunDriverDeps = {
      root,
      getDefinition: () => null,
      probeStepSession: () => ({ found: false }),
      spawnStep: async () => ({ sessionId: "must-not-start" }),
      now: () => "2026-07-14T12:00:00.000Z",
    };

    const result = await fireWorkflowEvent(
      deps,
      { event: "demo.ready", payload: { todoId: "JIN-1" } },
      { gatewayAuthorized: true },
    );

    expect(result).toEqual({ rejected: "no-matching-binding", outcomes: [] });
  });

  it.each(["gt", "gte", "lt", "lte", "contains", "startsWith"] as const)(
    "rejects %s conditions over trigger.payload.todoId",
    (op) => {
      expect(validateConditionShape({ path: "trigger.payload.todoId", op, value: "JIN-2" })).toEqual([
        expect.stringMatching(/trigger\.payload\.todoId/),
      ]);
    },
  );

  it("accepts only canonical eq/ne operands and valueless exists/absent", () => {
    expect(validateConditionShape({ path: "trigger.payload.todoId", op: "eq", value: "JIN-2" })).toEqual([]);
    expect(validateConditionShape({ path: "trigger.payload.todoId", op: "ne", value: "JIN-3" })).toEqual([]);
    expect(validateConditionShape({ path: "trigger.payload.todoId", op: "exists" })).toEqual([]);
    expect(validateConditionShape({ path: "trigger.payload.todoId", op: "absent" })).toEqual([]);
    expect(validateConditionShape({ path: "trigger.payload.todoId", op: "eq", value: "wi_0123456789ab" })).toEqual([
      expect.stringMatching(/canonical Todo ID/),
    ]);
  });

  it("rejects an authored valueless Todo condition with an own value property", () => {
    expect(validateConditionShape({
      path: "trigger.payload.todoId",
      op: "exists",
      value: undefined,
    })).toEqual([expect.stringMatching(/takes no value/)]);
  });

  it("fails closed when a persisted Todo condition bypasses authoring validation", () => {
    const evidence: ConditionEvidence = {
      receiptFor: () => null,
      runStatus: "running",
      triggerKind: "event-webhook",
      trigger: {
        source: "event-webhook",
        event: "demo.ready",
        payload: { todoId: "JIN-2" },
      },
    };

    expect(evaluateCondition(
      { path: "trigger.payload.todoId", op: "startsWith", value: "JIN-" },
      evidence,
    )).toBe(false);
    expect(evaluateCondition(
      { path: "trigger.payload.todoId", op: "exists", value: "JIN-2" },
      evidence,
    )).toBe(false);
  });

  it("rejects a forged noncanonical Todo status event before claim or run work", async () => {
    const claimEvent = vi.fn();
    const deps = {
      root: fs.mkdtempSync(path.join(os.tmpdir(), "jinn-phase-a-todo-event-")),
      todoEventFeed: {
        claimEvent,
        completeEvent: vi.fn(),
        releaseEvent: vi.fn(),
        listPendingEvents: vi.fn(() => []),
      },
      getDefinition: () => null,
      probeStepSession: () => ({ found: false as const }),
      spawnStep: async () => ({ sessionId: "must-not-start" }),
      now: () => "2026-07-14T12:00:00.000Z",
    } satisfies RunDriverDeps;

    await expect(fireTodoStatusChangeWorkflows(deps, {
      id: "event-legacy",
      workItemId: "wi_0123456789ab",
      fromStatus: "executing",
      toStatus: "in_review",
      item: { source: "human", department: null, assignee: null },
    })).rejects.toThrow(/Todo ID/i);
    expect(claimEvent).not.toHaveBeenCalled();
  });
});
