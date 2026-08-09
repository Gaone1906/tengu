import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ORG_DIR = path.join(__dirname, "..", "..", "..", "..", "..", "config", "org");

vi.mock("../../shared/paths.js", () => ({
  get ORG_DIR() {
    return REPO_ORG_DIR;
  },
}));

vi.mock("../../shared/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { scanOrg, GENERALIST_DEPARTMENT, DEFAULT_MAX_GENERALISTS } from "../org.js";

describe("real config/org roster — generalists", () => {
  it("has the repo's config/org checked out where this test expects it", () => {
    expect(fs.existsSync(REPO_ORG_DIR)).toBe(true);
    expect(fs.existsSync(path.join(REPO_ORG_DIR, "generalists"))).toBe(true);
  });

  it("parses all 3 generalist YAMLs (backend, frontend, testing) via scanOrg", () => {
    const registry = scanOrg();

    for (const name of ["backend", "frontend", "testing"]) {
      const employee = registry.get(name);
      expect(employee, `expected employee "${name}" to be registered`).toBeDefined();
      expect(employee!.department).toBe(GENERALIST_DEPARTMENT);
      expect(employee!.rank).toBe("manager");
      expect(employee!.engine).toBe("claude");
      expect(employee!.model).toBe("opus");
      expect(employee!.effortLevel).toBe("high");
      expect(employee!.interactive).toBe(true);
      expect(employee!.persona.length).toBeGreaterThan(200);
    }
  });

  it("keeps the generalist roster under the default cap", () => {
    let count = 0;
    for (const employee of scanOrg().values()) {
      if (employee.department === GENERALIST_DEPARTMENT) count++;
    }
    expect(count).toBe(3);
    expect(count).toBeLessThanOrEqual(DEFAULT_MAX_GENERALISTS);
  });

  it("does not register a specialists/README.md as an employee (it is documentation, not a roster entry)", () => {
    const registry = scanOrg();
    expect(fs.existsSync(path.join(REPO_ORG_DIR, "specialists", "README.md"))).toBe(true);
    for (const employee of registry.values()) {
      expect(employee.displayName).not.toMatch(/README/i);
    }
  });
});

describe("real config/org roster — retired D6 4-employee roster is gone", () => {
  it("the old department directories no longer exist on disk", () => {
    for (const dir of ["planning", "engineering", "review", "reporting"]) {
      expect(fs.existsSync(path.join(REPO_ORG_DIR, dir))).toBe(false);
    }
  });

  it("planner/engineer/reviewer/scribe are not empty files left behind either — they're absent from disk anywhere under config/org", () => {
    const found: string[] = [];
    const retiredNames = new Set(["planner", "engineer", "reviewer", "scribe"]);
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (retiredNames.has(path.basename(entry.name, path.extname(entry.name)))) {
          found.push(full);
        }
      }
    };
    walk(REPO_ORG_DIR);
    expect(found).toEqual([]);
  });

  it("scanOrg's registry no longer contains the retired planner/engineer/reviewer/scribe employees", () => {
    const registry = scanOrg();
    expect(registry.has("planner")).toBe(false);
    expect(registry.has("engineer")).toBe(false);
    expect(registry.has("reviewer")).toBe(false);
    expect(registry.has("scribe")).toBe(false);
  });
});
