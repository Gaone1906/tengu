import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installLaunchdService,
  launchdPlistPath,
  launchdServiceStatus,
  renderLaunchdPlist,
  startLaunchdService,
  stopLaunchdService,
  uninstallLaunchdService,
  validatePlistXml,
} from "../launchd.js";
import type { ServiceProgramSpec } from "../spec.js";

const spec: ServiceProgramSpec = {
  label: "com.tengu.gateway",
  execPath: "/usr/local/bin/node",
  args: ["/opt/tengu/bin/jinn.js", "start"],
  workingDirectory: "/Users/test/.jinn",
  env: { JINN_HOME: "/Users/test/.jinn" },
  stdoutPath: "/Users/test/.jinn/logs/service.stdout.log",
  stderrPath: "/Users/test/.jinn/logs/service.stderr.log",
};

describe("renderLaunchdPlist / validatePlistXml", () => {
  it("produces a plist that parses (balanced, well-formed XML) and lints (required keys present)", () => {
    const xml = renderLaunchdPlist(spec);
    const result = validatePlistXml(xml);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("sets RunAtLoad true and gates restart on failed exits only (KeepAlive.SuccessfulExit = false)", () => {
    const xml = renderLaunchdPlist(spec);
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\s*\/>/);
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\s*\/>\s*<\/dict>/);
  });

  it("includes every program argument and the working directory", () => {
    const xml = renderLaunchdPlist(spec);
    expect(xml).toContain("<string>/opt/tengu/bin/jinn.js</string>");
    expect(xml).toContain("<string>start</string>");
    expect(xml).toContain("<string>/Users/test/.jinn</string>");
  });

  it("XML-escapes values that contain reserved characters", () => {
    const xml = renderLaunchdPlist({ ...spec, env: { NOTE: "a & b < c" } });
    expect(xml).toContain("a &amp; b &lt; c");
    expect(xml).not.toContain("a & b < c");
  });

  it("flags a plist missing a required key", () => {
    const xml = renderLaunchdPlist(spec).replace("<key>RunAtLoad</key>", "<key>NotRunAtLoad</key>");
    const result = validatePlistXml(xml);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("RunAtLoad"))).toBe(true);
  });

  it("flags an unbalanced/mismatched plist", () => {
    const xml = renderLaunchdPlist(spec).replace("</dict>", "");
    const result = validatePlistXml(xml);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /unclosed tag/.test(e))).toBe(true);
  });
});

describe("launchd install/start/stop/status", () => {
  let tmpDir: string;
  let localSpec: ServiceProgramSpec;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-launchd-test-"));
    localSpec = {
      ...spec,
      workingDirectory: tmpDir,
      stdoutPath: path.join(tmpDir, "logs", "service.stdout.log"),
      stderrPath: path.join(tmpDir, "logs", "service.stderr.log"),
    };
  });

  it("writes a validated plist file to the agents directory", () => {
    const plistPath = installLaunchdService(localSpec, { agentsDir: tmpDir });
    expect(plistPath).toBe(launchdPlistPath(localSpec.label, { agentsDir: tmpDir }));
    expect(fs.existsSync(plistPath)).toBe(true);
    const contents = fs.readFileSync(plistPath, "utf-8");
    expect(validatePlistXml(contents).ok).toBe(true);
  });

  it("refuses to start a service that was never installed", async () => {
    await expect(startLaunchdService(localSpec, { agentsDir: tmpDir })).rejects.toThrow(/does not exist/);
  });

  it("bootstraps an installed service via launchctl", async () => {
    installLaunchdService(localSpec, { agentsDir: tmpDir });
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));
    await startLaunchdService(localSpec, { agentsDir: tmpDir }, runCommand);
    expect(runCommand).toHaveBeenCalledWith("launchctl", ["bootstrap", expect.stringContaining("gui/"), expect.stringContaining(".plist")]);
  });

  it("boots out the service on stop", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));
    await stopLaunchdService(localSpec, runCommand);
    expect(runCommand).toHaveBeenCalledWith("launchctl", ["bootout", expect.stringContaining(localSpec.label)]);
  });

  it("reports not-installed status when no plist exists", async () => {
    const status = await launchdServiceStatus(localSpec, { agentsDir: tmpDir });
    expect(status).toEqual({ installed: false, running: false });
  });

  it("reports running status parsed from launchctl print output", async () => {
    installLaunchdService(localSpec, { agentsDir: tmpDir });
    const runCommand = vi.fn(async () => ({ stdout: "state = running\n", stderr: "" }));
    const status = await launchdServiceStatus(localSpec, { agentsDir: tmpDir }, runCommand);
    expect(status.installed).toBe(true);
    expect(status.running).toBe(true);
  });

  it("removes the plist on uninstall", async () => {
    const plistPath = installLaunchdService(localSpec, { agentsDir: tmpDir });
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));
    await uninstallLaunchdService(localSpec, { agentsDir: tmpDir }, runCommand);
    expect(fs.existsSync(plistPath)).toBe(false);
  });
});
