import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { initDb } from "../sessions/registry.js";
import { activityEventFromRow, type ActivityRow } from "./store.js";
import { ActivityCursorSecretError, activityCursorSecret } from "./cursor-secret.js";
import { activitySearchQuery, normalizeActivitySearch } from "./projection.js";
import {
  ACTIVITY_KINDS,
  ACTIVITY_OUTCOMES,
  type ActivityEvent,
  type ActivityKind,
  type ActivityOutcomeState,
  type ActivityPage,
  type ActivityStory,
  type ActivityStoryDetail,
  type ActivityTotals,
} from "./types.js";

export interface ActivityQuery {
  limit?: number;
  cursor?: string;
  q?: string;
  kinds?: ActivityKind[];
  outcomes?: ActivityOutcomeState[];
}

export interface ActivityQueryOptions {
  database?: Database.Database;
  now?: () => Date;
}

interface CursorPayload {
  v: 3;
  occurredAt: string;
  id: string;
  snapshotSeq: number;
  asOf: string;
  queryHash: string;
  totals: ActivityTotals;
}

interface RepresentativeRow extends Record<string, unknown> {
  seq: number;
  id: string;
  story_id: string;
  occurred_at: string;
  event_count: number;
}

export class ActivityQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActivityQueryError";
  }
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function normalizedQuery(query: ActivityQuery): Required<Pick<ActivityQuery, "limit">> & Omit<ActivityQuery, "limit"> {
  const limit = query.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ActivityQueryError("limit must be an integer between 1 and 200");
  const q = query.q?.trim();
  if (q && q.length > 256) throw new ActivityQueryError("q must be at most 256 characters");
  const kinds = [...new Set(query.kinds ?? [])].sort();
  const outcomes = [...new Set(query.outcomes ?? [])].sort();
  if (kinds.some((kind) => !ACTIVITY_KINDS.includes(kind))) throw new ActivityQueryError("kind filter is invalid");
  if (outcomes.some((outcome) => !ACTIVITY_OUTCOMES.includes(outcome))) throw new ActivityQueryError("outcome filter is invalid");
  return {
    limit,
    ...(query.cursor ? { cursor: query.cursor } : {}),
    ...(q ? { q: normalizeActivitySearch(q) } : {}),
    ...(kinds.length ? { kinds } : {}),
    ...(outcomes.length ? { outcomes } : {}),
  };
}

function queryHash(query: ReturnType<typeof normalizedQuery>): string {
  return createHash("sha256")
    .update(JSON.stringify({ q: query.q ?? "", kinds: query.kinds ?? [], outcomes: query.outcomes ?? [] }))
    .digest("hex")
    .slice(0, 16);
}

function decodeCursor(raw: string, expectedHash: string, secret: Buffer): CursorPayload {
  try {
    const parts = raw.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("invalid token");
    const payloadBytes = Buffer.from(parts[0], "base64url");
    const supplied = Buffer.from(parts[1], "base64url");
    const expected = createHmac("sha256", secret).update(payloadBytes).digest();
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("invalid signature");
    const parsed = JSON.parse(payloadBytes.toString("utf8")) as Partial<CursorPayload>;
    if (Object.keys(parsed).sort().join(",") !== "asOf,id,occurredAt,queryHash,snapshotSeq,totals,v") throw new Error("invalid fields");
    if (
      parsed.v !== 3 || !canonicalIso(parsed.occurredAt) ||
      typeof parsed.id !== "string" || !/^act_[a-zA-Z0-9-]+$/.test(parsed.id) ||
      !Number.isSafeInteger(parsed.snapshotSeq) || (parsed.snapshotSeq ?? -1) < 0 ||
      !canonicalIso(parsed.asOf) || parsed.queryHash !== expectedHash ||
      !parsed.totals || typeof parsed.totals !== "object" || !Number.isSafeInteger(parsed.totals.matching)
    ) throw new Error("invalid payload");
    return parsed as CursorPayload;
  } catch {
    throw new ActivityQueryError("cursor is invalid or does not match the current filters");
  }
}

function encodeCursor(payload: CursorPayload, secret: Buffer): string {
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  const signature = createHmac("sha256", secret).update(bytes).digest("base64url");
  return `${bytes.toString("base64url")}.${signature}`;
}

function filteredWhere(
  query: ReturnType<typeof normalizedQuery>,
  snapshotSeq: number,
): { sql: string; params: Record<string, unknown> } {
  const clauses = ["1 = 1"];
  const params: Record<string, unknown> = { snapshotSeq };
  if (query.kinds?.length) {
    const names = query.kinds.map((kind, index) => {
      const name = `kind${index}`;
      params[name] = kind;
      return `@${name}`;
    });
    clauses.push(`snapshot_projection.kind IN (${names.join(",")})`);
  }
  if (query.outcomes?.length) {
    const names = query.outcomes.map((outcome, index) => {
      const name = `outcome${index}`;
      params[name] = outcome;
      return `@${name}`;
    });
    clauses.push(`snapshot_projection.outcome_state IN (${names.join(",")})`);
  }
  if (query.q) {
    const searchQuery = activitySearchQuery(query.q);
    if (!searchQuery) throw new ActivityQueryError("q must contain searchable letters or numbers");
    params.searchQuery = searchQuery;
    clauses.push(`snapshot_projection.story_id IN (
      SELECT story_id FROM activity_event_search
      WHERE activity_event_search MATCH @searchQuery AND CAST(seq AS INTEGER) <= @snapshotSeq
    )`);
  }
  return { sql: clauses.join(" AND "), params };
}

function storiesCte(where: string, currentSnapshot: boolean): string {
  const projection = currentSnapshot
    ? `SELECT story_id, latest_event_id, occurred_at, event_count, kind, outcome_state FROM activity_stories`
    : `SELECT story_id, latest_event_id, occurred_at, event_count, kind, outcome_state
      FROM activity_stories
      WHERE last_append_seq <= @snapshotSeq
      UNION ALL
      SELECT versions.story_id, versions.latest_event_id, versions.occurred_at,
        versions.event_count, versions.kind, versions.outcome_state
      FROM activity_stories current
      JOIN activity_story_versions versions ON versions.story_id = current.story_id
      WHERE current.last_append_seq > @snapshotSeq
        AND versions.append_seq = (
          SELECT MAX(candidate.append_seq) FROM activity_story_versions candidate
          WHERE candidate.story_id = current.story_id AND candidate.append_seq <= @snapshotSeq
        )`;
  return `
    WITH snapshot_projection AS (
      ${projection}
    ), filtered_projection AS (
      SELECT * FROM snapshot_projection WHERE ${where}
    ), filtered_stories AS (
      SELECT events.*, filtered_projection.event_count
      FROM filtered_projection
      JOIN activity_events events ON events.id = filtered_projection.latest_event_id
    )
  `;
}

function eventRowsForStories(database: Database.Database, storyIds: string[], snapshotSeq: number): Map<string, ActivityEvent[]> {
  const grouped = new Map<string, ActivityEvent[]>();
  if (storyIds.length === 0) return grouped;
  const params: Record<string, unknown> = { snapshotSeq };
  const names = storyIds.map((storyId, index) => {
    const name = `story${index}`;
    params[name] = storyId;
    return `@${name}`;
  });
  const rows = database.prepare(`
    SELECT * FROM activity_events
    WHERE seq <= @snapshotSeq AND story_id IN (${names.join(",")})
    ORDER BY occurred_at DESC, id DESC
  `).all(params) as Record<string, unknown>[];
  for (const row of rows) {
    const event = activityEventFromRow(row as unknown as ActivityRow);
    const events = grouped.get(event.storyId) ?? [];
    events.push(event);
    grouped.set(event.storyId, events);
  }
  return grouped;
}

function storyFromRepresentative(row: RepresentativeRow, events: ActivityEvent[]): ActivityStory {
  const representative = activityEventFromRow(row as unknown as ActivityRow);
  return {
    id: representative.storyId,
    headline: representative.summary,
    actor: representative.actor,
    object: representative.object,
    outcome: representative.outcome,
    latestAt: representative.occurredAt,
    eventCount: Number(row.event_count),
    preview: events.slice(0, 3),
  };
}

function globalBreakdown(database: Database.Database, snapshotSeq: number, now: Date, currentSnapshot: boolean): Omit<ActivityTotals, "matching"> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const projection = currentSnapshot
    ? "SELECT story_id, occurred_at, kind, outcome_state FROM activity_stories"
    : `SELECT story_id, occurred_at, kind, outcome_state FROM activity_stories WHERE last_append_seq <= ?
      UNION ALL
      SELECT versions.story_id, versions.occurred_at, versions.kind, versions.outcome_state
      FROM activity_stories current
      JOIN activity_story_versions versions ON versions.story_id = current.story_id
      WHERE current.last_append_seq > ?
        AND versions.append_seq = (
          SELECT MAX(candidate.append_seq) FROM activity_story_versions candidate
          WHERE candidate.story_id = current.story_id AND candidate.append_seq <= ?
        )`;
  const rows = database.prepare(`
    WITH snapshot_projection AS (
      ${projection}
    )
    SELECT kind, outcome_state, COUNT(*) AS n,
      COALESCE(SUM(CASE WHEN occurred_at >= ? THEN 1 ELSE 0 END), 0) AS today
    FROM snapshot_projection GROUP BY kind, outcome_state
  `).all(...(currentSnapshot ? [dayStart] : [snapshotSeq, snapshotSeq, snapshotSeq, dayStart])) as Array<{
    kind: ActivityKind;
    outcome_state: ActivityOutcomeState;
    n: number;
    today: number;
  }>;
  const byKind: Partial<Record<ActivityKind, number>> = {};
  const byOutcome: Partial<Record<ActivityOutcomeState, number>> = {};
  let total = 0;
  let today = 0;
  for (const row of rows) {
    total += row.n;
    today += row.today;
    byKind[row.kind] = (byKind[row.kind] ?? 0) + row.n;
    byOutcome[row.outcome_state] = (byOutcome[row.outcome_state] ?? 0) + row.n;
  }
  return { total, today, attention: byOutcome.attention ?? 0, failed: byOutcome.failed ?? 0, byKind, byOutcome };
}

function matchingTotals(
  database: Database.Database,
  cte: string,
  params: Record<string, unknown>,
): Pick<ActivityTotals, "matching" | "byKind" | "byOutcome"> {
  const rows = database.prepare(`${cte}
    SELECT kind, outcome_state, COUNT(*) AS n
    FROM filtered_projection GROUP BY kind, outcome_state
  `).all(params) as Array<{ kind: ActivityKind; outcome_state: ActivityOutcomeState; n: number }>;
  const byKind: Partial<Record<ActivityKind, number>> = {};
  const byOutcome: Partial<Record<ActivityOutcomeState, number>> = {};
  let matching = 0;
  for (const row of rows) {
    matching += row.n;
    byKind[row.kind] = (byKind[row.kind] ?? 0) + row.n;
    byOutcome[row.outcome_state] = (byOutcome[row.outcome_state] ?? 0) + row.n;
  }
  return {
    matching,
    byKind,
    byOutcome,
  };
}

export function queryActivityPage(rawQuery: ActivityQuery = {}, options: ActivityQueryOptions = {}): ActivityPage {
  const database = options.database ?? initDb();
  let secret: Buffer;
  try {
    secret = activityCursorSecret(database);
  } catch (error) {
    if (error instanceof ActivityCursorSecretError) throw new ActivityQueryError("activity cursor state is unavailable");
    throw error;
  }
  const query = normalizedQuery(rawQuery);
  const hash = queryHash(query);
  const now = options.now?.() ?? new Date();
  const max = database.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM activity_events").get() as { n: number };
  const cursor = query.cursor ? decodeCursor(query.cursor, hash, secret) : undefined;
  const snapshotSeq = cursor?.snapshotSeq ?? max.n;
  const currentSnapshot = snapshotSeq === max.n;
  const asOf = cursor?.asOf ?? now.toISOString();
  const filtered = filteredWhere(query, snapshotSeq);
  const cte = storiesCte(filtered.sql, currentSnapshot);
  const pageParams: Record<string, unknown> = { ...filtered.params, pageLimit: query.limit + 1 };
  let keyset = "";
  if (cursor) {
    pageParams.cursorOccurredAt = cursor.occurredAt;
    pageParams.cursorId = cursor.id;
    keyset = `WHERE (occurred_at < @cursorOccurredAt OR (occurred_at = @cursorOccurredAt AND id < @cursorId))`;
  }
  const rows = database.prepare(`
    ${cte}
    SELECT * FROM filtered_stories
    ${keyset}
    ORDER BY occurred_at DESC, id DESC
    LIMIT @pageLimit
  `).all(pageParams) as RepresentativeRow[];
  const hasMore = rows.length > query.limit;
  const visible = rows.slice(0, query.limit);
  const events = eventRowsForStories(database, visible.map((row) => row.story_id), snapshotSeq);
  const items = visible.map((row) => storyFromRepresentative(row, events.get(row.story_id) ?? []));
  let totals = cursor?.totals;
  if (!totals) {
    const global = globalBreakdown(database, snapshotSeq, new Date(asOf), currentSnapshot);
    const unfiltered = !query.q && !query.kinds?.length && !query.outcomes?.length;
    totals = unfiltered
      ? { ...global, matching: global.total }
      : { ...global, ...matchingTotals(database, cte, filtered.params) };
  }
  const last = visible.at(-1);
  const nextCursor = hasMore && last
    ? encodeCursor({ v: 3, occurredAt: last.occurred_at, id: last.id, snapshotSeq, asOf, queryHash: hash, totals }, secret)
    : null;

  return {
    items,
    page: { nextCursor, hasMore },
    totals,
    asOf,
  };
}

export function getActivityStory(storyId: string, options: Pick<ActivityQueryOptions, "database"> = {}): ActivityStoryDetail | null {
  if (!/^story_[a-f0-9]{24}$/.test(storyId)) throw new ActivityQueryError("storyId is invalid");
  const database = options.database ?? initDb();
  const rows = database.prepare(`
    SELECT * FROM activity_events WHERE story_id = ? ORDER BY occurred_at ASC, id ASC
  `).all(storyId) as Record<string, unknown>[];
  if (rows.length === 0) return null;
  const events = rows.map((row) => activityEventFromRow(row as unknown as ActivityRow));
  const representativeRow = rows[rows.length - 1] as RepresentativeRow;
  representativeRow.event_count = rows.length;
  const newestFirst = [...events].reverse();
  const links = new Map<string, NonNullable<ActivityEvent["links"]>[number]>();
  for (const event of events) {
    for (const link of event.links ?? []) links.set(`${link.rel}\0${link.href}`, link);
  }
  return {
    story: storyFromRepresentative(representativeRow, newestFirst),
    events,
    links: [...links.values()],
  };
}
