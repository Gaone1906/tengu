import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, Play, Workflow } from "lucide-react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { PageLayout } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { api, type WorkflowDefinitionV2Wire, type WorkflowRunSummaryV2Wire } from "@/lib/api"
import { queryKeys } from "@/lib/query-keys"
import {
  StatusGlyph,
  TRIGGER_KIND_LABEL,
  formatDuration,
  formatStarted,
  isLiveRunStatus,
  statusMeta,
} from "./run-support"

function nodeKind(type: WorkflowDefinitionV2Wire["nodes"][number]["type"]): string {
  return type === "employee" ? "Employee" : type.charAt(0).toUpperCase() + type.slice(1)
}

function hasManualTrigger(definition: WorkflowDefinitionV2Wire): boolean {
  return definition.nodes.some((node) => node.type === "trigger" && node.config["kind"] === "manual")
}

function RunRow({ run }: { run: WorkflowRunSummaryV2Wire }) {
  const meta = statusMeta(run.status)
  const nodeHint = run.currentOrFailingNode
  return (
    <Link
      to={`/workflow/${encodeURIComponent(run.workflowId)}/runs/${encodeURIComponent(run.id)}`}
      className="flex items-center gap-3 rounded-[13px] px-3.5 py-3 hover:bg-[var(--fill-quaternary)]"
    >
      <StatusGlyph status={run.status} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--text-primary)]">
            {meta.label}
          </span>
          <span
            className="truncate text-[length:var(--text-caption1)] text-[var(--text-quaternary)]"
            style={{ fontFamily: "var(--font-code)" }}
          >
            {run.id}
          </span>
        </span>
        <span className="block truncate text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          {TRIGGER_KIND_LABEL[run.trigger.kind]}
          {nodeHint ? ` · ${nodeHint.state === "failing" ? "failed at" : "at"} ${nodeHint.label}` : ""}
        </span>
      </span>
      <span
        className="shrink-0 text-right text-[length:var(--text-caption1)] text-[var(--text-tertiary)] [font-variant-numeric:tabular-nums]"
        style={{ fontFamily: "var(--font-code)" }}
      >
        <span className="block">{formatStarted(run.startedAt)}</span>
        <span className="block text-[var(--text-quaternary)]">{formatDuration(run.startedAt, run.endedAt)}</span>
      </span>
    </Link>
  )
}

function RunsSection({ workflowId }: { workflowId: string }) {
  const query = useQuery({
    queryKey: queryKeys.workflows.runs(workflowId),
    queryFn: () => api.listWorkflowRunsV2(workflowId),
    enabled: Boolean(workflowId),
    refetchInterval: (current) =>
      current.state.data?.items.some((run) => isLiveRunStatus(run.status)) ? 2500 : false,
  })

  return (
    <section className="mt-8">
      <h2 className="mb-3 text-[length:var(--text-headline)] font-[var(--weight-semibold)]">Runs</h2>
      {query.isPending && <p className="text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">Loading runs…</p>}
      {query.isError && (
        <p className="rounded-[var(--radius-lg)] bg-[var(--fill-tertiary)] p-4 text-[length:var(--text-subheadline)] text-[var(--system-red)]">
          {query.error instanceof Error ? query.error.message : "Failed to load runs."}
        </p>
      )}
      {query.data && query.data.items.length === 0 && (
        <p className="text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">No runs yet.</p>
      )}
      {query.data && query.data.items.length > 0 && (
        <div className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[5px] shadow-[var(--shadow-card)]">
          {query.data.items.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
          {query.data.nextCursor && (
            <p className="px-3.5 py-2.5 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
              Showing the latest {query.data.items.length} runs.
            </p>
          )}
        </div>
      )}
    </section>
  )
}

function DefinitionView({ definition }: { definition: WorkflowDefinitionV2Wire }) {
  const names = new Map(definition.nodes.map((node) => [node.id, node.name]))
  return (
    <>
      <section className="mt-8">
        <h2 className="mb-3 text-[length:var(--text-headline)] font-[var(--weight-semibold)]">Nodes</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {definition.nodes.map((node) => (
            <article key={node.id} className="rounded-[var(--radius-lg)] bg-[var(--bg-secondary)] p-4 shadow-[var(--shadow-card)]">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-[var(--weight-semibold)] text-[var(--text-primary)]">{node.name}</h3>
                  <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{node.id}</p>
                </div>
                <span className="rounded-full bg-[var(--fill-tertiary)] px-2.5 py-1 text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
                  {nodeKind(node.type)}
                </span>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="mb-3 text-[length:var(--text-headline)] font-[var(--weight-semibold)]">Connections</h2>
        {definition.edges.length === 0 ? (
          <p className="text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">No connections.</p>
        ) : (
          <div className="space-y-2">
            {definition.edges.map((edge) => (
              <div key={edge.id} className="rounded-[var(--radius-lg)] bg-[var(--fill-tertiary)] px-4 py-3 text-[length:var(--text-subheadline)]">
                {names.get(edge.from.nodeId) ?? edge.from.nodeId} → {names.get(edge.to.nodeId) ?? edge.to.nodeId}
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  )
}

function RunButton({ workflowId }: { workflowId: string }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const start = useMutation({
    mutationFn: () => api.startWorkflowRunV2(workflowId),
    onSuccess: (detail) => {
      queryClient.setQueryData(queryKeys.workflows.run(workflowId, detail.id), detail)
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflows.runs(workflowId) })
      navigate(`/workflow/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(detail.id)}`)
    },
  })

  return (
    <div className="shrink-0">
      <button
        type="button"
        onClick={() => start.mutate()}
        disabled={start.isPending}
        className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--accent)] px-4 text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--accent-contrast)] transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        <Play className="size-3.5" aria-hidden />
        {start.isPending ? "Starting…" : "Run"}
      </button>
      {start.isError && (
        <p className="mt-1.5 max-w-[220px] text-right text-[length:var(--text-caption1)] text-[var(--system-red)]">
          {start.error instanceof Error ? start.error.message : "Failed to start run."}
        </p>
      )}
    </div>
  )
}

export default function WorkflowPage() {
  const { id = "" } = useParams<{ id: string }>()
  const query = useQuery({
    queryKey: queryKeys.workflows.definition(id),
    queryFn: () => api.getWorkflowDefinitionV2(id),
    enabled: Boolean(id),
  })
  useBreadcrumbs([
    { label: "Workflows", href: "/workflow" },
    { label: query.data?.title ?? id },
  ])

  return (
    <PageLayout>
      <div className="h-full overflow-y-auto" data-scrollable="true">
        <main className="mx-auto max-w-[860px] px-5 pb-16 pt-6 md:pt-10">
          <Link to="/workflow" className="inline-flex items-center gap-1.5 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
            <ArrowLeft className="size-4" aria-hidden />
            Workflows
          </Link>
          {query.isPending && <p className="py-12 text-center text-[var(--text-secondary)]">Loading workflow…</p>}
          {query.isError && (
            <p className="mt-6 rounded-[var(--radius-lg)] bg-[var(--fill-tertiary)] p-4 text-[var(--system-red)]">
              {query.error instanceof Error ? query.error.message : "Failed to load workflow."}
            </p>
          )}
          {query.data && (
            <>
              <header className="mt-5 flex items-start gap-4">
                <span className="grid size-11 shrink-0 place-items-center rounded-[var(--radius-md)] bg-[var(--fill-tertiary)]">
                  <Workflow className="size-5 text-[var(--text-secondary)]" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <h1 className="text-[length:var(--text-title1)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)]">{query.data.title}</h1>
                  {query.data.description && <p className="mt-1 text-[var(--text-secondary)]">{query.data.description}</p>}
                  <p className="mt-2 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                    {query.data.enabled ? "Enabled" : "Disabled"} · Revision {query.data.revision}
                  </p>
                </div>
                {query.data.enabled && hasManualTrigger(query.data) && <RunButton workflowId={query.data.id} />}
              </header>
              <RunsSection workflowId={query.data.id} />
              <DefinitionView definition={query.data} />
            </>
          )}
        </main>
      </div>
    </PageLayout>
  )
}
