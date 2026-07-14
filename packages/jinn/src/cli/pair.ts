import fs from "node:fs";
import { gatewayBaseUrl, readGatewayInfo } from "../gateway/gateway-info.js";
import { loadConfig } from "../shared/config.js";
import { GATEWAY_INFO_FILE, JINN_HOME } from "../shared/paths.js";

export interface PairingSetupResponse {
  action: "create_pairing_code_in_browser";
  url: string;
  section: "Pairing";
}

export interface PairedDeviceResponse {
  id: string;
  name: string;
  kind?: string;
  createdAt?: string;
  lastSeenAt?: string;
  lastIp?: string;
  userAgent?: string;
  current?: boolean;
}

export interface UnpairDeviceResponse {
  status: "ok";
  current: boolean;
}

export function gatewayHttpBase(port: number, host?: string): string {
  return gatewayBaseUrl({ port, host });
}

interface GatewayRuntimeInfo {
  port: number;
  host?: string;
  token?: string;
}

function gatewayRuntimeInfo(): GatewayRuntimeInfo | null {
  if (!fs.existsSync(JINN_HOME)) return null;
  const info = readGatewayInfo(GATEWAY_INFO_FILE);
  let configHost: string | undefined;
  let configPort: number | undefined;
  try {
    const config = loadConfig();
    configHost = config.gateway.host;
    configPort = config.gateway.port;
  } catch {
    // gateway.json is enough for local CLI pairing when config.yaml is temporarily invalid.
  }
  const port = info?.port ?? configPort ?? 7777;
  const host = info?.host ?? configHost;
  return { port, host, token: info?.token };
}

function gatewayConnection(): { port: number; host?: string; token: string } | null {
  const info = gatewayRuntimeInfo();
  return info?.token ? { port: info.port, host: info.host, token: info.token } : null;
}

async function jsonOrThrow<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) {
    let message = fallback;
    try {
      const body = await res.json() as { error?: unknown; message?: unknown };
      if (body.error) message = String(body.error);
      else if (body.message) message = String(body.message);
    } catch {
      // keep status fallback
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export function pairingSetupResponse(port: number): PairingSetupResponse {
  return {
    action: "create_pairing_code_in_browser",
    url: `http://127.0.0.1:${port}/settings`,
    section: "Pairing",
  };
}

export async function requestPairedDevices(opts: {
  port: number;
  host?: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<PairedDeviceResponse[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${gatewayHttpBase(opts.port, opts.host)}/api/auth/devices`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${opts.token}`,
    },
  });
  const body = await jsonOrThrow<{ devices: PairedDeviceResponse[] }>(
    res,
    `Gateway rejected paired-browser listing (${res.status})`,
  );
  return body.devices;
}

export async function requestUnpairDevice(opts: {
  port: number;
  host?: string;
  token: string;
  deviceId: string;
  fetchImpl?: typeof fetch;
}): Promise<UnpairDeviceResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${gatewayHttpBase(opts.port, opts.host)}/api/auth/devices/${encodeURIComponent(opts.deviceId)}`, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${opts.token}`,
    },
  });
  return jsonOrThrow<UnpairDeviceResponse>(res, `Gateway rejected paired-browser removal (${res.status})`);
}

export function formatPairingSetupInstructions(setup: PairingSetupResponse): string {
  return [
    "Pair a browser with Jinn",
    "",
    "Pairing codes can only be created by an authenticated local browser.",
    "",
    `  1. On the gateway machine, open ${setup.url}`,
    `  2. In Settings > ${setup.section}, select "Create pairing code".`,
    "  3. On the other device, open Jinn using its Tailscale/LAN URL and enter the code.",
  ].join("\n");
}

export function formatPairedDevices(devices: PairedDeviceResponse[]): string {
  if (devices.length === 0) {
    return [
      "Paired browsers",
      "",
      "No paired browsers yet.",
      "Run jinn pair for the browser-based pairing steps.",
    ].join("\n");
  }
  const lines = ["Paired browsers", ""];
  for (const device of devices) {
    const current = device.current ? " (current)" : "";
    lines.push(`- ${device.name}${current}`);
    lines.push(`  id: ${device.id}`);
    if (device.lastSeenAt) lines.push(`  last seen: ${new Date(device.lastSeenAt).toLocaleString()}`);
    const unpairId = device.id.startsWith("-") ? `-- ${device.id}` : device.id;
    lines.push(`  unpair: jinn unpair ${unpairId}`);
  }
  return lines.join("\n");
}

export async function runPair(opts: { json?: boolean } = {}): Promise<void> {
  if (!fs.existsSync(JINN_HOME)) {
    console.error("Gateway is not set up. Run \"jinn setup\" first.");
    process.exitCode = 1;
    return;
  }
  const info = gatewayRuntimeInfo();
  if (!info) {
    console.error("Gateway location could not be determined. Run \"jinn setup\" first.");
    process.exitCode = 1;
    return;
  }

  const setup = pairingSetupResponse(info.port);
  if (opts.json) console.log(JSON.stringify(setup, null, 2));
  else console.log(formatPairingSetupInstructions(setup));
}

export async function runUnpair(deviceId?: string, opts: { json?: boolean } = {}): Promise<void> {
  const connection = gatewayConnection();
  if (!fs.existsSync(JINN_HOME)) {
    console.error("Gateway is not set up. Run \"jinn setup\" first.");
    process.exitCode = 1;
    return;
  }
  if (!connection) {
    console.error("Gateway auth token was not found. Start Jinn first, then run \"jinn unpair\".");
    process.exitCode = 1;
    return;
  }

  try {
    if (!deviceId) {
      const devices = await requestPairedDevices(connection);
      if (opts.json) console.log(JSON.stringify({ devices }, null, 2));
      else console.log(formatPairedDevices(devices));
      return;
    }
    const result = await requestUnpairDevice({ ...connection, deviceId });
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else console.log(result.current ? "Unpaired this browser." : `Unpaired ${deviceId}.`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
