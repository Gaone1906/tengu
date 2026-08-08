import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { RefreshCw, ShieldAlert, TriangleAlert } from "lucide-react"
import { api, type DepartmentStandupWire, type ProjectStandupWire } from "@/lib/api"
import { PageLayout } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { StateCircle } from "../todos/state-glyph"

/* Tengu step 11 (D16): the one genuinely new stand-up route, following Cron's
 * grouped-list pattern — project-groups in place of employee-groups,
 * department-rows in place of job-rows. */

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

function IncidentRow({ incident }: { incident: DepartmentStandupWire["incidents"][number] }) {
  const Icon = incident.kind === "security-block" ? ShieldAlert : TriangleAlert
  return (
    <div className="flex items-start gap-[7px] rounded-[10px] bg-[color-mix(in_srgb,var(--system-red)_8%,transparent)] px-2.5 py-2 text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
      <Icon size={13} strokeWidth={2.2} className="mt-[2px] flex-none text-[var(--system-red)]" aria-hidden />
      <span className="min-w-0 flex-1">{incident.summary}</span>
    </div>
  )
}

function DepartmentRow({ row }: { row: DepartmentStandupWire }) {
  const { progress } = row
  const remaining = progress.total - progress.completed
  return (
    <div className="rounded-[13px] px-2.5 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[length:var(--text-subheadline)] font-semibold capitalize text-[var(--text-primary)]">
          {row.department}
        </span>
        <span className="whitespace-nowrap text-[length:var(--text-caption1)] tabular-nums text-[var(--text-tertiary)]">
          {progress.completed}/{progress.total} done · {progress.inFlight} in flight · {remaining} left
        </span>
      </div>
      <div className="mt-2 flex items-center gap-2.5">
        <ProgressBar pct={progress.completedPct} />
        <span className="w-9 flex-none text-right text-[length:var(--text-caption1)] tabular-nums text-[var(--text-quaternary)]">
          {progress.completedPct}%
        </span>
      </div>

      {row.blocked.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {row.blocked.map((item) => (
            <span
              key={item.id}
              className="inline-flex items-center gap-1.5 rounded-full bg-[var(--fill-tertiary)] py-1 pl-1 pr-2.5 text-[length:var(--text-caption1)] text-[var(--text-secondary)]"
              title={item.title}
            >
              <StateCircle keyOf="blocked" size={16} />
              <span className="max-w-[180px] truncate">{item.title}</span>
            </span>
          ))}
        </div>
      )}

      {row.incidents.length > 0 && (
        <div className="mt-2.5 grid gap-1.5">
          {row.incidents.map((incident, i) => (
            <IncidentRow key={`${incident.workItemId}-${i}`} incident={incident} />
          ))}
        </div>
      )}

      {row.narrative && (
        <p className="mt-2.5 text-[length:var(--text-footnote)] leading-relaxed text-[var(--text-secondary)]">
          {row.narrative}
        </p>
      )}
    </div>
  )
}

function ProjectCard({ project }: { project: ProjectStandupWire }) {
  return (
    <section className="mb-[22px] rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[5px] shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-2.5 pb-1 pt-2">
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
      <div className="divide-y divide-[var(--separator)]">
        {project.departments.map((row) => (
          <DepartmentRow key={row.department} row={row} />
        ))}
      </div>
    </section>
  )
}

function ListSkeleton() {
  return (
    <section className="mb-[22px] rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[5px] shadow-[var(--shadow-card)]" aria-hidden>
      <div className="px-2.5 py-3">
        <span className="block h-3 w-40 rounded-[6px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]" />
      </div>
      {[0, 1].map((i) => (
        <div key={i} className="px-2.5 py-3">
          <span
            className="block h-2 rounded-full bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]"
            style={{ animationDelay: `${i * 200}ms` }}
          />
        </div>
      ))}
    </section>
  )
}

export default function StandupPage() {
  useBreadcrumbs([{ label: "Stand-up" }])

  const standupQuery = useQuery({
    queryKey: ["standup"],
    queryFn: () => api.getStandup(),
    refetchInterval: 60_000,
  })
  const projects = useMemo(() => standupQuery.data ?? [], [standupQuery.data])
  const totalIncidents = useMemo(
    () => projects.reduce((sum, p) => sum + p.departments.reduce((s, d) => s + d.incidents.length, 0), 0),
    [projects],
  )

  const refresh = () => void standupQuery.refetch()

  return (
    <PageLayout>
      <div className="h-full overflow-y-auto" data-scrollable>
        <div className="mx-auto max-w-[840px] px-5 pb-20 pt-6 md:pt-11">
          <header className="flex flex-wrap items-end justify-between gap-x-3 gap-y-3">
            <div>
              <h1 className="font-[var(--font-display)] text-[length:var(--text-title1)] font-bold leading-tight tracking-[var(--tracking-tight)] text-[var(--text-primary)] md:text-[length:var(--text-large-title)]">
                Stand-up
              </h1>
              <div className="mt-1 text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
                {standupQuery.isSuccess
                  ? `${projects.length} ${projects.length === 1 ? "project" : "projects"}${totalIncidents > 0 ? ` · ${totalIncidents} incident${totalIncidents === 1 ? "" : "s"}` : ""}`
                  : "What every project × department did while you were away"}
              </div>
            </div>
            <button
              type="button"
              aria-label="Refresh stand-up"
              onClick={refresh}
              className="grid size-[30px] flex-none place-items-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-secondary)]"
            >
              <RefreshCw size={13} strokeWidth={2.2} className={standupQuery.isFetching ? "animate-spin" : undefined} aria-hidden />
            </button>
          </header>

          <div className="mt-[22px]">
            {standupQuery.isLoading ? (
              <>
                <ListSkeleton />
                <ListSkeleton />
              </>
            ) : standupQuery.isError ? (
              <div
                className="rounded-[var(--radius-lg)] p-4 text-[length:var(--text-subheadline)] text-[var(--system-red)]"
                style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}
              >
                {standupQuery.error instanceof Error ? standupQuery.error.message : "Failed to load the stand-up"}
                <button type="button" onClick={refresh} className="ml-3 font-medium underline">
                  Retry
                </button>
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
              projects.map((project) => <ProjectCard key={project.rootId} project={project} />)
            )}
          </div>
        </div>
      </div>
    </PageLayout>
  )
}
