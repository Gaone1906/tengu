import { Beaker, ChevronRight } from "lucide-react"
import { Link } from "react-router-dom"
import { PageLayout } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { useExperiments } from "./use-experiments"
import type { Experiment } from "./types"

function ExperimentRow({ experiment }: { experiment: Experiment }) {
  const readingCount = experiment.readings.length
  return (
    <Link
      to={`/experiments/${encodeURIComponent(experiment.id)}`}
      className="flex min-h-[68px] items-center gap-3 rounded-[13px] px-3.5 py-2.5 transition-colors duration-150 hover:bg-[var(--fill-quaternary)] focus-visible:bg-[var(--fill-quaternary)] focus-visible:outline-none"
    >
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ background: experiment.status === "running" ? "var(--system-blue)" : "var(--system-green)" }}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
          {experiment.name}
        </span>
        <span className="mt-0.5 block truncate text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
          {experiment.hypothesis}
        </span>
        <span className="mt-1 block text-[length:var(--text-caption1)] text-[var(--text-quaternary)]">
          {readingCount === 0 ? (
            <span data-testid={`experiment-readings-empty-${experiment.id}`}>No readings yet</span>
          ) : (
            `${readingCount} ${readingCount === 1 ? "reading" : "readings"} · ${experiment.horizonDays}-day horizon`
          )}
        </span>
      </span>
      <ChevronRight size={15} strokeWidth={2.3} className="shrink-0 text-[var(--text-quaternary)]" aria-hidden />
    </Link>
  )
}

function ExperimentGroup({ label, experiments }: { label: string; experiments: Experiment[] }) {
  if (experiments.length === 0) return null
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center justify-between px-1.5 text-[length:var(--text-caption1)] font-[var(--weight-semibold)] uppercase tracking-[0.12em] text-[var(--text-secondary)]">
        <h2>{label}</h2>
        <span className="tabular-nums text-[var(--text-quaternary)]">{experiments.length}</span>
      </div>
      <div className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[5px] shadow-[var(--shadow-card)]">
        {experiments.map((experiment) => <ExperimentRow key={experiment.id} experiment={experiment} />)}
      </div>
    </section>
  )
}

export default function ExperimentsPage() {
  useBreadcrumbs([{ label: "Experiments" }])
  const query = useExperiments()
  const experiments = query.data?.experiments ?? []
  const running = experiments.filter((experiment) => experiment.status === "running")
  const concluded = experiments.filter((experiment) => experiment.status === "concluded")

  return (
    <PageLayout>
      <div className="h-full overflow-y-auto" data-scrollable>
        <main className="mx-auto max-w-[840px] px-5 pb-20 pt-6 md:pt-11">
          <header>
            <h1 className="font-[var(--font-display)] text-[length:var(--text-title1)] font-bold leading-tight tracking-[var(--tracking-tight)] text-[var(--text-primary)] md:text-[length:var(--text-large-title)]">
              Experiments
            </h1>
            <p className="mt-1 text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
              {query.isSuccess
                ? `${experiments.length} ${experiments.length === 1 ? "tracked bet" : "tracked bets"} · ${running.length} running`
                : "Hypotheses, measurements, and verdicts"}
            </p>
          </header>

          {query.isPending ? (
            <div className="mt-6 rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] px-6 py-16 text-center text-[var(--text-tertiary)] shadow-[var(--shadow-card)]">
              Loading experiments…
            </div>
          ) : query.isError ? (
            <div className="mt-6 rounded-[var(--radius-lg)] bg-[var(--fill-tertiary)] p-4 text-[var(--system-red)]">
              {query.error instanceof Error ? query.error.message : "Failed to load experiments."}
            </div>
          ) : experiments.length === 0 ? (
            <div className="mt-6 rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] px-8 py-16 text-center shadow-[var(--shadow-card)]" data-testid="experiments-empty">
              <Beaker className="mx-auto size-8 text-[var(--text-tertiary)]" aria-hidden />
              <h2 className="mt-4 text-[length:var(--text-title3)] font-[var(--weight-semibold)] text-[var(--text-primary)]">No experiments yet</h2>
              <p className="mx-auto mt-2 max-w-[340px] text-[length:var(--text-subheadline)] leading-relaxed text-[var(--text-tertiary)]">
                Create a tracked bet in chat to give its hypothesis and metrics a durable home.
              </p>
            </div>
          ) : (
            <>
              <ExperimentGroup label="Running" experiments={running} />
              <ExperimentGroup label="Concluded" experiments={concluded} />
            </>
          )}
        </main>
      </div>
    </PageLayout>
  )
}
