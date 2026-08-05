import { getStatus, resolveLocalGatewayConnection } from "../gateway/lifecycle.js";
import { gatewayBaseUrl } from "../gateway/gateway-info.js";
import { JINN_HOME, PID_FILE } from "../shared/paths.js";
import fs from "node:fs";

export async function runStatus(): Promise<void> {
  if (!fs.existsSync(JINN_HOME)) {
    console.log("Gateway is not set up. Run \"jinn setup\" first.");
    return;
  }

  const status = getStatus();

  if (!status.running) {
    console.log("Gateway: stopped");
    if (status.pid) {
      console.log(`  Stale PID file found (PID ${status.pid}). Process is not alive.`);
    }
    return;
  }

  console.log("Gateway: running");
  console.log(`  PID: ${status.pid}`);

  // Try to get uptime from PID file mtime
  try {
    const stat = fs.statSync(PID_FILE);
    const uptimeMs = Date.now() - stat.mtimeMs;
    const uptimeSec = Math.floor(uptimeMs / 1000);
    const hours = Math.floor(uptimeSec / 3600);
    const minutes = Math.floor((uptimeSec % 3600) / 60);
    const seconds = uptimeSec % 60;
    console.log(`  Uptime: ${hours}h ${minutes}m ${seconds}s`);
  } catch {
    // ignore
  }

  // Try to get live stats from the gateway. gatewayBaseUrl rather than concatenation
  // because gateway.host is a BIND address: 0.0.0.0 is routine there and does not
  // connect on macOS or Windows.
  const endpoint = resolveLocalGatewayConnection(JINN_HOME);
  try {
    const res = await fetch(`${gatewayBaseUrl(endpoint)}/api/status`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      console.log(`  Port: ${endpoint.port}`);
      if (data.sessions !== undefined) {
        if (typeof data.sessions === "object" && data.sessions && !Array.isArray(data.sessions)) {
          const s = data.sessions as { total?: number; active?: number; running?: number };
          const total = s.total ?? 0;
          const active = s.active ?? 0;
          const running = s.running ?? 0;
          console.log(`  Active sessions: ${active} (running: ${running}, total: ${total})`);
        } else {
          console.log(`  Active sessions: ${data.sessions}`);
        }
      }
      if (data.uptime !== undefined) {
        console.log(`  Server uptime: ${data.uptime}s`);
      }
    }
  } catch {
    // Gateway not responding to HTTP, that's fine
    console.log(`  Port: ${endpoint.port} (not responding to HTTP)`);
  }
}
