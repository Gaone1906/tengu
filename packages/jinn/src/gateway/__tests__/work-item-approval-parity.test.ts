import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";

/**
 * Todos v2 slice 4 — GOLDEN legacy byte-parity for the approval fields.
 *
 * Every payload sources the legacy `approval*` fields from `work_item_approvals`.
 * These pins hold the hard compatibility bar: for databases whose approvals came
 * from pre-slice columns (seeded here exactly as the backfill leaves them), the
 * compact AND detail payloads must emit the SAME values the pre-slice
 * column-backed implementation emitted — plus the new additive `approvals`
 * history on the detail payload only.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-parity-"));
process.env.JINN_HOME = tmp;
const dbModule = await import("../../shared/db.js");

type Api = typeof import("../api.js");
type Store = typeof import("../../work-items/store.js");
type Approvals = typeof import("../../work-items/approvals.js");
let api: Api;
let store: Store;
let approvals: Approvals;

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

/** Simulate a pre-slice-4 database's approvals: the exact `'legacy'` row the
 *  column backfill mints, so the payloads face what a migrated home carries. */
function seedLegacyColumns(id: string, legacy: LegacyApprovalColumns): void {
  if (legacy.approvalState === null) return;
  dbModule.initDb().prepare(
    `INSERT INTO work_item_approvals (id, work_item_id, state, request, ref, target, target_kind,
       requested_by, requested_at, escalated_at, decided_by, decided_at, note)
     SELECT 'wap_' || lower(hex(randomblob(6))), w.id, @approvalState, COALESCE(@approvalRequest, ''), @approvalRef,
       @approvalTarget, @approvalTargetKind, 'legacy', COALESCE(@approvalDecidedAt, w.updated_at),
       @approvalEscalatedAt, @approvalDecidedBy, @approvalDecidedAt, NULL
     FROM work_items w WHERE w.id = @id`,
  ).run({ ...legacy, id });
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
  {
    // Review F4a: escalation and a decision COEXIST on the pre-slice columns
    // (escalate → decide never cleared escalated_at) — the current row must
    // reproduce both stamp families at once.
    name: "escalated-then-decided",
    legacy: {
      approvalState: "approved", approvalRequest: "legacy escalated then decided", approvalRef: "esc-ref",
      approvalTarget: "coo", approvalTargetKind: "employee", approvalEscalatedAt: "2026-07-13T08:00:00.000Z",
      approvalDecidedBy: "operator", approvalDecidedAt: "2026-07-13T09:00:00.000Z",
    },
  },
];

const LEGACY_DETAIL_KEYS = [
  "approvalState", "approvalRequest", "approvalRef", "approvalTarget",
  "approvalTargetKind", "approvalEscalatedAt", "approvalDecidedBy", "approvalDecidedAt",
] as const;
const LEGACY_COMPACT_KEYS = [
  "approvalState", "approvalRequest", "approvalRef", "approvalTarget", "approvalEscalatedAt",
] as const;

const itemIds = new Map<string, string>();

beforeAll(async () => {
  api = await import("../api.js");
  store = await import("../../work-items/store.js");
  approvals = await import("../../work-items/approvals.js");
  dbModule.initDb();
  for (const fixture of FIXTURES) {
    const item = store.createWorkItem({ title: `parity ${fixture.name}`, department: "parity-fixture" });
    seedLegacyColumns(item.id, fixture.legacy);
    itemIds.set(fixture.name, item.id);
  }
});

describe("legacy approval-field byte-parity, sourced from work_item_approvals", () => {
  it.each(FIXTURES.map((fixture) => [fixture.name, fixture.legacy] as const))(
    "detail payload emits the exact pre-slice values for the %s fixture",
    async (name, legacy) => {
      const cap = makeRes();
      await api.handleApiRequest(makeReq("GET", `/api/work-items/${itemIds.get(name)}`), cap.res, ctx);
      expect(cap.status).toBe(200);
      expect(legacySubset(cap.body.workItem)).toEqual(legacy);
      // Review F4b: every legacy KEY is physically present even when null —
      // no `?? null` coercion hiding an omitted field.
      for (const key of LEGACY_DETAIL_KEYS) {
        expect(Object.prototype.hasOwnProperty.call(cap.body.workItem, key), `${name}.${key} key present`).toBe(true);
      }
    },
  );

  it("compact list payload emits the exact pre-slice values (keys always present) for every fixture", async () => {
    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/work-items?department=parity-fixture&limit=100"), cap.res, ctx);
    expect(cap.status).toBe(200);
    for (const fixture of FIXTURES) {
      const row = (cap.body.workItems as Array<Record<string, unknown>>).find((item) => item.id === itemIds.get(fixture.name))!;
      expect(compactLegacySubset(row), fixture.name).toEqual(compactLegacySubset(fixture.legacy as unknown as Record<string, unknown>));
      for (const key of LEGACY_COMPACT_KEYS) {
        expect(Object.prototype.hasOwnProperty.call(row, key), `${fixture.name}.${key} key present`).toBe(true);
      }
    }
  });

  it("the LIVE escalate → decide path keeps escalatedAt and the decided stamps coexisting (review F4a)", async () => {
    const item = store.createWorkItem({ title: "parity live escalation", department: "parity-live-esc" });
    approvals.requestApproval(item.id, { request: "escalate me", target: null, actor: "operator" });
    approvals.escalateApproval(item.id, "coo", "needs the top");
    const decided = await approvals.decideWorkItemApproval({ id: item.id, decision: "approve", decidedBy: "operator" });
    expect(decided.ok).toBe(true);
    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${item.id}`), cap.res, ctx);
    const subset = legacySubset(cap.body.workItem);
    expect(subset.approvalState).toBe("approved");
    expect(subset.approvalEscalatedAt).toBeTruthy();
    expect(subset.approvalDecidedBy).toBe("operator");
    expect(subset.approvalDecidedAt).toBeTruthy();
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
