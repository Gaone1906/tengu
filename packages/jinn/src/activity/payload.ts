import { createHash } from "node:crypto";
import type { ActivityEventInput, ActivityJsonValue, ActivityLink } from "./types.js";

type PersistedPayload = {
  occurredAt: string;
  kind: string;
  action: string;
  actorType: string;
  actorId: string;
  actorDisplayName: string;
  objectType: string;
  objectId: string;
  objectLabel: string;
  objectHref: string | null;
  outcomeState: string;
  outcomeLabel: string;
  summary: string;
  correlationId: string;
  causationId: string | null;
  rootEventId: string | null;
  attempt: number | null;
  idempotencyKey: string | null;
  detailRef: string | null;
  detailPresent: boolean;
  detail: ActivityJsonValue | null;
  linksPresent: boolean;
  links: ActivityLink[] | null;
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function digest(payload: PersistedPayload): string {
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

export function activityPayloadHash(input: ActivityEventInput): string {
  return digest({
    occurredAt: input.occurredAt,
    kind: input.kind,
    action: input.action,
    actorType: input.actor.type,
    actorId: input.actor.id,
    actorDisplayName: input.actor.displayName,
    objectType: input.object.type,
    objectId: input.object.id,
    objectLabel: input.object.label,
    objectHref: input.object.href ?? null,
    outcomeState: input.outcome.state,
    outcomeLabel: input.outcome.label,
    summary: input.summary,
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
    rootEventId: input.rootEventId ?? null,
    attempt: input.attempt ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    detailRef: input.detailRef ?? null,
    detailPresent: input.detail !== undefined,
    detail: input.detail === undefined ? null : input.detail,
    linksPresent: input.links !== undefined,
    links: input.links === undefined ? null : input.links,
  });
}

export function activityPayloadHashFromRow(row: Record<string, unknown>): string {
  let detail: ActivityJsonValue | null = null;
  let links: ActivityLink[] | null = null;
  try {
    detail = row.detail_json === null || row.detail_json === undefined
      ? null
      : JSON.parse(String(row.detail_json)) as ActivityJsonValue;
    links = row.links_json === null || row.links_json === undefined
      ? null
      : JSON.parse(String(row.links_json)) as ActivityLink[];
  } catch {
    throw new Error("legacy activity payload is not valid JSON");
  }
  return digest({
    occurredAt: String(row.occurred_at),
    kind: String(row.kind),
    action: String(row.action),
    actorType: String(row.actor_type),
    actorId: String(row.actor_id),
    actorDisplayName: String(row.actor_display_name),
    objectType: String(row.object_type),
    objectId: String(row.object_id),
    objectLabel: String(row.object_label),
    objectHref: row.object_href === null ? null : String(row.object_href),
    outcomeState: String(row.outcome_state),
    outcomeLabel: String(row.outcome_label),
    summary: String(row.summary),
    correlationId: String(row.correlation_id),
    causationId: row.causation_id === null ? null : String(row.causation_id),
    rootEventId: row.root_event_id === null ? null : String(row.root_event_id),
    attempt: row.attempt === null ? null : Number(row.attempt),
    idempotencyKey: row.idempotency_key === null ? null : String(row.idempotency_key),
    detailRef: row.detail_ref === null ? null : String(row.detail_ref),
    detailPresent: row.detail_json !== null && row.detail_json !== undefined,
    detail,
    linksPresent: row.links_json !== null && row.links_json !== undefined,
    links,
  });
}
