export type HandoffDocumentKind =
  | "scope-request"
  | "scope-verification"
  | "plan-hld-lld"
  | "task-assignment"
  | "completion-report";

export const HANDOFF_DOCUMENT_KINDS: ReadonlySet<HandoffDocumentKind> = new Set([
  "scope-request",
  "scope-verification",
  "plan-hld-lld",
  "task-assignment",
  "completion-report",
]);

const ID_MAX = 200;
const SLUG_MAX = 120;
const SHORT_TEXT_MAX = 200;
const LONG_TEXT_MAX = 8000;
const LIST_MAX_ITEMS = 100;
const LIST_ITEM_MAX = 400;
const BREAKDOWN_MAX_TASKS = 30;
const BREAKDOWN_MAX_SUBTASKS = 20;
const BREAKDOWN_MAX_COMMITS = 20;

export interface ScopeRequestDocument {
  id: string;
  projectRootId: string;
  repo: string;
  summary: string;
  proposedTouchpoints: string[];
  context: string;
  requestedBy: string;
  createdAt: string;
}

export interface ScopeVerificationDocument {
  id: string;
  requestId: string;
  repo: string;
  confirmed: boolean;
  actualTouchpoints: string[];
  risks: string[];
  notes: string;
  respondedBy: string;
  createdAt: string;
}

export interface PlanLldEntry {
  repo: string;
  files: string[];
  functions: string[];
  notes: string;
}

export interface PlanSubTaskEntry {
  title: string;
  commits: string[];
}

export interface PlanTaskEntry {
  title: string;
  subTasks: PlanSubTaskEntry[];
}

export interface PlanTaskBreakdownEntry {
  repo: string;
  tasks: PlanTaskEntry[];
}

export interface PlanHldLldDocument {
  id: string;
  projectRootId: string;
  hld: string;
  lld: PlanLldEntry[];
  taskBreakdown: PlanTaskBreakdownEntry[];
  synthesizedBy: string;
  createdAt: string;
}

export interface TaskAssignmentDocument {
  id: string;
  planId: string;
  repo: string;
  title: string;
  body: string;
  acceptance: string;
  verifyCommand: string | null;
  assignee: string;
  parallelSafe: boolean;
  createdAt: string;
}

export type CompletionReportStatus = "completed" | "blocked" | "partial";

export interface CompletionReportDocument {
  id: string;
  taskAssignmentId: string;
  repo: string;
  status: CompletionReportStatus;
  summary: string;
  filesChanged: string[];
  blockers: string[];
  reportedBy: string;
  createdAt: string;
}

export type HandoffDocument =
  | ScopeRequestDocument
  | ScopeVerificationDocument
  | PlanHldLldDocument
  | TaskAssignmentDocument
  | CompletionReportDocument;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function isBoundedStringArray(value: unknown, maxItems: number, maxItemLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maxItems
    && value.every((item) => isBoundedString(item, maxItemLength));
}

export function isHandoffDocumentKind(value: unknown): value is HandoffDocumentKind {
  return typeof value === "string" && HANDOFF_DOCUMENT_KINDS.has(value as HandoffDocumentKind);
}

function validateScopeRequest(record: Record<string, unknown>): string | null {
  const kind = "scope-request";
  if (!isBoundedString(record.id, ID_MAX)) return `${kind} document requires id`;
  if (!isBoundedString(record.projectRootId, ID_MAX)) return `${kind} document requires projectRootId`;
  if (!isBoundedString(record.repo, SLUG_MAX)) return `${kind} document requires repo`;
  if (!isBoundedString(record.summary, LONG_TEXT_MAX)) return `${kind} document requires summary`;
  if (!isBoundedStringArray(record.proposedTouchpoints, LIST_MAX_ITEMS, LIST_ITEM_MAX)) {
    return `${kind} document requires proposedTouchpoints[]`;
  }
  if (typeof record.context !== "string" || record.context.length > LONG_TEXT_MAX) {
    return `${kind} document requires context`;
  }
  if (!isBoundedString(record.requestedBy, SLUG_MAX)) return `${kind} document requires requestedBy`;
  if (!isBoundedString(record.createdAt, SHORT_TEXT_MAX)) return `${kind} document requires createdAt`;
  if (!hasOnlyKeys(record, [
    "id", "projectRootId", "repo", "summary", "proposedTouchpoints", "context", "requestedBy", "createdAt",
  ])) return `${kind} document has an invalid shape`;
  return null;
}

function validateScopeVerification(record: Record<string, unknown>): string | null {
  const kind = "scope-verification";
  if (!isBoundedString(record.id, ID_MAX)) return `${kind} document requires id`;
  if (!isBoundedString(record.requestId, ID_MAX)) return `${kind} document requires requestId`;
  if (!isBoundedString(record.repo, SLUG_MAX)) return `${kind} document requires repo`;
  if (typeof record.confirmed !== "boolean") return `${kind} document requires confirmed`;
  if (!isBoundedStringArray(record.actualTouchpoints, LIST_MAX_ITEMS, LIST_ITEM_MAX)) {
    return `${kind} document requires actualTouchpoints[]`;
  }
  if (!isBoundedStringArray(record.risks, LIST_MAX_ITEMS, LIST_ITEM_MAX)) {
    return `${kind} document requires risks[]`;
  }
  if (typeof record.notes !== "string" || record.notes.length > LONG_TEXT_MAX) {
    return `${kind} document requires notes`;
  }
  if (!isBoundedString(record.respondedBy, SLUG_MAX)) return `${kind} document requires respondedBy`;
  if (!isBoundedString(record.createdAt, SHORT_TEXT_MAX)) return `${kind} document requires createdAt`;
  if (!hasOnlyKeys(record, [
    "id", "requestId", "repo", "confirmed", "actualTouchpoints", "risks", "notes", "respondedBy", "createdAt",
  ])) return `${kind} document has an invalid shape`;
  return null;
}

function validatePlanLldEntry(value: unknown): string | null {
  if (!isRecord(value)) return "lld entry must be an object";
  if (!isBoundedString(value.repo, SLUG_MAX)) return "lld entry requires repo";
  if (!isBoundedStringArray(value.files, LIST_MAX_ITEMS, LIST_ITEM_MAX)) return "lld entry requires files[]";
  if (!isBoundedStringArray(value.functions, LIST_MAX_ITEMS, LIST_ITEM_MAX)) return "lld entry requires functions[]";
  if (typeof value.notes !== "string" || value.notes.length > LONG_TEXT_MAX) return "lld entry requires notes";
  if (!hasOnlyKeys(value, ["repo", "files", "functions", "notes"])) return "lld entry has an invalid shape";
  return null;
}

function validatePlanSubTaskEntry(value: unknown): string | null {
  if (!isRecord(value)) return "sub-task entry must be an object";
  if (!isBoundedString(value.title, SHORT_TEXT_MAX)) return "sub-task entry requires title";
  if (!isBoundedStringArray(value.commits, BREAKDOWN_MAX_COMMITS, LIST_ITEM_MAX)) {
    return "sub-task entry requires commits[]";
  }
  if (!hasOnlyKeys(value, ["title", "commits"])) return "sub-task entry has an invalid shape";
  return null;
}

function validatePlanTaskEntry(value: unknown): string | null {
  if (!isRecord(value)) return "task entry must be an object";
  if (!isBoundedString(value.title, SHORT_TEXT_MAX)) return "task entry requires title";
  if (!Array.isArray(value.subTasks) || value.subTasks.length > BREAKDOWN_MAX_SUBTASKS) {
    return "task entry requires subTasks[]";
  }
  for (const subTask of value.subTasks) {
    const error = validatePlanSubTaskEntry(subTask);
    if (error) return error;
  }
  if (!hasOnlyKeys(value, ["title", "subTasks"])) return "task entry has an invalid shape";
  return null;
}

function validatePlanTaskBreakdownEntry(value: unknown): string | null {
  if (!isRecord(value)) return "task breakdown entry must be an object";
  if (!isBoundedString(value.repo, SLUG_MAX)) return "task breakdown entry requires repo";
  if (!Array.isArray(value.tasks) || value.tasks.length > BREAKDOWN_MAX_TASKS) {
    return "task breakdown entry requires tasks[]";
  }
  for (const task of value.tasks) {
    const error = validatePlanTaskEntry(task);
    if (error) return error;
  }
  if (!hasOnlyKeys(value, ["repo", "tasks"])) return "task breakdown entry has an invalid shape";
  return null;
}

function validatePlanHldLld(record: Record<string, unknown>): string | null {
  const kind = "plan-hld-lld";
  if (!isBoundedString(record.id, ID_MAX)) return `${kind} document requires id`;
  if (!isBoundedString(record.projectRootId, ID_MAX)) return `${kind} document requires projectRootId`;
  if (!isBoundedString(record.hld, LONG_TEXT_MAX)) return `${kind} document requires hld`;
  if (!Array.isArray(record.lld) || record.lld.length > LIST_MAX_ITEMS) {
    return `${kind} document requires lld[]`;
  }
  for (const entry of record.lld) {
    const error = validatePlanLldEntry(entry);
    if (error) return `${kind} document ${error}`;
  }
  if (!Array.isArray(record.taskBreakdown) || record.taskBreakdown.length > LIST_MAX_ITEMS) {
    return `${kind} document requires taskBreakdown[]`;
  }
  for (const entry of record.taskBreakdown) {
    const error = validatePlanTaskBreakdownEntry(entry);
    if (error) return `${kind} document ${error}`;
  }
  if (!isBoundedString(record.synthesizedBy, SLUG_MAX)) return `${kind} document requires synthesizedBy`;
  if (!isBoundedString(record.createdAt, SHORT_TEXT_MAX)) return `${kind} document requires createdAt`;
  if (!hasOnlyKeys(record, [
    "id", "projectRootId", "hld", "lld", "taskBreakdown", "synthesizedBy", "createdAt",
  ])) return `${kind} document has an invalid shape`;
  return null;
}

function validateTaskAssignment(record: Record<string, unknown>): string | null {
  const kind = "task-assignment";
  if (!isBoundedString(record.id, ID_MAX)) return `${kind} document requires id`;
  if (!isBoundedString(record.planId, ID_MAX)) return `${kind} document requires planId`;
  if (!isBoundedString(record.repo, SLUG_MAX)) return `${kind} document requires repo`;
  if (!isBoundedString(record.title, SHORT_TEXT_MAX)) return `${kind} document requires title`;
  if (typeof record.body !== "string" || record.body.length > LONG_TEXT_MAX) return `${kind} document requires body`;
  if (typeof record.acceptance !== "string" || record.acceptance.length > LONG_TEXT_MAX) {
    return `${kind} document requires acceptance`;
  }
  if (record.verifyCommand !== null && !isBoundedString(record.verifyCommand, LONG_TEXT_MAX)) {
    return `${kind} document requires verifyCommand`;
  }
  if (!isBoundedString(record.assignee, SLUG_MAX)) return `${kind} document requires assignee`;
  if (typeof record.parallelSafe !== "boolean") return `${kind} document requires parallelSafe`;
  if (!isBoundedString(record.createdAt, SHORT_TEXT_MAX)) return `${kind} document requires createdAt`;
  if (!hasOnlyKeys(record, [
    "id", "planId", "repo", "title", "body", "acceptance", "verifyCommand", "assignee", "parallelSafe", "createdAt",
  ])) return `${kind} document has an invalid shape`;
  return null;
}

function isCompletionReportStatus(value: unknown): value is CompletionReportStatus {
  return value === "completed" || value === "blocked" || value === "partial";
}

function validateCompletionReport(record: Record<string, unknown>): string | null {
  const kind = "completion-report";
  if (!isBoundedString(record.id, ID_MAX)) return `${kind} document requires id`;
  if (!isBoundedString(record.taskAssignmentId, ID_MAX)) return `${kind} document requires taskAssignmentId`;
  if (!isBoundedString(record.repo, SLUG_MAX)) return `${kind} document requires repo`;
  if (!isCompletionReportStatus(record.status)) return `${kind} document requires a valid status`;
  if (!isBoundedString(record.summary, LONG_TEXT_MAX)) return `${kind} document requires summary`;
  if (!isBoundedStringArray(record.filesChanged, LIST_MAX_ITEMS, LIST_ITEM_MAX)) {
    return `${kind} document requires filesChanged[]`;
  }
  if (!isBoundedStringArray(record.blockers, LIST_MAX_ITEMS, LIST_ITEM_MAX)) {
    return `${kind} document requires blockers[]`;
  }
  if (!isBoundedString(record.reportedBy, SLUG_MAX)) return `${kind} document requires reportedBy`;
  if (!isBoundedString(record.createdAt, SHORT_TEXT_MAX)) return `${kind} document requires createdAt`;
  if (!hasOnlyKeys(record, [
    "id", "taskAssignmentId", "repo", "status", "summary", "filesChanged", "blockers", "reportedBy", "createdAt",
  ])) return `${kind} document has an invalid shape`;
  return null;
}

export function validateHandoffDocument(kind: HandoffDocumentKind, value: unknown): string | null {
  if (!isRecord(value)) return `${kind} document must be an object`;
  if (kind === "scope-request") return validateScopeRequest(value);
  if (kind === "scope-verification") return validateScopeVerification(value);
  if (kind === "plan-hld-lld") return validatePlanHldLld(value);
  if (kind === "task-assignment") return validateTaskAssignment(value);
  return validateCompletionReport(value);
}
