import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../shared/types.js";

const { getWorkItem, updateSession } = vi.hoisted(() => ({
  getWorkItem: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock("../../work-items/store.js", () => ({ getWorkItem }));
vi.mock("../registry.js", () => ({ updateSession }));

import { enforceDelegationCompletionContract } from "../delegation-completion-contract.js";

function child(overrides: Partial<Session> = {}): Session {
  return {
    id: "child-1",
    engine: "codex",
    engineSessionId: "native-1",
    source: "api",
    sourceRef: "api:child-1",
    connector: null,
    sessionKey: "child-1",
    workItemId: "wi_open",
    replyContext: null,
    messageId: null,
    transportMeta: null,
    employee: "worker",
    model: "gpt",
    title: "Implement bounded change",
    parentSessionId: "parent-1",
    status: "idle",
    attemptOutcome: "succeeded",
    attemptToken: "attempt-1",
    effortLevel: null,
    totalCost: 0,
    totalTurns: 1,
    lastContextTokens: null,
    createdAt: "2026-07-10T08:00:00.000Z",
    lastActivity: "2026-07-10T08:01:00.000Z",
    lastError: null,
    ...overrides,
  };
}

function openItem(status: "backlog" | "assigned" | "executing" | "in_review" | "done" = "executing") {
  return { id: "wi_open", status };
}

describe("delegation completion contract", () => {
  beforeEach(() => {
    getWorkItem.mockReset();
    updateSession.mockReset();
    updateSession.mockImplementation((id: string, updates: Partial<Session>) => ({ ...child({ id }), ...updates }));
  });

  it("nudges a qualifying idle progress-only child exactly once", async () => {
    getWorkItem.mockReturnValue(openItem("executing"));
    const postFollowUp = vi.fn().mockResolvedValue(undefined);

    const outcome = await enforceDelegationCompletionContract(
      child(),
      { result: "Progress update: implementation is in progress. Next step is running the tests." },
      { postFollowUp },
    );

    expect(outcome).toBe("nudged");
    expect(postFollowUp).toHaveBeenCalledOnce();
    expect(postFollowUp).toHaveBeenCalledWith(
      "child-1",
      expect.stringContaining("Continue"),
      expect.stringContaining("Completion contract"),
    );
    expect(updateSession).toHaveBeenCalledOnce();
    expect(updateSession.mock.calls[0][1].transportMeta).toMatchObject({
      delegationCompletionContract: { workItemId: "wi_open", state: "nudged" },
    });
  });

  it.each(["in_review", "done"] as const)("does not nudge a %s child", async (status) => {
    getWorkItem.mockReturnValue(openItem(status));
    const postFollowUp = vi.fn().mockResolvedValue(undefined);

    const outcome = await enforceDelegationCompletionContract(
      child(),
      { result: "Progress update: continuing with the remaining checks." },
      { postFollowUp },
    );

    expect(outcome).toBe("pass");
    expect(postFollowUp).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
  });

  it("does not nudge a child awaiting the parent", async () => {
    getWorkItem.mockReturnValue(openItem("executing"));
    const postFollowUp = vi.fn().mockResolvedValue(undefined);

    const outcome = await enforceDelegationCompletionContract(
      child(),
      { result: "Progress update: the implementation is ready. Which option should I use for the migration?" },
      { postFollowUp },
    );

    expect(outcome).toBe("pass");
    expect(postFollowUp).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
  });

  it("does not nudge a direct conversation without a parent", async () => {
    getWorkItem.mockReturnValue(openItem("executing"));
    const postFollowUp = vi.fn().mockResolvedValue(undefined);

    const outcome = await enforceDelegationCompletionContract(
      child({ parentSessionId: null }),
      { result: "Progress update: continuing with the remaining checks." },
      { postFollowUp },
    );

    expect(outcome).toBe("pass");
    expect(postFollowUp).not.toHaveBeenCalled();
  });

  it("does not nudge a final report even while reconciliation is pending", async () => {
    getWorkItem.mockReturnValue(openItem("executing"));
    const postFollowUp = vi.fn().mockResolvedValue(undefined);

    const outcome = await enforceDelegationCompletionContract(
      child(),
      { result: "Final report: implementation complete. All tests passed." },
      { postFollowUp },
    );

    expect(outcome).toBe("pass");
    expect(postFollowUp).not.toHaveBeenCalled();
  });

  it("surfaces the second idle settlement to the parent without a nudge loop", async () => {
    getWorkItem.mockReturnValue(openItem("executing"));
    const postFollowUp = vi.fn().mockResolvedValue(undefined);
    const alreadyNudged = child({
      attemptToken: "attempt-2",
      transportMeta: {
        delegationCompletionContract: { workItemId: "wi_open", state: "nudged" },
      },
    });

    const outcome = await enforceDelegationCompletionContract(
      alreadyNudged,
      { result: "Progress update: still working through the remaining checks." },
      { postFollowUp },
    );

    expect(outcome).toBe("surface");
    expect(postFollowUp).not.toHaveBeenCalled();
    expect(updateSession).toHaveBeenCalledOnce();
    expect(updateSession.mock.calls[0][1].transportMeta).toMatchObject({
      delegationCompletionContract: { workItemId: "wi_open", state: "surfaced" },
    });
  });
});
