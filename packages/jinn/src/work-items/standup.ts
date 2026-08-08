import { listWorkItems, listWorkItemEventsForItems, getWorkItem, type WorkItem, type WorkItemEvent } from './store.js';
import { listComments, type WorkItemComment } from './comments.js';
import { computeRootProgress, type RootProgress } from './progress.js';
import { SECURITY_EMPLOYEE_NAME } from '../security/audit.js';

export interface StandupWindow {
  since?: string;
  until?: string;
}

export type StandupIncidentKind = 'security-block' | 'pacing-circuit-breaker';

export interface StandupIncident {
  kind: StandupIncidentKind;
  at: string;
  actor: string | null;
  workItemId: string;
  summary: string;
}

export interface DepartmentStandup {
  department: string;
  progress: RootProgress;
  blocked: WorkItem[];
  incidents: StandupIncident[];
  events: WorkItemEvent[];
  narrative: string;
  narrativeFromCache: boolean;
  latestEventAt: string | null;
}

export interface ProjectStandup {
  rootId: string;
  title: string;
  workspacePath: string | null;
  departments: DepartmentStandup[];
}

export interface NarrationInput {
  rootId: string;
  projectTitle: string;
  department: string;
  progress: RootProgress;
  events: WorkItemEvent[];
  comments: WorkItemComment[];
}

// Real dispatch is a Haiku/Sonnet-low `scribe` session (D6) — never Opus, never the
// work engine. No one-shot non-interactive engine call exists yet (every engine call
// today is a full interactive PTY session), so this stays injectable.
export type Narrator = (input: NarrationInput) => Promise<string> | string;

function templateNarrative(input: NarrationInput): string {
  const { progress, events, department } = input;
  if (events.length === 0) {
    return `No activity in ${department} this window — ${progress.completed}/${progress.total} done.`;
  }
  const statusChanges = events.filter((e) => e.kind === 'status_change' || e.kind === 'escalated');
  const blocks = statusChanges.filter((e) => e.toStatus === 'blocked');
  const closes = statusChanges.filter((e) => e.toStatus === 'done');
  const parts = [`${progress.completed}/${progress.total} done, ${progress.inFlight} in flight in ${department}.`];
  if (closes.length > 0) parts.push(`Closed ${closes.length} item${closes.length === 1 ? '' : 's'} this window.`);
  if (blocks.length > 0) parts.push(`Hit ${blocks.length} block${blocks.length === 1 ? '' : 's'} along the way.`);
  return parts.join(' ');
}

// Fallback narrator, used until a real scribe dispatch exists (see the Narrator comment above).
export const defaultNarrator: Narrator = templateNarrative;

interface CacheEntry {
  latestEventAt: string | null;
  narrative: string;
}

// Keyed by (project, department, latest-event-timestamp): an unchanged window keeps
// the same latest timestamp, so a repeat call never re-invokes the narrator. Process-
// local for now; durable once stand-up snapshots are cron-scheduled rather than
// only computed on request.
const narrativeCache = new Map<string, CacheEntry>();

function cacheKey(rootId: string, department: string): string {
  return `${rootId} ${department}`;
}

export function clearStandupNarrativeCache(): void {
  narrativeCache.clear();
}

function latestTimestamp(events: readonly { createdAt: string }[]): string | null {
  let latest: string | null = null;
  for (const event of events) {
    if (latest === null || event.createdAt > latest) latest = event.createdAt;
  }
  return latest;
}

function inWindow(createdAt: string, window: StandupWindow | undefined): boolean {
  if (window?.since && createdAt < window.since) return false;
  if (window?.until && createdAt > window.until) return false;
  return true;
}

const NARRATIVE_EVENT_KINDS: ReadonlySet<WorkItemEvent['kind']> = new Set([
  'status_change',
  'escalated',
  'comment_added',
  'approval_requested',
  'approval_decided',
]);

export async function computeDepartmentStandup(
  rootId: string,
  department: string,
  opts: { window?: StandupWindow; narrator?: Narrator; projectTitle?: string } = {},
): Promise<DepartmentStandup> {
  const narrator = opts.narrator ?? defaultNarrator;
  const progress = computeRootProgress(rootId, { department });
  const items = listWorkItems({ rootId, department });
  const itemIds = items.map((item) => item.id);
  const blocked = items.filter((item) => item.status === 'blocked');

  const eventsByItem = listWorkItemEventsForItems(itemIds);
  const allEvents = itemIds.flatMap((id) => eventsByItem.get(id) ?? []);
  const latestEventAt = latestTimestamp(allEvents);

  const windowedEvents = allEvents
    .filter((e) => NARRATIVE_EVENT_KINDS.has(e.kind) && inWindow(e.createdAt, opts.window))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

  const windowedComments = itemIds
    .flatMap((id) => listComments(id, { limit: 500 }).comments)
    .filter((c) => inWindow(c.createdAt, opts.window))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

  // Security blocks land as `security`-authored system comments (security/audit.ts's
  // recordSecurityBlock) — surfaced here as incidents rather than re-derived.
  const incidents: StandupIncident[] = windowedComments
    .filter((c) => c.authorKind === 'system' && c.author === SECURITY_EMPLOYEE_NAME)
    .map((c) => ({ kind: 'security-block' as const, at: c.createdAt, actor: c.author, workItemId: c.workItemId, summary: c.body }));
  // INTEGRATION POINT: pacing circuit-breaker trips (08-pacing-controller.md, D9) have
  // no attributed receipt format yet — add a 'pacing-circuit-breaker' incident here
  // once shared/pacing-controller.ts lands one.

  const key = cacheKey(rootId, department);
  const cached = narrativeCache.get(key);
  const base = { department, progress, blocked, incidents, events: windowedEvents, latestEventAt };
  if (cached && cached.latestEventAt === latestEventAt) {
    return { ...base, narrative: cached.narrative, narrativeFromCache: true };
  }

  const root = getWorkItem(rootId);
  const narrative = await narrator({
    rootId,
    projectTitle: opts.projectTitle ?? root?.title ?? rootId,
    department,
    progress,
    events: windowedEvents,
    comments: windowedComments,
  });
  narrativeCache.set(key, { latestEventAt, narrative });
  return { ...base, narrative, narrativeFromCache: false };
}

export function departmentsForRoot(rootId: string): string[] {
  const departments = new Set<string>();
  for (const item of listWorkItems({ rootId })) {
    if (item.department) departments.add(item.department);
  }
  return [...departments].sort((a, b) => a.localeCompare(b));
}

export async function computeProjectStandup(
  rootId: string,
  opts: { window?: StandupWindow; narrator?: Narrator } = {},
): Promise<ProjectStandup> {
  const root = getWorkItem(rootId);
  if (!root) throw new Error(`computeProjectStandup: root Todo ${rootId} not found`);
  if (root.depth !== 0) throw new Error(`computeProjectStandup: ${rootId} is depth ${root.depth} — a project is a root (depth 0)`);
  const departments = await Promise.all(
    departmentsForRoot(rootId).map((department) =>
      computeDepartmentStandup(rootId, department, { window: opts.window, narrator: opts.narrator, projectTitle: root.title }),
    ),
  );
  return { rootId, title: root.title, workspacePath: root.workspacePath, departments };
}

// Roots without a workspacePath are not necessarily Tengu "projects" — excluded
// rather than shown as a blank card.
export function listStandupProjects(): WorkItem[] {
  return listWorkItems({ rootsOnly: true }).filter((item) => item.workspacePath !== null);
}

export async function computeStandup(opts: { window?: StandupWindow; narrator?: Narrator } = {}): Promise<ProjectStandup[]> {
  return Promise.all(listStandupProjects().map((project) => computeProjectStandup(project.id, opts)));
}
