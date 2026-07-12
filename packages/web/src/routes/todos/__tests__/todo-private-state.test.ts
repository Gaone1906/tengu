import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  clearTodoJournal,
  loadTodoJournal,
  persistTodoJournal,
  todoPrivateRef,
  transitionTodoJournal,
} from "../todo-private-state"

const JOURNAL_KEY = "jinn:todo-draft-journal:v2"
const SALT_KEY = "jinn:todo-tab-salt:v1"
const TODO_ID = "wi_private_journal_42"
const UUID = "123e4567-e89b-42d3-a456-426614174000"
const patch = { title: "Operator-authored wi_reference stays", assignee: null }
const baseline = { title: "Original", assignee: "owner" }

function request(state: "prepared" | "dispatched" | "uncertain" | "failed" | "conflict") {
  return {
    revision: 2,
    patch,
    expectedVersion: 7,
    idempotencyKey: UUID,
    state,
  }
}

function payload(state: "prepared" | "dispatched" | "uncertain" | "failed" | "conflict" = "prepared") {
  return {
    revision: 2,
    patch,
    baseline,
    baselineVersion: 7,
    request: request(state),
  }
}

function rawJournals(): Record<string, {
  expiresAt: number
  sequence: number
  payload: Record<string, unknown>
}> {
  return JSON.parse(sessionStorage.getItem(JOURNAL_KEY) ?? "{}")
}

function writeEnvelope(id: string, storedPayload: Record<string, unknown>): void {
  sessionStorage.setItem(JOURNAL_KEY, JSON.stringify({
    [todoPrivateRef(id)]: {
      expiresAt: Date.now() + 60_000,
      sequence: 1,
      payload: storedPayload,
    },
  }))
}

describe("Todo private CAS journal", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    sessionStorage.clear()
  })

  it("persists one immutable request fingerprint before dispatch", () => {
    const prepared = payload()

    persistTodoJournal(TODO_ID, prepared as never)

    expect(loadTodoJournal(TODO_ID)?.request).toEqual(prepared.request)
    expect(loadTodoJournal(TODO_ID)).toEqual(prepared)
  })

  it("persists conflict provenance independently of request lifecycle", () => {
    const conflicted = { ...payload("dispatched"), conflictFields: ["title"] as const }
    persistTodoJournal(TODO_ID, conflicted as never)
    persistTodoJournal(TODO_ID, payload("failed") as never)

    expect(loadTodoJournal(TODO_ID)?.conflictFields).toEqual(["title"])
    expect(loadTodoJournal(TODO_ID)?.request?.state).toBe("failed")
  })

  it.each([
    ["duplicate", ["title", "title"]],
    ["unsupported", ["rank"]],
    ["not dirty", ["body"]],
    ["empty", []],
  ])("rejects %s conflict provenance", (_label, conflictFields) => {
    persistTodoJournal(TODO_ID, { ...payload(), conflictFields } as never)
    expect(loadTodoJournal(TODO_ID)).toBeNull()
  })

  it("reports journal cleanup failure and succeeds after storage recovers", () => {
    persistTodoJournal(TODO_ID, payload() as never)
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "QuotaExceededError")
    })
    expect(clearTodoJournal(TODO_ID)).toBe(false)
    expect(loadTodoJournal(TODO_ID)).not.toBeNull()
    remove.mockRestore()
    expect(clearTodoJournal(TODO_ID)).toBe(true)
    expect(loadTodoJournal(TODO_ID)).toBeNull()
  })

  it.each(["prepared", "dispatched", "uncertain", "failed", "conflict"] as const)(
    "reloads the exact request in the %s state",
    (state) => {
      persistTodoJournal(TODO_ID, payload(state) as never)

      expect(loadTodoJournal(TODO_ID)?.request).toEqual(request(state))
    },
  )

  it("blocks a different logical request until the active request is explicitly cleared", () => {
    persistTodoJournal(TODO_ID, payload("prepared") as never)
    persistTodoJournal(TODO_ID, payload("dispatched") as never)
    persistTodoJournal(TODO_ID, {
      revision: 3,
      patch: { ...patch, priority: 2 },
      baseline: { ...baseline, priority: 1 },
      baselineVersion: 8,
      request: {
        ...request("prepared"),
        revision: 3,
        patch: { ...patch, priority: 2 },
        expectedVersion: 8,
        idempotencyKey: "987e6543-e21b-42d3-a456-426614174999",
      },
    } as never)

    expect(loadTodoJournal(TODO_ID)).toEqual(payload("dispatched"))
  })

  it.each([
    ["idempotency key", { idempotencyKey: "987e6543-e21b-42d3-a456-426614174999" }, 7],
    ["expected version", { expectedVersion: 8 }, 8],
    ["sent patch", { patch: { title: "Different sent title", assignee: null } }, 7],
    ["request revision", { revision: 3 }, 7],
  ] as const)("independently blocks replacement of the active request %s", (_label, replacement, baselineVersion) => {
    persistTodoJournal(TODO_ID, payload("dispatched") as never)
    persistTodoJournal(TODO_ID, {
      revision: 3,
      patch: { ...patch, priority: 2 },
      baseline: { ...baseline, priority: 1 },
      baselineVersion,
      request: { ...request("prepared"), ...replacement },
    } as never)

    expect(loadTodoJournal(TODO_ID)).toEqual(payload("dispatched"))
  })

  it("blocks a lower-revision request-less writer while an active request exists", () => {
    persistTodoJournal(TODO_ID, payload("dispatched") as never)
    persistTodoJournal(TODO_ID, {
      revision: 1,
      patch: { title: "Stale desired title" },
      baseline: { title: "Stale baseline title" },
      baselineVersion: 7,
    })

    expect(loadTodoJournal(TODO_ID)).toEqual(payload("dispatched"))
  })

  it("blocks a lower-revision writer carrying a different active request", () => {
    const active = {
      revision: 1,
      patch: { title: "B" },
      expectedVersion: 7,
      idempotencyKey: UUID,
      state: "dispatched" as const,
    }
    const current = {
      revision: 2,
      patch: { title: "C" },
      baseline: { title: "A" },
      baselineVersion: 7,
      request: active,
    }
    persistTodoJournal(TODO_ID, current as never)
    persistTodoJournal(TODO_ID, {
      revision: 1,
      patch: { title: "Other sent value" },
      baseline: { title: "A" },
      baselineVersion: 7,
      request: {
        ...active,
        patch: { title: "Other sent value" },
        idempotencyKey: "987e6543-e21b-42d3-a456-426614174999",
        state: "uncertain",
      },
    } as never)

    expect(loadTodoJournal(TODO_ID)).toEqual(current)
  })

  it("keeps the exact active request while late same-field and unrelated edits survive reload", () => {
    const active = {
      revision: 1,
      patch: { title: "B" },
      expectedVersion: 7,
      idempotencyKey: UUID,
      state: "dispatched" as const,
    }
    persistTodoJournal(TODO_ID, {
      revision: 1,
      patch: { title: "B" },
      baseline: { title: "A" },
      baselineVersion: 7,
      request: active,
    } as never)
    persistTodoJournal(TODO_ID, {
      revision: 2,
      patch: { title: "C", priority: 2 },
      baseline: { title: "A", priority: 1 },
      baselineVersion: 7,
      request: { ...active, state: "uncertain" },
      uncertainFields: ["title"],
    } as never)

    expect(loadTodoJournal(TODO_ID)).toEqual({
      revision: 2,
      patch: { title: "C", priority: 2 },
      baseline: { title: "A", priority: 1 },
      baselineVersion: 7,
      request: { ...active, state: "uncertain" },
      uncertainFields: ["title"],
    })
  })

  it("retains a same-field revert as latest intent while its active request remains uncertain", () => {
    const active = {
      revision: 1,
      patch: { title: "B" },
      expectedVersion: 7,
      idempotencyKey: UUID,
      state: "uncertain" as const,
    }

    persistTodoJournal(TODO_ID, {
      revision: 2,
      patch: { title: "A" },
      baseline: { title: "A" },
      baselineVersion: 7,
      uncertainFields: ["title"],
      request: active,
    } as never)

    expect(loadTodoJournal(TODO_ID)?.patch).toEqual({ title: "A" })
    expect(loadTodoJournal(TODO_ID)?.request?.patch).toEqual({ title: "B" })
    expect(loadTodoJournal(TODO_ID)?.uncertainFields).toEqual(["title"])
  })

  it("persists transport uncertainty without requiring a new local edit revision", () => {
    const active = {
      revision: 1,
      patch: { title: "B" },
      expectedVersion: 7,
      idempotencyKey: UUID,
    }
    const desired = {
      revision: 1,
      patch: { title: "B" },
      baseline: { title: "A" },
      baselineVersion: 7,
    }
    persistTodoJournal(TODO_ID, {
      ...desired,
      request: { ...active, state: "dispatched" },
    } as never)

    persistTodoJournal(TODO_ID, {
      ...desired,
      uncertainFields: ["title"],
      request: { ...active, state: "uncertain" },
    } as never)

    expect(loadTodoJournal(TODO_ID)?.uncertainFields).toEqual(["title"])
    expect(loadTodoJournal(TODO_ID)?.request?.state).toBe("uncertain")
  })

  it("applies delayed uncertainty for the same request without replacing newer desired intent", () => {
    const active = {
      revision: 1,
      patch: { title: "B" },
      expectedVersion: 7,
      idempotencyKey: UUID,
    }
    persistTodoJournal(TODO_ID, {
      revision: 2,
      patch: { title: "C", priority: 2 },
      baseline: { title: "A", priority: 1 },
      baselineVersion: 7,
      request: { ...active, state: "dispatched" },
    } as never)

    persistTodoJournal(TODO_ID, {
      revision: 1,
      patch: { title: "B" },
      baseline: { title: "A" },
      baselineVersion: 7,
      uncertainFields: ["title"],
      request: { ...active, state: "uncertain" },
    } as never)

    expect(loadTodoJournal(TODO_ID)).toEqual({
      revision: 2,
      patch: { title: "C", priority: 2 },
      baseline: { title: "A", priority: 1 },
      baselineVersion: 7,
      uncertainFields: ["title"],
      request: { ...active, state: "uncertain" },
    })
  })

  it.each([
    ["prepared", "dispatched"],
    ["prepared", "uncertain"],
    ["prepared", "failed"],
    ["prepared", "conflict"],
    ["dispatched", "uncertain"],
    ["dispatched", "failed"],
    ["dispatched", "conflict"],
    ["uncertain", "uncertain"],
    ["uncertain", "conflict"],
    ["conflict", "conflict"],
    ["failed", "dispatched"],
  ] as const)("allows the safe active-request transition %s -> %s", (current, next) => {
    persistTodoJournal(TODO_ID, payload(current) as never)
    persistTodoJournal(TODO_ID, payload(next) as never)

    expect(loadTodoJournal(TODO_ID)?.request?.state).toBe(next)
  })

  it.each([
    ["uncertain", "prepared"],
    ["uncertain", "dispatched"],
    ["uncertain", "failed"],
    ["conflict", "prepared"],
    ["conflict", "dispatched"],
    ["conflict", "failed"],
  ] as const)("keeps %s while accepting newer desired intent from a stale %s write", (current, stale) => {
    const active = {
      revision: 1,
      patch: { title: "B" },
      expectedVersion: 7,
      idempotencyKey: UUID,
    }
    persistTodoJournal(TODO_ID, {
      revision: 2,
      patch: { title: "C" },
      baseline: { title: "A" },
      baselineVersion: 7,
      request: { ...active, state: current },
    } as never)
    persistTodoJournal(TODO_ID, {
      revision: 3,
      patch: { title: "D", priority: 2 },
      baseline: { title: "A", priority: 1 },
      baselineVersion: 7,
      request: { ...active, state: stale },
    } as never)

    expect(loadTodoJournal(TODO_ID)).toMatchObject({
      revision: 3,
      patch: { title: "D", priority: 2 },
      request: { ...active, state: current },
    })
  })

  it.each([
    ["missing key", { ...request("prepared"), idempotencyKey: undefined }],
    ["non-UUID key", { ...request("prepared"), idempotencyKey: "request-2" }],
    ["string CAS version", { ...request("prepared"), expectedVersion: "7" }],
    ["unsafe CAS version", { ...request("prepared"), expectedVersion: Number.MAX_SAFE_INTEGER + 1 }],
    ["zero request revision", { ...request("prepared"), revision: 0 }],
    ["future request revision", { ...request("prepared"), revision: 3 }],
    ["unsupported state", { ...request("prepared"), state: "saved" }],
  ])("rejects a request with %s", (_label, malformedRequest) => {
    persistTodoJournal(TODO_ID, { ...payload(), request: malformedRequest } as never)

    expect(loadTodoJournal(TODO_ID)).toBeNull()
    expect(sessionStorage.getItem(JOURNAL_KEY)).toBeNull()
  })

  it.each([
    ["unsupported field", { rank: 10 }, { rank: 1 }],
    ["wrong title type", { title: 12 }, { title: "Original" }],
    ["wrong nullable type", { assignee: 12 }, { assignee: null }],
    ["non-finite priority", { priority: Number.POSITIVE_INFINITY }, { priority: 1 }],
    ["non-minimal baseline", { title: "Desired" }, { title: "Original", body: "extra" }],
  ])("rejects %s in dirty patch persistence", (_label, dirtyPatch, dirtyBaseline) => {
    const malformed = {
      ...payload(),
      patch: dirtyPatch,
      baseline: dirtyBaseline,
      request: { ...request("prepared"), patch: dirtyPatch },
    }

    persistTodoJournal(TODO_ID, malformed as never)

    expect(loadTodoJournal(TODO_ID)).toBeNull()
  })

  it("rejects a stored request whose active fields are missing from latest patch and baseline", () => {
    persistTodoJournal(TODO_ID, payload() as never)
    const journals = rawJournals()
    const ref = todoPrivateRef(TODO_ID)
    journals[ref].payload.request = {
      ...request("prepared"),
      patch: { title: patch.title, assignee: null, body: "sent" },
    }
    sessionStorage.setItem(JOURNAL_KEY, JSON.stringify(journals))

    expect(loadTodoJournal(TODO_ID)).toBeNull()
    expect(sessionStorage.getItem(JOURNAL_KEY)).toBeNull()
  })

  it.each([undefined, 8, "7"])("rejects active request baseline version %s that does not exactly match expectedVersion", (baselineVersion) => {
    persistTodoJournal(TODO_ID, { ...payload(), baselineVersion } as never)

    expect(loadTodoJournal(TODO_ID)).toBeNull()
  })

  it("accepts a modern request-less dirty draft with a positive numeric baseline version", () => {
    const modern = {
      revision: 3,
      patch: { title: "Modern desired title" },
      baseline: { title: "Modern baseline title" },
      baselineVersion: 9,
    }

    persistTodoJournal(TODO_ID, modern)

    expect(loadTodoJournal(TODO_ID)).toEqual(modern)
    expect(loadTodoJournal(TODO_ID)?.request).toBeUndefined()
  })

  it("recovers a valid legacy v2 payload without inventing a CAS request from updatedAt", () => {
    const legacy = {
      revision: 2,
      patch: { title: "Legacy draft" },
      baseline: { title: "Legacy original" },
      baselineVersion: "2026-07-12T08:00:00.000Z",
    }
    writeEnvelope(TODO_ID, legacy)

    expect(loadTodoJournal(TODO_ID)).toEqual(legacy)
    expect(loadTodoJournal(TODO_ID)?.request).toBeUndefined()
  })

  it("rejects flattened request metadata that could be confused with a legacy payload", () => {
    writeEnvelope(TODO_ID, {
      revision: 2,
      patch: { title: "Legacy draft" },
      baseline: { title: "Legacy original" },
      baselineVersion: "2026-07-12T08:00:00.000Z",
      expectedVersion: 7,
      idempotencyKey: UUID,
      state: "prepared",
    })

    expect(loadTodoJournal(TODO_ID)).toBeNull()
  })

  it("drops expired and malformed orphan entries during reload", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-12T08:00:00.000Z"))
    persistTodoJournal(TODO_ID, payload() as never)
    const journals = rawJournals()
    const validRef = todoPrivateRef(TODO_ID)
    journals[validRef].expiresAt = Date.now() - 1
    journals.wi_leaked_orphan = {
      expiresAt: Date.now() + 60_000,
      sequence: 2,
      payload: { id: TODO_ID },
    }
    sessionStorage.setItem(JOURNAL_KEY, JSON.stringify(journals))

    expect(loadTodoJournal(TODO_ID)).toBeNull()
    expect(sessionStorage.getItem(JOURNAL_KEY)).toBeNull()
  })

  it("keeps exactly the 50 newest journals without exposing the internal Todo id", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-12T08:00:00.000Z"))
    for (let index = 0; index < 51; index += 1) {
      const id = `wi_private_cap_${index}`
      const title = `Draft ${index}`
      persistTodoJournal(id, {
        revision: 1,
        patch: { title },
        baseline: { title: "Original" },
        baselineVersion: 1,
        request: {
          revision: 1,
          patch: { title },
          expectedVersion: 1,
          idempotencyKey: `123e4567-e89b-42d3-a456-42661417${index.toString().padStart(4, "0")}`,
          state: "prepared",
        },
      } as never)
    }

    expect(Object.keys(rawJournals())).toHaveLength(50)
    expect(loadTodoJournal("wi_private_cap_50")?.patch.title).toBe("Draft 50")
    expect(loadTodoJournal("wi_private_cap_0")).toBeNull()
    expect(sessionStorage.getItem(JOURNAL_KEY)).not.toContain("wi_private_cap_50")
    expect(sessionStorage.getItem(JOURNAL_KEY)).toContain("Draft 50")
  })

  describe("atomic active-request retirement", () => {
    function activeRequest() {
      return {
        revision: 1,
        patch: { title: "Sent A1" },
        expectedVersion: 7,
        idempotencyKey: UUID,
        state: "dispatched" as const,
      }
    }

    function currentWithNewerIntent() {
      return {
        revision: 2,
        patch: { title: "Desired A2", priority: 2 },
        baseline: { title: "Original", priority: 1 },
        baselineVersion: 7,
        request: activeRequest(),
      }
    }

    it("replaces acknowledged A1 with prepared A2 in exactly one storage write", () => {
      persistTodoJournal(TODO_ID, currentWithNewerIntent() as never)
      const next = {
        revision: 2,
        patch: { title: "Desired A2", priority: 2 },
        baseline: { title: "Sent A1", priority: 1 },
        baselineVersion: 8,
        request: {
          revision: 2,
          patch: { title: "Desired A2", priority: 2 },
          expectedVersion: 8,
          idempotencyKey: "987e6543-e21b-42d3-a456-426614174999",
          state: "prepared" as const,
        },
      }
      const setItem = vi.spyOn(Storage.prototype, "setItem")
      const removeItem = vi.spyOn(Storage.prototype, "removeItem")

      expect(transitionTodoJournal(TODO_ID, activeRequest(), 2, next)).toBe(true)

      expect(loadTodoJournal(TODO_ID)).toEqual(next)
      expect(setItem).toHaveBeenCalledTimes(1)
      expect(removeItem).not.toHaveBeenCalled()
    })

    it("retires acknowledged A1 to request-less dirty intent in exactly one storage write", () => {
      persistTodoJournal(TODO_ID, currentWithNewerIntent() as never)
      const next = {
        revision: 2,
        patch: { title: "Desired A2" },
        baseline: { title: "Sent A1" },
        baselineVersion: 8,
      }
      const setItem = vi.spyOn(Storage.prototype, "setItem")
      const removeItem = vi.spyOn(Storage.prototype, "removeItem")

      expect(transitionTodoJournal(TODO_ID, activeRequest(), 2, next)).toBe(true)

      expect(loadTodoJournal(TODO_ID)).toEqual(next)
      expect(setItem).toHaveBeenCalledTimes(1)
      expect(removeItem).not.toHaveBeenCalled()
    })

    it("retires acknowledged A1 to clean state with one removal", () => {
      persistTodoJournal(TODO_ID, currentWithNewerIntent() as never)
      const setItem = vi.spyOn(Storage.prototype, "setItem")
      const removeItem = vi.spyOn(Storage.prototype, "removeItem")

      expect(transitionTodoJournal(TODO_ID, activeRequest(), 2, null)).toBe(true)

      expect(loadTodoJournal(TODO_ID)).toBeNull()
      expect(setItem).not.toHaveBeenCalled()
      expect(removeItem).toHaveBeenCalledTimes(1)
    })

    it.each([
      ["rebase", "Rebased A2"],
      ["overwrite", "Overwrite A2"],
    ])("replaces conflicted A1 with explicit %s A2", (_resolution, resolvedTitle) => {
      const conflicted = { ...currentWithNewerIntent(), request: { ...activeRequest(), state: "conflict" as const } }
      persistTodoJournal(TODO_ID, conflicted as never)
      const next = {
        revision: 3,
        patch: { title: resolvedTitle },
        baseline: { title: "Server current" },
        baselineVersion: 9,
        request: {
          revision: 3,
          patch: { title: resolvedTitle },
          expectedVersion: 9,
          idempotencyKey: "987e6543-e21b-42d3-a456-426614174999",
          state: "prepared" as const,
        },
      }

      expect(transitionTodoJournal(TODO_ID, activeRequest(), 2, next)).toBe(true)
      expect(loadTodoJournal(TODO_ID)).toEqual(next)
    })

    it.each([
      ["revision", { revision: 2 }],
      ["sent patch", { patch: { title: "Different" } }],
      ["expected version", { expectedVersion: 8 }],
      ["idempotency key", { idempotencyKey: "987e6543-e21b-42d3-a456-426614174999" }],
    ] as const)("blocks a stale or mismatched active-request %s with zero writes", (_label, mismatch) => {
      const current = currentWithNewerIntent()
      persistTodoJournal(TODO_ID, current as never)
      const setItem = vi.spyOn(Storage.prototype, "setItem")
      const removeItem = vi.spyOn(Storage.prototype, "removeItem")

      expect(transitionTodoJournal(TODO_ID, { ...activeRequest(), ...mismatch }, 2, null)).toBe(false)

      expect(loadTodoJournal(TODO_ID)).toEqual(current)
      expect(setItem).not.toHaveBeenCalled()
      expect(removeItem).not.toHaveBeenCalled()
    })

    it("rejects a malformed expected fingerprint with zero writes", () => {
      const current = currentWithNewerIntent()
      persistTodoJournal(TODO_ID, current as never)
      const setItem = vi.spyOn(Storage.prototype, "setItem")
      const removeItem = vi.spyOn(Storage.prototype, "removeItem")

      expect(transitionTodoJournal(TODO_ID, null as never, 2, null)).toBe(false)

      expect(loadTodoJournal(TODO_ID)).toEqual(current)
      expect(setItem).not.toHaveBeenCalled()
      expect(removeItem).not.toHaveBeenCalled()
    })

    it("retains unrelated journals while retiring A1 in one mutation", () => {
      persistTodoJournal("wi_unrelated", {
        revision: 1,
        patch: { title: "Other desired" },
        baseline: { title: "Other original" },
        baselineVersion: 3,
      })
      persistTodoJournal(TODO_ID, currentWithNewerIntent() as never)
      const setItem = vi.spyOn(Storage.prototype, "setItem")

      expect(transitionTodoJournal(TODO_ID, activeRequest(), 2, null)).toBe(true)

      expect(loadTodoJournal("wi_unrelated")?.patch).toEqual({ title: "Other desired" })
      expect(setItem).toHaveBeenCalledTimes(1)
      expect(sessionStorage.getItem(JOURNAL_KEY)).not.toContain(TODO_ID)
    })

    it.each([
      ["missing salt", undefined],
      ["invalid salt", "short"],
    ])("performs zero writes when the tab has %s", (_label, salt) => {
      sessionStorage.clear()
      if (salt !== undefined) sessionStorage.setItem(SALT_KEY, salt)
      const setItem = vi.spyOn(Storage.prototype, "setItem")
      const removeItem = vi.spyOn(Storage.prototype, "removeItem")

      expect(transitionTodoJournal(TODO_ID, activeRequest(), 2, null)).toBe(false)

      expect(setItem).not.toHaveBeenCalled()
      expect(removeItem).not.toHaveBeenCalled()
    })

    it("performs zero writes when valid salted storage has no matching journal", () => {
      todoPrivateRef(TODO_ID)
      const setItem = vi.spyOn(Storage.prototype, "setItem")
      const removeItem = vi.spyOn(Storage.prototype, "removeItem")

      expect(transitionTodoJournal(TODO_ID, activeRequest(), 2, null)).toBe(false)

      expect(setItem).not.toHaveBeenCalled()
      expect(removeItem).not.toHaveBeenCalled()
    })

    it.each([
      ["replacement", {
        revision: 2,
        patch: { title: "Stale A2" },
        baseline: { title: "Sent A1" },
        baselineVersion: 8,
      }],
      ["removal", null],
    ] as const)("blocks stale desired revision A2 %s after A3 with zero writes", (_label, next) => {
      const current = {
        revision: 3,
        patch: { title: "Desired A3" },
        baseline: { title: "Original" },
        baselineVersion: 7,
        request: activeRequest(),
      }
      persistTodoJournal(TODO_ID, current as never)
      const setItem = vi.spyOn(Storage.prototype, "setItem")
      const removeItem = vi.spyOn(Storage.prototype, "removeItem")

      expect(transitionTodoJournal(TODO_ID, activeRequest(), 2, next)).toBe(false)

      expect(loadTodoJournal(TODO_ID)).toEqual(current)
      expect(setItem).not.toHaveBeenCalled()
      expect(removeItem).not.toHaveBeenCalled()
    })

    it("rejects a replacement revision lower than the matching current revision", () => {
      const current = {
        revision: 3,
        patch: { title: "Desired A3" },
        baseline: { title: "Original" },
        baselineVersion: 7,
        request: activeRequest(),
      }
      const lower = {
        revision: 2,
        patch: { title: "Older A2" },
        baseline: { title: "Sent A1" },
        baselineVersion: 8,
      }
      persistTodoJournal(TODO_ID, current as never)
      const setItem = vi.spyOn(Storage.prototype, "setItem")
      const removeItem = vi.spyOn(Storage.prototype, "removeItem")

      expect(transitionTodoJournal(TODO_ID, activeRequest(), 3, lower)).toBe(false)

      expect(loadTodoJournal(TODO_ID)).toEqual(current)
      expect(setItem).not.toHaveBeenCalled()
      expect(removeItem).not.toHaveBeenCalled()
    })

    it.each([undefined, "2026-07-12T08:00:00.000Z", 0, 1.5, Number.MAX_SAFE_INTEGER + 1])(
      "rejects post-response baseline version %s with zero writes",
      (baselineVersion) => {
        const current = currentWithNewerIntent()
        persistTodoJournal(TODO_ID, current as never)
        const setItem = vi.spyOn(Storage.prototype, "setItem")
        const removeItem = vi.spyOn(Storage.prototype, "removeItem")

        expect(transitionTodoJournal(TODO_ID, activeRequest(), 2, {
          revision: 2,
          patch: { title: "Desired A2" },
          baseline: { title: "Sent A1" },
          baselineVersion,
        } as never)).toBe(false)

        expect(loadTodoJournal(TODO_ID)).toEqual(current)
        expect(setItem).not.toHaveBeenCalled()
        expect(removeItem).not.toHaveBeenCalled()
      },
    )
  })
})
