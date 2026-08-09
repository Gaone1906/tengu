import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { MessageSquarePlus, Send, Users } from "lucide-react"
import { api } from "@/lib/api"
import { queryKeys } from "@/lib/query-keys"
import { PageLayout } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { useOrg } from "@/hooks/use-employees"
import { useSessionTelemetry, type SessionTelemetryEvent } from "@/hooks/use-session-telemetry"
import { sessionPath } from "@/components/chat/chat-route-helpers"
import { buildNewSessionParams } from "@/components/chat/new-chat-helpers"
import {
  generalistsFromEmployees,
  progressForEmployee,
  progressPct,
  projectsFromWorkItems,
  seatPosition,
} from "./roundtable-helpers"
import type { WorkItemCompactWire } from "@/lib/api"

type EmployeeProgressList = SessionTelemetryEvent["employeeProgress"]

/* The round-table dashboard (docs/tengu/18-council-specialists.md's frontend
 * plan) — replaces the deleted Stand-up. One card per Project (a root Todo
 * with a workspace path, same concept the old Stand-up used), the council's
 * generalists seated around an oval table, and a per-generalist panel with a
 * live progress rollup plus a chat box bound to that employee.
 *
 * "Ask council" starts a fresh, employee-less chat (the same navigation
 * `handleNewChat` uses on the chat route) so the picker's `generalists`
 * department group is the entry point — the round table doesn't pick a
 * specific generalist for the user, since triage is exactly what the
 * generalists do once engaged. */

function barColor(pct: number): string {
  return pct >= 90 ? "var(--system-green)" : pct >= 50 ? "var(--accent)" : "var(--system-orange)"
}

function ProgressBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--fill-tertiary)]">
      <div
        className="h-full rounded-full transition-[width] duration-500 ease-[var(--ease-smooth)]"
        style={{ width: `${clamped}%`, background: barColor(clamped) }}
      />
    </div>
  )
}

interface GeneralistPanelProps {
  name: string
  displayName: string
  employeeProgress: EmployeeProgressList | undefined
  onClose: () => void
}

function GeneralistPanel({ name, displayName, employeeProgress, onClose }: GeneralistPanelProps) {
  const navigate = useNavigate()
  const [message, setMessage] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const progress = progressForEmployee(name, employeeProgress)
  const pct = progressPct(progress)
  const remaining = progress ? progress.total - progress.completed : 0

  const send = async () => {
    const trimmed = message.trim()
    if (!trimmed || sending) return
    setSending(true)
    setError(null)
    try {
      const params = buildNewSessionParams({ message: trimmed, selectedEmployee: name })
      const result = (await api.createSession(params)) as Record<string, unknown>
      const newId = typeof result.id === "string" ? result.id : ""
      if (!newId) throw new Error("The gateway did not return a new session id")
      navigate(sessionPath(newId))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start the chat")
      setSending(false)
    }
  }

  return (
    <div
      data-testid={`generalist-panel-${name}`}
      className="mt-4 rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] p-3.5"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <EmployeeAvatar name={name} size={24} />
          <span className="truncate text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
            {displayName}
          </span>
        </div>
        <button
          type="button"
          aria-label="Close panel"
          onClick={onClose}
          className="shrink-0 rounded-full px-2 py-1 text-[length:var(--text-caption1)] text-[var(--text-tertiary)] hover:bg-[var(--fill-secondary)]"
        >
          Close
        </button>
      </div>

      {progress ? (
        <div className="mt-3">
          <div className="flex items-center gap-2.5">
            <ProgressBar pct={pct} />
            <span className="w-9 flex-none text-right text-[length:var(--text-caption1)] tabular-nums text-[var(--text-quaternary)]">
              {pct}%
            </span>
          </div>
          <div className="mt-1.5 text-[length:var(--text-caption1)] tabular-nums text-[var(--text-tertiary)]">
            {progress.completed}/{progress.total} done · {progress.inFlight} in flight · {remaining} left
          </div>
        </div>
      ) : (
        <div className="mt-3 text-[length:var(--text-caption1)] text-[var(--text-quaternary)]">
          No assigned Todos yet.
        </div>
      )}

      <div className="mt-3.5 flex items-center gap-2">
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder={`Message ${displayName}…`}
          aria-label={`Message ${displayName}`}
          disabled={sending}
          className="min-w-0 flex-1 rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] px-3 py-2 text-[length:var(--text-footnote)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] disabled:opacity-60"
        />
        <button
          type="button"
          aria-label={`Send to ${displayName}`}
          onClick={() => void send()}
          disabled={sending || !message.trim()}
          className="grid size-9 flex-none place-items-center rounded-full bg-[var(--accent)] text-white transition-opacity disabled:opacity-40"
        >
          <Send size={15} strokeWidth={2.3} aria-hidden />
        </button>
      </div>
      {error && (
        <div className="mt-2 text-[length:var(--text-caption1)] text-[var(--system-red)]">{error}</div>
      )}
    </div>
  )
}

interface ProjectTableProps {
  project: WorkItemCompactWire
  generalists: { name: string; displayName: string }[]
  employeeProgress: EmployeeProgressList | undefined
  openName: string | null
  onToggle: (name: string) => void
  onAskCouncil: () => void
}

function ProjectTable({ project, generalists, employeeProgress, openName, onToggle, onAskCouncil }: ProjectTableProps) {
  const openGeneralist = generalists.find((g) => g.name === openName)

  return (
    <section
      data-testid={`project-card-${project.id}`}
      className="mb-[22px] rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-5 shadow-[var(--shadow-card)]"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-[length:var(--text-body)] font-semibold text-[var(--text-primary)]">{project.title}</h2>
        {project.workspacePath && (
          <span
            className="truncate text-[length:var(--text-caption1)] text-[var(--text-quaternary)]"
            style={{ fontFamily: "var(--font-code)" }}
          >
            {project.workspacePath}
          </span>
        )}
      </div>

      <div className="relative mx-auto mt-6 aspect-[4/3] w-full max-w-[360px]">
        {/* The table itself — an oval with the "Ask council" button centered on it. */}
        <div
          className="absolute inset-[16%] rounded-[999px] border border-[var(--separator)]"
          style={{ background: "color-mix(in srgb, var(--fill-tertiary) 70%, transparent)" }}
          aria-hidden
        />
        <button
          type="button"
          onClick={onAskCouncil}
          className="absolute left-1/2 top-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-full bg-[var(--accent)] px-3.5 py-2 text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-white shadow-[var(--shadow-overlay)] transition-transform hover:scale-105"
        >
          <MessageSquarePlus size={14} strokeWidth={2.3} aria-hidden />
          Ask council
        </button>

        {generalists.map((g, i) => {
          const { xPct, yPct } = seatPosition(i, generalists.length)
          const isOpen = openName === g.name
          return (
            <button
              key={g.name}
              type="button"
              aria-label={g.displayName}
              aria-pressed={isOpen}
              data-testid={`generalist-seat-${g.name}`}
              onClick={() => onToggle(g.name)}
              onMouseEnter={() => onToggle(g.name)}
              className="absolute z-0 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1"
              style={{ left: `${50 + xPct}%`, top: `${50 + yPct}%` }}
            >
              <EmployeeAvatar
                name={g.name}
                size={44}
                style={isOpen ? { boxShadow: "0 0 0 3px var(--accent)" } : undefined}
              />
              <span className="max-w-[72px] truncate text-[length:var(--text-caption2)] text-[var(--text-secondary)]">
                {g.displayName}
              </span>
            </button>
          )
        })}
      </div>

      {openGeneralist && (
        <GeneralistPanel
          name={openGeneralist.name}
          displayName={openGeneralist.displayName}
          employeeProgress={employeeProgress}
          onClose={() => onToggle(openGeneralist.name)}
        />
      )}
    </section>
  )
}

export default function RoundtablePage() {
  useBreadcrumbs([{ label: "Round Table" }])
  const navigate = useNavigate()

  const orgQuery = useOrg()
  const projectsQuery = useQuery({
    queryKey: queryKeys.roundtable.projects,
    queryFn: () => api.listWorkItems({ rootsOnly: true, limit: 100 }),
  })
  const telemetry = useSessionTelemetry()

  const generalists = useMemo(() => generalistsFromEmployees(orgQuery.data?.employees ?? []), [orgQuery.data])
  const projects = useMemo(
    () => projectsFromWorkItems(projectsQuery.data?.workItems ?? []),
    [projectsQuery.data],
  )

  // projectId -> open generalist name. A separate key per card so opening a
  // seat in one project's table never affects another's.
  const [openByProject, setOpenByProject] = useState<Record<string, string | null>>({})
  const toggle = (projectId: string, name: string) => {
    setOpenByProject((prev) => ({ ...prev, [projectId]: prev[projectId] === name ? null : name }))
  }

  const askCouncil = () => navigate("/")

  const loading = orgQuery.isLoading || projectsQuery.isLoading
  const errored = orgQuery.isError || projectsQuery.isError

  return (
    <PageLayout>
      <div className="h-full overflow-y-auto" data-scrollable>
        <div className="mx-auto max-w-[840px] px-5 pb-20 pt-6 md:pt-11">
          <header>
            <h1 className="font-[var(--font-display)] text-[length:var(--text-title1)] font-bold leading-tight tracking-[var(--tracking-tight)] text-[var(--text-primary)] md:text-[length:var(--text-large-title)]">
              Round Table
            </h1>
            <div className="mt-1 text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
              {loading
                ? "The council, seated by project"
                : `${projects.length} ${projects.length === 1 ? "project" : "projects"} · ${generalists.length} ${generalists.length === 1 ? "generalist" : "generalists"}`}
            </div>
          </header>

          <div className="mt-[22px]">
            {loading ? (
              <div
                className="mb-[22px] rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-5 shadow-[var(--shadow-card)]"
                aria-hidden
              >
                <div className="h-5 w-40 rounded-[6px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]" />
                <div className="mx-auto mt-6 h-[220px] w-full max-w-[360px] rounded-[999px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]" />
              </div>
            ) : errored ? (
              <div
                className="rounded-[var(--radius-lg)] p-4 text-[length:var(--text-subheadline)] text-[var(--system-red)]"
                style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}
              >
                Failed to load the round table.
              </div>
            ) : generalists.length === 0 ? (
              <div className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] shadow-[var(--shadow-card)]">
                <div className="px-6 py-12 text-center">
                  <Users size={28} strokeWidth={1.8} className="mx-auto text-[var(--text-quaternary)]" aria-hidden />
                  <h3 className="mt-3 text-[length:var(--text-title3)] font-bold tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
                    No generalists yet
                  </h3>
                  <p className="mx-auto mt-2 max-w-[360px] text-[length:var(--text-subheadline)] leading-relaxed text-[var(--text-tertiary)]">
                    The council seats its Opus-tier generalists here once your org config has a `generalists` department.
                  </p>
                </div>
              </div>
            ) : projects.length === 0 ? (
              <div className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] shadow-[var(--shadow-card)]">
                <div className="px-6 py-12 text-center">
                  <h3 className="text-[length:var(--text-title3)] font-bold tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
                    No projects yet
                  </h3>
                  <p className="mx-auto mt-2 max-w-[360px] text-[length:var(--text-subheadline)] leading-relaxed text-[var(--text-tertiary)]">
                    A project is a root Todo with a workspace path. Give one an identity and it shows up here.
                  </p>
                </div>
              </div>
            ) : (
              projects.map((project) => (
                <ProjectTable
                  key={project.id}
                  project={project}
                  generalists={generalists}
                  employeeProgress={telemetry.data?.employeeProgress}
                  openName={openByProject[project.id] ?? null}
                  onToggle={(name) => toggle(project.id, name)}
                  onAskCouncil={askCouncil}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </PageLayout>
  )
}
