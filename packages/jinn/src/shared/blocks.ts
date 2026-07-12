import type {
  ChatBlock,
  ChatBlockEnvelope,
  ChatBlockStatus,
  ChatBlockType,
  JsonObject,
  JsonValue,
} from "./types.js";
import { STRUCTURED_MESSAGE_BODY_MAX_CHARS } from "./types.js";

const BLOCK_TYPES = new Set<ChatBlockType>([
  "task-list",
  "delegation",
  "dispatch",
  "todo-activity",
  "workflow-definition",
  "workflow-run",
]);
const STATUSES = new Set<ChatBlockStatus>([
  "queued",
  "dispatched",
  "running",
  "waiting",
  "done",
  "completed",
  "error",
]);
const OPS = new Set(["put", "patch", "remove"]);
const FORBIDDEN_KEYS = new Set(["html", "script", "component", "dangerouslySetInnerHTML"]);
const MAX_BLOCK_BYTES = 32_000;
const MAX_ACTIVITY_TEXT_CHARS = 4_000;
const ACTIVITY_TYPES = new Set<ChatBlockType>([
  "todo-activity",
  "workflow-definition",
  "workflow-run",
]);

export type BlockValidationResult =
  | { ok: true; envelope: ChatBlockEnvelope }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cleanId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,96}$/.test(id)) return null;
  return id;
}

function cleanText(value: unknown, max = 4000): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+$/g, "");
  return text.length > max ? text.slice(0, max) : text;
}

function hasUnsafeString(value: string): boolean {
  return /<\s*script\b/i.test(value) || /javascript\s*:/i.test(value);
}

function isSafeJson(value: unknown, depth = 0): value is JsonValue {
  if (depth > 8) return false;
  if (value === null) return true;
  if (typeof value === "string") return !hasUnsafeString(value);
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length <= 250 && value.every((item) => isSafeJson(item, depth + 1));
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > 100) return false;
  for (const [key, child] of entries) {
    if (FORBIDDEN_KEYS.has(key)) return false;
    if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(key)) return false;
    if (!isSafeJson(child, depth + 1)) return false;
  }
  return true;
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && isSafeJson(value);
}

function validateRequiredPayloadText(
  type: ChatBlockType,
  payload: JsonObject,
  field: string,
): string | null {
  const value = payload[field];
  if (typeof value !== "string" || !value.trim()) return `${type} payload requires ${field}`;
  if (value.length > 160) return `${type} payload ${field} is too long`;
  return null;
}

function validateActivityReceipt(blockId: string, payload: JsonObject): string | null {
  const receipt = payload.activityReceipt;
  if (receipt === undefined) return null;
  if (!isRecord(receipt)) return "activity receipt must be an object";
  if (receipt.id !== blockId) return "activity receipt id must match block id";
  for (const field of ["operationId", "toolName"] as const) {
    const value = receipt[field];
    if (typeof value !== "string" || !value.trim()) return `activity receipt requires ${field}`;
    if (value.length > STRUCTURED_MESSAGE_BODY_MAX_CHARS) return `activity receipt ${field} is too long`;
  }
  return null;
}

function validateActivityPayloadText(type: ChatBlockType, payload: JsonObject): string | null {
  for (const field of ["preview", "latestError", "error", "errorMessage"] as const) {
    const value = payload[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") return `${type} payload ${field} must be a string`;
    if (value.length > MAX_ACTIVITY_TEXT_CHARS) return `${type} payload ${field} is too long`;
  }
  return null;
}

function validateActivityPayload(
  type: ChatBlockType,
  blockId: string,
  payload: JsonObject,
  op: string,
): string | null {
  const boundedTextError = validateActivityPayloadText(type, payload);
  if (boundedTextError) return boundedTextError;
  const receiptError = validateActivityReceipt(blockId, payload);
  if (receiptError) return receiptError;
  if (op !== "put") return null;

  const requiredFields = type === "todo-activity"
    ? ["todoId", "action", "status"]
    : type === "workflow-definition"
      ? ["workflowId", "action", "definitionStatus"]
      : ["workflowId", "runId", "action", "runStatus"];
  for (const field of requiredFields) {
    const error = validateRequiredPayloadText(type, payload, field);
    if (error) return error;
  }
  return null;
}

function validatePayload(type: ChatBlockType, blockId: string, payload: JsonObject, op: string): string | null {
  if (type === "task-list") {
    const items = payload.items;
    if (items === undefined) {
      if (op === "put") return "task-list payload requires items[]";
    } else {
      if (!Array.isArray(items)) return "task-list payload requires items[]";
      for (const item of items) {
        if (!isRecord(item) || typeof item.text !== "string" || !item.text.trim()) {
          return "task-list item requires text";
        }
      }
    }
  }
  if (type === "delegation" && op === "put") {
    for (const field of ["employee", "employeeDisplay", "title", "childSessionId", "workItemId"] as const) {
      if (typeof payload[field] !== "string" || !payload[field].trim()) {
        return `delegation payload requires ${field}`;
      }
    }
    if (typeof payload.dispatchedAt !== "number" || !Number.isFinite(payload.dispatchedAt)) {
      return "delegation payload requires dispatchedAt";
    }
  }
  if (type === "dispatch" && op === "put") {
    for (const field of ["targetSessionId", "employee", "employeeDisplay"] as const) {
      if (typeof payload[field] !== "string" || !payload[field].trim()) {
        return `dispatch payload requires ${field}`;
      }
    }
    if (typeof payload.preview !== "string") return "dispatch payload requires preview";
    if (typeof payload.sentAt !== "number" || !Number.isFinite(payload.sentAt)) {
      return "dispatch payload requires sentAt";
    }
  }
  if (ACTIVITY_TYPES.has(type)) return validateActivityPayload(type, blockId, payload, op);
  return null;
}

export function validateBlockEnvelope(input: unknown): BlockValidationResult {
  if (!isRecord(input)) return { ok: false, error: "block envelope must be an object" };
  const op = String(input.op ?? "");
  if (!OPS.has(op)) return { ok: false, error: "block op must be put, patch, or remove" };
  if (!isRecord(input.block)) return { ok: false, error: "block must be an object" };

  const id = cleanId(input.block.id);
  if (!id) return { ok: false, error: "block id is invalid" };
  const type = String(input.block.type ?? "") as ChatBlockType;
  if (!BLOCK_TYPES.has(type)) return { ok: false, error: "block type is invalid" };
  const version = typeof input.block.version === "number" && Number.isFinite(input.block.version)
    ? input.block.version
    : 1;
  const payloadRaw = input.block.payload ?? {};
  if (!isJsonObject(payloadRaw)) return { ok: false, error: "block payload must be safe JSON" };

  const statusRaw = input.block.status;
  const status = typeof statusRaw === "string" && STATUSES.has(statusRaw as ChatBlockStatus)
    ? statusRaw as ChatBlockStatus
    : undefined;
  const title = cleanText(input.block.title, 160);
  if (op === "put" && ACTIVITY_TYPES.has(type)) {
    if (!title?.trim()) return { ok: false, error: `${type} put requires title` };
    if (!status) return { ok: false, error: `${type} put requires status` };
  }
  if (ACTIVITY_TYPES.has(type) && statusRaw !== undefined && !status) {
    return { ok: false, error: `${type} block status is invalid` };
  }
  const payloadError = validatePayload(type, id, payloadRaw, op);
  if (payloadError) return { ok: false, error: payloadError };

  const block: ChatBlock = {
    id,
    type,
    version,
    payload: payloadRaw,
    ...(status ? { status } : {}),
    ...(cleanText(input.block.sourceEngine, 80) ? { sourceEngine: cleanText(input.block.sourceEngine, 80) } : {}),
    ...(title ? { title } : {}),
    ...(cleanText(input.block.summary, 400) ? { summary: cleanText(input.block.summary, 400) } : {}),
  };

  if (JSON.stringify({ op, block }).length > MAX_BLOCK_BYTES) {
    return { ok: false, error: "block is too large" };
  }

  return { ok: true, envelope: { op: op as ChatBlockEnvelope["op"], block } };
}

export function mergeBlock(existing: ChatBlock, patch: ChatBlock): ChatBlock {
  if (patch.version < existing.version) return existing;
  return {
    ...existing,
    ...patch,
    id: existing.id,
    type: existing.type,
    version: patch.version ?? existing.version,
    payload: {
      ...existing.payload,
      ...patch.payload,
    },
  };
}

export function blockFallbackText(block: ChatBlock): string {
  const prefix = block.title || block.summary || block.type;
  if (block.type === "task-list") {
    const items = Array.isArray(block.payload.items) ? block.payload.items : [];
    return `${prefix}: ${items.length} item${items.length === 1 ? "" : "s"}`;
  }
  if (block.type === "delegation") {
    return typeof block.payload.title === "string" && block.payload.title.trim()
      ? block.payload.title
      : prefix;
  }
  if (block.type === "dispatch") {
    return typeof block.payload.preview === "string" && block.payload.preview.trim()
      ? `Followed up: ${block.payload.preview}`
      : "Followed up";
  }
  if (block.type === "todo-activity") {
    const status = typeof block.payload.status === "string" && block.payload.status.trim()
      ? block.payload.status.replace(/[_-]+/g, " ")
      : block.status ?? "updated";
    return `Todo “${prefix}” · ${status}`;
  }
  if (block.type === "workflow-definition") {
    const action = typeof block.payload.action === "string" && block.payload.action.trim()
      ? block.payload.action.replace(/[_-]+/g, " ")
      : "updated";
    const detail = action === "updated" ? `updated to v${block.version}` : action;
    return `Workflow “${prefix}” · ${detail}`;
  }
  if (block.type === "workflow-run") {
    const runStatus = typeof block.payload.runStatus === "string" && block.payload.runStatus.trim()
      ? block.payload.runStatus
      : block.status ?? "updated";
    const detail = runStatus === "parked"
      ? "waiting for approval"
      : runStatus.replace(/[_-]+/g, " ");
    return `Workflow “${prefix}” · ${detail}`;
  }
  return prefix;
}
