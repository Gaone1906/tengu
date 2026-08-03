import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adoptLegacyModels,
  resolveSttModelsDir,
} from "../model-store.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: spawnMock,
}));

const scratch: string[] = [];
const originalModelsDir = process.env.JINN_STT_MODELS_DIR;

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-stt-model-store-"));
  scratch.push(dir);
  return dir;
}

function writeModel(dir: string, filename: string, contents: string | Uint8Array): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, filename);
  fs.writeFileSync(file, contents);
  return file;
}

afterEach(() => {
  spawnMock.mockReset();
  vi.restoreAllMocks();
  vi.resetModules();
  if (originalModelsDir === undefined) delete process.env.JINN_STT_MODELS_DIR;
  else process.env.JINN_STT_MODELS_DIR = originalModelsDir;
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("resolveSttModelsDir", () => {
  it("uses the host data directory on each supported platform", () => {
    expect(resolveSttModelsDir({ platform: "darwin", home: "/home/operator", env: {} })).toBe(
      "/home/operator/Library/Application Support/Jinn/models/whisper",
    );
    expect(resolveSttModelsDir({ platform: "linux", home: "/home/operator", env: {} })).toBe(
      "/home/operator/.config/jinn/models/whisper",
    );
    expect(resolveSttModelsDir({
      platform: "linux",
      home: "/home/operator",
      env: { XDG_CONFIG_HOME: "/config" },
    })).toBe("/config/jinn/models/whisper");
    expect(resolveSttModelsDir({
      platform: "win32",
      home: "C:\\Home",
      env: { APPDATA: "C:\\AppData" },
    })).toBe("C:\\AppData\\Jinn\\models\\whisper");
  });

  it("ignores JINN_HOME and honors the direct override", () => {
    const first = resolveSttModelsDir({
      platform: "linux",
      home: "/home/operator",
      env: { JINN_HOME: "/instances/one" },
    });
    const second = resolveSttModelsDir({
      platform: "linux",
      home: "/home/operator",
      env: { JINN_HOME: "/instances/two" },
    });

    expect(first).toBe(second);
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(resolveSttModelsDir({
        platform,
        home: "/home/operator",
        env: { JINN_STT_MODELS_DIR: "/shared/whisper" },
      })).toBe("/shared/whisper");
    }
  });
});

describe("legacy model adoption", () => {
  it("moves a legacy model into the shared directory used by getModelPath", async () => {
    const root = tempDir();
    const sharedDir = path.join(root, "shared");
    const legacyDir = path.join(process.env.JINN_HOME!, "models", "whisper");
    const filename = "ggml-small.bin";
    const legacyFile = writeModel(legacyDir, filename, "legacy model");
    process.env.JINN_STT_MODELS_DIR = sharedDir;
    const { getModelPath } = await import("../stt.js");

    const adopted = adoptLegacyModels({ sharedDir, legacyDir, filenames: [filename] });
    const sharedFile = path.join(sharedDir, filename);

    expect(adopted).toEqual([sharedFile]);
    expect(fs.existsSync(legacyFile)).toBe(false);
    expect(getModelPath("small")).toBe(sharedFile);
  });

  it("preserves an existing shared model", () => {
    const root = tempDir();
    const sharedDir = path.join(root, "shared");
    const legacyDir = path.join(root, "legacy");
    const filename = "ggml-small.bin";
    const sharedFile = writeModel(sharedDir, filename, "shared model");
    const legacyFile = writeModel(legacyDir, filename, "legacy model");

    expect(adoptLegacyModels({ sharedDir, legacyDir, filenames: [filename] })).toEqual([]);
    expect(fs.readFileSync(sharedFile, "utf8")).toBe("shared model");
    expect(fs.readFileSync(legacyFile, "utf8")).toBe("legacy model");
  });

  it("returns quietly when the legacy directory is missing or unreadable", () => {
    const root = tempDir();
    const sharedDir = path.join(root, "shared");
    const missingDir = path.join(root, "missing");

    expect(adoptLegacyModels({ sharedDir, legacyDir: missingDir, filenames: ["ggml-small.bin"] })).toEqual([]);
    vi.spyOn(fs, "readdirSync").mockImplementationOnce(() => {
      const error = new Error("permission denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    });
    expect(adoptLegacyModels({ sharedDir, legacyDir: root, filenames: ["ggml-small.bin"] })).toEqual([]);
  });

  it("copies byte-identically and unlinks the legacy file when rename crosses filesystems", () => {
    const root = tempDir();
    const sharedDir = path.join(root, "shared");
    const legacyDir = path.join(root, "legacy");
    const filename = "ggml-small.bin";
    const contents = Buffer.from([0, 1, 2, 3, 254, 255]);
    const legacyFile = writeModel(legacyDir, filename, contents);
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      const error = new Error("cross-device link") as NodeJS.ErrnoException;
      error.code = "EXDEV";
      throw error;
    });

    adoptLegacyModels({ sharedDir, legacyDir, filenames: [filename] });

    const sharedFile = path.join(sharedDir, filename);
    expect(rename).toHaveBeenCalledWith(legacyFile, sharedFile);
    expect(fs.readFileSync(sharedFile)).toEqual(contents);
    expect(fs.existsSync(legacyFile)).toBe(false);
  });
});

describe("STT model lookup and download", () => {
  it("prefers the shared copy, falls back to legacy, and rejects missing or unknown models", async () => {
    const root = tempDir();
    const sharedDir = path.join(root, "shared");
    const legacyDir = path.join(process.env.JINN_HOME!, "models", "whisper");
    process.env.JINN_STT_MODELS_DIR = sharedDir;
    const { getModelPath } = await import("../stt.js");
    const filename = "ggml-small.bin";
    const legacyFile = writeModel(legacyDir, filename, "legacy model");

    expect(getModelPath("small")).toBe(legacyFile);
    const sharedFile = writeModel(sharedDir, filename, "shared model");
    expect(getModelPath("small")).toBe(sharedFile);
    fs.unlinkSync(sharedFile);
    fs.unlinkSync(legacyFile);
    expect(getModelPath("small")).toBeNull();
    expect(getModelPath("unknown")).toBeNull();
  });

  it("downloads to a pid-unique partial file and renames only after the size check passes", async () => {
    const root = tempDir();
    const sharedDir = path.join(root, "shared");
    process.env.JINN_STT_MODELS_DIR = sharedDir;
    const { downloadModel } = await import("../stt.js");
    let partialPath = "";
    let finalExistedDuringDownload = false;
    spawnMock.mockImplementation((_command: string, args: string[]) => {
      const child = new EventEmitter();
      partialPath = args[args.indexOf("-o") + 1]!;
      const finalPath = path.join(sharedDir, "ggml-tiny.bin");
      finalExistedDuringDownload = fs.existsSync(finalPath);
      fs.mkdirSync(path.dirname(partialPath), { recursive: true });
      fs.writeFileSync(partialPath, "model");
      fs.truncateSync(partialPath, 75_000_000);
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });

    await downloadModel("tiny", () => undefined);

    const finalPath = path.join(sharedDir, "ggml-tiny.bin");
    expect(partialPath).toBe(`${finalPath}.downloading.${process.pid}`);
    expect(path.dirname(partialPath)).toBe(sharedDir);
    expect(finalExistedDuringDownload).toBe(false);
    expect(fs.existsSync(partialPath)).toBe(false);
    expect(fs.statSync(finalPath).size).toBe(75_000_000);
  });
});
