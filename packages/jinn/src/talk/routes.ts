/**
 * Jinn Talk — HTTP route dispatcher (Phase 2).
 *
 * Single entry point `handleTalkApi(req, res, context)` for everything under
 * `/api/talk/*`. Registered from gateway/api.ts near the STT routes. Returns
 * `true` when it owns the path (so api.ts can early-return), `false` otherwise.
 *
 * The heavy lifting lives elsewhere — this file only parses the request, wires
 * `TalkDeps`, and shapes the JSON response. The live token/audio/card stream
 * goes out over the WebSocket (talk:* events) during the awaited turn; the HTTP
 * response is just the terminal ok/error.
 */
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import type { ApiContext } from "../gateway/api.js";
import { runTalkTurn, warmTalkSession } from "./agent.js";
import { createOrgBridge } from "./org-bridge.js";
import { createKokoroTts } from "./kokoro.js";
import type { OrgBridge, Tts, TalkDeps } from "./context.js";
import type { TalkTurnRequest, TalkTtsRequest } from "./protocol.js";

// ── Module-level singletons ─────────────────────────────────────────────
// Instantiated once for the gateway's lifetime. The org bridge is config-free;
// the TTS engine reads the real `talk.kokoro` config lazily on first use so it
// picks up the loaded config rather than whatever existed at import time.
const org: OrgBridge = createOrgBridge();

let tts: Tts | null = null;
function getTts(context: ApiContext): Tts {
  if (!tts) {
    const config = context.getConfig();
    tts = createKokoroTts(config.talk?.kokoro);
  }
  return tts;
}

/**
 * Dispatch any `/api/talk/*` request. Returns `true` if handled (caller should
 * early-return), `false` if the path is not a talk route.
 */
export async function handleTalkApi(
  req: HttpRequest,
  res: ServerResponse,
  context: ApiContext,
): Promise<boolean> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const method = req.method || "GET";

  if (!pathname.startsWith("/api/talk/")) return false;

  try {
    // POST /api/talk/turn — run one agent turn. Streams talk:* over WS during
    // the await; HTTP response is the terminal { ok, error }.
    if (method === "POST" && pathname === "/api/talk/turn") {
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return true; // readJsonBody already wrote the error response
      const body = parsed.body as Partial<TalkTurnRequest> | null;
      const sessionId = body?.sessionId;
      const text = body?.text;
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        badRequest(res, "sessionId is required");
        return true;
      }
      if (typeof text !== "string" || !text.trim()) {
        badRequest(res, "text is required");
        return true;
      }
      const deps: TalkDeps = {
        sessionId,
        emit: context.emit,
        org,
        tts: getTts(context),
      };
      const result = await runTalkTurn(text, deps);
      json(res, { ok: result.ok, error: result.error });
      return true;
    }

    // POST /api/talk/warm — pre-boot the agent session so the first real turn
    // is warm. Fire-and-forget; returns immediately.
    if (method === "POST" && pathname === "/api/talk/warm") {
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return true;
      const body = parsed.body as Partial<TalkTurnRequest> | null;
      const sessionId = body?.sessionId;
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        badRequest(res, "sessionId is required");
        return true;
      }
      warmTalkSession({
        sessionId,
        emit: context.emit,
        org,
        tts: getTts(context),
      });
      json(res, { ok: true });
      return true;
    }

    // GET /api/talk/status — TTS engine readiness (TalkStatusResponse-ish).
    if (method === "GET" && pathname === "/api/talk/status") {
      const s = getTts(context).status();
      json(res, {
        ttsAvailable: s.available,
        ttsDownloading: s.downloading,
        progress: s.progress,
        voice: s.voice,
        ready: s.ready,
      });
      return true;
    }

    // POST /api/talk/tts/download — kick Kokoro weight download in the
    // background (progress streams over talk:tts:download:* WS events).
    if (method === "POST" && pathname === "/api/talk/tts/download") {
      // Fire-and-forget: don't await; the watcher emits progress over WS.
      getTts(context)
        .download(context.emit)
        .catch((err) => {
          context.emit("talk:tts:download:error", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      json(res, { status: "downloading" });
      return true;
    }

    // POST /api/talk/tts — direct WAV synthesis. Not implemented in this POC:
    // audio streams over WS (talk:audio) during a /api/talk/turn instead. The
    // Tts interface exposes no synchronous synth method, so we return 501.
    if (method === "POST" && pathname === "/api/talk/tts") {
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return true;
      // Body parsed for shape-validation only; intentionally unused in the POC.
      void (parsed.body as Partial<TalkTtsRequest> | null);
      json(res, { error: "audio streams over WS in this build" }, 501);
      return true;
    }

    // Unknown /api/talk/* path — let api.ts fall through to its 404.
    return false;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    json(res, { ok: false, error }, 500);
    return true;
  }
}

// ── Local copies of api.ts response helpers ─────────────────────────────
// api.ts keeps readJsonBody/json/badRequest module-private, so we re-implement
// the same tiny contract here rather than widen api.ts's exported surface.
// (Behaviour matches: JSON 200 by default; badRequest → 400; invalid body → 400.)

async function readJsonBody(
  req: HttpRequest,
  res: ServerResponse,
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  let raw: string;
  try {
    raw = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  } catch {
    badRequest(res, "Failed to read request body");
    return { ok: false };
  }
  if (!raw.trim()) {
    badRequest(res, "Empty request body");
    return { ok: false };
  }
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    badRequest(res, "Invalid JSON in request body");
    return { ok: false };
  }
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function badRequest(res: ServerResponse, message: string): void {
  json(res, { error: message }, 400);
}
