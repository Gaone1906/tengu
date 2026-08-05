import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveHostDataDir } from "../../instances/directory.js";
import {
  readSharedSttSettings,
  resolveEffectiveSttSettings,
  resolveSttSettingsPath,
  seedSharedSttSettings,
  writeSharedSttSettings,
} from "../settings-store.js";

const scratch: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-stt-settings-"));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function withSttPaths<T>(
  root: string,
  run: (settingsPath: string) => T | Promise<T>,
): Promise<T> {
  const settingsPath = path.join(root, "host", "stt.json");
  const previousSettingsPath = process.env.JINN_STT_SETTINGS;
  const previousModelsDir = process.env.JINN_STT_MODELS_DIR;
  process.env.JINN_STT_SETTINGS = settingsPath;
  process.env.JINN_STT_MODELS_DIR = path.join(root, "models");
  vi.resetModules();
  try {
    return await run(settingsPath);
  } finally {
    if (previousSettingsPath === undefined) delete process.env.JINN_STT_SETTINGS;
    else process.env.JINN_STT_SETTINGS = previousSettingsPath;
    if (previousModelsDir === undefined) delete process.env.JINN_STT_MODELS_DIR;
    else process.env.JINN_STT_MODELS_DIR = previousModelsDir;
    vi.resetModules();
  }
}

describe("resolveSttSettingsPath", () => {
  it("uses one host-level file regardless of JINN_HOME", () => {
    const firstOptions = {
      platform: "linux" as const,
      home: "/home/operator",
      env: { JINN_HOME: "/instances/one" },
    };
    const secondOptions = {
      ...firstOptions,
      env: { JINN_HOME: "/instances/two" },
    };

    const first = resolveSttSettingsPath(firstOptions);
    const second = resolveSttSettingsPath(secondOptions);

    expect(first).toBe(`${resolveHostDataDir(firstOptions)}/stt.json`);
    expect(first).toBe(second);
    expect(first.startsWith(firstOptions.env.JINN_HOME)).toBe(false);
    expect(second.startsWith(secondOptions.env.JINN_HOME)).toBe(false);
  });

  it("honors the direct override", () => {
    expect(resolveSttSettingsPath({
      platform: "linux",
      home: "/home/operator",
      env: { JINN_STT_SETTINGS: "/shared/stt.json" },
    })).toBe("/shared/stt.json");
  });
});

describe("readSharedSttSettings", () => {
  it("keeps only valid shared fields", () => {
    const settingsPath = path.join(tempDir(), "stt.json");
    fs.writeFileSync(settingsPath, JSON.stringify({
      enabled: true,
      model: "medium",
      languages: ["en", "bg"],
      modelsDir: "/ignored",
    }));

    expect(readSharedSttSettings(settingsPath)).toEqual({
      state: "loaded",
      settings: {
        enabled: true,
        model: "medium",
        languages: ["en", "bg"],
      },
    });
  });

  it("reports missing quietly when the file does not exist", () => {
    const warn = vi.fn();

    expect(readSharedSttSettings(path.join(tempDir(), "missing.json"), warn)).toEqual({ state: "missing" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once and reports unreadable when the file is malformed", () => {
    const settingsPath = path.join(tempDir(), "stt.json");
    fs.writeFileSync(settingsPath, "{not-json");
    const warn = vi.fn();

    expect(readSharedSttSettings(settingsPath, warn)).toEqual({ state: "unreadable" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Could not read shared STT settings"));
  });

  it("warns once and reports unreadable when the body is not an object", () => {
    const settingsPath = path.join(tempDir(), "stt.json");
    fs.writeFileSync(settingsPath, "[]");
    const warn = vi.fn();

    expect(readSharedSttSettings(settingsPath, warn)).toEqual({ state: "unreadable" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("expected a JSON object"));
  });

  it.runIf(process.platform !== "win32")("warns once and reports unreadable when the file mode is 000", () => {
    const settingsPath = path.join(tempDir(), "stt.json");
    fs.writeFileSync(settingsPath, "{}", { mode: 0o000 });
    const warn = vi.fn();

    expect(readSharedSttSettings(settingsPath, warn)).toEqual({ state: "unreadable" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Could not read shared STT settings"));
  });
});

describe("seedSharedSttSettings", () => {
  it("creates the shared file with only supported local fields", () => {
    const settingsPath = path.join(tempDir(), "host", "stt.json");

    seedSharedSttSettings(settingsPath, {
      enabled: true,
      model: "small",
      language: "bg",
      modelsDir: "/ignored",
    } as { enabled: boolean; model: string; language: string; modelsDir: string });

    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual({
      enabled: true,
      model: "small",
      languages: ["bg"],
    });
  });

  it("never overwrites an existing shared file", () => {
    const settingsPath = path.join(tempDir(), "stt.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ model: "medium", languages: ["en", "bg"] }));

    seedSharedSttSettings(settingsPath, { model: "small", languages: ["en"] });

    expect(readSharedSttSettings(settingsPath)).toEqual({
      state: "loaded",
      settings: { model: "medium", languages: ["en", "bg"] },
    });
  });

  it.each([undefined, {}])("does not create a file for absent or empty local settings", (localSettings) => {
    const settingsPath = path.join(tempDir(), "host", "stt.json");

    seedSharedSttSettings(settingsPath, localSettings);

    expect(fs.existsSync(settingsPath)).toBe(false);
  });
});

describe("writeSharedSttSettings", () => {
  it("atomically replaces the shared file with owner-only permissions", () => {
    const settingsPath = path.join(tempDir(), "host", "stt.json");
    const rename = vi.spyOn(fs, "renameSync");

    writeSharedSttSettings(settingsPath, {
      enabled: true,
      model: "small",
      languages: ["en", "bg"],
      modelsDir: "/ignored",
    } as { enabled: boolean; model: string; languages: string[]; modelsDir: string });

    expect(rename).toHaveBeenCalledWith(`${settingsPath}.tmp-${process.pid}`, settingsPath);
    expect(readSharedSttSettings(settingsPath)).toEqual({
      state: "loaded",
      settings: {
        enabled: true,
        model: "small",
        languages: ["en", "bg"],
      },
    });
    expect(fs.readdirSync(path.dirname(settingsPath))).toEqual(["stt.json"]);
    if (process.platform !== "win32") expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600);
  });

  it("preserves the previous file and cleans up when rename fails", () => {
    const settingsPath = path.join(tempDir(), "stt.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ model: "medium", languages: ["en"] }));
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("rename failed");
    });

    expect(() => writeSharedSttSettings(settingsPath, { model: "small", languages: ["bg"] })).toThrow("rename failed");
    expect(readSharedSttSettings(settingsPath)).toEqual({
      state: "loaded",
      settings: { model: "medium", languages: ["en"] },
    });
    expect(fs.readdirSync(path.dirname(settingsPath))).toEqual(["stt.json"]);
  });
});

describe("resolveEffectiveSttSettings", () => {
  it("uses defaults instead of the local block when shared settings are malformed", () => {
    const settingsPath = path.join(tempDir(), "stt.json");
    fs.writeFileSync(settingsPath, "{not-json");

    expect(resolveEffectiveSttSettings(
      readSharedSttSettings(settingsPath, vi.fn()),
      { model: "tiny", languages: ["bg"] },
    )).toEqual({ model: "small", languages: ["en"] });
  });

  it.runIf(process.platform !== "win32")("uses defaults instead of the local block when shared settings are unreadable", () => {
    const settingsPath = path.join(tempDir(), "stt.json");
    fs.writeFileSync(settingsPath, "{}", { mode: 0o000 });

    expect(resolveEffectiveSttSettings(
      readSharedSttSettings(settingsPath, vi.fn()),
      { model: "tiny", languages: ["bg"] },
    )).toEqual({ model: "small", languages: ["en"] });
  });

  it("uses shared settings before the local block", () => {
    expect(resolveEffectiveSttSettings(
      { state: "loaded", settings: { enabled: false, model: "medium", languages: ["bg"] } },
      { enabled: true, model: "small", languages: ["en"] },
    )).toEqual({ enabled: false, model: "medium", languages: ["bg"] });
  });

  it("uses the local block, including the deprecated language field, when no shared file exists", () => {
    expect(resolveEffectiveSttSettings({ state: "missing" }, {
      enabled: true,
      model: "base",
      languages: [],
      language: "en",
    })).toEqual({ enabled: true, model: "base", languages: ["en"] });
  });

  it("fills missing fields from defaults rather than a lower-priority source", () => {
    expect(resolveEffectiveSttSettings(
      { state: "loaded", settings: { languages: ["bg"] } },
      { enabled: true, model: "medium", languages: ["en"] },
    )).toEqual({ model: "small", languages: ["bg"] });
  });

  it("preserves today's defaults when neither source exists", () => {
    expect(resolveEffectiveSttSettings({ state: "missing" }, undefined)).toEqual({
      model: "small",
      languages: ["en"],
    });
  });
});

describe("initStt", () => {
  it("seeds shared settings from the instance config on boot", async () => {
    const root = tempDir();
    await withSttPaths(root, async (settingsPath) => {
      const { initStt } = await import("../stt.js");

      initStt({ enabled: true, model: "small", languages: ["en", "bg"] });

      expect(readSharedSttSettings(settingsPath)).toEqual({
        state: "loaded",
        settings: {
          enabled: true,
          model: "small",
          languages: ["en", "bg"],
        },
      });
    });
  });

  it("warns but does not throw when shared settings are malformed", async () => {
    const root = tempDir();
    await withSttPaths(root, async (settingsPath) => {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, "{not-json");
      const { logger: freshLogger } = await import("../../shared/logger.js");
      const warn = vi.spyOn(freshLogger, "warn").mockImplementation(() => undefined);
      const { initStt } = await import("../stt.js");

      expect(() => initStt()).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Could not read shared STT settings"));
    });
  });

  it.runIf(process.platform !== "win32")("warns but does not throw when shared settings mode is 000", async () => {
    const root = tempDir();
    await withSttPaths(root, async (settingsPath) => {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, "{}", { mode: 0o000 });
      const { logger: freshLogger } = await import("../../shared/logger.js");
      const warn = vi.spyOn(freshLogger, "warn").mockImplementation(() => undefined);
      const { initStt } = await import("../stt.js");

      expect(() => initStt({ model: "tiny", languages: ["bg"] })).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Could not read shared STT settings"));
    });
  });
});
