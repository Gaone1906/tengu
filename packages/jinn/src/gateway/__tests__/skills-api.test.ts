import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import yaml from "js-yaml";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../mcp/identity.js";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-skills-api-"));
process.env.JINN_HOME = tmpHome;

const skillName = "sample-skill";
const initialContent = "---\nname: sample-skill\ndescription: Generic sample skill.\n---\n\n# Sample\n";
const updatedContent = "---\nname: sample-skill\ndescription: Updated generic skill.\n---\n\n# Updated\n\nNew instructions.\n";
const skillsDir = path.join(tmpHome, "skills");
const skillDir = path.join(skillsDir, skillName);
const skillPath = path.join(skillDir, "SKILL.md");

fs.mkdirSync(path.join(tmpHome, "sessions"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, "org"), { recursive: true });
fs.writeFileSync(
  path.join(tmpHome, "config.yaml"),
  yaml.dump({
    gateway: {},
    engines: { default: "codex", claude: {}, codex: { bin: "codex", model: "gpt-5.5" } },
    portal: { portalName: "Portal COO", setupComplete: true },
    connectors: {},
    mcp: {},
    sessions: {},
  }),
);

type Api = typeof import("../api.js");
type Registry = typeof import("../../sessions/registry.js");

let api: Api;
let registry: Registry;
let worker: import("../../shared/types.js").Session;

const apiCtx = {
  getConfig: () => yaml.load(fs.readFileSync(path.join(tmpHome, "config.yaml"), "utf-8")),
  reloadConfig: () => {},
  reloadOrg: () => {},
  reloadConnectorInstances: async () => ({ reloaded: true }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => {},
  sessionManager: {
    getEngines: () => new Map([["codex", {}]]),
    getEngine: () => undefined,
    getQueue: () => ({
      getPendingCount: () => 0,
      getTransportState: (_key: string, status: string) => status,
    }),
  },
} as unknown as import("../api.js").ApiContext;

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    setHeader() {
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get bodyText() {
      return Buffer.concat(chunks).toString("utf-8");
    },
    get body() {
      return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    },
  };
}

async function call(method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Object.assign(Readable.from(payload), {
    method,
    url: urlPath,
    headers: { host: "localhost", "content-type": "application/json", ...headers },
    socket: { remoteAddress: "127.0.0.1" },
  });
  const cap = makeRes();
  await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, apiCtx);
  return cap;
}

function workerHeaders(): Record<string, string> {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: worker.id,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(worker.id),
  };
}

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  registry.initDb();
  worker = registry.createSession({
    engine: "codex",
    source: "web",
    sourceRef: "skills-api-worker",
    title: "Skills API worker",
    employee: "platform-worker",
  });
});

beforeEach(() => {
  fs.rmSync(skillsDir, { recursive: true, force: true });
  fs.rmSync(path.join(tmpHome, ".claude"), { recursive: true, force: true });
  fs.rmSync(path.join(tmpHome, ".agents"), { recursive: true, force: true });
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(skillPath, initialContent);
});

describe("skills API", () => {
  it("keeps list and full-content reads unchanged", async () => {
    const list = await call("GET", "/api/skills");
    expect(list.status).toBe(200);
    expect(list.body).toContainEqual({ name: skillName, description: "Generic sample skill." });

    const read = await call("GET", `/api/skills/${skillName}`);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ name: skillName, content: initialContent });
  });

  it("updates SKILL.md and immediately re-syncs engine skill links", async () => {
    const response = await call(
      "PUT",
      `/api/skills/${skillName}`,
      { content: updatedContent },
      { authorization: "Bearer test-token" },
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "updated", name: skillName, content: updatedContent });
    expect(fs.readFileSync(skillPath, "utf-8")).toBe(updatedContent);
    expect(fs.existsSync(path.join(tmpHome, ".claude", "skills", skillName))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, ".agents", "skills", skillName))).toBe(true);

    const read = await call("GET", `/api/skills/${skillName}`);
    expect(read.body).toEqual({ name: skillName, content: updatedContent });
  });

  it.each([
    ["missing frontmatter", "# Invalid\n", /frontmatter/i],
    ["missing name", "---\ndescription: Missing name.\n---\n\n# Invalid\n", /name/i],
    ["missing description", "---\nname: sample-skill\n---\n\n# Invalid\n", /description/i],
    ["mismatched name", "---\nname: another-skill\ndescription: Wrong name.\n---\n", /match/i],
  ])("rejects %s without changing the skill", async (_label, content, errorPattern) => {
    const response = await call(
      "PUT",
      `/api/skills/${skillName}`,
      { content },
      { authorization: "Bearer test-token" },
    );

    expect(response.status).toBe(400);
    expect(response.bodyText).toMatch(errorPattern);
    expect(fs.readFileSync(skillPath, "utf-8")).toBe(initialContent);
  });

  it("rejects path traversal without touching files outside the skills directory", async () => {
    const outside = path.join(tmpHome, "outside.md");
    fs.writeFileSync(outside, "unchanged");

    const response = await call(
      "PUT",
      "/api/skills/..%2Foutside",
      { content: updatedContent },
      { authorization: "Bearer test-token" },
    );

    expect(response.status).toBe(404);
    expect(fs.readFileSync(outside, "utf-8")).toBe("unchanged");
    expect(fs.readFileSync(skillPath, "utf-8")).toBe(initialContent);
  });

  it("rejects anonymous and capability-bound writes", async () => {
    const anonymous = await call("PUT", `/api/skills/${skillName}`, { content: updatedContent });
    expect(anonymous.status).toBe(403);

    const capability = await call("PUT", `/api/skills/${skillName}`, { content: updatedContent }, workerHeaders());
    expect(capability.status).toBe(403);
    expect(capability.bodyText).toMatch(/operator.*control-plane/i);
    expect(fs.readFileSync(skillPath, "utf-8")).toBe(initialContent);
  });
});
