import { describe, it, expect } from "vitest";
import { gatewayRequest, JinnMcpToolError, type JinnMcpContext } from "../toolkit.js";
import {
  ACTIVITY_OPERATION_HEADER,
  ACTIVITY_TOOL_HEADER,
} from "../identity.js";

/**
 * GRS-015-fix — transport failure modes of the shared gateway client (Codex
 * findings 2 + 3): a wedged gateway must time out with a structured error, and a
 * fetch-level failure (ECONNREFUSED, socket reset mid-upload) must reach the agent
 * with route/method/gateway context — never as a bare "fetch failed".
 */

describe("gatewayRequest — transport failure modes", () => {
  it("forwards activity correlation only for a bound Session MCP operation", async () => {
    let headers: Record<string, string> = {};
    const fetchFn = (async (_input: string | URL, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return { status: 200, text: async () => '{"activityReceiptId":"todo:wi_release"}' } as unknown as Response;
    }) as unknown as typeof fetch;
    const ctx: JinnMcpContext = {
      gatewayUrl: "http://x",
      callerSessionId: "session-1",
      sessionCapability: "signed-capability",
      activityOperation: { id: "2ce1c337-0f11-4d19-a2ac-4130ce738455", toolName: "update_work_item" },
      fetchFn,
    };

    await gatewayRequest(ctx, "POST", "/api/work-items/wi_release/status", { status: "in_review" });

    expect(headers[ACTIVITY_OPERATION_HEADER]).toBe(ctx.activityOperation?.id);
    expect(headers[ACTIVITY_TOOL_HEADER]).toBe("update_work_item");
  });

  it.each([
    [{ activityOperation: { id: "forged", toolName: "update_work_item" } }, "unbound"],
    [{ callerSessionId: "session-1", activityOperation: { id: "forged", toolName: "update_work_item" } }, "missing capability"],
    [{ sessionCapability: "cap", activityOperation: { id: "forged", toolName: "update_work_item" } }, "missing session"],
  ])("does not forward forged activity headers from %s context", async (extra, _label) => {
    let headers: Record<string, string> = {};
    const fetchFn = (async (_input: string | URL, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return { status: 200, text: async () => "{}" } as unknown as Response;
    }) as unknown as typeof fetch;
    await gatewayRequest({ gatewayUrl: "http://x", fetchFn, ...extra } as JinnMcpContext, "POST", "/api/work-items", {});
    expect(headers[ACTIVITY_OPERATION_HEADER]).toBeUndefined();
    expect(headers[ACTIVITY_TOOL_HEADER]).toBeUndefined();
  });

  it("times out a wedged gateway with a structured error naming route, budget, and gateway URL", async () => {
    const never = (() => new Promise<never>(() => {})) as unknown as typeof fetch;
    const ctx: JinnMcpContext = { gatewayUrl: "http://127.0.0.1:7797", fetchFn: never, timeoutMs: 50 };
    const err = await gatewayRequest(ctx, "GET", "/api/workflows").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(JinnMcpToolError);
    expect((err as Error).message).toMatch(/GET \/api\/workflows timed out after 50ms/);
    expect((err as Error).message).toContain("http://127.0.0.1:7797");
    expect((err as Error).message).toMatch(/retry/i);
  });

  it("aborts the underlying request on timeout (real fetch implementations clean up)", async () => {
    let seenSignal: AbortSignal | undefined;
    const never = (async (_input: string | URL, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      return new Promise<never>(() => {});
    }) as unknown as typeof fetch;
    const ctx: JinnMcpContext = { gatewayUrl: "http://x", fetchFn: never, timeoutMs: 30 };
    await expect(gatewayRequest(ctx, "GET", "/api/org")).rejects.toThrow(/timed out/);
    expect(seenSignal?.aborted).toBe(true);
  });

  it("a stalled response BODY also times out (headers arrived, text never settles)", async () => {
    const stalledBody = (async () => ({
      status: 200,
      text: () => new Promise<never>(() => {}),
    })) as unknown as typeof fetch;
    const ctx: JinnMcpContext = { gatewayUrl: "http://x", fetchFn: stalledBody, timeoutMs: 50 };
    await expect(gatewayRequest(ctx, "POST", "/api/workflows", {})).rejects.toThrow(/timed out after 50ms/);
  });

  it("wraps fetch rejections with method/route/gateway context — never a bare 'fetch failed'", async () => {
    const refused = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const ctx: JinnMcpContext = { gatewayUrl: "http://127.0.0.1:1", fetchFn: refused };
    const err = await gatewayRequest(ctx, "POST", "/api/workflows", { id: "x" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(JinnMcpToolError);
    const msg = (err as Error).message;
    expect(msg).toContain("POST /api/workflows");
    expect(msg).toContain("http://127.0.0.1:1");
    expect(msg).toMatch(/could not reach|check that it is running/i);
    expect(msg).toContain("fetch failed"); // the cause is preserved, with context around it
  });

  it("does not time out a healthy fast request (timer cleared, result passthrough)", async () => {
    const quick = (async () => ({ status: 200, text: async () => '{"ok":true}' })) as unknown as typeof fetch;
    const ctx: JinnMcpContext = { gatewayUrl: "http://x", fetchFn: quick, timeoutMs: 5000 };
    const { status, body } = await gatewayRequest(ctx, "GET", "/api/org");
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
  });
});
