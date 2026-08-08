import { execFile as nodeExecFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { logger } from "../shared/logger.js";
import type { RunCommandFn, ServiceProgramSpec, ServiceStatus } from "./spec.js";

const defaultRunCommand: RunCommandFn = promisify(nodeExecFile);

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderLaunchdPlist(spec: ServiceProgramSpec): string {
  const programArguments = [spec.execPath, ...spec.args]
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join("\n");
  const envEntries = Object.entries(spec.env ?? {})
    .map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`)
    .join("\n");
  const environmentBlock = envEntries
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n${envEntries}\n  </dict>\n`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(spec.label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(spec.workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
${environmentBlock}  <key>StandardOutPath</key>
  <string>${escapeXml(spec.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(spec.stderrPath)}</string>
</dict>
</plist>
`;
}

export interface PlistValidationResult {
  ok: boolean;
  errors: string[];
}

const REQUIRED_PLIST_KEYS = ["Label", "ProgramArguments", "RunAtLoad", "KeepAlive"];

export function validatePlistXml(xml: string): PlistValidationResult {
  const errors: string[] = [];

  if (!xml.trimStart().startsWith("<?xml")) errors.push("missing XML declaration");
  if (!xml.includes("<!DOCTYPE plist")) errors.push("missing plist DOCTYPE");
  if (!/<plist version="1\.0">/.test(xml)) errors.push('missing <plist version="1.0">');
  for (const key of REQUIRED_PLIST_KEYS) {
    if (!xml.includes(`<key>${key}</key>`)) errors.push(`missing required key: ${key}`);
  }
  if (!/<key>RunAtLoad<\/key>\s*<true\s*\/>/.test(xml)) errors.push("RunAtLoad must be true");

  const stack: string[] = [];
  const tagPattern = /<(\/?)([a-zA-Z][\w.-]*)\b[^>]*?(\/?)>/g;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(xml))) {
    const [, closing, name, selfClosing] = match;
    if (selfClosing) continue;
    if (closing) {
      const top = stack.pop();
      if (top !== name) {
        errors.push(`mismatched closing tag </${name}> (expected </${top ?? "nothing open"}>)`);
        break;
      }
    } else {
      stack.push(name);
    }
  }
  if (stack.length) errors.push(`unclosed tag(s): ${stack.join(", ")}`);

  return { ok: errors.length === 0, errors };
}

export interface LaunchdPaths {
  agentsDir?: string;
}

function agentsDir(paths: LaunchdPaths = {}): string {
  return paths.agentsDir ?? path.join(os.homedir(), "Library", "LaunchAgents");
}

export function launchdPlistPath(label: string, paths: LaunchdPaths = {}): string {
  return path.join(agentsDir(paths), `${label}.plist`);
}

function launchdDomainTarget(): string {
  return `gui/${os.userInfo().uid}`;
}

export function installLaunchdService(spec: ServiceProgramSpec, paths: LaunchdPaths = {}): string {
  const xml = renderLaunchdPlist(spec);
  const validation = validatePlistXml(xml);
  if (!validation.ok) {
    throw new Error(`generated launchd plist failed validation: ${validation.errors.join("; ")}`);
  }

  const plistPath = launchdPlistPath(spec.label, paths);
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.mkdirSync(path.dirname(spec.stdoutPath), { recursive: true });
  fs.writeFileSync(plistPath, xml, "utf-8");
  logger.info(`launchd: wrote service definition for ${spec.label} to ${plistPath}`);
  return plistPath;
}

export async function startLaunchdService(
  spec: ServiceProgramSpec,
  paths: LaunchdPaths = {},
  runCommand: RunCommandFn = defaultRunCommand,
): Promise<void> {
  const plistPath = launchdPlistPath(spec.label, paths);
  if (!fs.existsSync(plistPath)) {
    throw new Error(`${plistPath} does not exist — run "jinn service install" first`);
  }
  await runCommand("launchctl", ["bootstrap", launchdDomainTarget(), plistPath]);
  logger.info(`launchd: started ${spec.label}`);
}

export async function stopLaunchdService(
  spec: ServiceProgramSpec,
  runCommand: RunCommandFn = defaultRunCommand,
): Promise<void> {
  await runCommand("launchctl", ["bootout", `${launchdDomainTarget()}/${spec.label}`]);
  logger.info(`launchd: stopped ${spec.label}`);
}

export async function uninstallLaunchdService(
  spec: ServiceProgramSpec,
  paths: LaunchdPaths = {},
  runCommand: RunCommandFn = defaultRunCommand,
): Promise<void> {
  try {
    await stopLaunchdService(spec, runCommand);
  } catch {
    /* already stopped or never started */
  }
  const plistPath = launchdPlistPath(spec.label, paths);
  if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
}

export async function launchdServiceStatus(
  spec: ServiceProgramSpec,
  paths: LaunchdPaths = {},
  runCommand: RunCommandFn = defaultRunCommand,
): Promise<ServiceStatus> {
  const plistPath = launchdPlistPath(spec.label, paths);
  if (!fs.existsSync(plistPath)) return { installed: false, running: false };
  try {
    const { stdout } = await runCommand("launchctl", ["print", `${launchdDomainTarget()}/${spec.label}`]);
    return { installed: true, running: /state = running/.test(stdout), raw: stdout };
  } catch (err) {
    return { installed: true, running: false, raw: err instanceof Error ? err.message : String(err) };
  }
}
