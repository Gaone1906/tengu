import { describe, expect, it } from "vitest";
import {
  HANDOFF_DOCUMENT_KINDS,
  isHandoffDocumentKind,
  validateHandoffDocument,
  type CompletionReportDocument,
  type PlanHldLldDocument,
  type ScopeRequestDocument,
  type ScopeVerificationDocument,
  type TaskAssignmentDocument,
} from "../handoff-schemas.js";

const scopeRequest: ScopeRequestDocument = {
  id: "sr-1",
  projectRootId: "wi_root",
  repo: "gaone1906/tengu",
  summary: "Add council/specialist redesign",
  proposedTouchpoints: ["packages/jinn/src/council/handoff-schemas.ts"],
  context: "Part of D20-D25.",
  requestedBy: "coo",
  createdAt: "2026-08-08T00:00:00.000Z",
};

const scopeVerification: ScopeVerificationDocument = {
  id: "sv-1",
  requestId: "sr-1",
  repo: "gaone1906/tengu",
  confirmed: true,
  actualTouchpoints: ["packages/jinn/src/council/handoff-schemas.ts"],
  risks: [],
  notes: "Scope looks correct.",
  respondedBy: "specialist-tengu",
  createdAt: "2026-08-08T00:05:00.000Z",
};

const planHldLld: PlanHldLldDocument = {
  id: "plan-1",
  projectRootId: "wi_root",
  hld: "Introduce handoff document schemas.",
  lld: [
    { repo: "gaone1906/tengu", files: ["council/handoff-schemas.ts"], functions: ["validateHandoffDocument"], notes: "" },
  ],
  taskBreakdown: [
    {
      repo: "gaone1906/tengu",
      tasks: [
        { title: "Define schemas", subTasks: [{ title: "Write validators", commits: ["initial commit"] }] },
      ],
    },
  ],
  synthesizedBy: "coo",
  createdAt: "2026-08-08T00:10:00.000Z",
};

const taskAssignment: TaskAssignmentDocument = {
  id: "ta-1",
  planId: "plan-1",
  repo: "gaone1906/tengu",
  title: "Implement handoff-schemas.ts",
  body: "Build the five document kinds.",
  acceptance: "All five kinds validate correctly.",
  verifyCommand: "npx --yes pnpm@10.6.4 --filter jinn test",
  assignee: "specialist-tengu",
  parallelSafe: false,
  createdAt: "2026-08-08T00:15:00.000Z",
};

const completionReport: CompletionReportDocument = {
  id: "cr-1",
  taskAssignmentId: "ta-1",
  repo: "gaone1906/tengu",
  status: "completed",
  summary: "Implemented and tested.",
  filesChanged: ["packages/jinn/src/council/handoff-schemas.ts"],
  blockers: [],
  reportedBy: "specialist-tengu",
  createdAt: "2026-08-08T00:30:00.000Z",
};

describe("handoff document kinds", () => {
  it("exposes exactly the five document kinds from the design doc", () => {
    expect([...HANDOFF_DOCUMENT_KINDS].sort()).toEqual([
      "completion-report",
      "plan-hld-lld",
      "scope-request",
      "scope-verification",
      "task-assignment",
    ]);
  });

  it("isHandoffDocumentKind recognizes only the five kinds", () => {
    for (const kind of HANDOFF_DOCUMENT_KINDS) expect(isHandoffDocumentKind(kind)).toBe(true);
    expect(isHandoffDocumentKind("scope-approval")).toBe(false);
    expect(isHandoffDocumentKind(42)).toBe(false);
    expect(isHandoffDocumentKind(undefined)).toBe(false);
  });

  it("validates a well-formed scope-request", () => {
    expect(validateHandoffDocument("scope-request", scopeRequest)).toBeNull();
  });

  it("rejects a scope-request missing a required field", () => {
    const { summary: _summary, ...rest } = scopeRequest;
    expect(validateHandoffDocument("scope-request", rest)).toBe("scope-request document requires summary");
  });

  it("rejects a scope-request with an extra unknown field", () => {
    expect(validateHandoffDocument("scope-request", { ...scopeRequest, extra: "nope" }))
      .toBe("scope-request document has an invalid shape");
  });

  it("rejects a scope-request with a wrongly typed field", () => {
    expect(validateHandoffDocument("scope-request", { ...scopeRequest, proposedTouchpoints: "not-an-array" }))
      .toBe("scope-request document requires proposedTouchpoints[]");
  });

  it("validates a well-formed scope-verification", () => {
    expect(validateHandoffDocument("scope-verification", scopeVerification)).toBeNull();
  });

  it("rejects a scope-verification with a non-boolean confirmed field", () => {
    expect(validateHandoffDocument("scope-verification", { ...scopeVerification, confirmed: "yes" }))
      .toBe("scope-verification document requires confirmed");
  });

  it("validates a well-formed plan-hld-lld with nested task/sub-task/commit breakdown", () => {
    expect(validateHandoffDocument("plan-hld-lld", planHldLld)).toBeNull();
  });

  it("rejects a plan-hld-lld whose taskBreakdown entry is malformed", () => {
    const malformed = {
      ...planHldLld,
      taskBreakdown: [{ repo: "gaone1906/tengu", tasks: [{ title: "Bad", subTasks: [{ title: "x" }] }] }],
    };
    expect(validateHandoffDocument("plan-hld-lld", malformed))
      .toBe("plan-hld-lld document sub-task entry requires commits[]");
  });

  it("rejects a plan-hld-lld whose lld entry is missing a required field", () => {
    const malformed = { ...planHldLld, lld: [{ repo: "gaone1906/tengu", files: [], functions: [] }] };
    expect(validateHandoffDocument("plan-hld-lld", malformed))
      .toBe("plan-hld-lld document lld entry requires notes");
  });

  it("rejects a plan-hld-lld whose lld entry has an extra unknown field", () => {
    const malformed = {
      ...planHldLld,
      lld: [{ repo: "gaone1906/tengu", files: [], functions: [], notes: "", extra: true }],
    };
    expect(validateHandoffDocument("plan-hld-lld", malformed))
      .toBe("plan-hld-lld document lld entry has an invalid shape");
  });

  it("validates a well-formed task-assignment, including a null verifyCommand", () => {
    expect(validateHandoffDocument("task-assignment", taskAssignment)).toBeNull();
    expect(validateHandoffDocument("task-assignment", { ...taskAssignment, verifyCommand: null })).toBeNull();
  });

  it("rejects a task-assignment with a blank verifyCommand string", () => {
    expect(validateHandoffDocument("task-assignment", { ...taskAssignment, verifyCommand: "   " }))
      .toBe("task-assignment document requires verifyCommand");
  });

  it("validates a well-formed completion-report", () => {
    expect(validateHandoffDocument("completion-report", completionReport)).toBeNull();
  });

  it("rejects a completion-report with an invalid status enum value", () => {
    expect(validateHandoffDocument("completion-report", { ...completionReport, status: "done" }))
      .toBe("completion-report document requires a valid status");
  });

  it("rejects a non-object document payload for every kind", () => {
    for (const kind of HANDOFF_DOCUMENT_KINDS) {
      expect(validateHandoffDocument(kind, "not-an-object")).toBe(`${kind} document must be an object`);
      expect(validateHandoffDocument(kind, null)).toBe(`${kind} document must be an object`);
      expect(validateHandoffDocument(kind, ["array"])).toBe(`${kind} document must be an object`);
    }
  });
});
