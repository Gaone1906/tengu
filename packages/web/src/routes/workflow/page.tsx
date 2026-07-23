import { useQuery } from "@tanstack/react-query"
import { ArrowLeft, Workflow } from "lucide-react"
import { Link, useParams } from "react-router-dom"
import { PageLayout } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { api, type WorkflowDefinitionV2Wire } from "@/lib/api"
import { queryKeys } from "@/lib/query-keys"

function nodeKind(type: WorkflowDefinitionV2Wire["nodes"][number]["type"]): string {
  return type === "employee" ? "Employee" : type.charAt(0).toUpperCase() + type.slice(1)
}

function DefinitionView({ definition }: { definition: WorkflowDefinitionV2Wire }) {
  const names = new Map(definition.nodes.map((node) => [node.id, node.name]))
  return (
    <>
      <section className="mt-6">
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
                  <div className="flex flex-wrap items-center gap-2">
                    <h1 className="text-[length:var(--text-title1)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)]">{query.data.title}</h1>
                    <span className="rounded-full bg-[var(--fill-tertiary)] px-2.5 py-1 text-[length:var(--text-caption1)] text-[var(--text-secondary)]">Read only</span>
                  </div>
                  {query.data.description && <p className="mt-1 text-[var(--text-secondary)]">{query.data.description}</p>}
                  <p className="mt-2 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                    {query.data.enabled ? "Enabled" : "Disabled"} · Revision {query.data.revision}
                  </p>
                </div>
              </header>
              <DefinitionView definition={query.data} />
            </>
          )}
        </main>
      </div>
    </PageLayout>
  )
}
