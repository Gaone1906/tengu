import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const entrypoint = fileURLToPath(new URL("../../../../../docker-entrypoint.sh", import.meta.url));
const dockerConfigure = fileURLToPath(new URL("../../../../../scripts/docker-configure.mjs", import.meta.url));
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(): { home: string; env: NodeJS.ProcessEnv } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-entrypoint-"));
  dirs.push(root);
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(home, "config.yaml"), "gateway:\n  port: 7777\nengines:\n  default: claude\n  claude: {}\n");
  for (const command of ["jinn", "node"]) {
    const executable = path.join(bin, command);
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(executable, 0o755);
  }
  return {
    home,
    env: {
      ...process.env,
      HOME: root,
      JINN_HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    },
  };
}

function seedRuntimeRecords(home: string): void {
  fs.writeFileSync(path.join(home, "gateway.pid"), "1\n");
  fs.writeFileSync(path.join(home, "gateway.json"), JSON.stringify({
    port: 7777,
    pid: 1,
    secret: "old-container",
    token: "preserve-this-token",
    ptyPids: [7, 9],
  }));
}

describe.skipIf(process.platform === "win32")("Docker entrypoint runtime cleanup", () => {
  it("clears stale gateway and PTY records in the container-only pre-start step", () => {
    const { home, env } = fixture();
    seedRuntimeRecords(home);

    expect(fs.readFileSync(entrypoint, "utf-8")).toContain("node /opt/jinn/scripts/docker-configure.mjs");
    const result = spawnSync(process.execPath, [dockerConfigure], { env, encoding: "utf-8" });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(home, "gateway.pid"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(home, "gateway.json"), "utf-8"))).toMatchObject({
      pid: 0,
      ptyPids: [],
      token: "preserve-this-token",
    });
  });

  it("does not clear the live service records for a one-off command", () => {
    const { home, env } = fixture();
    seedRuntimeRecords(home);

    const result = spawnSync("/bin/sh", [entrypoint, "jinn", "status"], { env, encoding: "utf-8" });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(home, "gateway.pid"))).toBe(true);
    expect(fs.existsSync(path.join(home, "gateway.json"))).toBe(true);
  });
});
