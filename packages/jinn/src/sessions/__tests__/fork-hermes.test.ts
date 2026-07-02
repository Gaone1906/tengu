import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

let capturedSpawn: { bin: string; args: string[]; cwd: string } | null = null;
let capturedRequests: Array<{ method: string; params: Record<string, unknown> }> = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (bin: string, args: string[], opts: { cwd: string }) => {
      capturedSpawn = { bin, args, cwd: opts.cwd };
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      stdin.on("data", (b: Buffer) => {
        for (const line of b.toString().split("\n")) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown> };
          capturedRequests.push({ method: msg.method, params: msg.params ?? {} });
          const reply = (result: unknown) =>
            stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
          if (msg.method === "initialize") reply({ protocolVersion: 1 });
          else if (msg.method === "session/fork") reply({ sessionId: "hermes-fork-123" });
        }
      });
      return {
        stdin,
        stdout,
        stderr: new PassThrough(),
        pid: 12345,
        exitCode: null,
        killed: false,
        kill: vi.fn(),
        on: vi.fn(),
        once: vi.fn(),
      } as unknown as ChildProcess;
    },
  };
});

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../shared/resolve-bin.js", () => ({
  resolveBin: (name: string, override?: string) => override ?? name,
}));

import { forkEngineSession, forkHermesSession } from "../fork.js";

beforeEach(() => {
  capturedSpawn = null;
  capturedRequests = [];
  vi.clearAllMocks();
});

describe("forkHermesSession", () => {
  it("forks through Hermes ACP and returns the new Hermes session id", async () => {
    const result = await forkHermesSession("source-hermes-session", "/tmp/project");

    expect(result.engineSessionId).toBe("hermes-fork-123");
    expect(capturedSpawn).toEqual({ bin: "hermes", args: ["acp"], cwd: "/tmp/project" });
    expect(capturedRequests).toEqual([
      { method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } },
      { method: "session/fork", params: { sessionId: "source-hermes-session", cwd: "/tmp/project", mcpServers: [] } },
    ]);
  });

  it("routes hermes through forkEngineSession", async () => {
    await expect(forkEngineSession("hermes", "source-hermes-session", "/tmp/project"))
      .resolves.toEqual({ engineSessionId: "hermes-fork-123" });
  });
});
