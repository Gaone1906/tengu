import fs from "node:fs";
import path from "node:path";
import { gatewayBaseUrl } from "../gateway/gateway-info.js";
import { resolveLocalGatewayConnection } from "../gateway/lifecycle.js";
import { PAIRING_CHALLENGE_FILE_PREFIX } from "../gateway/pairing-challenge.js";
import { JINN_HOME } from "../shared/paths.js";
import { resolveJinnInstance, pairCommandFor } from "../shared/home.js";
import { loadInstances } from "./instances.js";

export interface PairingCodeResponse {
  code: string;
  expiresAt: string;
  ttlSeconds?: number;
}

interface PairingChallengeResponse {
  challengeId: string;
  nonce: string;
  path: string;
  expiresAt: string;
  ttlSeconds?: number;
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
  return resolveLocalGatewayConnection(JINN_HOME);
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

export async function requestPairingCode(opts: {
  port: number;
  host?: string;
  jinnHome?: string;
  fetchImpl?: typeof fetch;
}): Promise<PairingCodeResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const jinnHome = opts.jinnHome ?? JINN_HOME;
  // Pairing challenges are intentionally sent to loopback even when the gateway
  // advertises a wildcard/LAN host. The route also verifies the Host header.
  const baseUrl = gatewayHttpBase(opts.port, opts.host);
  const challengeRes = await fetchImpl(`${baseUrl}/api/auth/pairing-challenges`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const challenge = await jsonOrThrow<PairingChallengeResponse>(
    challengeRes,
    `Gateway rejected pairing challenge creation (${challengeRes.status})`,
  );
  if (typeof challenge.challengeId !== "string"
    || typeof challenge.nonce !== "string"
    || typeof challenge.path !== "string") {
    throw new Error("Gateway returned an invalid pairing challenge");
  }

  const expectedPath = path.join(jinnHome, `${PAIRING_CHALLENGE_FILE_PREFIX}${challenge.challengeId}`);
  if (path.resolve(challenge.path) !== path.resolve(expectedPath)) {
    throw new Error("Gateway returned a pairing challenge path outside JINN_HOME");
  }

  let proofCreated = false;
  try {
    fs.writeFileSync(expectedPath, challenge.nonce, { encoding: "utf-8", flag: "wx", mode: 0o600 });
    proofCreated = true;
    fs.chmodSync(expectedPath, 0o600);

    const pairingRes = await fetchImpl(`${baseUrl}/api/auth/pairing-codes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: challenge.challengeId }),
    });
    return await jsonOrThrow<PairingCodeResponse>(
      pairingRes,
      `Gateway rejected pairing-code creation (${pairingRes.status})`,
    );
  } finally {
    if (proofCreated) fs.rmSync(expectedPath, { force: true });
  }
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

export function formatPairingInstructions(
  pairing: PairingCodeResponse,
  port: number,
  instance = "jinn",
): string {
  const minutes = pairing.ttlSeconds ? Math.max(1, Math.ceil(pairing.ttlSeconds / 60)) : 5;
  return [
    "Pair a browser with Jinn",
    "",
    // Always name the instance this code belongs to: a code only pairs the
    // instance that minted it, so an operator running several must see which one.
    `Instance: ${instance} (port ${port})`,
    `Code: ${pairing.code}`,
    `Expires: ${minutes} minutes, single-use`,
    "",
    "On the other device:",
    "  1. Open Jinn on the other device using your Tailscale/LAN URL.",
    "  2. When Pair This Browser appears, enter the code above.",
    "  3. After pairing, refreshes open the normal app.",
    "",
    "From the web UI, you can also create a code in Settings > Pairing.",
    `Local dashboard: http://127.0.0.1:${port}`,
  ].join("\n");
}

export function formatPairedDevices(devices: PairedDeviceResponse[]): string {
  if (devices.length === 0) {
    return [
      "Paired browsers",
      "",
      "No paired browsers yet.",
      "Create a code with jinn pair, then open Jinn from the other browser and enter it.",
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

  const instance = resolveJinnInstance();
  try {
    const pairing = await requestPairingCode({ port: info.port, host: info.host });
    if (opts.json) {
      console.log(JSON.stringify({ ...pairing, instance }, null, 2));
    } else {
      console.log(formatPairingInstructions(pairing, info.port, instance));
      // On the default instance, nudge multi-instance operators toward the -i
      // form so they don't mint a code for `.jinn` when they meant another one.
      if (instance === "jinn") {
        const others = loadInstances().filter((i) => i.name !== "jinn");
        if (others.length > 0) {
          console.log("");
          console.log(`This paired the default instance. ${others.length} other instance(s) exist.`);
          console.log("To pair a different one, name it: jinn -i <instance> pair");
        }
      }
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
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
