import { Component, Suspense, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Navigate, Outlet, RouterProvider, createBrowserRouter } from 'react-router-dom'
import { ClientProviders } from './routes/client-providers'
import { lazyRoute } from './lib/lazy-route'
import { registerRoutePrefetch } from './lib/route-prefetch'
import { TodosIndexRedirect } from './routes/todos/board/todos-index-redirect'
import { useFeatures } from './hooks/use-features'
import './routes/globals.css'

const ChatPage = lazyRoute(() => import('./routes/chat/page'), 'chat')
const CronPage = lazyRoute(() => import('./routes/cron/page'), 'cron')
const CronDetailPage = lazyRoute(() => import('./routes/cron/detail'), 'cron-detail')
const TodoBoardPage = lazyRoute(() => import('./routes/todos/board/board-page'), 'todo-board')
const TaskPage = lazyRoute(() => import('./routes/todos/task-page/task-page'), 'todo-task')
const NotesPage = lazyRoute(() => import('./routes/notes/page'), 'notes')
const ExperimentsPage = lazyRoute(() => import('./routes/experiments/page'), 'experiments')
const ExperimentDetailPage = lazyRoute(() => import('./routes/experiments/detail'), 'experiment-detail')
const LogsPage = lazyRoute(() => import('./routes/logs/page'), 'logs')
const LimitsPage = lazyRoute(() => import('./routes/limits/page'), 'limits')
const OrgPage = lazyRoute(() => import('./routes/org/page'), 'org')
const SettingsPage = lazyRoute(() => import('./routes/settings/page'), 'settings')
const SkillsPage = lazyRoute(() => import('./routes/skills/page'), 'skills')
const SkillDetailPage = lazyRoute(() => import('./routes/skills/detail'), 'skill-detail')
const FilePage = lazyRoute(() => import('./routes/file/page'), 'file')
const MorePage = lazyRoute(() => import('./routes/more/page'), 'more')
const RedesignPage = lazyRoute(() => import('./routes/redesign/page'), 'redesign')
const WorkflowListPage = lazyRoute(() => import('./routes/workflow/list'), 'workflow-list')
const WorkflowPage = lazyRoute(() => import('./routes/workflow/page'), 'workflow')
const WorkflowRunPage = lazyRoute(() => import('./routes/workflow/run'), 'workflow-run')

registerRoutePrefetch('/', ChatPage.prefetch)
registerRoutePrefetch('/cron', CronPage.prefetch)
registerRoutePrefetch('/todos', TodoBoardPage.prefetch)
registerRoutePrefetch('/notes', NotesPage.prefetch)
registerRoutePrefetch('/experiments', ExperimentsPage.prefetch)
registerRoutePrefetch('/logs', LogsPage.prefetch)
registerRoutePrefetch('/limits', LimitsPage.prefetch)
registerRoutePrefetch('/org', OrgPage.prefetch)
registerRoutePrefetch('/settings', SettingsPage.prefetch)
registerRoutePrefetch('/skills', SkillsPage.prefetch)
registerRoutePrefetch('/more', MorePage.prefetch)
registerRoutePrefetch('/workflow', WorkflowListPage.prefetch)

if (typeof window !== 'undefined') {
  const scheduleIdle = window.requestIdleCallback
    ? (callback: () => void) => window.requestIdleCallback(callback)
    : (callback: () => void) => window.setTimeout(callback, 0)
  scheduleIdle(() => void ChatPage.prefetch())
  scheduleIdle(() => void TodoBoardPage.prefetch())
}

function RouteLoading() {
  return (
    <div className="flex h-dvh items-center justify-center bg-background" role="status" aria-label="Loading page">
      <div className="size-5 animate-spin rounded-full border-2 border-[var(--fill-tertiary)] border-t-[var(--accent)]" />
    </div>
  )
}

function NotesFeatureRoute() {
  const { data: features, isPending } = useFeatures()
  if (isPending) return <RouteLoading />
  return features?.notesEnabled === true ? <NotesPage /> : <Navigate to="/" replace />
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('[AppErrorBoundary]', error)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background p-6 text-center">
        <div className="text-sm font-medium text-foreground">Web UI needs a refresh</div>
        <button
          className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white active:scale-[0.96] transition-transform"
          onClick={() => window.location.reload()}
        >
          Refresh
        </button>
      </div>
    )
  }
}

function AppShell() {
  return (
    <ClientProviders>
      <Suspense fallback={<RouteLoading />}>
        <Outlet />
      </Suspense>
    </ClientProviders>
  )
}

const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: '/', element: <ChatPage /> },
      { path: '/chat', element: <Navigate to="/" replace /> },
      { path: '/cron', element: <CronPage /> },
      { path: '/cron/:id', element: <CronDetailPage /> },
      // Todos v2 slice 6 (stage-C cutover): the board IS /todos and
      // /todos/:todoId is the full task page. The legacy list is gone.
      { path: '/todos', element: <TodosIndexRedirect /> },
      { path: '/todos/b/:board', element: <TodoBoardPage /> },
      { path: '/todos/:todoId', element: <TaskPage /> },
      { path: '/notes', element: <NotesFeatureRoute /> },
      // Folder/note deep links: /notes/f/<folder>, /notes/n/<rel>, or both.
      { path: '/notes/*', element: <NotesFeatureRoute /> },
      { path: '/experiments', element: <ExperimentsPage /> },
      { path: '/experiments/:id', element: <ExperimentDetailPage /> },
      // GRS-021d: Kanban became Todos. Old links redirect.
      { path: '/kanban', element: <Navigate to="/todos" replace /> },
      { path: '/logs', element: <LogsPage /> },
      { path: '/limits', element: <LimitsPage /> },
      { path: '/org', element: <OrgPage /> },
      { path: '/settings', element: <SettingsPage /> },
      { path: '/skills', element: <SkillsPage /> },
      { path: '/skills/:name', element: <SkillDetailPage /> },
      { path: '/file', element: <FilePage /> },
      { path: '/more', element: <MorePage /> },
      { path: '/workflow', element: <WorkflowListPage /> },
      { path: '/workflow/:id', element: <WorkflowPage /> },
      { path: '/workflow/:id/runs/:runId', element: <WorkflowRunPage /> },
      ...(import.meta.env.DEV
        ? [
            { path: '/redesign', element: <RedesignPage /> },
          ]
        : []),
    ],
  },
])

function App() {
  return (
    <AppErrorBoundary>
      <RouterProvider router={router} />
    </AppErrorBoundary>
  )
}

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found')
createRoot(rootEl).render(<App />)
