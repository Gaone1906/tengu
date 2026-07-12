import { createHash } from "node:crypto";
import { isSecretKey, redactText } from "../shared/redact.js";
import type { ActivityJsonValue } from "./types.js";

const POSIX_HOME_RE = /(\/(?:Users|home))\/[^/\s"'?#]+/g;
const WINDOWS_HOME_RE = /([A-Za-z]:\\Users\\)[^\\\s"']+/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const AWS_ACCESS_KEY_RE = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const GOOGLE_CREDENTIAL_RE = /\b(?:AIza[0-9A-Za-z_-]{20,}|ya29\.[0-9A-Za-z_-]{20,})\b/g;
const QUERY_SECRET_RE = /([?&](?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|key|secret|password|credential)=)[^&#\s]+/gi;
const CONTEXTUAL_SECRET_RE = /(\b(?:access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|api[ _-]?key|password|passwd|pwd|credential|secret|token)\b\s*(?:is|=|:)\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;

export const ACTIVITY_INPUT_LIMITS = {
  maxDepth: 24,
  maxNodes: 5_000,
  maxCollectionItems: 1_000,
  maxStringBytes: 32_768,
  maxTotalStringBytes: 262_144,
  maxLinks: 32,
} as const;

export class ActivityValueLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActivityValueLimitError";
  }
}

export function assertActivityValueWithinLimits(value: unknown, jsonOnly = false): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let totalStringBytes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > ACTIVITY_INPUT_LIMITS.maxNodes) throw new ActivityValueLimitError("activity input exceeds the node limit");
    if (current.depth > ACTIVITY_INPUT_LIMITS.maxDepth) throw new ActivityValueLimitError("activity input exceeds the depth limit");
    if (typeof current.value === "string") {
      const bytes = Buffer.byteLength(current.value, "utf8");
      if (bytes > ACTIVITY_INPUT_LIMITS.maxStringBytes) throw new ActivityValueLimitError("activity input exceeds the string byte limit");
      totalStringBytes += bytes;
      if (totalStringBytes > ACTIVITY_INPUT_LIMITS.maxTotalStringBytes) throw new ActivityValueLimitError("activity input exceeds the total byte limit");
      continue;
    }
    if (jsonOnly && typeof current.value === "number" && !Number.isFinite(current.value)) {
      throw new ActivityValueLimitError("activity input contains a non-finite number");
    }
    if (jsonOnly && current.value !== null && !["boolean", "number", "object"].includes(typeof current.value)) {
      throw new ActivityValueLimitError("activity input contains a non-JSON value");
    }
    if (!current.value || typeof current.value !== "object") continue;
    if (jsonOnly && !Array.isArray(current.value) && Object.getPrototypeOf(current.value) !== Object.prototype && Object.getPrototypeOf(current.value) !== null) {
      throw new ActivityValueLimitError("activity input contains a non-JSON object");
    }
    if (seen.has(current.value)) throw new ActivityValueLimitError("activity input contains a cycle or repeated object reference");
    seen.add(current.value);
    const values = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    if (values.length > ACTIVITY_INPUT_LIMITS.maxCollectionItems) throw new ActivityValueLimitError("activity input exceeds the collection limit");
    for (const nested of values) stack.push({ value: nested, depth: current.depth + 1 });
  }
}

export function redactActivityText(value: string): string {
  return redactText(value)
    .replace(JWT_RE, "[REDACTED JWT]")
    .replace(AWS_ACCESS_KEY_RE, "[REDACTED CLOUD CREDENTIAL]")
    .replace(GOOGLE_CREDENTIAL_RE, "[REDACTED CLOUD CREDENTIAL]")
    .replace(QUERY_SECRET_RE, "$1[REDACTED]")
    .replace(CONTEXTUAL_SECRET_RE, "$1[REDACTED]")
    .replace(POSIX_HOME_RE, "$1/[REDACTED]")
    .replace(WINDOWS_HOME_RE, "$1[REDACTED]");
}

export function redactActivityValue(value: ActivityJsonValue): ActivityJsonValue {
  assertActivityValueWithinLimits(value, true);
  if (typeof value === "string") return redactActivityText(value);
  if (Array.isArray(value)) return value.map(redactActivityValue);
  if (value && typeof value === "object") {
    const redacted: Record<string, ActivityJsonValue> = {};
    for (const [key, nested] of Object.entries(value)) {
      redacted[key] = isSecretKey(key) ? "[REDACTED]" : redactActivityValue(nested);
    }
    return redacted;
  }
  return value;
}

export function redactStableIdentity(value: string): string {
  const redacted = redactActivityText(value);
  if (redacted === value) return value;
  return `redacted_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}
