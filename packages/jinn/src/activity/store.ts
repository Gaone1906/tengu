import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { initDb } from "../sessions/registry.js";
import { ACTIVITY_KINDS, ACTIVITY_OUTCOMES, type ActivityAppendResult, type ActivityEvent, type ActivityEventInput, type ActivityJsonValue, type ActivityLink } from "./types.js";
import { activityPayloadHash } from "./payload.js";
import {
  ACTIVITY_INPUT_LIMITS,
  ActivityValueLimitError,
  assertActivityValueWithinLimits,
  redactActivityText,
  redactActivityValue,
  redactStableIdentity,
} from "./redact.js";

export interface ActivityRow {
  seq: number;
  id: string;
  story_id: string;
  occurred_at: string;
  kind: ActivityEvent["kind"];
  action: string;
  actor_type: ActivityEvent["actor"]["type"];
  actor_id: string;
  actor_display_name: string;
  object_type: string;
  object_id: string;
  object_label: string;
  object_href: string | null;
  outcome_state: ActivityEvent["outcome"]["state"];
  outcome_label: string;
  summary: string;
  correlation_id: string;
  causation_id: string | null;
  root_event_id: string | null;
  attempt: number | null;
  idempotency_key: string | null;
  detail_ref: string | null;
  detail_json: string | null;
  links_json: string | null;
  payload_hash: string;
}

export interface AppendActivityOptions {
  database?: Database.Database;
  idFactory?: () => string;
}

export class ActivityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActivityValidationError";
  }
}

export class ActivityIdempotencyConflictError extends Error {
  constructor() {
    super("activity idempotency key conflicts with an existing event");
    this.name = "ActivityIdempotencyConflictError";
  }
}

export class ActivityCorruptionError extends Error {
  constructor() {
    super("activity ledger data is corrupted");
    this.name = "ActivityCorruptionError";
  }
}

function required(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ActivityValidationError(`${field} is required`);
  return value.trim();
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function safeHref(value: string | undefined, field: string): string | undefined {
  const href = optional(value);
  if (!href) return undefined;
  if (!href.startsWith("/") || href.startsWith("//") || href.includes("\\")) {
    throw new ActivityValidationError(`${field} href must be a gateway-relative path`);
  }
  return redactActivityText(href);
}

function validateIso(value: string): string {
  const occurredAt = required(value, "occurredAt");
  const parsed = Date.parse(occurredAt);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== occurredAt) {
    throw new ActivityValidationError("occurredAt must be a canonical ISO timestamp");
  }
  return occurredAt;
}

function validateInput(input: ActivityEventInput): ActivityEventInput {
  try {
    assertActivityValueWithinLimits(input);
  } catch (error) {
    if (error instanceof ActivityValueLimitError) throw new ActivityValidationError(error.message);
    throw error;
  }
  if (!input || typeof input !== "object" || !input.actor || typeof input.actor !== "object" ||
      !input.object || typeof input.object !== "object" || !input.outcome || typeof input.outcome !== "object") {
    throw new ActivityValidationError("activity input shape is invalid");
  }
  const correlationId = required(input.correlationId, "correlationId");
  const idempotencyKey = optional(input.idempotencyKey);
  const causationId = optional(input.causationId);
  const rootEventId = optional(input.rootEventId);
  const detailRef = optional(input.detailRef);
  if (idempotencyKey && !/^[^:\s]+:[^:\s]+:.+/.test(idempotencyKey)) {
    throw new ActivityValidationError("idempotencyKey must be globally namespaced as domain:operation:source");
  }
  if (!ACTIVITY_KINDS.includes(input.kind)) throw new ActivityValidationError("kind is invalid");
  if (!ACTIVITY_OUTCOMES.includes(input.outcome.state)) throw new ActivityValidationError("outcome.state is invalid");
  if (!(["operator", "employee", "system"] as const).includes(input.actor.type)) throw new ActivityValidationError("actor.type is invalid");
  if (input.attempt !== undefined && (!Number.isSafeInteger(input.attempt) || input.attempt < 1)) throw new ActivityValidationError("attempt must be a positive integer");
  if (input.links && input.links.length > ACTIVITY_INPUT_LIMITS.maxLinks) throw new ActivityValidationError("links exceeds the link count limit");

  const links = input.links?.map((link, index): ActivityLink => ({
    rel: redactActivityText(required(link.rel, `links[${index}].rel`)),
    label: redactActivityText(required(link.label, `links[${index}].label`)),
    href: safeHref(link.href, `links[${index}]`)!,
  }));
  let detail: ActivityJsonValue | undefined;
  try {
    detail = input.detail === undefined ? undefined : redactActivityValue(input.detail);
  } catch (error) {
    if (error instanceof ActivityValueLimitError) throw new ActivityValidationError(error.message);
    throw error;
  }

  const objectHref = safeHref(input.object.href, "object");
  return {
    occurredAt: validateIso(input.occurredAt),
    kind: input.kind,
    action: redactActivityText(required(input.action, "action")),
    actor: {
      type: input.actor.type,
      id: redactStableIdentity(required(input.actor.id, "actor.id")),
      displayName: redactActivityText(required(input.actor.displayName, "actor.displayName")),
    },
    object: {
      type: redactActivityText(required(input.object.type, "object.type")),
      id: redactStableIdentity(required(input.object.id, "object.id")),
      label: redactActivityText(required(input.object.label, "object.label")),
      ...(objectHref ? { href: objectHref } : {}),
    },
    outcome: {
      state: input.outcome.state,
      label: redactActivityText(required(input.outcome.label, "outcome.label")),
    },
    summary: redactActivityText(required(input.summary, "summary")),
    correlationId: redactStableIdentity(correlationId),
    ...(causationId ? { causationId: redactStableIdentity(causationId) } : {}),
    ...(rootEventId ? { rootEventId: redactStableIdentity(rootEventId) } : {}),
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    ...(idempotencyKey ? { idempotencyKey: redactStableIdentity(idempotencyKey) === idempotencyKey
      ? idempotencyKey
      : `redacted:identity:${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}` } : {}),
    ...(detailRef ? { detailRef: redactActivityText(detailRef) } : {}),
    ...(detail !== undefined ? { detail } : {}),
    ...(links ? { links } : {}),
  };
}

export function activityStoryId(correlationId: string): string {
  return `story_${createHash("sha256").update(correlationId).digest("hex").slice(0, 24)}`;
}

export function activityEventFromRow(row: ActivityRow): ActivityEvent {
  try {
    const detail = row.detail_json ? JSON.parse(row.detail_json) as ActivityJsonValue : undefined;
    const links = row.links_json ? JSON.parse(row.links_json) as ActivityLink[] : undefined;
    if (detail !== undefined) assertActivityValueWithinLimits(detail);
    if (links !== undefined) {
      assertActivityValueWithinLimits(links);
      if (!Array.isArray(links) || links.length > ACTIVITY_INPUT_LIMITS.maxLinks || links.some((link) =>
        !link || typeof link !== "object" || typeof link.rel !== "string" || typeof link.label !== "string" || typeof link.href !== "string")) {
        throw new Error("invalid activity links");
      }
    }
    return {
      id: row.id,
      storyId: row.story_id,
      seq: row.seq,
      occurredAt: row.occurred_at,
      kind: row.kind,
      action: row.action,
      actor: { type: row.actor_type, id: row.actor_id, displayName: row.actor_display_name },
      object: {
        type: row.object_type,
        id: row.object_id,
        label: row.object_label,
        ...(row.object_href ? { href: row.object_href } : {}),
      },
      outcome: { state: row.outcome_state, label: row.outcome_label },
      summary: row.summary,
      correlationId: row.correlation_id,
      ...(row.causation_id ? { causationId: row.causation_id } : {}),
      ...(row.root_event_id ? { rootEventId: row.root_event_id } : {}),
      ...(row.attempt !== null ? { attempt: row.attempt } : {}),
      ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
      ...(row.detail_ref ? { detailRef: row.detail_ref } : {}),
      ...(detail !== undefined ? { detail } : {}),
      ...(links !== undefined ? { links } : {}),
    };
  } catch (error) {
    if (error instanceof ActivityCorruptionError) throw error;
    throw new ActivityCorruptionError();
  }
}

function replayResult(row: ActivityRow | undefined, payloadHash: string): ActivityAppendResult | undefined {
  if (!row) return undefined;
  if (row.payload_hash !== payloadHash) throw new ActivityIdempotencyConflictError();
  return { inserted: false, event: activityEventFromRow(row) };
}

export function appendActivityEvent(input: ActivityEventInput, options: AppendActivityOptions = {}): ActivityAppendResult {
  const database = options.database ?? initDb();
  const normalized = validateInput(input);
  const storyId = activityStoryId(normalized.correlationId);
  const payloadHash = activityPayloadHash(normalized);
  if (normalized.idempotencyKey) {
    const replay = replayResult(database.prepare("SELECT * FROM activity_events WHERE idempotency_key = ?").get(normalized.idempotencyKey) as ActivityRow | undefined, payloadHash);
    if (replay) return replay;
  }
  const id = `act_${(options.idFactory ?? randomUUID)()}`;
  if (!/^act_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    throw new ActivityValidationError("idFactory must return a canonical UUID");
  }
  let result: Database.RunResult;
  try {
    result = database.prepare(`
    INSERT INTO activity_events (
      id, story_id, occurred_at, kind, action,
      actor_type, actor_id, actor_display_name,
      object_type, object_id, object_label, object_href,
      outcome_state, outcome_label, summary, correlation_id,
      causation_id, root_event_id, attempt, idempotency_key,
      detail_ref, detail_json, links_json, payload_hash
    ) VALUES (
      @id, @storyId, @occurredAt, @kind, @action,
      @actorType, @actorId, @actorDisplayName,
      @objectType, @objectId, @objectLabel, @objectHref,
      @outcomeState, @outcomeLabel, @summary, @correlationId,
      @causationId, @rootEventId, @attempt, @idempotencyKey,
      @detailRef, @detailJson, @linksJson, @payloadHash
    )
  `).run({
    id,
    storyId,
    occurredAt: normalized.occurredAt,
    kind: normalized.kind,
    action: normalized.action,
    actorType: normalized.actor.type,
    actorId: normalized.actor.id,
    actorDisplayName: normalized.actor.displayName,
    objectType: normalized.object.type,
    objectId: normalized.object.id,
    objectLabel: normalized.object.label,
    objectHref: normalized.object.href ?? null,
    outcomeState: normalized.outcome.state,
    outcomeLabel: normalized.outcome.label,
    summary: normalized.summary,
    correlationId: normalized.correlationId,
    causationId: normalized.causationId ?? null,
    rootEventId: normalized.rootEventId ?? null,
    attempt: normalized.attempt ?? null,
    idempotencyKey: normalized.idempotencyKey ?? null,
    detailRef: normalized.detailRef ?? null,
    detailJson: normalized.detail === undefined ? null : JSON.stringify(normalized.detail),
    linksJson: normalized.links === undefined ? null : JSON.stringify(normalized.links),
    payloadHash,
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (normalized.idempotencyKey && code?.startsWith("SQLITE_CONSTRAINT")) {
      const replay = replayResult(database.prepare("SELECT * FROM activity_events WHERE idempotency_key = ?").get(normalized.idempotencyKey) as ActivityRow | undefined, payloadHash);
      if (replay) return replay;
    }
    throw error;
  }

  const row = database.prepare("SELECT * FROM activity_events WHERE id = ?").get(id) as ActivityRow | undefined;
  if (!row || result.changes !== 1) throw new ActivityCorruptionError();
  return { inserted: true, event: activityEventFromRow(row) };
}
