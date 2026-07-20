import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const INSTANCE_DIRECTORY_SCHEMA_VERSION = 2 as const;

export interface InstanceAccessUrls {
  local?: string;
  remote?: string;
}

export interface Instance {
  id: string;
  name: string;
  displayName?: string;
  port: number;
  home: string;
  createdAt: string;
  kind?: "workspace" | "sandbox";
  pinned?: boolean;
  accessUrls?: InstanceAccessUrls;
}

export type InstanceInput = Omit<Instance, "id"> & { id?: string };

interface InstanceDirectoryFile {
  schemaVersion: typeof INSTANCE_DIRECTORY_SCHEMA_VERSION;
  instances: Instance[];
}

export interface HostPathOptions {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

export interface DirectoryOptions {
  registryPath?: string;
  legacyRegistryPath?: string;
}

function pathApi(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

export function resolveHostDataDir(options: HostPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const p = pathApi(platform);
  if (platform === "darwin") return p.join(home, "Library", "Application Support", "Jinn");
  if (platform === "win32") return p.join(env.APPDATA || p.join(home, "AppData", "Roaming"), "Jinn");
  return p.join(env.XDG_CONFIG_HOME || p.join(home, ".config"), "jinn");
}

export function resolveInstancesRegistryPath(options: HostPathOptions = {}): string {
  const env = options.env ?? process.env;
  return env.JINN_INSTANCES_REGISTRY || pathApi(options.platform ?? process.platform).join(
    resolveHostDataDir(options),
    "instances.json",
  );
}

export function resolveLegacyInstancesRegistryPath(options: HostPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  return pathApi(platform).join(options.home ?? os.homedir(), ".jinn", "instances.json");
}

function invalid(message: string): never {
  throw new Error(`Invalid workspace directory: ${message}`);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) invalid(`${field} must be a non-empty string`);
  return value.trim();
}

function normalizeAccessUrls(value: unknown): InstanceAccessUrls | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("accessUrls must be an object");
  const raw = value as Record<string, unknown>;
  const local = optionalString(raw.local, "accessUrls.local");
  const remote = optionalString(raw.remote, "accessUrls.remote");
  for (const candidate of [local, remote]) {
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") invalid("access URLs must use http or https");
    } catch {
      invalid("access URLs must be valid URLs");
    }
  }
  return local || remote ? { ...(local ? { local } : {}), ...(remote ? { remote } : {}) } : undefined;
}

function normalizeInstance(value: unknown): Instance {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("each instance must be an object");
  const raw = value as Record<string, unknown>;
  const name = optionalString(raw.name, "name");
  const home = optionalString(raw.home, "home");
  const createdAt = optionalString(raw.createdAt, "createdAt");
  if (!name || !home || !createdAt) invalid("name, home, and createdAt are required");
  if (!Number.isSafeInteger(raw.port) || (raw.port as number) < 1 || (raw.port as number) > 65_535) {
    invalid("port must be an integer between 1 and 65535");
  }
  if (!path.isAbsolute(home) && !path.win32.isAbsolute(home)) invalid("home must be absolute");
  const id = optionalString(raw.id, "id") ?? crypto.randomUUID();
  const displayName = optionalString(raw.displayName, "displayName");
  const kind = raw.kind;
  if (kind !== undefined && kind !== "workspace" && kind !== "sandbox") invalid("kind must be workspace or sandbox");
  if (raw.pinned !== undefined && typeof raw.pinned !== "boolean") invalid("pinned must be boolean");
  return {
    id,
    name,
    ...(displayName ? { displayName } : {}),
    port: raw.port as number,
    home,
    createdAt,
    ...(kind ? { kind } : {}),
    ...(typeof raw.pinned === "boolean" ? { pinned: raw.pinned } : {}),
    ...(raw.accessUrls === undefined ? {} : { accessUrls: normalizeAccessUrls(raw.accessUrls) }),
  };
}

function parseDirectory(contents: string): { instances: Instance[]; needsWrite: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return invalid("file is not valid JSON");
  }
  if (Array.isArray(parsed)) return { instances: parsed.map(normalizeInstance), needsWrite: true };
  if (!parsed || typeof parsed !== "object") return invalid("root must be an object");
  const raw = parsed as Record<string, unknown>;
  if (raw.schemaVersion !== INSTANCE_DIRECTORY_SCHEMA_VERSION) invalid(`unsupported schema version ${String(raw.schemaVersion)}`);
  if (!Array.isArray(raw.instances)) invalid("instances must be an array");
  const rawInstances = raw.instances as unknown[];
  const instances = rawInstances.map(normalizeInstance);
  const needsWrite = instances.some((instance, index) => {
    const original = rawInstances[index] as Record<string, unknown>;
    return original.id !== instance.id;
  });
  return { instances, needsWrite };
}

function writeDirectory(registryPath: string, instances: Instance[]): void {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true, mode: 0o700 });
  const file: InstanceDirectoryFile = { schemaVersion: INSTANCE_DIRECTORY_SCHEMA_VERSION, instances };
  const tmp = `${registryPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, registryPath);
    try { fs.chmodSync(registryPath, 0o600); } catch { /* Windows and restrictive filesystems */ }
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
  }
}

export function loadInstances(options: DirectoryOptions = {}): Instance[] {
  const registryPath = options.registryPath ?? resolveInstancesRegistryPath();
  const legacyRegistryPath = options.legacyRegistryPath ?? resolveLegacyInstancesRegistryPath();
  let source = registryPath;
  if (!fs.existsSync(source)) {
    if (!fs.existsSync(legacyRegistryPath) || path.resolve(legacyRegistryPath) === path.resolve(registryPath)) return [];
    source = legacyRegistryPath;
  }
  const parsed = parseDirectory(fs.readFileSync(source, "utf8"));
  if (source !== registryPath || parsed.needsWrite) writeDirectory(registryPath, parsed.instances);
  return parsed.instances;
}

export function saveInstances(instances: InstanceInput[], options: Pick<DirectoryOptions, "registryPath"> = {}): void {
  const normalized = instances.map(normalizeInstance);
  writeDirectory(options.registryPath ?? resolveInstancesRegistryPath(), normalized);
}

export function nextAvailablePort(instances: Pick<Instance, "port">[]): number {
  const usedPorts = new Set(instances.map((instance) => instance.port));
  let port = 7777;
  while (usedPorts.has(port)) port += 1;
  return port;
}

export function ensureDefaultInstance(): void {
  const instances = loadInstances();
  if (instances.some((instance) => instance.name === "jinn")) return;
  saveInstances([{
    name: "jinn",
    displayName: "Jinn",
    port: 7777,
    home: path.join(os.homedir(), ".jinn"),
    createdAt: new Date().toISOString(),
    kind: "workspace",
    pinned: true,
  }, ...instances]);
}

export function findInstance(name: string): Instance | undefined {
  return loadInstances().find((instance) => instance.name === name);
}
