import { beforeEach, describe, expect, it } from "vitest";
import { loadTodoJournal, persistTodoJournal } from "../todo-private-state";
import { isTodoId } from "@/lib/todo-id";

const ID = "JIN-42";

describe("public company-prefixed Todo state", () => {
  beforeEach(() => sessionStorage.clear());

  it("keys recoverable draft state directly by the sole Todo id", () => {
    persistTodoJournal(ID, {
      revision: 1,
      patch: { title: "draft" },
      baseline: { title: "original" },
      baselineVersion: 7,
    });

    const raw = sessionStorage.getItem("jinn:todo-draft-journal:v2");
    expect(raw).toContain(`\"${ID}\"`);
    expect(raw).not.toMatch(/td_|salt/i);
    expect(sessionStorage.getItem("jinn:todo-tab-salt:v1")).toBeNull();
    expect(loadTodoJournal(ID)?.patch).toEqual({ title: "draft" });
  });

  it("accepts the public safe-integer AAA-N grammar", () => {
    expect(isTodoId("JIN-1")).toBe(true);
    expect(isTodoId("ICI-1")).toBe(true);
    expect(isTodoId("ACM-42")).toBe(true);
    expect(isTodoId("JIN-9007199254740991")).toBe(true);
    for (const value of ["IC-1", "ICID-1", "ici-1", "I1I-1", "JIN-0", "JIN-01", "JIN-9007199254740992", "wi_0123456789ab", " JIN-1", 1]) {
      expect(isTodoId(value)).toBe(false);
    }
  });
});
