import { describe, it, expect } from "vitest";
import type { Employee } from "../types.js";
import { resolveSessionCwd } from "../session-cwd.js";
import { JINN_HOME } from "../paths.js";

function makeEmployee(overrides: Partial<Employee> = {}): Employee {
  return {
    name: "engineer",
    displayName: "Engineer",
    department: "specialists",
    rank: "employee",
    engine: "claude",
    model: "sonnet",
    persona: "You are an engineer.",
    ...overrides,
  };
}

describe("resolveSessionCwd", () => {
  it("falls back to JINN_HOME when no employee is passed", () => {
    expect(resolveSessionCwd()).toBe(JINN_HOME);
  });

  it("falls back to JINN_HOME for a generalist employee with no repo set", () => {
    expect(resolveSessionCwd(makeEmployee())).toBe(JINN_HOME);
  });

  it("resolves to the employee's repo when set (specialist)", () => {
    const employee = makeEmployee({ repo: "/Users/dev/repos/jinn" });
    expect(resolveSessionCwd(employee)).toBe("/Users/dev/repos/jinn");
  });

  it("resolves to a ~-relative repo path unmodified — resolution is the engine's job, not this function's", () => {
    const employee = makeEmployee({ repo: "~/repos/side-project" });
    expect(resolveSessionCwd(employee)).toBe("~/repos/side-project");
  });
});
