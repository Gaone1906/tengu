import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { JinnConfig } from "../../shared/types.js";

let tmpDir: string;

vi.mock("../../shared/paths.js", () => ({
  get ORG_DIR() {
    return tmpDir;
  },
}));

vi.mock("../../shared/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  scanOrg,
  validateGeneralistCap,
  resolveMaxGeneralists,
  DEFAULT_MAX_GENERALISTS,
  GENERALIST_DEPARTMENT,
} from "../org.js";
import { logger } from "../../shared/logger.js";
import type { Employee } from "../../shared/types.js";

const warn = logger.warn as ReturnType<typeof vi.fn>;

function writeYaml(subdir: string, filename: string, content: string) {
  const dir = path.join(tmpDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content, "utf-8");
}

function generalist(name: string): Employee {
  return {
    name,
    displayName: name,
    department: GENERALIST_DEPARTMENT,
    rank: "executive",
    engine: "claude",
    model: "opus",
    persona: `${name} generalist`,
  };
}

describe("resolveMaxGeneralists", () => {
  it("defaults to 5 when config.org.maxGeneralists is unset", () => {
    expect(resolveMaxGeneralists(undefined)).toBe(DEFAULT_MAX_GENERALISTS);
    expect(resolveMaxGeneralists({} as JinnConfig)).toBe(DEFAULT_MAX_GENERALISTS);
  });

  it("falls back to the default for a non-positive configured value", () => {
    expect(resolveMaxGeneralists({ org: { maxGeneralists: 0 } } as JinnConfig)).toBe(DEFAULT_MAX_GENERALISTS);
    expect(resolveMaxGeneralists({ org: { maxGeneralists: -3 } } as JinnConfig)).toBe(DEFAULT_MAX_GENERALISTS);
  });

  it("honors an explicit positive configured value", () => {
    expect(resolveMaxGeneralists({ org: { maxGeneralists: 3 } } as JinnConfig)).toBe(3);
  });
});

describe("validateGeneralistCap", () => {
  it("accepts a roster at or under the configured max", () => {
    const config = { org: { maxGeneralists: 3 } } as JinnConfig;
    const employees = [generalist("a"), generalist("b"), generalist("c")];
    const result = validateGeneralistCap(employees, config);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(3);
    expect(result.max).toBe(3);
    expect(result.error).toBeUndefined();
  });

  it("rejects a roster exceeding the configured max", () => {
    const config = { org: { maxGeneralists: 3 } } as JinnConfig;
    const employees = [generalist("a"), generalist("b"), generalist("c"), generalist("d")];
    const result = validateGeneralistCap(employees, config);
    expect(result.ok).toBe(false);
    expect(result.count).toBe(4);
    expect(result.max).toBe(3);
    expect(result.error).toMatch(/4 generalist employee\(s\) exceed the configured max of 3/);
  });

  it("ignores non-generalist departments when counting", () => {
    const config = { org: { maxGeneralists: 1 } } as JinnConfig;
    const specialist: Employee = {
      name: "spec",
      displayName: "spec",
      department: "specialists",
      rank: "employee",
      engine: "claude",
      model: "sonnet",
      persona: "a specialist",
    };
    const result = validateGeneralistCap([generalist("a"), specialist], config);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
  });

  it("uses the default max of 5 when unconfigured", () => {
    const employees = Array.from({ length: 6 }, (_, i) => generalist(`g${i}`));
    const result = validateGeneralistCap(employees, undefined);
    expect(result.ok).toBe(false);
    expect(result.max).toBe(DEFAULT_MAX_GENERALISTS);
  });
});

describe("scanOrg — generalist cap warning", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "org-generalist-cap-"));
    warn.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not warn when the generalist roster is within the default cap", () => {
    for (const name of ["g1", "g2", "g3"]) {
      writeYaml("generalists", `${name}.yaml`, `
name: ${name}
department: ${GENERALIST_DEPARTMENT}
persona: a council generalist
`);
    }
    scanOrg();
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when a roster exceeding the configured max is scanned", () => {
    for (const name of ["g1", "g2", "g3", "g4"]) {
      writeYaml("generalists", `${name}.yaml`, `
name: ${name}
department: ${GENERALIST_DEPARTMENT}
persona: a council generalist
`);
    }
    const config = {
      engines: { default: "claude", claude: { bin: "claude", model: "sonnet" } },
      org: { maxGeneralists: 3 },
    } as unknown as JinnConfig;
    scanOrg(config);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/4 generalist employee\(s\) exceed the configured max of 3/));
  });
});
