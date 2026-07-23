import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importLegacyWorkflowDefinitions } from "../import-v1.js";
import { openWorkflowDatabase } from "../repository-migrations.js";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "jinn-workflow-v1-import-"));
  roots.push(root);
  const legacyDirectory = path.join(root, "workflow-evidence", "workflows");
  mkdirSync(legacyDirectory, { recursive: true });
  const db = openWorkflowDatabase(path.join(root, "workflows.db"));
  return { root, legacyDirectory, db };
}

function writeLegacy(directory: string, value: unknown): void {
  const id = (value as { id: string }).id;
  writeFileSync(path.join(directory, `${id}.definition.json`), JSON.stringify(value));
}

const morningDigest = {
  schemaVersion: 1,
  id: "morning-digest",
  title: "Morning Digest",
  version: 1,
  status: "active",
  updatedAt: "2026-07-11T08:12:13.559Z",
  nodes: [{
    id: "trigger",
    type: "trigger",
    label: "Trigger",
    position: { x: 80, y: 120 },
    trigger: { kind: "manual" },
  }],
  edges: [],
};

const planImplementVerify = {
  schemaVersion: 1,
  id: "plan-implement-verify",
  title: "Plan → Implement → Verify",
  version: 1,
  status: "active",
  updatedAt: "2026-07-12T08:48:50.041Z",
  nodes: [
    { id: "trigger", type: "trigger", label: "Manual trigger", position: { x: 0, y: 0 }, trigger: { kind: "manual" } },
    { id: "plan", type: "step", label: "PLAN", position: { x: 320, y: -100 },
      actor: { kind: "engine", ref: "codex" }, instructions: "Plan the requested change.",
      options: { model: "gpt-5.6-sol", effort: "xhigh", retry: { maxAttempts: 2 }, timeoutMinutes: 120 } },
    { id: "implement", type: "step", label: "IMPLEMENT", position: { x: 760, y: -100 },
      actor: { kind: "engine", ref: "codex" }, instructions: "Implement the approved plan." },
    { id: "verify", type: "step", label: "VERIFY", position: { x: 1200, y: -100 },
      actor: { kind: "engine", ref: "codex" }, instructions: "Verify the implementation." },
  ],
  edges: [
    { id: "trigger-to-plan", from: "trigger", to: "plan", kind: "sequence" },
    { id: "plan-to-implement", from: "plan", to: "implement", kind: "handoff" },
    { id: "implement-to-verify", from: "implement", to: "verify", kind: "handoff" },
    { id: "verify-to-plan", from: "verify", to: "plan", kind: "loop",
      when: [{ path: "steps.verify.outcome.fields.verdict", op: "eq", value: "ship" }] },
  ],
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("legacy Workflow definition import", () => {
  it("imports the two live v1 shapes once as disabled v2 drafts without touching the source", () => {
    const { legacyDirectory, db } = fixture();
    writeLegacy(legacyDirectory, morningDigest);
    writeLegacy(legacyDirectory, planImplementVerify);
    const logs: string[] = [];

    expect(importLegacyWorkflowDefinitions(db, {
      legacyDirectory,
      log: (_level, message) => logs.push(message),
    })).toEqual({ imported: 2, failed: 0, skipped: false });

    const rows = db.prepare("SELECT id, enabled, definition_json FROM workflow_definitions ORDER BY id")
      .all() as Array<{ id: string; enabled: number; definition_json: string }>;
    expect(rows.map(({ id, enabled }) => ({ id, enabled }))).toEqual([
      { id: "morning-digest", enabled: 0 },
      { id: "plan-implement-verify", enabled: 0 },
    ]);
    const morning = JSON.parse(rows[0]!.definition_json);
    const pipeline = JSON.parse(rows[1]!.definition_json);
    expect(morning.nodes).toEqual([
      { id: "trigger", type: "trigger", name: "Trigger", config: { kind: "manual" } },
    ]);
    expect(pipeline.nodes.map((node: { type: string }) => node.type)).toEqual([
      "trigger", "employee", "employee", "employee",
    ]);
    expect(pipeline.edges).toHaveLength(4);
    expect(pipeline.ui.positions.verify).toEqual({ x: 1200, y: -100 });
    expect(logs.filter((line) => line.includes("imported legacy Workflow"))).toHaveLength(2);
    expect(existsSync(path.join(legacyDirectory, "morning-digest.definition.json"))).toBe(true);
    expect(existsSync(path.join(legacyDirectory, "plan-implement-verify.definition.json"))).toBe(true);

    expect(importLegacyWorkflowDefinitions(db, { legacyDirectory })).toEqual({
      imported: 0, failed: 0, skipped: true,
    });
    db.close();
  });

  it("logs and preserves an unsupported v1 definition instead of partially importing it", () => {
    const { legacyDirectory, db } = fixture();
    writeLegacy(legacyDirectory, {
      ...morningDigest,
      id: "unsupported-workflow",
      nodes: [{ id: "gate", type: "gate", label: "Gate", position: { x: 0, y: 0 } }],
    });
    const logs: string[] = [];
    expect(importLegacyWorkflowDefinitions(db, {
      legacyDirectory,
      log: (_level, message) => logs.push(message),
    })).toEqual({ imported: 0, failed: 1, skipped: false });
    expect(logs).toEqual([expect.stringContaining("failed to import legacy Workflow unsupported-workflow")]);
    expect(existsSync(path.join(legacyDirectory, "unsupported-workflow.definition.json"))).toBe(true);
    expect(db.prepare("SELECT count(*) FROM workflow_definitions").pluck().get()).toBe(0);
    db.close();
  });
});
