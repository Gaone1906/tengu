export const ACTIVITY_KINDS = [
  "session",
  "delegation",
  "todo",
  "workflow",
  "approval",
  "cron",
  "system",
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const ACTIVITY_OUTCOMES = [
  "running",
  "succeeded",
  "failed",
  "attention",
  "cancelled",
  "info",
] as const;

export type ActivityOutcomeState = (typeof ACTIVITY_OUTCOMES)[number];
export type ActivityActorType = "operator" | "employee" | "system";
export type ActivityJsonValue = null | boolean | number | string | ActivityJsonValue[] | { [key: string]: ActivityJsonValue };

export interface ActivityActor {
  type: ActivityActorType;
  id: string;
  displayName: string;
}

export interface ActivityObject {
  type: string;
  id: string;
  label: string;
  href?: string;
}

export interface ActivityOutcome {
  state: ActivityOutcomeState;
  label: string;
}

export interface ActivityLink {
  rel: string;
  label: string;
  href: string;
}

export interface ActivityEventInput {
  occurredAt: string;
  kind: ActivityKind;
  action: string;
  actor: ActivityActor;
  object: ActivityObject;
  outcome: ActivityOutcome;
  summary: string;
  correlationId: string;
  causationId?: string;
  rootEventId?: string;
  attempt?: number;
  idempotencyKey?: string;
  detailRef?: string;
  detail?: ActivityJsonValue;
  links?: ActivityLink[];
}

export interface ActivityEvent extends ActivityEventInput {
  id: string;
  storyId: string;
  seq: number;
}

export interface ActivityAppendResult {
  inserted: boolean;
  event: ActivityEvent;
}

export interface ActivityStory {
  id: string;
  headline: string;
  actor: ActivityActor;
  object: ActivityObject;
  outcome: ActivityOutcome;
  latestAt: string;
  eventCount: number;
  preview: ActivityEvent[];
}

export interface ActivityTotals {
  matching: number;
  total: number;
  today: number;
  attention: number;
  failed: number;
  byKind: Partial<Record<ActivityKind, number>>;
  byOutcome: Partial<Record<ActivityOutcomeState, number>>;
}

export interface ActivityPage {
  items: ActivityStory[];
  page: { nextCursor: string | null; hasMore: boolean };
  totals: ActivityTotals;
  asOf: string;
}

export interface ActivityStoryDetail {
  story: ActivityStory;
  events: ActivityEvent[];
  links: ActivityLink[];
}
