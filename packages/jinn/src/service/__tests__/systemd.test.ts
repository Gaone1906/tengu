import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installSystemdService,
  renderSystemdUnit,
  systemdServiceStatus,
  systemdUnitName,
  systemdUnitPath,
  validateSystemdUnit,
} from "../systemd.js";
import type { ServiceProgramSpec } from "../spec.js";

const spec: ServiceProgramSpec = {
  label: "com.tengu.gateway",
  execPath: "/usr/bin/node",
  args: ["/opt/tengu/bin/jinn.js", "start"],
  workingDirectory: "/home/test/.jinn",
  env: { JINN_HOME: "/home/test/.jinn" },
  stdoutPath: "/home/test/.jinn/logs/service.stdout.log",
  stderrPath: "/home/test/.jinn/logs/service.stderr.log",
};

describe("renderSystemdUnit / validateSystemdUnit", () => {
  it("produces a unit that parses (well-formed INI sections) and lints (required keys present)", () => {
    const unit = renderSystemdUnit(spec);
    const result = validateSystemdUnit(unit);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("sets Restart=on-failure and WantedBy=default.target", () => {
    const unit = renderSystemdUnit(spec);
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("quotes an ExecStart argument that contains whitespace", () => {
    const unit = renderSystemdUnit({ ...spec, args: ["/opt/tengu bin/jinn.js", "start"] });
    expect(unit).toContain('"/opt/tengu bin/jinn.js"');
  });

  it("flags a unit missing the [Install] section", () => {
    const unit = renderSystemdUnit(spec).replace("[Install]\nWantedBy=default.target\n", "");
    const result = validateSystemdUnit(unit);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("[Install]"))).toBe(true);
  });

  it("flags Restart values other than on-failure", () => {
    const unit = renderSystemdUnit(spec).replace("Restart=on-failure", "Restart=always");
    const result = validateSystemdUnit(unit);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("Restart"))).toBe(true);
  });

  it("flags a key that appears before any section header", () => {
    const result = validateSystemdUnit("Restart=on-failure\n[Unit]\nDescription=x\n[Service]\nExecStart=x\n[Install]\nWantedBy=default.target\n");
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("before any"))).toBe(true);
  });
});

describe("systemd install/start/stop/status", () => {
  let tmpDir: string;
  let localSpec: ServiceProgramSpec;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-systemd-test-"));
    localSpec = {
      ...spec,
      workingDirectory: tmpDir,
      stdoutPath: path.join(tmpDir, "logs", "service.stdout.log"),
      stderrPath: path.join(tmpDir, "logs", "service.stderr.log"),
    };
  });

  it("derives a hyphenated unit name from the dotted label", () => {
    expect(systemdUnitName(spec)).toBe("com-tengu-gateway");
  });

  it("writes a validated unit file to the unit directory", () => {
    const unitPath = installSystemdService(localSpec, { unitDir: tmpDir });
    expect(unitPath).toBe(systemdUnitPath(localSpec, { unitDir: tmpDir }));
    expect(fs.existsSync(unitPath)).toBe(true);
    expect(validateSystemdUnit(fs.readFileSync(unitPath, "utf-8")).ok).toBe(true);
  });

  it("reports not-installed status when no unit file exists", async () => {
    const status = await systemdServiceStatus(localSpec, { unitDir: tmpDir });
    expect(status).toEqual({ installed: false, running: false });
  });

  it("reports running status from systemctl is-active", async () => {
    installSystemdService(localSpec, { unitDir: tmpDir });
    const runCommand = vi.fn(async () => ({ stdout: "active\n", stderr: "" }));
    const status = await systemdServiceStatus(localSpec, { unitDir: tmpDir }, runCommand);
    expect(status.installed).toBe(true);
    expect(status.running).toBe(true);
  });

  it("reports not-running when systemctl is-active exits non-zero", async () => {
    installSystemdService(localSpec, { unitDir: tmpDir });
    const runCommand = vi.fn(async () => {
      throw new Error("Command failed: inactive");
    });
    const status = await systemdServiceStatus(localSpec, { unitDir: tmpDir }, runCommand);
    expect(status.installed).toBe(true);
    expect(status.running).toBe(false);
  });
});
