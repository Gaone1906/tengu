import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft } from "lucide-react"
import { Link, useParams } from "react-router-dom"
import { PageLayout } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { api, type WorkflowRunDetailV2Wire } from "@/lib/api"
import { queryKeys } from "@/lib/query-keys"
import { RunCanvas } from "./run-canvas"
import { RunInspector } from "./run-inspector"
import {
  StatusLine,
  TRIGGER_KIND_LABEL,
  formatDuration,
  formatStarted,
  mergeRunDetail,
  missingPromptAttempt,
} from "./run-support"

/** The run detail page IS the canvas: the editor graph read-only, painted with
 *  live node state. Clicking a node opens the run inspector. */
export default function WorkflowRunPage() {
  const { id = "", runId = "" } = useParams<{ id: string; runId: string }>()
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const runKey = queryKeys.workflows.run(id, runId)
  /** The canvas cannot draw without the definition snapshot, so the first fetch
   *  is the fat one; every poll after it is lean and folded into that snapshot. */
  const query = useQuery({
    queryKey: runKey,
    queryFn: async () => {
      const snapshot = queryClient.getQueryData<WorkflowRunDetailV2Wire>(runKey)
      if (!snapshot) return api.getWorkflowRunFullV2(id, runId)
      return mergeRunDetail(snapshot, await api.getWorkflowRunV2(id, runId))
    },
    enabled: Boolean(id && runId),
  })
  useBreadcrumbs([
    { label: "Workflows", href: "/workflow" },
    { label: query.data?.workflowTitle ?? id, href: `/workflow/${encodeURIComponent(id)}` },
    { label: "Run" },
  ])

  const detail = query.data
  /** Opening a node whose prompt the snapshot predates — a retry dispatched
   *  while this page was open — re-fetches the snapshot once, so the panel shows
   *  the prompt instead of silently dropping the section. */
  const promptGap = detail && selectedNodeId ? missingPromptAttempt(detail, selectedNodeId) : null
  useQuery({
    queryKey: queryKeys.workflows.runPrompt(id, runId, promptGap ?? ""),
    queryFn: async () => {
      const snapshot = await api.getWorkflowRunFullV2(id, runId)
      queryClient.setQueryData<WorkflowRunDetailV2Wire>(runKey, (current) => (
        current ? mergeRunDetail(snapshot, current) : snapshot
      ))
      return snapshot
    },
    enabled: promptGap !== null,
    staleTime: Infinity,
  })

  const decide = useMutation({
    mutationFn: ({ nodeId, decision }: { nodeId: string; decision: "approve" | "reject" }) =>
      api.decideWorkflowApprovalV2(id, runId, nodeId, { decision, expectedRevision: query.data?.revision ?? 0 }),
    onSuccess: (decided) => {
      queryClient.setQueryData(runKey, decided)
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflows.runs(id) })
    },
  })

  return (
    <PageLayout>
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-3 pt-4 md:px-5">
          <Link
            to={`/workflow/${encodeURIComponent(id)}?lens=runs`}
            aria-label={`Back to ${detail?.workflowTitle ?? "workflow"} runs`}
            className="grid size-8 shrink-0 place-items-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--fill-tertiary)]"
          >
            <ArrowLeft className="size-4" aria-hidden />
          </Link>
          <div className="min-w-0 flex-[1_1_160px]">
            <h1 className="truncate text-[length:var(--text-headline)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)]">
              {detail ? `${TRIGGER_KIND_LABEL[detail.trigger.kind]} run` : "Run"}
            </h1>
            <p
              className="truncate text-[length:var(--text-caption2)] text-[var(--text-quaternary)]"
              style={{ fontFamily: "var(--font-code)" }}
            >
              {runId}
            </p>
          </div>
          {detail && (
            <>
              <StatusLine status={detail.status} className="shrink-0 text-[length:var(--text-footnote)]" />
              {detail.spendUsd > 0 && (
                <span className="shrink-0 text-[length:var(--text-caption1)] text-[var(--text-tertiary)] [font-variant-numeric:tabular-nums]">
                  {detail.spendUsd.toLocaleString("en-US", {
                    style: "currency",
                    currency: "USD",
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 6,
                  })}
                </span>
              )}
              <span className="hidden shrink-0 text-[length:var(--text-caption1)] text-[var(--text-tertiary)] [font-variant-numeric:tabular-nums] sm:block">
                Started {formatStarted(detail.startedAt)} · {formatDuration(detail.startedAt, detail.endedAt)}
                {" · "}Revision {detail.definitionRevision}
              </span>
            </>
          )}
        </header>
        {detail?.error && (
          <p className="mx-4 mb-2 rounded-[var(--radius-lg)] bg-[var(--fill-tertiary)] px-4 py-3 text-[length:var(--text-footnote)] text-[var(--system-red)] md:mx-5">
            {detail.error.message}
          </p>
        )}
        {decide.isError && (
          <p className="mx-4 mb-2 rounded-[var(--radius-lg)] bg-[var(--fill-tertiary)] px-4 py-3 text-[length:var(--text-footnote)] text-[var(--system-red)] md:mx-5">
            {decide.error instanceof Error ? decide.error.message : "Failed to record the decision."}
          </p>
        )}
        {query.isPending && <p className="py-12 text-center text-[var(--text-secondary)]">Loading run…</p>}
        {query.isError && (
          <p className="mx-auto mt-6 max-w-[560px] rounded-[var(--radius-lg)] bg-[var(--fill-tertiary)] p-4 text-[var(--system-red)]">
            {query.error instanceof Error ? query.error.message : "Failed to load run."}
          </p>
        )}
        {detail && (
          <div className="relative min-h-0 flex-1">
            <RunCanvas detail={detail} selectedNodeId={selectedNodeId} onSelectNode={setSelectedNodeId} />
            {selectedNodeId && (
              <RunInspector
                detail={detail}
                nodeId={selectedNodeId}
                onClose={() => setSelectedNodeId(null)}
                onDecide={(nodeId, decision) => decide.mutate({ nodeId, decision })}
                deciding={decide.isPending}
              />
            )}
          </div>
        )}
      </div>
    </PageLayout>
  )
}
