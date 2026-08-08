import { execFile as nodeExecFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { logger } from "../shared/logger.js";
import type { RunCommandFn, ServiceProgramSpec, ServiceStatus } from "./spec.js";

const defaultRunCommand: RunCommandFn = promisify(nodeExecFile);

function quoteArg(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

export function systemdUnitName(spec: ServiceProgramSpec): string {
  return spec.label.split(".").join("-");
}

export function renderSystemdUnit(spec: ServiceProgramSpec): string {
  const execStart = [spec.execPath, ...spec.args].map(quoteArg).join(" ");
  const envLines = Object.entries(spec.env ?? {}).map(([key, value]) => `Environment=${key}=${value}`);

  return [
    "[Unit]",
    "Description=Tengu gateway daemon (governed autonomous agent org, jinn fork)",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${execStart}`,
    `WorkingDirectory=${spec.workingDirectory}`,
    ...envLines,
    "Restart=on-failure",
    "RestartSec=5",
    `StandardOutput=append:${spec.stdoutPath}`,
    `StandardError=append:${spec.stderrPath}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export interface SystemdValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateSystemdUnit(unit: string): SystemdValidationResult {
  const errors: string[] = [];
  const sections = new Map<string, Map<string, string>>();
  let currentSection = "";

  for (const raw of unit.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    const sectionMatch = /^\[([A-Za-z]+)\]$/.exec(line);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      if (!sections.has(currentSection)) sections.set(currentSection, new Map());
      continue;
    }

    const eq = line.indexOf("=");
    if (eq === -1) {
      errors.push(`malformed line outside key=value form: "${line}"`);
      continue;
    }
    if (!currentSection) {
      errors.push(`key "${line.slice(0, eq)}" appears before any [Section] header`);
      continue;
    }
    sections.get(currentSection)!.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }

  for (const required of ["Unit", "Service", "Install"]) {
    if (!sections.has(required)) errors.push(`missing [${required}] section`);
  }

  const service = sections.get("Service");
  if (service) {
    if (!service.has("ExecStart")) errors.push("[Service] missing ExecStart");
    if (service.get("Restart") !== "on-failure") errors.push('[Service] Restart must be "on-failure"');
  }

  const install = sections.get("Install");
  if (install && install.get("WantedBy") !== "default.target") {
    errors.push('[Install] WantedBy must be "default.target"');
  }

  return { ok: errors.length === 0, errors };
}

export interface SystemdPaths {
  unitDir?: string;
}

function unitDir(paths: SystemdPaths = {}): string {
  return paths.unitDir ?? path.join(os.homedir(), ".config", "systemd", "user");
}

export function systemdUnitPath(spec: ServiceProgramSpec, paths: SystemdPaths = {}): string {
  return path.join(unitDir(paths), `${systemdUnitName(spec)}.service`);
}

export function installSystemdService(spec: ServiceProgramSpec, paths: SystemdPaths = {}): string {
  const unit = renderSystemdUnit(spec);
  const validation = validateSystemdUnit(unit);
  if (!validation.ok) {
    throw new Error(`generated systemd unit failed validation: ${validation.errors.join("; ")}`);
  }

  const unitPath = systemdUnitPath(spec, paths);
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  fs.mkdirSync(path.dirname(spec.stdoutPath), { recursive: true });
  fs.writeFileSync(unitPath, unit, "utf-8");
  logger.info(`systemd: wrote service definition for ${systemdUnitName(spec)} to ${unitPath}`);
  return unitPath;
}

export async function startSystemdService(
  spec: ServiceProgramSpec,
  runCommand: RunCommandFn = defaultRunCommand,
): Promise<void> {
  const name = systemdUnitName(spec);
  await runCommand("systemctl", ["--user", "daemon-reload"]);
  await runCommand("systemctl", ["--user", "enable", "--now", name]);
  logger.info(`systemd: started ${name}`);
}

export async function stopSystemdService(
  spec: ServiceProgramSpec,
  runCommand: RunCommandFn = defaultRunCommand,
): Promise<void> {
  const name = systemdUnitName(spec);
  await runCommand("systemctl", ["--user", "stop", name]);
  logger.info(`systemd: stopped ${name}`);
}

export async function uninstallSystemdService(
  spec: ServiceProgramSpec,
  paths: SystemdPaths = {},
  runCommand: RunCommandFn = defaultRunCommand,
): Promise<void> {
  const name = systemdUnitName(spec);
  try {
    await runCommand("systemctl", ["--user", "disable", "--now", name]);
  } catch {
    /* already stopped or never enabled */
  }
  const unitPath = systemdUnitPath(spec, paths);
  if (fs.existsSync(unitPath)) fs.unlinkSync(unitPath);
  await runCommand("systemctl", ["--user", "daemon-reload"]);
}

export async function systemdServiceStatus(
  spec: ServiceProgramSpec,
  paths: SystemdPaths = {},
  runCommand: RunCommandFn = defaultRunCommand,
): Promise<ServiceStatus> {
  const unitPath = systemdUnitPath(spec, paths);
  if (!fs.existsSync(unitPath)) return { installed: false, running: false };
  try {
    const { stdout } = await runCommand("systemctl", ["--user", "is-active", systemdUnitName(spec)]);
    return { installed: true, running: stdout.trim() === "active", raw: stdout.trim() };
  } catch (err) {
    return { installed: true, running: false, raw: err instanceof Error ? err.message : String(err) };
  }
}
