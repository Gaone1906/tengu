import { useQuery } from "@tanstack/react-query"
import { ArrowRight, Workflow } from "lucide-react"
import { Link } from "react-router-dom"
import { PageLayout } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import {
  api,
  type WorkflowDefinitionSummaryV2Wire,
  type WorkflowDefinitionV2Wire,
} from "@/lib/api"
import { queryKeys } from "@/lib/query-keys"

interface WorkflowListEntry {
  summary: WorkflowDefinitionSummaryV2Wire
  definition: WorkflowDefinitionV2Wire | null
}

async function loadDefinitions(): Promise<WorkflowListEntry[]> {
  const page = await api.listWorkflowDefinitionsV2()
  return Promise.all(page.items.filter((item) => !item.retiredAt).map(async (summary) => ({
    summary,
    definition: await api.getWorkflowDefinitionV2(summary.id).catch(() => null),
  })))
}

function countLabel(definition: WorkflowDefinitionV2Wire | null): string {
  if (!definition) return "Definition unavailable"
  const nodes = `${definition.nodes.length} ${definition.nodes.length === 1 ? "node" : "nodes"}`
  const edges = `${definition.edges.length} ${definition.edges.length === 1 ? "edge" : "edges"}`
  return `${nodes} · ${edges}`
}

export default function WorkflowListPage() {
  useBreadcrumbs([{ label: "Workflows" }])
  const query = useQuery({
    queryKey: queryKeys.workflows.all,
    queryFn: loadDefinitions,
  })

  return (
    <PageLayout>
      <div className="h-full overflow-y-auto" data-scrollable="true">
        <main className="mx-auto max-w-[760px] px-5 pb-16 pt-6 md:pt-12">
          <header className="mb-6">
            <h1 className="font-[var(--font-display)] text-[length:var(--text-large-title)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
              Workflows
            </h1>
            <p className="mt-1 text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">
              Read-only definitions from the workflow engine.
            </p>
          </header>

          {query.isPending && <p className="py-12 text-center text-[var(--text-secondary)]">Loading workflows…</p>}
          {query.isError && (
            <p className="rounded-[var(--radius-lg)] bg-[var(--fill-tertiary)] p-4 text-[var(--system-red)]">
              {query.error instanceof Error ? query.error.message : "Failed to load workflows."}
            </p>
          )}
          {query.data?.length === 0 && (
            <div className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] px-8 py-16 text-center shadow-[var(--shadow-card)]">
              <Workflow className="mx-auto size-8 text-[var(--text-tertiary)]" aria-hidden />
              <h2 className="mt-4 text-[length:var(--text-title3)] font-[var(--weight-semibold)]">No workflows yet</h2>
            </div>
          )}
          <div className="space-y-3">
            {query.data?.map(({ summary, definition }) => (
              <Link
                key={summary.id}
                to={`/workflow/${encodeURIComponent(summary.id)}`}
                className="hover-lift flex items-center gap-4 rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] px-5 py-4 shadow-[var(--shadow-card)]"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-[var(--radius-md)] bg-[var(--fill-tertiary)]">
                  <Workflow className="size-[18px] text-[var(--text-secondary)]" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-[var(--weight-semibold)] text-[var(--text-primary)]">{summary.title}</span>
                  <span className="block truncate text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
                    {summary.description || countLabel(definition)}
                  </span>
                  {summary.description && (
                    <span className="block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{countLabel(definition)}</span>
                  )}
                </span>
                <span className="shrink-0 text-right text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                  <span className="block">{summary.enabled ? "Enabled" : "Disabled"}</span>
                  <span className="block">Revision {summary.revision}</span>
                </span>
                <ArrowRight className="size-4 shrink-0 text-[var(--text-quaternary)]" aria-hidden />
              </Link>
            ))}
          </div>
        </main>
      </div>
    </PageLayout>
  )
}
