import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";

/**
 * Todos v2 slice 4 — GOLDEN legacy byte-parity for the approval fields.
 *
 * The approval_* columns are frozen and every payload sources the legacy
 * `approval*` fields from `work_item_approvals`. These pins hold the hard
 * compatibility bar: for databases carrying pre-slice column values (simulated
 * here exactly as the backfill finds them), the compact AND detail payloads
 * must emit the SAME values the pre-slice column-backed implementation emitted
 * — plus the new additive `approvals` history on the detail payload only.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-parity-"));
process.env.JINN_HOME = tmp;

type Api = typeof import("../api.js");
type Reg = typeof import("../../sessions/registry.js");
type Store = typeof import("../../work-items/store.js");
type Approvals = typeof import("../../work-items/approvals.js");
type Migrate = typeof import("../../work-items/migrate.js");
let api: Api;
let reg: Reg;
let store: Store;
let approvals: Approvals;
let migrate: Migrate;

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    setHeader() {
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get body() {
      return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    },
  };
}

function makeReq(method: string, urlPath: string) {
  return Object.assign(Readable.from([]), {
    method,
    url: urlPath,
    headers: { host: "localhost", "content-type": "application/json" },
  }) as unknown as Parameters<Api["handleApiRequest"]>[0];
}

const ctx = {
  getConfig: () => ({ gateway: {}, engines: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  sessionManager: {
    getQueue: () => ({
      getPendingCount: () => 0,
      getTransportState: (_key: string, status: string) => status,
    }),
  },
} as unknown as import("../api.js").ApiContext;

/** The 8 legacy fields exactly as the pre-slice implementation stored them. */
interface LegacyApprovalColumns {
  approvalState: string | null;
  approvalRequest: string | null;
  approvalRef: string | null;
  approvalTarget: string | null;
  approvalTargetKind: string | null;
  approvalEscalatedAt: string | null;
  approvalDecidedBy: string | null;
  approvalDecidedAt: string | null;
}

/** Simulate a pre-slice-4 database row: write the approval COLUMNS directly
 *  (the write path no longer does), exactly what the backfill later consumes. */
function seedLegacyColumns(id: string, legacy: LegacyApprovalColumns): void {
  reg
    .initDb()
    .prepare(
      `UPDATE work_items SET approval_state = ?, approval_request = ?, approval_ref = ?, approval_target = ?,
         approval_target_kind = ?, approval_escalated_at = ?, approval_decided_by = ?, approval_decided_at = ?
       WHERE id = ?`,
    )
    .run(
      legacy.approvalState,
      legacy.approvalRequest,
      legacy.approvalRef,
      legacy.approvalTarget,
      legacy.approvalTargetKind,
      legacy.approvalEscalatedAt,
      legacy.approvalDecidedBy,
      legacy.approvalDecidedAt,
      id,
    );
}

function legacySubset(payload: Record<string, unknown>): LegacyApprovalColumns {
  return {
    approvalState: (payload.approvalState as string) ?? null,
    approvalRequest: (payload.approvalRequest as string) ?? null,
    approvalRef: (payload.approvalRef as string) ?? null,
    approvalTarget: (payload.approvalTarget as string) ?? null,
    approvalTargetKind: (payload.approvalTargetKind as string) ?? null,
    approvalEscalatedAt: (payload.approvalEscalatedAt as string) ?? null,
    approvalDecidedBy: (payload.approvalDecidedBy as string) ?? null,
    approvalDecidedAt: (payload.approvalDecidedAt as string) ?? null,
  };
}

/** Compact payloads emit 5 of the 8 legacy fields — pin that subset verbatim. */
function compactLegacySubset(payload: Record<string, unknown>): Partial<LegacyApprovalColumns> {
  return {
    approvalState: (payload.approvalState as string) ?? null,
    approvalRequest: (payload.approvalRequest as string) ?? null,
    approvalRef: (payload.approvalRef as string) ?? null,
    approvalTarget: (payload.approvalTarget as string) ?? null,
    approvalEscalatedAt: (payload.approvalEscalatedAt as string) ?? null,
  };
}

const FIXTURES: Array<{ name: string; legacy: LegacyApprovalColumns }> = [
  {
    name: "none",
    legacy: {
      approvalState: null, approvalRequest: null, approvalRef: null, approvalTarget: null,
      approvalTargetKind: null, approvalEscalatedAt: null, approvalDecidedBy: null, approvalDecidedAt: null,
    },
  },
  {
    name: "pending",
    legacy: {
      approvalState: "pending", approvalRequest: "legacy pending gate", approvalRef: "workflow-gate:def:run:g1",
      approvalTarget: "coo", approvalTargetKind: "employee", approvalEscalatedAt: null,
      approvalDecidedBy: null, approvalDecidedAt: null,
    },
  },
  {
    name: "approved",
    legacy: {
      approvalState: "approved", approvalRequest: "legacy approved gate", approvalRef: null,
      approvalTarget: "coo", approvalTargetKind: "employee", approvalEscalatedAt: null,
      approvalDecidedBy: "operator", approvalDecidedAt: "2026-07-10T10:00:00.000Z",
    },
  },
  {
    name: "rejected",
    legacy: {
      approvalState: "rejected", approvalRequest: "legacy rejected gate", approvalRef: "opaque-r",
      approvalTarget: null, approvalTargetKind: "none", approvalEscalatedAt: null,
      approvalDecidedBy: "coo", approvalDecidedAt: "2026-07-11T11:00:00.000Z",
    },
  },
  {
    name: "escalated",
    legacy: {
      approvalState: "pending", approvalRequest: "legacy escalated gate", approvalRef: null,
      approvalTarget: "aceo", approvalTargetKind: "virtual", approvalEscalatedAt: "2026-07-12T12:00:00.000Z",
      approvalDecidedBy: null, approvalDecidedAt: null,
    },
  },
];

const itemIds = new Map<string, string>();

beforeAll(async () => {
  api = await import("../api.js");
  reg = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  approvals = await import("../../work-items/approvals.js");
  migrate = await import("../../work-items/migrate.js");
  reg.initDb();
  for (const fixture of FIXTURES) {
    const item = store.createWorkItem({ title: `parity ${fixture.name}`, department: "parity-fixture" });
    seedLegacyColumns(item.id, fixture.legacy);
    itemIds.set(fixture.name, item.id);
  }
  migrate.backfillWorkItemApprovals(reg.initDb());
});

describe("legacy approval-field byte-parity across the dual-read window", () => {
  it.each(FIXTURES.map((fixture) => [fixture.name, fixture.legacy] as const))(
    "detail payload emits the exact pre-slice values for the %s fixture",
    async (name, legacy) => {
      const cap = makeRes();
      await api.handleApiRequest(makeReq("GET", `/api/work-items/${itemIds.get(name)}`), cap.res, ctx);
      expect(cap.status).toBe(200);
      expect(legacySubset(cap.body.workItem)).toEqual(legacy);
    },
  );

  it("compact list payload emits the exact pre-slice values for every fixture", async () => {
    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/work-items?department=parity-fixture&limit=100"), cap.res, ctx);
    expect(cap.status).toBe(200);
    for (const fixture of FIXTURES) {
      const row = (cap.body.workItems as Array<Record<string, unknown>>).find((item) => item.id === itemIds.get(fixture.name))!;
      expect(compactLegacySubset(row), fixture.name).toEqual(compactLegacySubset(fixture.legacy as unknown as Record<string, unknown>));
    }
  });

  it("a post-slice request emits exactly what the pre-slice implementation would have", async () => {
    const item = store.createWorkItem({ title: "parity live request", department: "parity-live" });
    approvals.requestApproval(item.id, { request: "live gate?", ref: "live-ref", target: null, actor: "operator" });
    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${item.id}`), cap.res, ctx);
    expect(legacySubset(cap.body.workItem)).toEqual({
      approvalState: "pending",
      approvalRequest: "live gate?",
      approvalRef: "live-ref",
      approvalTarget: null,
      approvalTargetKind: "none",
      approvalEscalatedAt: null,
      approvalDecidedBy: null,
      approvalDecidedAt: null,
    });
    const decided = await approvals.decideWorkItemApproval({ id: item.id, decision: "reject", note: "not yet", decidedBy: "coo" });
    expect(decided.ok).toBe(true);
    const afterDecide = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${item.id}`), afterDecide.res, ctx);
    const subset = legacySubset(afterDecide.body.workItem);
    expect(subset.approvalState).toBe("rejected");
    expect(subset.approvalRequest).toBe("live gate?");
    expect(subset.approvalRef).toBe("live-ref");
    expect(subset.approvalDecidedBy).toBe("coo");
    expect(subset.approvalDecidedAt).toBeTruthy();
  });
});

describe("additive approvals history on the detail payload", () => {
  it("detail gains `approvals` (oldest first); the compact payload does NOT", async () => {
    const item = store.createWorkItem({ title: "parity history", department: "parity-history" });
    approvals.requestApproval(item.id, { request: "round one", target: null, actor: "operator" });
    await approvals.decideWorkItemApproval({ id: item.id, decision: "reject", note: "redo", decidedBy: "coo" });
    approvals.requestApproval(item.id, { request: "round two", target: null, actor: "operator" });

    const detail = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${item.id}`), detail.res, ctx);
    const history = detail.body.approvals as Array<Record<string, unknown>>;
    expect(Array.isArray(history)).toBe(true);
    expect(history.map((row) => [row.request, row.state])).toEqual([
      ["round one", "rejected"],
      ["round two", "pending"],
    ]);
    expect(history[0].note).toBe("redo");
    expect(history[0].workItemId).toBe(item.id);

    const list = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/work-items?department=parity-history"), list.res, ctx);
    const compact = (list.body.workItems as Array<Record<string, unknown>>)[0];
    expect("approvals" in compact).toBe(false);
  });

  it("a backfilled fixture surfaces exactly one legacy history row", async () => {
    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${itemIds.get("approved")}`), cap.res, ctx);
    const history = cap.body.approvals as Array<Record<string, unknown>>;
    expect(history.length).toBe(1);
    expect(history[0]).toMatchObject({
      state: "approved",
      request: "legacy approved gate",
      requestedBy: "legacy",
      decidedBy: "operator",
      decidedAt: "2026-07-10T10:00:00.000Z",
    });
  });

  it("an item with no approval history serves an empty additive array", async () => {
    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${itemIds.get("none")}`), cap.res, ctx);
    expect(cap.body.approvals).toEqual([]);
  });
});
