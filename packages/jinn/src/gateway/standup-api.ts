import type { IncomingMessage, ServerResponse } from "node:http";
import { computeStandup, computeProjectStandup, type StandupWindow } from "../work-items/standup.js";

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function windowFromQuery(url: URL): StandupWindow {
  const since = url.searchParams.get("since");
  const until = url.searchParams.get("until");
  return { ...(since ? { since } : {}), ...(until ? { until } : {}) };
}

function segments(pathname: string): string[] | null {
  try {
    return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
}

/** GET /api/standup (all projects) and GET /api/standup/:rootId (one project),
 *  each accepting ?since=&until= window bounds. Same additive-module pattern as
 *  `workflow-api.ts` — one gated call from `api.ts`'s dispatcher, everything
 *  else self-contained here. */
export async function handleStandupApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = segments(url.pathname);
  if (!parts || parts[0] !== "api" || parts[1] !== "standup") return false;
  if ((req.method ?? "GET") !== "GET") {
    send(res, 405, { code: "method-not-allowed", message: "Stand-up is read-only." });
    return true;
  }
  const window = windowFromQuery(url);
  try {
    if (parts.length === 2) {
      send(res, 200, await computeStandup({ window }));
      return true;
    }
    if (parts.length === 3) {
      send(res, 200, await computeProjectStandup(parts[2], { window }));
      return true;
    }
    send(res, 404, { code: "not-found", message: "Unknown stand-up route." });
    return true;
  } catch (error) {
    send(res, 404, { code: "not-found", message: error instanceof Error ? error.message : "Stand-up computation failed." });
    return true;
  }
}
