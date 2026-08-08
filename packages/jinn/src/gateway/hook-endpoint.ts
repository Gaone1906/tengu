import { timingSafeEqual } from "node:crypto";
import type { HookRegistry, HookPayload } from "./hook-registry.js";
import { evaluateCommandPolicy, evaluateWritePolicy } from "../shared/command-policy.js";
import { ensureRestorePoint } from "../security/restore-points.js";
import { recordSecurityBlock } from "../security/audit.js";

const WRITE_TOOL_NAMES = new Set(["Write", "Edit", "NotebookEdit"]);

function writeTargetPath(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const key = toolName === "NotebookEdit" ? "notebook_path" : "file_path";
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export interface HookEndpointCtx {
  reg: HookRegistry;
  secret: string;
  remoteAddress: string | undefined;
}

/**
 * True if `addr` is a loopback address. Normalizes before comparing: lowercase,
 * strips the IPv4-mapped `::ffff:` prefix, and accepts `::1` plus the whole
 * 127.0.0.0/8 range (not just 127.0.0.1).
 */
export function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  let a = addr.trim().toLowerCase();
  if (a.startsWith("::ffff:")) a = a.slice("::ffff:".length);
  if (a === "::1") return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  return m !== null && m.slice(1).every((o) => Number(o) <= 255);
}

export function handleHookPost(
  ctx: HookEndpointCtx,
  providedSecret: string | undefined,
  body: { jinnSessionId?: string; hook?: HookPayload },
): { status: number; body: string } {
  const rejected = validateHookPost(ctx, providedSecret, body);
  if (rejected) return rejected;
  ctx.reg.deliver(body.jinnSessionId!, body.hook!);
  return { status: 200, body: "ok" };
}

/** Authenticate and validate a hook without delivering it. The API route uses
 * this seam to classify an authenticated target before HookRegistry effects;
 * handleHookPost keeps its standalone validate-and-deliver contract. */
export function validateHookPost(
  ctx: HookEndpointCtx,
  providedSecret: string | undefined,
  body: { jinnSessionId?: string; hook?: HookPayload },
): { status: number; body: string } | undefined {
  // Loopback check first — defense-in-depth alongside any upstream check.
  if (!isLoopback(ctx.remoteAddress)) {
    return { status: 403, body: "forbidden" };
  }
  // Defense-in-depth: an empty server secret would allow any client (including one
  // sending no header) to pass timingSafeEqual against an empty buffer. The daemon
  // guards against this upstream in api.ts, but make the endpoint safe standalone.
  if (!ctx.secret || ctx.secret.length === 0) {
    return { status: 401, body: "unauthorized" };
  }
  const a = Buffer.from(providedSecret ?? "", "utf-8");
  const b = Buffer.from(ctx.secret, "utf-8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { status: 403, body: "forbidden" };
  }
  if (!body.jinnSessionId || !body.hook?.hook_event_name) {
    return { status: 400, body: "bad request" };
  }
  const toolName = body.hook.tool_name;
  if (body.hook.hook_event_name === "PreToolUse" && toolName && (toolName === "Bash" || WRITE_TOOL_NAMES.has(toolName))) {
    const input = body.hook.tool_input;
    const cwd = body.hook.cwd;
    if (cwd) {
      try {
        ensureRestorePoint(cwd, body.jinnSessionId!);
      } catch {
        // Best-effort: a restore point is recovery insurance, not a gate — never block on its failure.
      }
    }
    const decision = toolName === "Bash"
      ? evaluateCommandPolicy(
          input && typeof input === "object" && "command" in input
            ? String((input as { command?: unknown }).command ?? "")
            : "",
          cwd,
        )
      : (() => {
          const filePath = writeTargetPath(toolName, input);
          return filePath ? evaluateWritePolicy(filePath, cwd) : { action: "allow" as const };
        })();
    if (decision.action === "block") {
      recordSecurityBlock({
        jinnSessionId: body.jinnSessionId!,
        toolName,
        reason: decision.reason || "Blocked by Jinn security policy",
        cwd,
      });
      return { status: 451, body: decision.reason || "Command blocked by Jinn security policy" };
    }
  }
  return undefined;
}
