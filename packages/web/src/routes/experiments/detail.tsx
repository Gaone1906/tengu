import { ArrowLeft, CalendarDays } from "lucide-react"
import { Link, useParams } from "react-router-dom"
import { PageLayout } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { formatMetricValue, ReadingChart } from "./reading-chart"
import { useExperiment } from "./use-experiments"
import type { Experiment, ExperimentMetric } from "./types"

function latestFor(experiment: Experiment, metric: ExperimentMetric) {
  return experiment.readings.filter((reading) => reading.metric === metric.name).at(-1)
}

function MetricSection({ experiment, metric }: { experiment: Experiment; metric: ExperimentMetric }) {
  const readings = experiment.readings.filter((reading) => reading.metric === metric.name)
  const latest = latestFor(experiment, metric)
  return (
    <section className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] px-5 py-5 shadow-[var(--shadow-card)] md:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[length:var(--text-headline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">{metric.name}</h2>
          <p className="mt-0.5 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{metric.howToMeasure}</p>
        </div>
        <div className="flex gap-5 text-right">
          <div data-testid={`metric-baseline-${metric.name}`}>
            <div className="text-[length:var(--text-caption2)] uppercase tracking-[0.1em] text-[var(--text-quaternary)]">Baseline</div>
            <div className="mt-0.5 text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] tabular-nums text-[var(--text-secondary)]">
              {formatMetricValue(experiment.baseline[metric.name], metric.unit)}
            </div>
          </div>
          <div data-testid={`metric-latest-${metric.name}`}>
            <div className="text-[length:var(--text-caption2)] uppercase tracking-[0.1em] text-[var(--text-quaternary)]">Latest</div>
            <div className="mt-0.5 text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] tabular-nums text-[var(--text-primary)]">
              {formatMetricValue(latest?.value, metric.unit)}
            </div>
          </div>
        </div>
      </div>
      {readings.length < 2 ? (
        <div className="mt-4 rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] px-4 py-10 text-center text-[length:var(--text-footnote)] text-[var(--text-tertiary)]" data-testid={`metric-readings-empty-${metric.name}`}>
          {readings.length === 0 ? "No readings yet" : "One reading recorded · add another to draw the trend"}
        </div>
      ) : (
        <ReadingChart metric={metric} readings={readings} baseline={experiment.baseline[metric.name]} />
      )}
    </section>
  )
}

function verdictLabel(outcome: NonNullable<Experiment["verdict"]>["outcome"]): string {
  return outcome === "win" ? "Win" : outcome === "loss" ? "Loss" : "Inconclusive"
}

export default function ExperimentDetailPage() {
  const { id } = useParams<{ id: string }>()
  const query = useExperiment(id)
  const experiment = query.data?.experiment
  useBreadcrumbs([{ label: "Experiments", href: "/experiments" }, { label: experiment?.name ?? "Experiment" }])

  return (
    <PageLayout>
      <div className="h-full overflow-y-auto" data-scrollable>
        <main className="mx-auto max-w-[900px] px-5 pb-20 pt-5 md:pt-9">
          <Link to="/experiments" className="inline-flex min-h-[34px] items-center gap-1.5 rounded-full px-2 text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]">
            <ArrowLeft className="size-4" aria-hidden />
            Experiments
          </Link>

          {query.isPending ? (
            <div className="py-20 text-center text-[var(--text-tertiary)]">Loading experiment…</div>
          ) : query.isError || !experiment ? (
            <div className="mt-5 rounded-[var(--radius-lg)] bg-[var(--fill-tertiary)] p-4 text-[var(--system-red)]">
              {query.error instanceof Error ? query.error.message : "Experiment not found."}
            </div>
          ) : (
            <>
              <header className="mt-4">
                <div className="flex items-center gap-2 text-[length:var(--text-caption1)] font-[var(--weight-semibold)] uppercase tracking-[0.12em] text-[var(--text-secondary)]">
                  <span className="size-2 rounded-full" style={{ background: experiment.status === "running" ? "var(--system-blue)" : "var(--system-green)" }} aria-hidden />
                  {experiment.status === "running" ? "Running" : "Concluded"}
                </div>
                <h1 className="mt-2 font-[var(--font-display)] text-[length:var(--text-title1)] font-bold leading-tight tracking-[var(--tracking-tight)] text-[var(--text-primary)] md:text-[length:var(--text-large-title)]">
                  {experiment.name}
                </h1>
                <div className="mt-2 flex items-center gap-1.5 text-[length:var(--text-footnote)] text-[var(--text-quaternary)]">
                  <CalendarDays className="size-3.5" aria-hidden />
                  Started {new Date(experiment.startedAt).toLocaleDateString()} · {experiment.horizonDays}-day horizon
                </div>
              </header>

              <section className="mt-7">
                <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] uppercase tracking-[0.12em] text-[var(--text-secondary)]">Hypothesis</div>
                <p className="mt-2 max-w-[760px] text-[length:var(--text-title3)] leading-relaxed text-[var(--text-primary)]">{experiment.hypothesis}</p>
              </section>

              {experiment.readings.length === 0 && (
                <div className="mt-7 rounded-[var(--radius-xl)] bg-[var(--accent-fill)] px-5 py-4 text-[length:var(--text-subheadline)] text-[var(--text-secondary)]" data-testid="experiment-detail-readings-empty">
                  No readings yet. Scheduled or manual check-ins will build the series here.
                </div>
              )}

              <div className="mt-7 space-y-4">
                {experiment.metrics.map((metric) => <MetricSection key={metric.name} experiment={experiment} metric={metric} />)}
              </div>

              {experiment.verdict && (
                <section className="mt-7 rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] px-5 py-5 shadow-[var(--shadow-card)] md:px-6">
                  <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] uppercase tracking-[0.12em] text-[var(--accent)]">
                    Verdict · {verdictLabel(experiment.verdict.outcome)}
                  </div>
                  <p className="mt-2 text-[length:var(--text-body)] leading-relaxed text-[var(--text-primary)]">{experiment.verdict.note}</p>
                  <div className="mt-2 text-[length:var(--text-caption1)] text-[var(--text-quaternary)]">
                    Concluded {new Date(experiment.verdict.concludedAt).toLocaleDateString()}
                  </div>
                </section>
              )}
            </>
          )}
        </main>
      </div>
    </PageLayout>
  )
}
