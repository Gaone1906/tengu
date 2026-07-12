import { createHash } from "node:crypto";
import type { ActivityKind } from "./types.js";

const NAMESPACED_ID_RE = /^[^:\s]+:[^:\s]+:[^:\s]+(?::[^:\s]+)*$/;
const ACTIVITY_EVENT_ID_RE = /^act_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isNamespacedActivityIdentity(value: string): boolean {
  return NAMESPACED_ID_RE.test(value);
}

export function isExplicitActivityRoot(value: string): boolean {
  return ACTIVITY_EVENT_ID_RE.test(value) || (value.startsWith("root:") && NAMESPACED_ID_RE.test(value));
}

export function activityStoryId(kind: ActivityKind, correlationId: string, rootEventId?: string): string {
  const identity = rootEventId && isExplicitActivityRoot(rootEventId)
    ? `root\0${rootEventId}`
    : `source\0${kind}\0${correlationId}`;
  return `story_${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}
