import fs from "node:fs";
import { gatewayBaseUrl } from "../gateway/gateway-info.js";
import { resolveLocalGatewayConnection } from "../gateway/lifecycle.js";
import { JINN_HOME } from "../shared/paths.js";

interface GatewayConnection {
  port: number;
  host?: string;
  token: string;
}

function gatewayConnection(): GatewayConnection | null {
  if (!fs.existsSync(JINN_HOME)) return null;
  const info = resolveLocalGatewayConnection(JINN_HOME);
  const token = info.token;
  if (!token) return null;
  return { port: info.port, host: info.host, token };
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
