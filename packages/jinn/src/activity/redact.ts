import { createHash } from "node:crypto";
import { isSecretKey, redactText } from "../shared/redact.js";
import type { ActivityJsonValue } from "./types.js";

const POSIX_HOME_RE = /(\/(?:Users|home))\/[^/\s"'?#]+/g;
const WINDOWS_HOME_RE = /([A-Za-z]:\\Users\\)[^\\\s"']+/g;

export function redactActivityText(value: string): string {
  return redactText(value)
    .replace(POSIX_HOME_RE, "$1/[REDACTED]")
    .replace(WINDOWS_HOME_RE, "$1[REDACTED]");
}

export function redactActivityValue(value: ActivityJsonValue): ActivityJsonValue {
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
