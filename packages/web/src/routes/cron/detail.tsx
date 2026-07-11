import { useMemo, useRef, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, ChevronLeft, Play } from "lucide-react"
import { api } from "@/lib/api"
import {
  agoLabel,
  describeCron,
  formatDuration,
  formatNextRun,
  formatRunTime,
  nextCronDate,
} from "@/lib/cron-utils"
import { PageLayout } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import {
  displayNameOf,
  RunGlyph,
  runDurationMs,
  runOutcome,
  runTimestamp,
  ToggleSwitch,
  type CronJobWire,
  type CronRunWire,
} from "./shared"

/* design-cron §2.4 — a cron job opens as a document (the Skills idiom): back
 * link, large-title name, the schedule as a sentence, quiet mono metadata,
 * Run-now + the ToggleSwitch in the header, an Overview inset, and the full
 * run history (GET /api/cron/:id/runs) as a grouped-inset list. The read tier
 * deliberately scrubs prompt/env server-side, so the document shows everything
 * the gateway exposes — no more, no less. */

function DetailSkeleton() {
  return (
    <div aria-hidden data-testid="cron-detail-skeleton">
      <div className="h-8 w-[42%] rounded-[8px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]" />
      <div className="mt-3 h-3.5 w-[30%] rounded-[6px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]" style={{ animationDelay: "150ms" }} />
      <div className="mt-10 space-y-3">
        {["70%", "62%", "66%"].map((w, i) => (
          <div
            key={i}
            className="h-3 rounded-[6px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]"
            style={{ width: w, animationDelay: `${200 + i * 150}ms` }}
          />
        ))}
      </div>
    </div>
  )
}

function OverviewRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[44px] items-center gap-3 rounded-[13px] px-3.5 py-1.5">
      <span className="w-[96px] flex-none text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{label}</span>
      <span className="flex min-w-0 items-center gap-2 text-[length:var(--text-footnote)] text-[var(--text-primary)]">
        {children}
      </span>
    </div>
  )
}

const RUN_STATUS_WORD: Record<string, string> = {
  error: "error",
  started: "running",
  skipped: "skipped",
  duplicate: "duplicate",
  expired: "expired",
}

function RunRow({ run, now }: { run: CronRunWire; now: Date }) {
  const outcome = runOutcome(run)
  const ts = runTimestamp(run)
  const dur = runDurationMs(run)
  const word = run.status ? RUN_STATUS_WORD[run.status] : undefined
  return (
    <div className="flex min-h-[44px] items-center gap-2.5 rounded-[13px] py-1.5 pl-2.5 pr-3.5 transition-colors duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-quaternary)]">
      <RunGlyph outcome={outcome} size={22} />
      <span className="min-w-0 flex-1 truncate text-[length:var(--text-footnote)] text-[var(--text-primary)]">
        {ts != null ? formatRunTime(ts, now) : "—"}
      </span>
      {word && (
        <span
          className="flex-none text-[length:var(--text-caption1)]"
          style={{ color: outcome === "error" ? "var(--system-red)" : "var(--text-tertiary)" }}
        >
          {word}
        </span>
      )}
      <span
        className="min-w-[52px] flex-none text-right text-[length:var(--text-caption1)] tabular-nums text-[var(--text-tertiary)]"
        style={{ fontFamily: "var(--font-code)" }}
      >
        {dur != null ? formatDuration(dur) : "—"}
      </span>
    </div>
  )
}

export default function CronDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params.id ? decodeURIComponent(params.id) : ""
  useBreadcrumbs(useMemo(() => [{ label: "Cron", href: "/cron" }, { label: id }], [id]))
  const navigate = useNavigate()
  const qc = useQueryClient()
  const now = useMemo(() => new Date(), [])

  // The read tier has no single-job GET; the list query is the source of truth
  // and a deep link simply loads it.
  const jobsQuery = useQuery({
    queryKey: ["cron-jobs"],
    queryFn: api.getCronJobs,
    refetchInterval: 60_000,
  })
  const job = useMemo(
    () => ((jobsQuery.data ?? []) as unknown as CronJobWire[]).find((j) => j.id === id),
    [jobsQuery.data, id],
  )

  const runsQuery = useQuery({
    queryKey: ["cron-runs", id],
    queryFn: () => api.getCronRuns(id),
    enabled: !!id,
  })
  const runs = useMemo(() => (runsQuery.data ?? []) as unknown as CronRunWire[], [runsQuery.data])

  const org = useQuery({ queryKey: ["org"], queryFn: api.getOrg, staleTime: 60_000 })
  const byName = useMemo(() => new Map((org.data?.employees ?? []).map((e) => [e.name, e])), [org.data])

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.updateCronJob(id, { enabled }),
    onMutate: async (enabled) => {
      await qc.cancelQueries({ queryKey: ["cron-jobs"] })
      const prev = qc.getQueryData(["cron-jobs"])
      qc.setQueryData(["cron-jobs"], (old: unknown) =>
        Array.isArray(old) ? old.map((j) => ((j as CronJobWire).id === id ? { ...j, enabled } : j)) : old,
      )
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(["cron-jobs"], ctx.prev)
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["cron-jobs"] }),
  })

  const [triggered, setTriggered] = useState(false)
  const triggerTimer = useRef<number | null>(null)
  const trigger = useMutation({
    mutationFn: () => api.triggerCronJob(id),
    onSuccess: () => {
      setTriggered(true)
      if (triggerTimer.current != null) window.clearTimeout(triggerTimer.current)
      triggerTimer.current = window.setTimeout(() => setTriggered(false), 2000)
      // The run lands in the log a beat after the trigger returns.
      window.setTimeout(() => {
        void qc.invalidateQueries({ queryKey: ["cron-runs", id] })
        void qc.invalidateQueries({ queryKey: ["cron-jobs"] })
      }, 2000)
    },
  })

  const next = useMemo(
    () => (job?.enabled ? nextCronDate(job.schedule, job.timezone ?? undefined, now) : null),
    [job, now],
  )
  const lastTs = runTimestamp(job?.lastRun)

  const notFound = jobsQuery.isSuccess && !job

  return (
    <PageLayout>
      <div className="h-full overflow-y-auto" data-scrollable>
        <div className="mx-auto max-w-[840px] px-5 pb-24 pt-6 md:pt-11">
          <Link
            to="/cron"
            className="mb-3.5 inline-flex items-center gap-1 text-[length:var(--text-footnote)] font-medium text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]"
          >
            <ChevronLeft size={13} strokeWidth={2.4} aria-hidden />
            Cron
          </Link>

          {jobsQuery.isLoading ? (
            <DetailSkeleton />
          ) : notFound ? (
            <div className="px-2 py-12 text-center" data-testid="cron-not-found">
              <h1 className="text-[length:var(--text-title3)] font-bold tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
                Job not found
              </h1>
              <p className="mt-2 text-[length:var(--text-subheadline)] text-[var(--text-tertiary)]">
                “{id}” isn't scheduled on this gateway.
              </p>
              <button
                type="button"
                onClick={() => navigate("/cron")}
                className="mt-4 text-[length:var(--text-footnote)] font-medium text-[var(--accent)] transition-opacity hover:opacity-80"
              >
                Back to Cron
              </button>
            </div>
          ) : jobsQuery.isError ? (
            <div
              className="rounded-[var(--radius-lg)] p-4 text-[length:var(--text-subheadline)] text-[var(--system-red)]"
              style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}
            >
              {jobsQuery.error instanceof Error ? jobsQuery.error.message : "Failed to load the job"}
            </div>
          ) : job ? (
            <>
              <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-4">
                <div className="min-w-0 flex-1 basis-[320px]">
                  <h1 className="font-[var(--font-display)] text-[length:var(--text-title1)] font-bold leading-tight tracking-[var(--tracking-tight)] text-[var(--text-primary)] [overflow-wrap:anywhere] md:text-[length:var(--text-large-title)]">
                    {job.name}
                  </h1>
                  <p className="mt-1.5 text-[length:var(--text-subheadline)] leading-[var(--leading-normal)] text-[var(--text-secondary)]">
                    {describeCron(job.schedule)}
                    {job.timezone ? ` · ${job.timezone}` : ""}
                  </p>
                  <div
                    className="mt-2.5 text-[length:var(--text-caption1)] leading-[1.7] text-[var(--text-quaternary)] [overflow-wrap:anywhere]"
                    style={{ fontFamily: "var(--font-code)" }}
                  >
                    {job.schedule}
                    <br />
                    id: {job.id}
                  </div>
                </div>
                <div className="flex flex-none items-center gap-3.5 pb-1">
                  <button
                    type="button"
                    data-testid="cron-run-now"
                    disabled={trigger.isPending || triggered}
                    onClick={() => trigger.mutate()}
                    className="inline-flex h-[38px] flex-none items-center gap-1.5 rounded-full px-4 text-[length:var(--text-subheadline)] font-semibold transition-transform hover:scale-[0.98] disabled:opacity-80"
                    style={
                      triggered
                        ? { background: "color-mix(in srgb, var(--system-green) 13%, transparent)", color: "var(--system-green)", boxShadow: "var(--inset-shine)" }
                        : { background: "var(--accent-fill)", color: "var(--accent)", boxShadow: "var(--inset-shine)" }
                    }
                  >
                    {triggered ? (
                      <>
                        <Check className="size-[15px]" aria-hidden />
                        Triggered
                      </>
                    ) : (
                      <>
                        <Play className="size-[13px]" fill="currentColor" strokeWidth={0} aria-hidden />
                        {trigger.isPending ? "Starting…" : "Run now"}
                      </>
                    )}
                  </button>
                  <ToggleSwitch
                    checked={job.enabled}
                    onChange={(v) => toggle.mutate(v)}
                    label={job.enabled ? `Disable ${job.name}` : `Enable ${job.name}`}
                  />
                </div>
              </header>

              {trigger.isError && (
                <div
                  className="mt-4 rounded-[var(--radius-md)] p-[10px_13px] text-[length:var(--text-footnote)] text-[var(--system-red)]"
                  style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}
                >
                  {trigger.error instanceof Error ? trigger.error.message : "Couldn't trigger the job"}
                </div>
              )}

              <section className="mt-7">
                <div className="flex items-baseline gap-2 px-1.5 pb-2">
                  <span className="text-[length:var(--text-footnote)] font-semibold tracking-[var(--tracking-tight)] text-[var(--text-secondary)]">
                    Overview
                  </span>
                </div>
                <div className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[5px] shadow-[var(--shadow-card)]">
                  <OverviewRow label="Target">
                    {job.employee ? (
                      <>
                        <EmployeeAvatar name={job.employee} size={20} fontSize={11} className="bg-[var(--fill-secondary)]" />
                        <span className="truncate">{displayNameOf(job.employee, byName)}</span>
                      </>
                    ) : (
                      <span className="text-[var(--text-tertiary)]">Unassigned</span>
                    )}
                    {job.engine && (
                      <span className="rounded-[9px] bg-[var(--fill-tertiary)] px-2 py-0.5 text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
                        {job.engine}
                      </span>
                    )}
                  </OverviewRow>
                  <OverviewRow label="Schedule">
                    <span>{describeCron(job.schedule)}</span>
                    <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]" style={{ fontFamily: "var(--font-code)" }}>
                      {job.schedule}
                    </span>
                  </OverviewRow>
                  {job.timezone && <OverviewRow label="Timezone">{job.timezone}</OverviewRow>}
                  {job.enabled && next && (
                    <OverviewRow label="Next run">{formatRunTime(next.getTime(), now)}</OverviewRow>
                  )}
                  <OverviewRow label="Status">
                    <span style={{ color: job.enabled ? "var(--system-green)" : "var(--text-tertiary)" }}>
                      {job.enabled ? "Enabled" : "Disabled"}
                    </span>
                    {lastTs != null && (
                      <span className="text-[length:var(--text-caption1)] text-[var(--text-quaternary)]">
                        · last ran {agoLabel(lastTs, now)}
                      </span>
                    )}
                  </OverviewRow>
                </div>
              </section>

              <section className="mt-7">
                <div className="flex items-baseline gap-2 px-1.5 pb-2">
                  <span className="text-[length:var(--text-footnote)] font-semibold tracking-[var(--tracking-tight)] text-[var(--text-secondary)]">
                    Run history
                  </span>
                  {runsQuery.isSuccess && runs.length > 0 && (
                    <span className="text-[length:var(--text-caption1)] text-[var(--text-quaternary)]">
                      {runs.length >= 50 ? "last 50" : `${runs.length} ${runs.length === 1 ? "run" : "runs"}`}
                    </span>
                  )}
                </div>
                {runsQuery.isLoading ? (
                  <div className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[5px] shadow-[var(--shadow-card)]" aria-hidden>
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="flex min-h-[44px] items-center gap-2.5 py-1.5 pl-2.5 pr-3.5">
                        <span className="size-[22px] flex-none rounded-full bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]" style={{ animationDelay: `${i * 200}ms` }} />
                        <span className="h-3 w-[34%] rounded-[6px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]" style={{ animationDelay: `${i * 200}ms` }} />
                      </div>
                    ))}
                  </div>
                ) : runs.length === 0 ? (
                  <div className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] shadow-[var(--shadow-card)]" data-testid="cron-runs-empty">
                    <div className="px-5 py-8 text-center text-[length:var(--text-subheadline)] text-[var(--text-tertiary)]">
                      No runs yet.
                    </div>
                  </div>
                ) : (
                  <div className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[5px] shadow-[var(--shadow-card)]" data-testid="cron-runs">
                    {runs.map((run, i) => (
                      <RunRow key={run.id ?? `${runTimestamp(run) ?? "run"}-${i}`} run={run} now={now} />
                    ))}
                  </div>
                )}
              </section>
            </>
          ) : (
            <DetailSkeleton />
          )}
        </div>
      </div>
    </PageLayout>
  )
}
