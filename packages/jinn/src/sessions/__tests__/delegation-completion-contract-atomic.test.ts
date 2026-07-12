import { beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-delegation-contract-"));
process.env.JINN_HOME = tmp;

type Registry = typeof import("../registry.js");
type WorkItems = typeof import("../../work-items/store.js");
type Contract = typeof import("../delegation-completion-contract.js");

let registry: Registry;
let workItems: WorkItems;
let contract: Contract;

beforeAll(async () => {
  registry = await import("../registry.js");
  workItems = await import("../../work-items/store.js");
  contract = await import("../delegation-completion-contract.js");
  registry.initDb();
});

describe("delegation completion contract atomic guard", () => {
  it("posts exactly one nudge when duplicate idle callbacks race", async () => {
    const item = workItems.createWorkItem({
      title: "Atomic completion contract",
      status: "executing",
      source: "delegation",
    });
    const session = registry.createSession({
      engine: "codex",
      source: "api",
      sourceRef: "api:atomic-contract",
      parentSessionId: "parent-atomic",
      transportMeta: { delegationCompletionTracked: true },
    });
    workItems.linkSession(item.id, session.id);
    const idleChild = registry.getSession(session.id)!;
    const postFollowUp = vi.fn(async () => undefined);
    const result = { result: "Progress update: the implementation is still in progress; tests are still running." };

    const outcomes = await Promise.all([
      contract.enforceDelegationCompletionContract(idleChild, result, { postFollowUp }),
      contract.enforceDelegationCompletionContract(idleChild, result, { postFollowUp }),
    ]);

    expect(postFollowUp).toHaveBeenCalledOnce();
    expect(outcomes.sort()).toEqual(["nudged", "suppress"]);
  });

  it("atomically clears only the stale guard under a racing claim", () => {
    const oldItem = workItems.createWorkItem({ title: "Old cycle", status: "executing", source: "delegation" });
    const newItem = workItems.createWorkItem({ title: "New cycle", status: "executing", source: "delegation" });
    const session = registry.createSession({
      engine: "codex",
      source: "api",
      sourceRef: "api:atomic-clear",
      parentSessionId: "parent-clear",
      transportMeta: { delegationCompletionTracked: true, preserved: "live" },
    });
    registry.claimDelegationCompletionNudge(session.id, oldItem.id);
    const staleSession = registry.getSession(session.id)!;
    registry.claimDelegationCompletionNudge(session.id, newItem.id);

    contract.clearDelegationCompletionContract(staleSession);

    expect(registry.getSession(session.id)?.transportMeta).toMatchObject({
      delegationCompletionTracked: true,
      preserved: "live",
      delegationCompletionContract: { workItemId: newItem.id, state: "nudged" },
    });
  });

  it("independently excludes a guarded child that already has a durable nudge receipt", () => {
    const item = workItems.createWorkItem({ title: "Pending durable nudge", status: "executing", source: "delegation" });
    const session = registry.createSession({
      engine: "codex",
      source: "api",
      sourceRef: "api:pending-durable-nudge",
      parentSessionId: "parent-pending-nudge",
      transportMeta: { delegationCompletionTracked: true },
    });
    workItems.linkSession(item.id, session.id);
    const attempt = registry.beginSessionAttempt(session.id)!;
    const idle = registry.completeSessionAttempt(session.id, attempt.attemptToken!, {
      status: "idle",
      attemptOutcome: "succeeded",
    })!;
    registry.claimDelegationCompletionNudge(idle.id, item.id);
    registry.claimCallbackDelivery({
      parentSessionId: idle.id,
      childSessionId: idle.id,
      attemptToken: idle.attemptToken!,
      terminalOutcome: "succeeded",
      terminalVersion: idle.attemptTerminalVersion!,
      callbackKind: "delegation-completion-nudge",
      payload: { message: "continue", displayMessage: "continuing" },
    });

    expect(registry.listDelegationCompletionNudgedSessions().map(({ id }) => id)).not.toContain(idle.id);
  });
});
