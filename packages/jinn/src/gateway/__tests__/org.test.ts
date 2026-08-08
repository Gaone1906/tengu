import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// We need to mock ORG_DIR to point to a temp directory
let tmpDir: string;

vi.mock("../../shared/paths.js", () => ({
  get ORG_DIR() {
    return tmpDir;
  },
}));

vi.mock("../../shared/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { scanOrg } from "../org.js";

function writeYaml(subdir: string, filename: string, content: string) {
  const dir = path.join(tmpDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content, "utf-8");
}

describe("scanOrg — alwaysNotify field", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "org-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("defaults alwaysNotify to true when not specified in YAML", () => {
    writeYaml("platform", "dev.yaml", `
name: dev
persona: A developer
`);
    const registry = scanOrg();
    const emp = registry.get("dev");
    expect(emp).toBeDefined();
    expect(emp!.alwaysNotify).toBe(true);
  });

  it("parses alwaysNotify: false from YAML", () => {
    writeYaml("platform", "worker.yaml", `
name: worker
persona: A worker
alwaysNotify: false
`);
    const registry = scanOrg();
    const emp = registry.get("worker");
    expect(emp).toBeDefined();
    expect(emp!.alwaysNotify).toBe(false);
  });

  it("parses alwaysNotify: true from YAML", () => {
    writeYaml("platform", "lead.yaml", `
name: lead
persona: A lead
alwaysNotify: true
`);
    const registry = scanOrg();
    const emp = registry.get("lead");
    expect(emp).toBeDefined();
    expect(emp!.alwaysNotify).toBe(true);
  });

  it("ignores non-boolean alwaysNotify values and defaults to true", () => {
    writeYaml("platform", "bad.yaml", `
name: bad
persona: A bad config
alwaysNotify: "yes"
`);
    const registry = scanOrg();
    const emp = registry.get("bad");
    expect(emp).toBeDefined();
    expect(emp!.alwaysNotify).toBe(true);
  });
});

describe("scanOrg — jinnMcp per-employee override (GRS-017e-fix, live-QA phase-D catch)", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "org-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses jinnMcp: true/false from the employee YAML (the scan whitelist previously dropped it — a YAML pilot could never arm the smoke gate)", () => {
    writeYaml("platform", "pilot.yaml", `
name: pilot
persona: pilot employee
jinnMcp: true
`);
    writeYaml("platform", "optout.yaml", `
name: optout
persona: opted-out employee
jinnMcp: false
`);
    const registry = scanOrg();
    expect(registry.get("pilot")!.jinnMcp).toBe(true);
    expect(registry.get("optout")!.jinnMcp).toBe(false);
  });

  it("leaves jinnMcp undefined when absent or non-boolean (follow the global setting)", () => {
    writeYaml("platform", "plain.yaml", `
name: plain
persona: plain employee
`);
    writeYaml("platform", "bad.yaml", `
name: badjinn
persona: bad value
jinnMcp: "yes"
`);
    const registry = scanOrg();
    expect(registry.get("plain")!.jinnMcp).toBeUndefined();
    expect(registry.get("badjinn")!.jinnMcp).toBeUndefined();
  });
});

describe("scanOrg — reserved author identities", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "org-test-reserved-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips employees whose name collides with the operator/system/session author namespaces and keeps scanning", async () => {
    const { logger } = await import("../../shared/logger.js");
    (logger.warn as ReturnType<typeof vi.fn>).mockClear();
    writeYaml("platform", "operator.yaml", "name: Operator\npersona: sentinel impostor\n");
    writeYaml("platform", "system.yaml", "name: system\npersona: sentinel impostor\n");
    writeYaml("platform", "session.yaml", 'name: "session:0a1b2c3d"\npersona: sentinel impostor\n');
    // Todos v2 slice 5: cron:<jobId> and workflow:<defId> are creator
    // identities too — same reservation.
    writeYaml("platform", "cron.yaml", 'name: "cron:nightly"\npersona: sentinel impostor\n');
    writeYaml("platform", "workflow.yaml", 'name: "workflow:release"\npersona: sentinel impostor\n');
    writeYaml("platform", "dev.yaml", "name: dev\npersona: A developer\n");

    const registry = scanOrg();
    expect(registry.get("dev")).toBeDefined();
    // 1 org employee ("dev") + the hardcoded system employees (`security`,
    // `todo-dispatcher`) — bumps whenever SYSTEM_EMPLOYEES grows.
    expect(registry.size).toBe(3);
    expect(registry.has("Operator")).toBe(false);
    expect(registry.has("system")).toBe(false);
    expect(registry.has("session:0a1b2c3d")).toBe(false);
    expect(registry.has("cron:nightly")).toBe(false);
    expect(registry.has("workflow:release")).toBe(false);

    const warnings = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(warnings.filter((w) => /reserved author identity/i.test(w))).toHaveLength(5);
  });
});
