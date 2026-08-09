import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { RefreshCw } from "lucide-react"
import { api } from "@/lib/api"
import { queryKeys } from "@/lib/query-keys"
import { PageLayout } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { SpecialistCarousel } from "./specialist-carousel"

// The specialist carousel (docs/tengu/18-council-specialists.md's frontend
// plan): pages through the `department: specialists` roster, reusing the
// chat route's `?employee=` deep-link (chat-employee-picker.tsx's own
// persona-binding mechanism) to start a bound conversation, and surfaces the
// two RAG-subsystem actions (Lane A's `knowledge-base/index.ts`) plus a
// read-only view of `manifest.ts`'s KB metadata.
//
// ASSUMPTION (documented per the task brief): "re-run incremental learning"
// calls a real endpoint — `runIncrementalUpdate` in `knowledge-base/index.ts`
// is a clean fire-and-forget job, the same shape as Cron's manual trigger.
// "Trigger a teaching session" stays a disabled, clearly-labeled
// not-yet-available action even though `knowledge-base/teaching.ts` has since
// landed: `runTeachingPhase` only *harvests* an already-completed session's
// transcript, and starting one properly needs a session excluded from
// continuous-loop auto-continuation while it waits for the human's replies —
// today that exclusion is `Employee.interactive`, a per-employee YAML flag,
// not something a session spawned post-hoc can set for itself. Specialists
// are deliberately NOT `interactive: true` (docs/tengu/18-council-specialists.md:
// they "work continuously and unattended"), so a session spawned here would
// have no such exclusion and risk the continuous-loop dispatcher answering
// the specialist's own questions. The specialist creation wizard
// (`routes/specialists/new.tsx`, "last piece to land" per the design doc)
// owns the one place this is meant to happen — it drives the teaching
// session directly rather than spawning one generically. A follow-up pass
// should revisit this once session-level (not employee-level) interactive
// scoping exists, or once the wizard's flow can be safely reused here.
const TEACHING_AVAILABLE = false

export default function SpecialistsPage() {
  useBreadcrumbs([{ label: "Specialists" }])
  const navigate = useNavigate()
  const qc = useQueryClient()

  const orgQuery = useQuery({ queryKey: queryKeys.org.all, queryFn: api.getOrg })
  const specialists = useMemo(
    () => (orgQuery.data?.employees ?? []).filter((e) => !!e.repo),
    [orgQuery.data],
  )

  const [activeIndex, setActiveIndex] = useState(0)
  useEffect(() => {
    if (activeIndex >= specialists.length && specialists.length > 0) setActiveIndex(0)
  }, [activeIndex, specialists.length])

  const activeName = specialists[activeIndex]?.name ?? null

  const kbQuery = useQuery({
    queryKey: queryKeys.specialists.kb(activeName ?? ""),
    queryFn: () => api.getSpecialistKb(activeName!),
    enabled: !!activeName,
  })

  const [triggeredName, setTriggeredName] = useState<string | null>(null)
  const triggerTimer = useRef<number | null>(null)
  const incrementalMutation = useMutation({
    mutationFn: (name: string) => api.triggerSpecialistIncrementalLearning(name),
    onSuccess: (_data, name) => {
      setTriggeredName(name)
      if (triggerTimer.current != null) window.clearTimeout(triggerTimer.current)
      triggerTimer.current = window.setTimeout(() => setTriggeredName(null), 2000)
      // The manifest updates a beat after the trigger returns (fire-and-forget job).
      window.setTimeout(() => {
        void qc.invalidateQueries({ queryKey: queryKeys.specialists.kb(name) })
      }, 2000)
    },
  })

  const onStartChat = (name: string) => navigate(`/?employee=${encodeURIComponent(name)}`)
  const onTriggerTeaching = () => {
    // Stubbed until knowledge-base/teaching.ts lands — the button itself is
    // disabled, so this is unreachable, but stays a no-op rather than silent.
  }

  return (
    <PageLayout>
      <div className="h-full overflow-y-auto" data-scrollable>
        <div className="mx-auto max-w-[720px] px-5 pb-20 pt-6 md:pt-11">
          <header className="flex flex-wrap items-end justify-between gap-x-3 gap-y-3">
            <div>
              <h1 className="font-[var(--font-display)] text-[length:var(--text-title1)] font-bold leading-tight tracking-[var(--tracking-tight)] text-[var(--text-primary)] md:text-[length:var(--text-large-title)]">
                Specialists
              </h1>
              <div className="mt-1 text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
                {orgQuery.isSuccess
                  ? `${specialists.length} ${specialists.length === 1 ? "specialist" : "specialists"}, one repo each`
                  : "Sonnet-tier employees who each own one repo"}
              </div>
            </div>
            <button
              type="button"
              aria-label="Refresh specialists"
              onClick={() => void orgQuery.refetch()}
              className="grid size-[30px] place-items-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-secondary)]"
            >
              <RefreshCw size={13} strokeWidth={2.2} className={orgQuery.isFetching ? "animate-spin" : undefined} aria-hidden />
            </button>
          </header>

          <div className="mt-6">
            {orgQuery.isLoading ? (
              <div
                className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-5 shadow-[var(--shadow-card)]"
                data-testid="specialists-skeleton"
                aria-hidden
              >
                <div className="h-6 w-1/2 rounded-[6px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]" />
                <div className="mt-3 h-4 w-1/3 rounded-[6px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]" />
              </div>
            ) : orgQuery.isError ? (
              <div
                className="rounded-[var(--radius-lg)] p-4 text-[length:var(--text-subheadline)] text-[var(--system-red)]"
                style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}
              >
                {orgQuery.error instanceof Error ? orgQuery.error.message : "Failed to load the org roster"}
              </div>
            ) : (
              <SpecialistCarousel
                specialists={specialists}
                activeIndex={activeIndex}
                onChangeIndex={setActiveIndex}
                kbManifest={kbQuery.data?.manifest ?? null}
                kbExists={kbQuery.data?.exists}
                kbLoading={kbQuery.isLoading}
                onStartChat={onStartChat}
                teachingAvailable={TEACHING_AVAILABLE}
                onTriggerTeaching={onTriggerTeaching}
                onTriggerIncrementalLearning={(name) => incrementalMutation.mutate(name)}
                incrementalPending={incrementalMutation.isPending}
                incrementalTriggered={triggeredName === activeName}
              />
            )}
          </div>
        </div>
      </div>
    </PageLayout>
  )
}
