import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadInstances, saveInstances, type Instance } from "./directory.js";
import { startInstance } from "./start.js";

const scratch: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(): { root: string; registryPath: string; legacyRegistryPath: string; instance: Instance } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-start-instance-"));
  scratch.push(root);
  const registryPath = path.join(root, "host", "instances.json");
  const legacyRegistryPath = path.join(root, "missing.json");
  const instance: Instance = {
    id: "offline-id",
    name: "atlas",
    displayName: "Atlas",
    port: 7801,
    home: path.join(root, ".atlas"),
    createdAt: "2026-01-01T00:00:00.000Z",
    kind: "workspace",
    pinned: true,
  };
  fs.mkdirSync(instance.home, { recursive: true });
  fs.writeFileSync(path.join(instance.home, "config.yaml"), "gateway:\n  port: 7801\n");
  saveInstances([instance], { registryPath });
  return { root, registryPath, legacyRegistryPath, instance };
}

describe("offline workspace start", () => {
  it("rejects secondary workspace start in the single-instance Docker image", async () => {
    vi.stubEnv("JINN_CONTAINER", "1");
    const { registryPath, legacyRegistryPath, instance } = fixture();
    const execFile = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(startInstance({ instance, currentPort: 7777 }, {
      registryPath,
      legacyRegistryPath,
      execFile,
      isPortAvailable: async () => true,
      waitForHealth: async () => true,
      provisionAccess: async () => ({ status: "not-detected" }),
    })).rejects.toThrow(/Docker image supports one Jinn instance/i);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("does not inherit the primary gateway binding", async () => {
    vi.stubEnv("JINN_HOST", "0.0.0.0");
    vi.stubEnv("JINN_PORT", "7777");
    const { registryPath, legacyRegistryPath, instance } = fixture();
    const execFile = vi.fn(async (
      _file: string,
      _args: string[],
      _options?: { env?: NodeJS.ProcessEnv },
    ) => ({ stdout: "", stderr: "" }));

    await startInstance({ instance, currentPort: 7777 }, {
      registryPath,
      legacyRegistryPath,
      cliEntry: "/package/dist/bin/jinn.js",
      execFile,
      isPortAvailable: async () => true,
      waitForHealth: async () => true,
      provisionAccess: async () => ({ status: "not-detected" }),
    });

    const childEnv = execFile.mock.calls[0]?.[2]?.env;
    expect(childEnv?.JINN_HOST).toBeUndefined();
    expect(childEnv?.JINN_PORT).toBeUndefined();
  });

  it("checks the port, starts the registered home, waits for health, and persists discovered remote access", async () => {
    const { registryPath, legacyRegistryPath, instance } = fixture();
    const execFile = vi.fn(async () => ({ stdout: "", stderr: "" }));

    const result = await startInstance({ instance, currentPort: 7777 }, {
      registryPath,
      legacyRegistryPath,
      cliEntry: "/package/dist/bin/jinn.js",
      execFile,
      isPortAvailable: async () => true,
      waitForHealth: async () => true,
      provisionAccess: async () => ({ status: "configured", url: "https://machine.example.ts.net:7801" }),
    });

    expect(execFile).toHaveBeenCalledWith(process.execPath, ["/package/dist/bin/jinn.js", "start", "--daemon"], {
      env: expect.objectContaining({ JINN_HOME: instance.home, JINN_INSTANCE: "atlas", JINN_NO_OPEN: "1" }),
      timeout: 30_000,
    });
    expect(result.instance.accessUrls?.remote).toBe("https://machine.example.ts.net:7801");
    expect(loadInstances({ registryPath, legacyRegistryPath })[0].accessUrls?.remote).toBe("https://machine.example.ts.net:7801");
  });

  it("refuses to launch when another process already owns the registered port", async () => {
    const { registryPath, legacyRegistryPath, instance } = fixture();
    const execFile = vi.fn();

    await expect(startInstance({ instance, currentPort: 7777 }, {
      registryPath,
      legacyRegistryPath,
      execFile,
      isPortAvailable: async () => false,
      waitForHealth: async () => true,
      provisionAccess: async () => ({ status: "not-detected" }),
    })).rejects.toThrow(/port 7801 is already in use/i);
    expect(execFile).not.toHaveBeenCalled();
  });
});
