import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { initDb } from "../sessions/registry.js";
import { ACTIVITY_KINDS, ACTIVITY_OUTCOMES, type ActivityAppendResult, type ActivityEvent, type ActivityEventInput, type ActivityJsonValue, type ActivityLink } from "./types.js";
import { redactActivityText, redactActivityValue, redactStableIdentity } from "./redact.js";

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
}

export interface AppendActivityOptions {
  database?: Database.Database;
  idFactory?: () => string;
}

function required(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
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
    throw new Error(`${field} href must be a gateway-relative path`);
  }
  return redactActivityText(href);
}

function validateIso(value: string): string {
  const occurredAt = required(value, "occurredAt");
  const parsed = Date.parse(occurredAt);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== occurredAt) {
    throw new Error("occurredAt must be a canonical ISO timestamp");
  }
  return occurredAt;
}

function validateInput(input: ActivityEventInput): ActivityEventInput {
  const correlationId = required(input.correlationId, "correlationId");
  const idempotencyKey = optional(input.idempotencyKey);
  const causationId = optional(input.causationId);
  const rootEventId = optional(input.rootEventId);
  const detailRef = optional(input.detailRef);
  if (idempotencyKey && !/^[^:\s]+:[^:\s]+:.+/.test(idempotencyKey)) {
    throw new Error("idempotencyKey must be globally namespaced as domain:operation:source");
  }
  if (!ACTIVITY_KINDS.includes(input.kind)) throw new Error("kind is invalid");
  if (!ACTIVITY_OUTCOMES.includes(input.outcome.state)) throw new Error("outcome.state is invalid");
  if (!(["operator", "employee", "system"] as const).includes(input.actor.type)) throw new Error("actor.type is invalid");
  if (input.attempt !== undefined && (!Number.isSafeInteger(input.attempt) || input.attempt < 1)) throw new Error("attempt must be a positive integer");

  const links = input.links?.map((link, index): ActivityLink => ({
    rel: redactActivityText(required(link.rel, `links[${index}].rel`)),
    label: redactActivityText(required(link.label, `links[${index}].label`)),
    href: safeHref(link.href, `links[${index}]`)!,
  }));

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
    ...(idempotencyKey ? { idempotencyKey: redactStableIdentity(idempotencyKey) } : {}),
    ...(detailRef ? { detailRef: redactActivityText(detailRef) } : {}),
    ...(input.detail !== undefined ? { detail: redactActivityValue(input.detail) } : {}),
    ...(links ? { links } : {}),
  };
}

export function activityStoryId(correlationId: string): string {
  return `story_${createHash("sha256").update(correlationId).digest("hex").slice(0, 24)}`;
}

export function activityEventFromRow(row: ActivityRow): ActivityEvent {
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
    ...(row.detail_json ? { detail: JSON.parse(row.detail_json) as ActivityJsonValue } : {}),
    ...(row.links_json ? { links: JSON.parse(row.links_json) as ActivityLink[] } : {}),
  };
}

export function appendActivityEvent(input: ActivityEventInput, options: AppendActivityOptions = {}): ActivityAppendResult {
  const database = options.database ?? initDb();
  const normalized = validateInput(input);
  const storyId = activityStoryId(normalized.correlationId);
  const id = `act_${(options.idFactory ?? randomUUID)()}`;
  const result = database.prepare(`
    INSERT OR IGNORE INTO activity_events (
      id, story_id, occurred_at, kind, action,
      actor_type, actor_id, actor_display_name,
      object_type, object_id, object_label, object_href,
      outcome_state, outcome_label, summary, correlation_id,
      causation_id, root_event_id, attempt, idempotency_key,
      detail_ref, detail_json, links_json
    ) VALUES (
      @id, @storyId, @occurredAt, @kind, @action,
      @actorType, @actorId, @actorDisplayName,
      @objectType, @objectId, @objectLabel, @objectHref,
      @outcomeState, @outcomeLabel, @summary, @correlationId,
      @causationId, @rootEventId, @attempt, @idempotencyKey,
      @detailRef, @detailJson, @linksJson
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
  });

  const row = (result.changes === 1
    ? database.prepare("SELECT * FROM activity_events WHERE id = ?").get(id)
    : database.prepare("SELECT * FROM activity_events WHERE idempotency_key = ?").get(normalized.idempotencyKey)) as ActivityRow | undefined;
  if (!row) throw new Error("activity append conflicted without a resolvable idempotency key");
  return { inserted: result.changes === 1, event: activityEventFromRow(row) };
}
