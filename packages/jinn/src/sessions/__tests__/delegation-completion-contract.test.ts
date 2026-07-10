import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../shared/types.js";

const { getWorkItem, getSession, updateSession, claimDelegationCompletionNudge, clearDelegationCompletionGuard, markDelegationCompletionSurfaced, releaseDelegationCompletionNudge } = vi.hoisted(() => ({
  getWorkItem: vi.fn(),
  getSession: vi.fn(),
  updateSession: vi.fn(),
  claimDelegationCompletionNudge: vi.fn(),
  clearDelegationCompletionGuard: vi.fn(),
  markDelegationCompletionSurfaced: vi.fn(),
  releaseDelegationCompletionNudge: vi.fn(),
}));

vi.mock("../../work-items/store.js", () => ({ getWorkItem }));
vi.mock("../registry.js", () => ({
  updateSession,
  getSession,
  claimDelegationCompletionNudge,
  clearDelegationCompletionGuard,
  markDelegationCompletionSurfaced,
  releaseDelegationCompletionNudge,
}));

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
    transportMeta: { delegationCompletionTracked: true },
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
  return { id: "wi_open", status, source: "delegation" };
}

describe("delegation completion contract", () => {
  beforeEach(() => {
    getWorkItem.mockReset();
    updateSession.mockReset();
    updateSession.mockImplementation((id: string, updates: Partial<Session>) => ({ ...child({ id }), ...updates }));
    claimDelegationCompletionNudge.mockReset();
    claimDelegationCompletionNudge.mockImplementation((id: string, workItemId: string) => child({
      id,
      transportMeta: { delegationCompletionContract: { workItemId, state: "nudged" } },
    }));
    markDelegationCompletionSurfaced.mockReset();
    markDelegationCompletionSurfaced.mockImplementation((id: string, workItemId: string) => child({
      id,
      transportMeta: { delegationCompletionContract: { workItemId, state: "surfaced" } },
    }));
    releaseDelegationCompletionNudge.mockReset();
    clearDelegationCompletionGuard.mockReset();
    getSession.mockReset();
  });

  it("nudges a qualifying idle progress-only child exactly once", async () => {
    getWorkItem.mockReturnValue(openItem("executing"));
    const postFollowUp = vi.fn().mockResolvedValue(undefined);

    const outcome = await enforceDelegationCompletionContract(
      child(),
      { result: "Progress update: the implementation is still in progress. I will continue with the tests." },
      { postFollowUp },
    );

    expect(outcome).toBe("nudged");
    expect(postFollowUp).toHaveBeenCalledOnce();
    expect(postFollowUp).toHaveBeenCalledWith(
      "child-1",
      expect.stringContaining("Continue"),
      expect.stringContaining("Completion contract"),
    );
    expect(claimDelegationCompletionNudge).toHaveBeenCalledOnce();
    expect(claimDelegationCompletionNudge).toHaveBeenCalledWith("child-1", "wi_open");
  });

  it.each(["in_review", "done"] as const)("does not nudge a %s child", async (status) => {
    getWorkItem.mockReturnValue(openItem(status));
    const postFollowUp = vi.fn().mockResolvedValue(undefined);

    const outcome = await enforceDelegationCompletionContract(
      child(),
      { result: "Progress update: I will continue with the remaining checks." },
      { postFollowUp },
    );

    expect(outcome).toBe("pass");
    expect(postFollowUp).not.toHaveBeenCalled();
    expect(claimDelegationCompletionNudge).not.toHaveBeenCalled();
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
    expect(claimDelegationCompletionNudge).not.toHaveBeenCalled();
  });

  it.each([
    "Progress update: not done; tests are still running.",
    "Progress update: not finished; tests are still running.",
    "Progress update: not complete; tests are still running.",
    "I am still working on the migration.",
    "I will continue after this.",
  ])("nudges an explicit task-unfinished report: %s", async (message) => {
    getWorkItem.mockReturnValue(openItem("executing"));
    const postFollowUp = vi.fn().mockResolvedValue(undefined);

    const outcome = await enforceDelegationCompletionContract(child(), { result: message }, { postFollowUp });

    expect(outcome).toBe("nudged");
    expect(postFollowUp).toHaveBeenCalledOnce();
  });

  it.each([
    "Status update: all checks are green and the deliverable is ready",
    "Progress update: success. No further action is required",
  ])("does not let a generic update header authorize a nudge: %s", async (message) => {
    getWorkItem.mockReturnValue(openItem("executing"));
    const postFollowUp = vi.fn().mockResolvedValue(undefined);

    const outcome = await enforceDelegationCompletionContract(child(), { result: message }, { postFollowUp });

    expect(outcome).toBe("pass");
    expect(postFollowUp).not.toHaveBeenCalled();
    expect(claimDelegationCompletionNudge).not.toHaveBeenCalled();
  });

  it.each([
    "There is no remaining work.",
    "The fix is verified. Next step: merge when convenient.",
    "The feature is working on both iOS and Android; verification is green.",
    "The service is still running and healthy after the rollout.",
  ])("does not let incidental operational language authorize a nudge: %s", async (message) => {
    getWorkItem.mockReturnValue(openItem("executing"));
    const postFollowUp = vi.fn().mockResolvedValue(undefined);

    const outcome = await enforceDelegationCompletionContract(child(), { result: message }, { postFollowUp });

    expect(outcome).toBe("pass");
    expect(postFollowUp).not.toHaveBeenCalled();
    expect(claimDelegationCompletionNudge).not.toHaveBeenCalled();
  });

  it("does not let bare remaining language authorize a nudge", async () => {
    getWorkItem.mockReturnValue(openItem("executing"));
    const postFollowUp = vi.fn().mockResolvedValue(undefined);

    const outcome = await enforceDelegationCompletionContract(
      child(),
      { result: "Remaining notes are attached for context." },
      { postFollowUp },
    );

    expect(outcome).toBe("pass");
    expect(postFollowUp).not.toHaveBeenCalled();
    expect(claimDelegationCompletionNudge).not.toHaveBeenCalled();
  });

  it.each([
    "Remaining checks now pass; the patch is ready for review.",
    "Progress update: tests pass and the PR is ready.",
    "Remaining checks pass; ready to merge.",
  ])("does not nudge terminal handoff language: %s", async (message) => {
    getWorkItem.mockReturnValue(openItem("executing"));
    const postFollowUp = vi.fn().mockResolvedValue(undefined);

    const outcome = await enforceDelegationCompletionContract(child(), { result: message }, { postFollowUp });

    expect(outcome).toBe("pass");
    expect(postFollowUp).not.toHaveBeenCalled();
  });

  it("does not nudge a direction request without a question mark", async () => {
    getWorkItem.mockReturnValue(openItem("executing"));
    const postFollowUp = vi.fn().mockResolvedValue(undefined);

    const outcome = await enforceDelegationCompletionContract(
      child(),
      { result: "Progress update: blocked on the API choice. Let me know whether to use REST or GraphQL." },
      { postFollowUp },
    );

    expect(outcome).toBe("pass");
    expect(postFollowUp).not.toHaveBeenCalled();
  });

  it("nudges a spawned delegation linked to an existing human Todo", async () => {
    getWorkItem.mockReturnValue({ ...openItem("executing"), source: "human" });
    const postFollowUp = vi.fn().mockResolvedValue(undefined);

    const outcome = await enforceDelegationCompletionContract(
      child(),
      { result: "Progress update: I will continue with the remaining checks." },
      { postFollowUp },
    );

    expect(outcome).toBe("nudged");
    expect(postFollowUp).toHaveBeenCalledOnce();
  });

  it("does not nudge an unmarked session even when its Todo is open", async () => {
    getWorkItem.mockReturnValue(openItem("executing"));
    const postFollowUp = vi.fn().mockResolvedValue(undefined);

    const outcome = await enforceDelegationCompletionContract(
      child({ transportMeta: null }),
      { result: "Progress update: continuing with the remaining checks." },
      { postFollowUp },
    );

    expect(outcome).toBe("pass");
    expect(postFollowUp).not.toHaveBeenCalled();
  });

  it("surfaces a mixed terminal and unfinished report as ambiguous", async () => {
    getWorkItem.mockReturnValue(openItem("executing"));
    const postFollowUp = vi.fn().mockResolvedValue(undefined);

    const outcome = await enforceDelegationCompletionContract(
      child(),
      { result: "Tests pass for the API, but the migration remains incomplete." },
      { postFollowUp },
    );

    expect(outcome).toBe("pass");
    expect(postFollowUp).not.toHaveBeenCalled();
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
        delegationCompletionTracked: true,
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
    expect(markDelegationCompletionSurfaced).toHaveBeenCalledOnce();
    expect(markDelegationCompletionSurfaced).toHaveBeenCalledWith("child-1", "wi_open");
  });
});
