import fs from "node:fs";
import { gatewayBaseUrl, readGatewayInfo, resolveGatewayEndpoint } from "../gateway/gateway-info.js";
import { loadConfig } from "../shared/config.js";
import { GATEWAY_INFO_FILE, JINN_HOME } from "../shared/paths.js";

interface GatewayConnection {
  port: number;
  host?: string;
  token: string;
}

function gatewayConnection(): GatewayConnection | null {
  if (!fs.existsSync(JINN_HOME)) return null;
  const info = readGatewayInfo(GATEWAY_INFO_FILE);
  let configBinding: { host?: string; port?: number } = {};
  try {
    configBinding = loadConfig().gateway;
  } catch {
    // gateway.json is enough when config.yaml is temporarily unreadable.
  }

  const token = info?.token;
  if (!token) return null;
  return { ...resolveGatewayEndpoint(info, configBinding), token };
}

export async function requestRestartFromGateway(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const connection = gatewayConnection();
  if (!connection) return false;
  const currentSessionId = process.env.JINN_SESSION_ID?.trim();

  try {
    const res = await fetchImpl(`${gatewayBaseUrl(connection)}/api/system/restart`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.token}`,
        "content-type": "application/json",
        ...(currentSessionId ? { "x-jinn-session-id": currentSessionId } : {}),
      },
      body: "{}",
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
