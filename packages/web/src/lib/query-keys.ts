export const TODO_WRITE_KEY = ['todo-write'] as const

/** Todo surfaces resync when you return to them: an invalidation that lands
 * while the surface is unmounted must not survive its next mount (ICI-659). */
export const TODO_QUERY_FRESHNESS = { staleTime: 10_000, refetchOnMount: true } as const

export const queryKeys = {
  pins: ['pins'] as const,
  sessions: {
    all: ['sessions'] as const,
    search: (q: string) => ['sessions', 'search', q] as const,
    detail: (id: string) => ['sessions', id] as const,
    children: (id: string) => ['sessions', id, 'children'] as const,
    transcript: (id: string) => ['sessions', id, 'transcript'] as const,
    queue: (id: string) => ['sessions', id, 'queue'] as const,
  },
  org: {
    all: ['org'] as const,
    employee: (name: string) => ['org', 'employees', name] as const,
    board: (dept: string) => ['org', 'departments', dept, 'board'] as const,
  },
  cron: {
    all: ['cron'] as const,
    jobs: ['cron-jobs'] as const,
    runs: (id: string) => ['cron', id, 'runs'] as const,
  },
  workflows: {
    all: ['workflows'] as const,
    definition: (id: string) => ['workflows', 'definition', id] as const,
    runs: (id: string) => ['workflows', 'runs', id] as const,
    run: (id: string, runId: string) => ['workflows', 'runs', id, runId] as const,
    runPrompt: (id: string, runId: string, attemptKey: string) =>
      ['workflows', 'runs', id, runId, 'prompt', attemptKey] as const,
  },
  skills: {
    all: ['skills'] as const,
    detail: (name: string) => ['skills', name] as const,
  },
  notes: {
    all: ['notes'] as const,
    list: (query = '') => query ? ['notes', { query }] as const : ['notes'] as const,
    document: (path: string) => ['note', path] as const,
  },
  engines: {
    all: ['engines'] as const,
  },
  config: ['config'] as const,
  status: ['status'] as const,
  workspaces: ['workspaces'] as const,
  instanceMigration: ['instance-migration'] as const,
  onboarding: ['onboarding'] as const,
} as const
