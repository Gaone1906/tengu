import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-instances-home-"));
process.env.JINN_HOME = testHome;
process.env.JINN_INSTANCES_REGISTRY = path.join(testHome, "instances.json");

const { INSTANCES_REGISTRY } = await import("../../shared/paths.js");
const { loadInstances, saveInstances } = await import("../instances.js");

describe("instances registry isolation", () => {
  it("uses the explicit registry override for isolated runs", () => {
    expect(INSTANCES_REGISTRY).toBe(path.join(testHome, "instances.json"));

    saveInstances([{ name: "test", port: 8000, home: testHome, createdAt: "2026-06-24T00:00:00.000Z" }]);

    expect(fs.existsSync(path.join(testHome, "instances.json"))).toBe(true);
    const loaded = loadInstances();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      name: "test",
      port: 8000,
      home: testHome,
      createdAt: "2026-06-24T00:00:00.000Z",
    });
    expect(loaded[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
