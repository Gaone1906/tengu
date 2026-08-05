import { execFile as nodeExecFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cloneCurrentTailscaleServe, type AccessProvisionResult, type ExecFileFn } from "./access.js";
import { ensureGatewayAuthToken } from "../gateway/auth.js";
import { patchConfigFile, ConfigDocumentError } from "../shared/config-document.js";
import {
  loadInstances,
  saveInstances,
  type DirectoryOptions,
  type Instance,
} from "./directory.js";

const execFileAsync = promisify(nodeExecFile);

export interface NormalizedWorkspaceName {
  displayName: string;
  slug: string;
  instanceName: string;
  homeName: string;
}

export interface CreateInstanceInput {
  name: string;
  port?: number;
  currentPort: number;
  gatewayHost?: string;
  authRequired?: boolean;
}

export interface CreateInstanceResult {
  instance: Instance;
  warning?: string;
}

export interface CreateInstanceDependencies extends DirectoryOptions {
  homeDir?: string;
  cliEntry?: string;
  execFile?: ExecFileFn;
  isPortAvailable?: (port: number) => Promise<boolean>;
  waitForHealth?: (port: number) => Promise<boolean>;
  provisionAccess?: (options: { currentPort: number; newPort: number }) => Promise<AccessProvisionResult>;
  now?: () => Date;
}

export function assertSecondaryInstancesSupported(env: NodeJS.ProcessEnv = process.env): void {
  if (env.JINN_CONTAINER !== "1") return;
  throw new Error(
    "The Docker image supports one Jinn instance. Run each additional instance in its own container with dedicated jinn-home and jinn-claude volumes and a separately published port.",
  );
}

export function normalizeWorkspaceName(input: string): NormalizedWorkspaceName {
  const collapsed = input.trim().replace(/\s+/g, " ");
  if (!collapsed || collapsed.length > 48 || /[\\/]|\.\./.test(collapsed)) {
    throw new Error("Workspace name must be 1–48 characters and cannot contain path separators");
  }
  const withoutPrefix = collapsed.replace(/^jinn-/i, "");
  const slug = withoutPrefix
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z][a-z0-9-]*$/.test(slug) || slug === "jinn") {
    throw new Error("Workspace name must begin with a Latin letter and include a name other than Jinn");
  }
  const displayName = withoutPrefix.charAt(0).toUpperCase() + withoutPrefix.slice(1);
  return { displayName, slug, instanceName: `jinn-${slug}`, homeName: `.jinn-${slug}` };
}

export function resolveInstanceHome(selector: string, instances: Instance[], homeDir = os.homedir()): string {
  if (selector === "jinn") return path.join(homeDir, ".jinn");
  const prefixed = selector.startsWith("jinn-") ? selector : `jinn-${selector}`;
  const unprefixed = selector.replace(/^jinn-/, "");
  const registered = instances.find((instance) => (
    instance.name === selector
    || instance.name === prefixed
    || instance.name.replace(/^jinn-/, "") === unprefixed
  ));
  if (registered) return registered.home;
  return path.join(homeDir, `.${prefixed}`);
}

export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port }, () => server.close(() => resolve(true)));
  });
}

async function selectPort(
  requested: number | undefined,
  instances: Instance[],
  available: (port: number) => Promise<boolean>,
  reservedPorts: number[] = [],
): Promise<number> {
  const used = new Set([...instances.map((instance) => instance.port), ...reservedPorts]);
  if (requested !== undefined) {
    if (!Number.isSafeInteger(requested) || requested < 1 || requested > 65_535) throw new Error("Port must be between 1 and 65535");
    if (used.has(requested) || !await available(requested)) throw new Error(`Port ${requested} is already in use`);
    return requested;
  }
  for (let port = 7777; port <= 65_535; port += 1) {
    if (used.has(port)) continue;
    if (await available(port)) return port;
  }
  throw new Error("No available port could be found");
}

function resolveCliEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../bin/jinn.js"),
    path.resolve(here, "../../dist/bin/jinn.js"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function defaultExecFile(file: string, args: string[], options?: { env?: NodeJS.ProcessEnv; timeout?: number }) {
  return execFileAsync(file, args, { ...options, encoding: "utf8" }).then((result) => ({
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  }));
}

function patchWorkspaceConfig(
  home: string,
  port: number,
  displayName: string,
  network: Pick<CreateInstanceInput, "gatewayHost" | "authRequired">,
): void {
  const configPath = path.join(home, "config.yaml");
  if (!fs.existsSync(configPath)) throw new Error(`Setup did not create ${configPath}`);
  try {
    patchConfigFile(configPath, [
      { path: ["gateway", "port"], value: port },
      { path: ["gateway", "host"], value: network.gatewayHost?.trim() || undefined },
      { path: ["gateway", "authRequired"], value: network.authRequired === true ? true : undefined },
      { path: ["portal", "companyName"], value: displayName },
    ]);
  } catch (err) {
    if (err instanceof ConfigDocumentError) throw new Error(`Setup created invalid config.yaml: ${err.message}`);
    throw err;
  }
  ensureGatewayAuthToken(home);
}

function defaultWaitForHealth(port: number, host = "127.0.0.1", timeoutMs = 12_000): Promise<boolean> {
  const hostname = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const request = http.request({ hostname, port, path: "/api/status", timeout: 750 }, (response) => {
        response.resume();
        if (response.statusCode === 200) return resolve(true);
        retry();
      });
      const retry = () => {
        request.destroy();
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(attempt, 200).unref?.();
      };
      request.once("error", retry);
      request.once("timeout", retry);
      request.end();
    };
    attempt();
  });
}

export async function createInstance(
  input: CreateInstanceInput,
  dependencies: CreateInstanceDependencies = {},
): Promise<CreateInstanceResult> {
  assertSecondaryInstancesSupported();
  const naming = normalizeWorkspaceName(input.name);
  const homeDir = dependencies.homeDir ?? os.homedir();
  const home = path.join(homeDir, naming.homeName);
  const instances = loadInstances(dependencies);
  if (instances.some((instance) => instance.name === naming.instanceName)) {
    throw new Error(`Workspace "${naming.displayName}" already exists`);
  }
  if (fs.existsSync(home)) throw new Error(`Workspace directory ${home} already exists`);
  const port = await selectPort(
    input.port,
    instances,
    dependencies.isPortAvailable ?? isPortAvailable,
    [input.currentPort],
  );
  const execFile = dependencies.execFile ?? defaultExecFile;
  const cliEntry = dependencies.cliEntry ?? resolveCliEntry();
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    JINN_HOME: home,
    JINN_INSTANCE: naming.instanceName,
    JINN_SETUP_NAME: naming.displayName,
    JINN_NO_OPEN: "1",
  };
  // JINN_HOST/JINN_PORT name THIS gateway's binding — compose sets JINN_PORT for the
  // whole service — and the child is a different instance on a port just allocated for
  // it. Inherited, it starts on ours instead, fails the port-ownership check, and the
  // rollback below deletes the workspace it had just created.
  delete childEnv.JINN_HOST;
  delete childEnv.JINN_PORT;

  try {
    await execFile(process.execPath, [cliEntry, "setup"], { env: childEnv, timeout: 120_000 });
    patchWorkspaceConfig(home, port, naming.displayName, input);
  } catch (error) {
    if (fs.existsSync(home)) fs.rmSync(home, { recursive: true, force: true });
    throw error;
  }

  let instance: Instance = {
    id: crypto.randomUUID(),
    name: naming.instanceName,
    displayName: naming.displayName,
    port,
    home,
    createdAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    kind: "workspace",
    pinned: true,
  };
  saveInstances([...instances, instance], dependencies);

  try {
    await execFile(process.execPath, [cliEntry, "start", "--daemon"], { env: childEnv, timeout: 30_000 });
  } catch (error) {
    saveInstances(instances, dependencies);
    fs.rmSync(home, { recursive: true, force: true });
    throw error;
  }
  const healthy = dependencies.waitForHealth
    ? await dependencies.waitForHealth(port)
    : await defaultWaitForHealth(port, input.gatewayHost);
  if (!healthy) throw new Error(`Workspace was created but did not become healthy on port ${port}`);

  const provision = await (dependencies.provisionAccess ?? ((options) => cloneCurrentTailscaleServe(options)))({
    currentPort: input.currentPort,
    newPort: port,
  });
  if (provision.status === "configured") {
    instance = { ...instance, accessUrls: { remote: provision.url } };
    saveInstances([...instances, instance], dependencies);
  }
  return {
    instance,
    ...(provision.status === "failed" ? { warning: provision.warning } : {}),
  };
}
