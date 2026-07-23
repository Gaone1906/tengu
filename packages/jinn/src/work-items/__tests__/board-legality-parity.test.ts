import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Throwaway registry (SESSIONS_DB resolves from JINN_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-board-parity-"));
process.env.JINN_HOME = tmp;

/* Todos v2 slice 6 — SERVER PARITY for the web board's legality map.
 *
 * The board/pickers/keyboard consume packages/web/src/lib/legal-targets.ts,
 * which reads packages/web/src/lib/transition-edges.json — a hand-maintained
 * mirror of this package's transitions.ts. This suite derives the PREDICTED
 * legality from that JSON and probes the real transition() for every ordered
 * status pair under the operator surface's options ({ manual, human }), plus
 * the sticky-terminal and roll-up-gate rules. Any drift between transitions.ts
 * and the mirror fails HERE, behaviorally — the fixture can never rot silently.
 */

type Store = typeof import("../store.js");
type Transitions = typeof import("../transitions.js");
type Reg = typeof import("../../sessions/registry.js");

let store: Store;
let tr: Transitions;
let reg: Reg;

const FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
  "web/src/lib/transition-edges.json",
);

interface EdgesFixture {
  edges: Record<string, string[]>;
  manualExecutingFrom: string[];
  sticky: string[];
  closeGated: string[];
}

const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as EdgesFixture;

beforeAll(async () => {
  store = await import("../store.js");
  tr = await import("../transitions.js");
  reg = await import("../../sessions/registry.js");
  reg.initDb();
});

type Status = import("../store.js").WorkItemStatus;

const mk = (status: Status, extra: Record<string, unknown> = {}) =>
  store.createWorkItem({ title: `parity-${Math.random().toString(36).slice(2, 8)}`, status, ...extra });

/** The gateway's canonical status set, read behaviorally: tree totals are
 *  zero-filled over WORK_ITEM_STATUS_VALUES (module-private), so their keys ARE
 *  the server's status list — no backend export needed. */
function serverStatusValues(): Status[] {
  const probe = mk("backlog");
  return Object.keys(store.getWorkItemTree(probe.id)!.totals) as Status[];
}

/** What the web fixture predicts for a manual human move (ungated). */
function predictedLegal(from: string, to: string): boolean {
  if (!(fixture.edges[from] ?? []).includes(to)) return false;
  if (to === "executing" && !fixture.manualExecutingFrom.includes(from)) return false;
  return true;
}

describe("board legality fixture — structural parity", () => {
  it("covers exactly the gateway's status set", () => {
    expect(Object.keys(fixture.edges).sort()).toEqual(serverStatusValues().sort());
  });

  it("mirrors STICKY_STATUSES exactly", () => {
    expect([...fixture.sticky].sort()).toEqual([...store.STICKY_STATUSES].sort());
  });

  it("declares the close-gated targets as done + cancelled", () => {
    expect([...fixture.closeGated].sort()).toEqual(["cancelled", "done"]);
  });
});

describe("board legality — behavioral parity over every ordered pair", () => {
  it("transition() accepts exactly the pairs the web fixture predicts (manual + human, no gates)", () => {
    const statuses = serverStatusValues();
    const mismatches: string[] = [];
    for (const from of statuses) {
      for (const to of statuses) {
        if (from === to) continue; // same-status is a no-op, not an edge
        const wi = mk(from);
        let accepted = true;
        let code: string | undefined;
        try {
          tr.transition(wi.id, to, "operator", { manual: true, human: true });
        } catch (err) {
          accepted = false;
          code = err instanceof tr.TransitionError ? err.code : `unexpected:${String(err)}`;
        }
        const predicted = predictedLegal(from, to);
        if (accepted !== predicted) {
          mismatches.push(`${from} → ${to}: server ${accepted ? "accepted" : `refused (${code})`}, fixture predicts ${predicted ? "legal" : "illegal"}`);
        }
        if (!accepted && code !== "illegal-edge") {
          mismatches.push(`${from} → ${to}: refusal code ${code}, expected illegal-edge`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("sticky terminals refuse a NON-human manual move (the operator surface must send human)", () => {
    for (const from of fixture.sticky as Status[]) {
      const to = (fixture.edges[from] ?? [])[0] as Status | undefined;
      expect(to, `fixture lists no exit edge for sticky ${from}`).toBeTruthy();
      const wi = mk(from);
      expect(() => tr.transition(wi.id, to!, "operator", { manual: true })).toThrowError(/human decision/);
      let humanRequired: string | undefined;
      try {
        tr.transition(wi.id, to!, "operator", { manual: true });
      } catch (err) {
        humanRequired = err instanceof tr.TransitionError ? err.code : undefined;
      }
      expect(humanRequired).toBe("human-required");
    }
  });
});

describe("board legality — roll-up close gate parity", () => {
  it("gates every closeGated target while a child is open, with the gateway's reason", () => {
    for (const target of fixture.closeGated as Status[]) {
      const parent = mk("executing");
      const child = mk("backlog", { parentId: parent.id });
      let code: string | undefined;
      let message = "";
      try {
        tr.transition(parent.id, target, "operator", { manual: true, human: true });
      } catch (err) {
        if (err instanceof tr.TransitionError) {
          code = err.code;
          message = err.message;
        }
      }
      expect(code, `${target} must be gated while a child is open`).toBe("children-open");
      expect(message).toMatch(/still has open children/);
      expect(message).toContain(child.id);
      // Closing the child releases the gate.
      tr.transition(child.id, "cancelled", "operator", { manual: true, human: true });
      const result = tr.transition(parent.id, target, "operator", { manual: true, human: true });
      expect(result.item.status).toBe(target);
    }
  });

  it("does not gate non-close targets on a parent with open children", () => {
    const parent = mk("executing");
    mk("backlog", { parentId: parent.id });
    const result = tr.transition(parent.id, "in_review", "operator", { manual: true, human: true });
    expect(result.item.status).toBe("in_review");
  });
});
