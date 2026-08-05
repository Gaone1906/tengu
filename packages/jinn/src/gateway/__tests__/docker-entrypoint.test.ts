import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const entrypoint = fileURLToPath(new URL("../../../../../docker-entrypoint.sh", import.meta.url));
const dockerConfigure = fileURLToPath(new URL("../../../../../scripts/docker-configure.mjs", import.meta.url));
const dockerfile = fileURLToPath(new URL("../../../../../Dockerfile", import.meta.url));
const composeFile = fileURLToPath(new URL("../../../../../docker-compose.yml", import.meta.url));
const serviceMarker = "__jinn_service_start__";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(): { home: string; log: string; env: NodeJS.ProcessEnv } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-entrypoint-"));
  dirs.push(root);
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(home, "config.yaml"), "gateway:\n  port: 7777\nengines:\n  default: claude\n  claude: {}\n");
  const log = path.join(root, "commands.log");
  const jinn = path.join(bin, "jinn");
  fs.writeFileSync(jinn, '#!/bin/sh\nprintf \'%s|%s\\n\' "$*" "${_JINN_CONTAINER_SERVICE_START:-}" >> "$JINN_TEST_LOG"\n');
  fs.chmodSync(jinn, 0o755);
  const node = path.join(bin, "node");
  fs.writeFileSync(node, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(node, 0o755);
  return {
    home,
    log,
    env: {
      ...process.env,
      HOME: root,
      JINN_HOME: home,
      JINN_TEST_LOG: log,
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
  it("starts the gateway only through the private default service marker", () => {
    const { env, log } = fixture();

    expect(fs.readFileSync(dockerfile, "utf-8")).toContain(`CMD ["${serviceMarker}"]`);
    expect(fs.readFileSync(composeFile, "utf-8")).toContain(`command: ["${serviceMarker}"]`);
    const result = spawnSync("/bin/sh", [entrypoint, serviceMarker], { env, encoding: "utf-8" });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(log, "utf-8")).toBe("start|1\n");
  });

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

  it("preserves a safe one-off status command and the live service records", () => {
    const { home, env, log } = fixture();
    seedRuntimeRecords(home);

    const result = spawnSync("/bin/sh", [entrypoint, "jinn", "status"], { env, encoding: "utf-8" });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(log, "utf-8")).toBe("status|\n");
    expect(fs.existsSync(path.join(home, "gateway.pid"))).toBe(true);
    expect(fs.existsSync(path.join(home, "gateway.json"))).toBe(true);
  });

  it.each(["setup", "start", "restart"])("rejects one-off jinn %s before it can touch the shared volume", (command) => {
    const { env, log } = fixture();

    const result = spawnSync("/bin/sh", [entrypoint, "jinn", command], { env, encoding: "utf-8" });

    expect(result.status).toBe(64);
    expect(result.stderr).toMatch(/service|shared.*volume|already-running/i);
    expect(fs.existsSync(log)).toBe(false);
  });
});
