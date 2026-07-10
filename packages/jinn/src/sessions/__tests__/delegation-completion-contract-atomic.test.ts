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
    });
    workItems.linkSession(item.id, session.id);
    const idleChild = registry.getSession(session.id)!;
    const postFollowUp = vi.fn(async () => undefined);
    const result = { result: "Progress update: implementation is in progress; tests are still running." };

    const outcomes = await Promise.all([
      contract.enforceDelegationCompletionContract(idleChild, result, { postFollowUp }),
      contract.enforceDelegationCompletionContract(idleChild, result, { postFollowUp }),
    ]);

    expect(postFollowUp).toHaveBeenCalledOnce();
    expect(outcomes.sort()).toEqual(["nudged", "suppress"]);
  });
});
