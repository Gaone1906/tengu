import { Component, Suspense, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Navigate, Outlet, RouterProvider, createBrowserRouter } from 'react-router-dom'
import { ClientProviders } from './routes/client-providers'
import { lazyRoute } from './lib/lazy-route'
import { TodosIndexRedirect } from './routes/todos/board/todos-index-redirect'
import { useFeatures } from './hooks/use-features'
import './routes/globals.css'

const ChatPage = lazyRoute(() => import('./routes/chat/page'), 'chat')
const CronPage = lazyRoute(() => import('./routes/cron/page'), 'cron')
const CronDetailPage = lazyRoute(() => import('./routes/cron/detail'), 'cron-detail')
const TodosPage = lazyRoute(() => import('./routes/todos/page'), 'todos')
const TodoBoardPage = lazyRoute(() => import('./routes/todos/board/board-page'), 'todo-board')
const NotesPage = lazyRoute(() => import('./routes/notes/page'), 'notes')
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
      // Todos v2 slice 6: the board is the front door; the legacy list stays
      // reachable at /todos/list until the stage-C cutover. /todos/:todoId
      // keeps serving the legacy list+sheet until stage B swaps in the task page.
      { path: '/todos', element: <TodosIndexRedirect /> },
      { path: '/todos/b/:board', element: <TodoBoardPage /> },
      { path: '/todos/list', element: <TodosPage /> },
      { path: '/todos/:todoId', element: <TodosPage /> },
      { path: '/notes', element: <NotesFeatureRoute /> },
      // Folder/note deep links: /notes/f/<folder>, /notes/n/<rel>, or both.
      { path: '/notes/*', element: <NotesFeatureRoute /> },
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
