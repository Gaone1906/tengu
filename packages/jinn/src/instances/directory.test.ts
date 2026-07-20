import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  INSTANCE_DIRECTORY_SCHEMA_VERSION,
  loadInstances,
  resolveHostDataDir,
  resolveInstancesRegistryPath,
  saveInstances,
} from "./directory.js";

const scratch: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-instance-directory-"));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("host workspace directory paths", () => {
  it("uses Application Support on macOS", () => {
    expect(resolveHostDataDir({ platform: "darwin", home: "/home/operator", env: {} })).toBe(
      "/home/operator/Library/Application Support/Jinn",
    );
  });

  it("uses APPDATA on Windows", () => {
    expect(resolveHostDataDir({
      platform: "win32",
      home: "C:\\Users\\operator",
      env: { APPDATA: "C:\\Users\\operator\\AppData\\Roaming" },
    })).toBe("C:\\Users\\operator\\AppData\\Roaming\\Jinn");
  });

  it("uses XDG_CONFIG_HOME on Linux and respects the direct registry override", () => {
    expect(resolveHostDataDir({ platform: "linux", home: "/home/operator", env: { XDG_CONFIG_HOME: "/config" } })).toBe(
      "/config/jinn",
    );
    expect(resolveInstancesRegistryPath({
      platform: "linux",
      home: "/home/operator",
      env: { JINN_INSTANCES_REGISTRY: "/tmp/isolated.json" },
    })).toBe("/tmp/isolated.json");
  });
});

describe("workspace directory persistence", () => {
  it("imports the legacy array once, assigns immutable ids, and leaves the source intact", () => {
    const root = tempDir();
    const registryPath = path.join(root, "host", "instances.json");
    const legacyRegistryPath = path.join(root, ".jinn", "instances.json");
    fs.mkdirSync(path.dirname(legacyRegistryPath), { recursive: true });
    const legacy = [{
      name: "jinn",
      port: 7777,
      home: path.join(root, ".jinn"),
      createdAt: "2026-01-01T00:00:00.000Z",
    }];
    fs.writeFileSync(legacyRegistryPath, JSON.stringify(legacy, null, 2));

    const first = loadInstances({ registryPath, legacyRegistryPath });
    const second = loadInstances({ registryPath, legacyRegistryPath });

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject(legacy[0]);
    expect(first[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(second[0].id).toBe(first[0].id);
    expect(JSON.parse(fs.readFileSync(legacyRegistryPath, "utf8"))).toEqual(legacy);
    expect(JSON.parse(fs.readFileSync(registryPath, "utf8"))).toEqual({
      schemaVersion: INSTANCE_DIRECTORY_SCHEMA_VERSION,
      instances: first,
    });
  });

  it("upgrades an array already at the new location and writes atomically", () => {
    const root = tempDir();
    const registryPath = path.join(root, "instances.json");
    fs.writeFileSync(registryPath, JSON.stringify([{
      name: "jinn-lab",
      port: 7788,
      home: path.join(root, ".jinn-lab"),
      createdAt: "2026-01-01T00:00:00.000Z",
    }]));

    const upgraded = loadInstances({ registryPath, legacyRegistryPath: path.join(root, "missing.json") });
    saveInstances(upgraded, { registryPath });

    const stored = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    expect(stored.schemaVersion).toBe(INSTANCE_DIRECTORY_SCHEMA_VERSION);
    expect(stored.instances[0].id).toBe(upgraded[0].id);
    expect(fs.existsSync(`${registryPath}.tmp`)).toBe(false);
  });

  it("rejects malformed rows instead of silently treating corruption as an empty directory", () => {
    const root = tempDir();
    const registryPath = path.join(root, "instances.json");
    fs.writeFileSync(registryPath, JSON.stringify({ schemaVersion: 2, instances: [{ name: "bad", port: "7777" }] }));

    expect(() => loadInstances({ registryPath, legacyRegistryPath: path.join(root, "missing.json") })).toThrow(
      /invalid workspace directory/i,
    );
  });
});
