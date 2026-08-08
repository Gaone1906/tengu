import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveJinnInstance } from "../shared/home.js";
import { JINN_HOME, LOGS_DIR } from "../shared/paths.js";
import * as launchd from "./launchd.js";
import * as systemd from "./systemd.js";
import type { ServiceProgramSpec, ServiceStatus } from "./spec.js";

export type { ServiceProgramSpec, ServiceStatus } from "./spec.js";

export type SupervisedPlatform = "darwin" | "linux";

export function assertSupervisedPlatform(platform: NodeJS.Platform = process.platform): SupervisedPlatform {
  if (platform === "darwin" || platform === "linux") return platform;
  throw new Error(
    `"jinn service" supports macOS (launchd) and Linux (systemd --user) only; this host reports "${platform}". ` +
      "Run the gateway directly with \"jinn start\" instead.",
  );
}

function resolveCliEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../bin/jinn.js"),
    path.resolve(here, "../../dist/bin/jinn.js"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

export function buildServiceProgramSpec(): ServiceProgramSpec {
  const instance = resolveJinnInstance();
  const label = instance === "jinn" ? "com.tengu.gateway" : `com.tengu.gateway.${instance}`;
  return {
    label,
    execPath: process.execPath,
    args: [resolveCliEntry(), "start"],
    workingDirectory: JINN_HOME,
    env: {
      JINN_HOME,
      ...(process.env.JINN_INSTANCE ? { JINN_INSTANCE: process.env.JINN_INSTANCE } : {}),
    },
    stdoutPath: path.join(LOGS_DIR, "service.stdout.log"),
    stderrPath: path.join(LOGS_DIR, "service.stderr.log"),
  };
}

export function installService(): string {
  const platform = assertSupervisedPlatform();
  const spec = buildServiceProgramSpec();
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  return platform === "darwin" ? launchd.installLaunchdService(spec) : systemd.installSystemdService(spec);
}

export async function startService(): Promise<void> {
  const platform = assertSupervisedPlatform();
  const spec = buildServiceProgramSpec();
  if (platform === "darwin") await launchd.startLaunchdService(spec);
  else await systemd.startSystemdService(spec);
}

export async function stopService(): Promise<void> {
  const platform = assertSupervisedPlatform();
  const spec = buildServiceProgramSpec();
  if (platform === "darwin") await launchd.stopLaunchdService(spec);
  else await systemd.stopSystemdService(spec);
}

export async function getServiceStatus(): Promise<ServiceStatus> {
  const platform = assertSupervisedPlatform();
  const spec = buildServiceProgramSpec();
  return platform === "darwin" ? launchd.launchdServiceStatus(spec) : systemd.systemdServiceStatus(spec);
}
