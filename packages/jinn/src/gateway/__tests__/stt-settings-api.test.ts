import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import yaml from "js-yaml";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JinnConfig } from "../../shared/types.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-stt-settings-api-"));
const jinnHome = path.join(root, "instance");
const settingsPath = path.join(root, "host", "stt.json");
const modelsDir = path.join(root, "models");
process.env.JINN_HOME = jinnHome;
process.env.JINN_STT_SETTINGS = settingsPath;
process.env.JINN_STT_MODELS_DIR = modelsDir;
fs.mkdirSync(jinnHome, { recursive: true });
fs.mkdirSync(modelsDir, { recursive: true });

type Api = typeof import("../api.js");
type SettingsStore = typeof import("../../stt/settings-store.js");

let api: Api;
let settingsStore: SettingsStore;
let currentConfig: JinnConfig;
const emit = vi.fn();

function configWithoutStt(): JinnConfig {
  return {
    gateway: {},
    engines: { default: "codex", claude: {} },
    connectors: {},
    logging: { file: false, stdout: false, level: "info" },
  } as JinnConfig;
}

function writeLocalConfig(): void {
  fs.writeFileSync(path.join(jinnHome, "config.yaml"), yaml.dump(configWithoutStt()));
}

function makeResponse() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(nextStatus: number) {
      status = nextStatus;
      return this;
    },
    setHeader() {
      return this;
    },
    end(chunk?: Buffer | string) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf8");
      return raw ? JSON.parse(raw) : null;
    },
  };
}

async function call(method: string, url: string, body?: unknown) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const req = Object.assign(Readable.from(raw ? [Buffer.from(raw)] : []), {
    method,
    url,
    headers: {
      host: "localhost",
      authorization: "Bearer test-token",
      ...(raw ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)) } : {}),
    },
    socket: { remoteAddress: "127.0.0.1" },
  });
  const capture = makeResponse();
  await api.handleApiRequest(
    req as unknown as Parameters<Api["handleApiRequest"]>[0],
    capture.res,
    {
      gatewayAuthToken: "test-token",
      jinnHome,
      getConfig: () => currentConfig,
      connectors: new Map(),
      startTime: Date.now(),
      emit,
      sessionManager: {
        getEngines: () => new Map(),
        getEngine: () => undefined,
        getQueue: () => ({
          getPendingCount: () => 0,
          getTransportState: (_key: string, state: string) => state,
        }),
      },
    } as unknown as import("../api.js").ApiContext,
  );
  return capture;
}

beforeAll(async () => {
  api = await import("../api.js");
  settingsStore = await import("../../stt/settings-store.js");
});

beforeEach(() => {
  fs.rmSync(settingsPath, { force: true });
  fs.writeFileSync(path.join(modelsDir, "ggml-small.bin"), "model");
  fs.writeFileSync(path.join(modelsDir, "ggml-tiny.bin"), "model");
  writeLocalConfig();
  currentConfig = configWithoutStt();
  emit.mockClear();
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("shared STT settings API", () => {
  it("returns shared model and languages when the instance has no stt block", async () => {
    settingsStore.writeSharedSttSettings(settingsPath, {
      enabled: true,
      model: "tiny",
      languages: ["en", "bg"],
    });

    const response = await call("GET", "/api/stt/status");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      available: true,
      model: "tiny",
      languages: ["en", "bg"],
    });
  });

  it("returns defaults instead of local settings when the shared file is malformed", async () => {
    currentConfig = {
      ...configWithoutStt(),
      stt: { model: "tiny", languages: ["bg"] },
    };
    fs.writeFileSync(settingsPath, "{not-json");

    const response = await call("GET", "/api/stt/status");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ model: "small", languages: ["en"] });
  });

  it.runIf(process.platform !== "win32")("returns defaults instead of local settings when the shared file mode is 000", async () => {
    currentConfig = {
      ...configWithoutStt(),
      stt: { model: "tiny", languages: ["bg"] },
    };
    fs.writeFileSync(settingsPath, "{}", { mode: 0o000 });

    const response = await call("GET", "/api/stt/status");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ model: "small", languages: ["en"] });
  });

  it("writes languages to the shared file and exposes them on the next GET", async () => {
    settingsStore.writeSharedSttSettings(settingsPath, {
      enabled: true,
      model: "tiny",
      languages: ["en"],
    });

    const update = await call("PUT", "/api/stt/config", { languages: ["en", "bg"] });
    const nextStatus = await call("GET", "/api/stt/status");

    expect(update.status).toBe(200);
    expect(settingsStore.readSharedSttSettings(settingsPath)).toEqual({
      state: "loaded",
      settings: {
        enabled: true,
        model: "tiny",
        languages: ["en", "bg"],
      },
    });
    expect(nextStatus.body).toMatchObject({ model: "tiny", languages: ["en", "bg"] });
  });

  it("records a successful download in the shared file", async () => {
    settingsStore.writeSharedSttSettings(settingsPath, {
      model: "tiny",
      languages: ["bg"],
    });

    const response = await call("POST", "/api/stt/download", {});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "downloading", model: "tiny" });
    await vi.waitFor(() => {
      expect(settingsStore.readSharedSttSettings(settingsPath)).toEqual({
        state: "loaded",
        settings: {
          enabled: true,
          model: "tiny",
          languages: ["bg"],
        },
      });
    });
  });
});
