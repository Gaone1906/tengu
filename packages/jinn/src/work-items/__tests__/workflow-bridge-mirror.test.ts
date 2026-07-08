import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway registry DB — off the live DB. Set BEFORE importing the store.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-mirror-"));
process.env.JINN_HOME = tmp;
const orgDir = path.join(tmp, "org", "platform");
fs.mkdirSync(orgDir, { recursive: true });
fs.writeFileSync(path.join(orgDir, "department.yaml"), "name: platform\n");
fs.writeFileSync(
  path.join(orgDir, "coo.yaml"),
  "name: coo\ndisplayName: COO\ndepartment: platform\nrank: executive\nengine: codex\nmodel: gpt-5.5\npersona: Runs the company.\n",
);

type Store = typeof import("../store.js");
type Bridge = typeof import("../workflow-bridge.js");
type Reg = typeof import("../../sessions/registry.js");
let store: Store;
let bridgeMod: Bridge;
let reg: Reg;

beforeAll(async () => {
  store = await import("../store.js");
  bridgeMod = await import("../workflow-bridge.js");
  reg = await import("../../sessions/registry.js");
  reg.initDb();
});

const run = (runId: string) => ({ runId, workflowId: "wf-mirror", title: `Run ${runId}` });

/**
 * GRS-021b — the workflow-park → Todo approval MIRROR (design §1.3). When a run
 * parks on an approval gate, its run-level Todo gets a PENDING approval whose ref
 * marks it a mirror (`workflow-gate:<defId>:<runId>:<gateRef>`) — one operator
 * queue, and deciding it (elsewhere) routes back to the shipped resolve-gate.
 */
describe("workflow-bridge — mirrorParkedGate", () => {
  it("sets a pending approval with the workflow-gate ref + description, on the run's Todo", () => {
    const bridge = bridgeMod.createWorkflowTodoBridge();
    bridge.mintRunItem(run("run_a"));
    bridge.mirrorParkedGate(run("run_a"), { ref: "gate-1", description: "Approve the publish step" });

    const item = store.getWorkItemBySourceRef("workflow", "workflow:wf-mirror:run_a")!;
    expect(item.assignee).toBeNull();
    expect(item.department).toBe("platform");
    expect(item.approvalState).toBe("pending");
    expect(item.approvalRequest).toBe("Approve the publish step");
    expect(item.approvalRef).toBe("workflow-gate:wf-mirror:run_a:gate-1");
    expect(item.approvalTarget).toBe("coo");
    expect(store.listWorkItemEvents(item.id).filter((e) => e.kind === "approval_requested").length).toBe(1);
  });

  it("falls back to the gate description as the gate key when the gate has no ref", () => {
    const bridge = bridgeMod.createWorkflowTodoBridge();
    bridge.mintRunItem(run("run_b"));
    bridge.mirrorParkedGate(run("run_b"), { description: "human sign-off" });
    const item = store.getWorkItemBySourceRef("workflow", "workflow:wf-mirror:run_b")!;
    expect(item.approvalRef).toBe("workflow-gate:wf-mirror:run_b:human sign-off");
  });

  it("is idempotent across sweeps — a re-mirror of the same park appends no duplicate event", () => {
    const bridge = bridgeMod.createWorkflowTodoBridge();
    bridge.mintRunItem(run("run_c"));
    bridge.mirrorParkedGate(run("run_c"), { ref: "g", description: "d" });
    bridge.mirrorParkedGate(run("run_c"), { ref: "g", description: "d" });
    const item = store.getWorkItemBySourceRef("workflow", "workflow:wf-mirror:run_c")!;
    expect(store.listWorkItemEvents(item.id).filter((e) => e.kind === "approval_requested").length).toBe(1);
  });

  it("self-heals a lost mint (get-or-create), like linkRunSession", () => {
    const bridge = bridgeMod.createWorkflowTodoBridge();
    // NO mintRunItem first — the park hook must still mirror onto a created item.
    bridge.mirrorParkedGate(run("run_d"), { ref: "g", description: "d" });
    const item = store.getWorkItemBySourceRef("workflow", "workflow:wf-mirror:run_d");
    expect(item).toBeTruthy();
    expect(item!.approvalState).toBe("pending");
  });
});
