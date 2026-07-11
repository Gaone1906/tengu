import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { initDb } from "../sessions/registry.js";
import { activityEventFromRow, type ActivityRow } from "./store.js";
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
  v: 1;
  occurredAt: string;
  id: string;
  snapshotSeq: number;
  asOf: string;
  queryHash: string;
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
    ...(q ? { q } : {}),
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

function decodeCursor(raw: string, expectedHash: string): CursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<CursorPayload>;
    if (
      parsed.v !== 1 || !canonicalIso(parsed.occurredAt) ||
      typeof parsed.id !== "string" || !/^act_[a-zA-Z0-9-]+$/.test(parsed.id) ||
      !Number.isSafeInteger(parsed.snapshotSeq) || (parsed.snapshotSeq ?? -1) < 0 ||
      !canonicalIso(parsed.asOf) || parsed.queryHash !== expectedHash
    ) throw new Error("invalid payload");
    return parsed as CursorPayload;
  } catch {
    throw new ActivityQueryError("cursor is invalid or does not match the current filters");
  }
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function filteredWhere(
  query: ReturnType<typeof normalizedQuery>,
  snapshotSeq: number,
): { sql: string; params: Record<string, unknown> } {
  const clauses = ["seq <= @snapshotSeq"];
  const params: Record<string, unknown> = { snapshotSeq };
  if (query.kinds?.length) {
    const names = query.kinds.map((kind, index) => {
      const name = `kind${index}`;
      params[name] = kind;
      return `@${name}`;
    });
    clauses.push(`kind IN (${names.join(",")})`);
  }
  if (query.outcomes?.length) {
    const names = query.outcomes.map((outcome, index) => {
      const name = `outcome${index}`;
      params[name] = outcome;
      return `@${name}`;
    });
    clauses.push(`outcome_state IN (${names.join(",")})`);
  }
  if (query.q) {
    params.q = query.q.toLocaleLowerCase();
    clauses.push(`instr(lower(
      summary || ' ' || action || ' ' || actor_display_name || ' ' || actor_id || ' ' ||
      object_label || ' ' || object_id || ' ' || outcome_label
    ), @q) > 0`);
  }
  return { sql: clauses.join(" AND "), params };
}

function storiesCte(where: string): string {
  return `
    WITH filtered AS (
      SELECT *,
        ROW_NUMBER() OVER (PARTITION BY story_id ORDER BY occurred_at DESC, id DESC) AS story_rank
      FROM activity_events
      WHERE ${where}
    ), stories AS (
      SELECT filtered.*,
        (SELECT COUNT(*) FROM activity_events all_events
          WHERE all_events.story_id = filtered.story_id AND all_events.seq <= @snapshotSeq) AS event_count
      FROM filtered
      WHERE story_rank = 1
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

function globalTotals(database: Database.Database, snapshotSeq: number, now: Date): Omit<ActivityTotals, "matching" | "byKind" | "byOutcome"> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const row = database.prepare(`
    WITH ranked AS (
      SELECT occurred_at, outcome_state,
        ROW_NUMBER() OVER (PARTITION BY story_id ORDER BY occurred_at DESC, id DESC) AS story_rank
      FROM activity_events WHERE seq <= ?
    )
    SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN occurred_at >= ? THEN 1 ELSE 0 END), 0) AS today,
      COALESCE(SUM(CASE WHEN outcome_state = 'attention' THEN 1 ELSE 0 END), 0) AS attention,
      COALESCE(SUM(CASE WHEN outcome_state = 'failed' THEN 1 ELSE 0 END), 0) AS failed
    FROM ranked WHERE story_rank = 1
  `).get(snapshotSeq, dayStart) as { total: number; today: number; attention: number; failed: number };
  return row;
}

function matchingTotals(
  database: Database.Database,
  cte: string,
  params: Record<string, unknown>,
): Pick<ActivityTotals, "matching" | "byKind" | "byOutcome"> {
  const matching = database.prepare(`${cte} SELECT COUNT(*) AS n FROM stories`).get(params) as { n: number };
  const byKindRows = database.prepare(`${cte} SELECT kind AS key, COUNT(*) AS n FROM stories GROUP BY kind`).all(params) as Array<{ key: ActivityKind; n: number }>;
  const byOutcomeRows = database.prepare(`${cte} SELECT outcome_state AS key, COUNT(*) AS n FROM stories GROUP BY outcome_state`).all(params) as Array<{ key: ActivityOutcomeState; n: number }>;
  return {
    matching: matching.n,
    byKind: Object.fromEntries(byKindRows.map((row) => [row.key, row.n])),
    byOutcome: Object.fromEntries(byOutcomeRows.map((row) => [row.key, row.n])),
  };
}

export function queryActivityPage(rawQuery: ActivityQuery = {}, options: ActivityQueryOptions = {}): ActivityPage {
  const database = options.database ?? initDb();
  const query = normalizedQuery(rawQuery);
  const hash = queryHash(query);
  const now = options.now?.() ?? new Date();
  const max = database.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM activity_events").get() as { n: number };
  const cursor = query.cursor ? decodeCursor(query.cursor, hash) : undefined;
  const snapshotSeq = cursor?.snapshotSeq ?? max.n;
  const asOf = cursor?.asOf ?? now.toISOString();
  const filtered = filteredWhere(query, snapshotSeq);
  const cte = storiesCte(filtered.sql);
  const pageParams: Record<string, unknown> = { ...filtered.params, pageLimit: query.limit + 1 };
  let keyset = "";
  if (cursor) {
    pageParams.cursorOccurredAt = cursor.occurredAt;
    pageParams.cursorId = cursor.id;
    keyset = `WHERE (occurred_at < @cursorOccurredAt OR (occurred_at = @cursorOccurredAt AND id < @cursorId))`;
  }
  const rows = database.prepare(`
    ${cte}
    SELECT * FROM stories
    ${keyset}
    ORDER BY occurred_at DESC, id DESC
    LIMIT @pageLimit
  `).all(pageParams) as RepresentativeRow[];
  const hasMore = rows.length > query.limit;
  const visible = rows.slice(0, query.limit);
  const events = eventRowsForStories(database, visible.map((row) => row.story_id), snapshotSeq);
  const items = visible.map((row) => storyFromRepresentative(row, events.get(row.story_id) ?? []));
  const last = visible.at(-1);
  const nextCursor = hasMore && last
    ? encodeCursor({ v: 1, occurredAt: last.occurred_at, id: last.id, snapshotSeq, asOf, queryHash: hash })
    : null;

  return {
    items,
    page: { nextCursor, hasMore },
    totals: {
      ...globalTotals(database, snapshotSeq, new Date(asOf)),
      ...matchingTotals(database, cte, filtered.params),
    },
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
