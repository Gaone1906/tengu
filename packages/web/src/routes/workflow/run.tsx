import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft } from "lucide-react"
import { Link, useParams } from "react-router-dom"
import { PageLayout } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import {
  api,
  type WorkflowApprovalV2Wire,
  type WorkflowAttemptV2Wire,
  type WorkflowNodeRunV2Wire,
  type WorkflowRunDetailV2Wire,
} from "@/lib/api"
import { queryKeys } from "@/lib/query-keys"
import {
  StatusLine,
  TRIGGER_KIND_LABEL,
  formatDuration,
  formatStarted,
  isLiveRunStatus,
} from "./run-support"

// View model — rendered straight off the server's WorkflowRunDetail, no client
// mirror: one timeline row per definition node (definition order), joined with
// its nodeRun (status/timing/error/output), its attempts (detail.attempts
// filtered by nodeId), and its approval (detail.approvals by nodeId).
interface TimelineRow {
  nodeId: string
  name: string
  type: string
  nodeRun: WorkflowNodeRunV2Wire | undefined
  attempts: WorkflowAttemptV2Wire[]
  approval: WorkflowApprovalV2Wire | undefined
}

function timelineRows(detail: WorkflowRunDetailV2Wire): TimelineRow[] {
  const nodeRuns = new Map(detail.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun]))
  const approvals = new Map(detail.approvals.map((approval) => [approval.nodeId, approval]))
  return detail.definition.nodes.map((node) => ({
    nodeId: node.id,
    name: node.name,
    type: node.type === "employee" ? "Employee" : node.type.charAt(0).toUpperCase() + node.type.slice(1),
    nodeRun: nodeRuns.get(node.id),
    attempts: detail.attempts
      .filter((attempt) => attempt.nodeId === node.id)
      .sort((a, b) => a.attempt - b.attempt),
    approval: approvals.get(node.id),
  }))
}

function ErrorNote({ message }: { message: string }) {
  return <p className="mt-1.5 text-[length:var(--text-caption1)] text-[var(--system-red)]">{message}</p>
}

function AttemptRow({ attempt }: { attempt: WorkflowAttemptV2Wire }) {
  return (
    <div className="mt-2 rounded-[10px] bg-[var(--fill-quaternary)] px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <span className="text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)]">
          Attempt {attempt.attempt}
        </span>
        <StatusLine status={attempt.status} />
        <span
          className="ml-auto text-[length:var(--text-caption1)] text-[var(--text-quaternary)] [font-variant-numeric:tabular-nums]"
          style={{ fontFamily: "var(--font-code)" }}
        >
          {formatDuration(attempt.startedAt, attempt.endedAt)}
        </span>
      </div>
      {attempt.error && <ErrorNote message={attempt.error.message} />}
      {attempt.output?.text && (
        <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
          {attempt.output.text}
        </p>
      )}
    </div>
  )
}

function ApprovalBlock({ approval, onDecide, deciding }: {
  approval: WorkflowApprovalV2Wire
  onDecide: (nodeId: string, decision: "approve" | "reject") => void
  deciding: boolean
}) {
  if (approval.status === "pending") {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2.5 rounded-[10px] bg-[var(--fill-quaternary)] px-3 py-2.5">
        <span className="text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
          Approval requested {formatStarted(approval.requestedAt)}
          {approval.approverRef ? ` · ${approval.approverRef}` : ""}
        </span>
        <span className="ml-auto flex gap-2">
          <button
            type="button"
            disabled={deciding}
            onClick={() => onDecide(approval.nodeId, "approve")}
            className="h-7 rounded-full bg-[var(--accent)] px-3 text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--accent-contrast)] transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Approve
          </button>
          <button
            type="button"
            disabled={deciding}
            onClick={() => onDecide(approval.nodeId, "reject")}
            className="h-7 rounded-full bg-[var(--fill-secondary)] px-3 text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--system-red)] transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Reject
          </button>
        </span>
      </div>
    )
  }
  return (
    <p className="mt-1.5 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
      {approval.status === "approved" ? "Approved" : "Rejected"}
      {approval.decidedBy ? ` by ${approval.decidedBy}` : ""}
      {approval.decidedAt ? ` · ${formatStarted(approval.decidedAt)}` : ""}
      {approval.reason ? ` — ${approval.reason}` : ""}
    </p>
  )
}

function NodeRow({ row, onDecide, deciding }: {
  row: TimelineRow
  onDecide: (nodeId: string, decision: "approve" | "reject") => void
  deciding: boolean
}) {
  const status = row.nodeRun?.status ?? "pending"
  const dimmed = status === "skipped" || (!row.nodeRun?.activated && status === "pending")
  return (
    <div className={`rounded-[13px] px-3.5 py-3 ${dimmed ? "opacity-55" : ""}`}>
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--text-primary)]">
              {row.name}
            </span>
            <span className="shrink-0 text-[length:var(--text-caption1)] text-[var(--text-quaternary)]">{row.type}</span>
          </span>
        </span>
        <span
          className="shrink-0 text-[length:var(--text-caption1)] text-[var(--text-quaternary)] [font-variant-numeric:tabular-nums]"
          style={{ fontFamily: "var(--font-code)" }}
        >
          {formatDuration(row.nodeRun?.startedAt, row.nodeRun?.endedAt)}
        </span>
        <StatusLine status={status} className="w-[92px] shrink-0 justify-end sm:w-[104px]" />
      </div>
      {row.nodeRun?.error && <ErrorNote message={row.nodeRun.error.message} />}
      {row.approval && <ApprovalBlock approval={row.approval} onDecide={onDecide} deciding={deciding} />}
      {row.attempts.map((attempt) => (
        <AttemptRow key={attempt.attempt} attempt={attempt} />
      ))}
      {row.attempts.length === 0 && row.nodeRun?.output?.text && (
        <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
          {row.nodeRun.output.text}
        </p>
      )}
    </div>
  )
}

export default function WorkflowRunPage() {
  const { id = "", runId = "" } = useParams<{ id: string; runId: string }>()
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: queryKeys.workflows.run(id, runId),
    queryFn: () => api.getWorkflowRunV2(id, runId),
    enabled: Boolean(id && runId),
    refetchInterval: (current) => (isLiveRunStatus(current.state.data?.status) ? 2000 : false),
  })
  useBreadcrumbs([
    { label: "Workflows", href: "/workflow" },
    { label: query.data?.workflowTitle ?? id, href: `/workflow/${encodeURIComponent(id)}` },
    { label: "Run" },
  ])

  const decide = useMutation({
    mutationFn: ({ nodeId, decision }: { nodeId: string; decision: "approve" | "reject" }) =>
      api.decideWorkflowApprovalV2(id, runId, nodeId, { decision, expectedRevision: query.data?.revision ?? 0 }),
    onSuccess: (detail) => {
      queryClient.setQueryData(queryKeys.workflows.run(id, runId), detail)
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflows.runs(id) })
    },
  })

  const detail = query.data
  return (
    <PageLayout>
      <div className="h-full overflow-y-auto" data-scrollable="true">
        <main className="mx-auto max-w-[860px] px-5 pb-16 pt-6 md:pt-10">
          <Link
            to={`/workflow/${encodeURIComponent(id)}`}
            className="inline-flex items-center gap-1.5 text-[length:var(--text-footnote)] text-[var(--text-secondary)]"
          >
            <ArrowLeft className="size-4" aria-hidden />
            {detail?.workflowTitle ?? "Workflow"}
          </Link>
          {query.isPending && <p className="py-12 text-center text-[var(--text-secondary)]">Loading run…</p>}
          {query.isError && (
            <p className="mt-6 rounded-[var(--radius-lg)] bg-[var(--fill-tertiary)] p-4 text-[var(--system-red)]">
              {query.error instanceof Error ? query.error.message : "Failed to load run."}
            </p>
          )}
          {detail && (
            <>
              <header className="mt-5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h1 className="text-[length:var(--text-title2)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)]">
                    {TRIGGER_KIND_LABEL[detail.trigger.kind]} run
                  </h1>
                  <StatusLine status={detail.status} className="text-[length:var(--text-footnote)]" />
                </div>
                <p
                  className="mt-1 text-[length:var(--text-caption1)] text-[var(--text-quaternary)]"
                  style={{ fontFamily: "var(--font-code)" }}
                >
                  {detail.id}
                </p>
                <p className="mt-2 text-[length:var(--text-caption1)] text-[var(--text-tertiary)] [font-variant-numeric:tabular-nums]">
                  Started {formatStarted(detail.startedAt)} · {formatDuration(detail.startedAt, detail.endedAt)}
                  {" · "}Revision {detail.definitionRevision}
                </p>
                {detail.error && (
                  <p className="mt-3 rounded-[var(--radius-lg)] bg-[var(--fill-tertiary)] px-4 py-3 text-[length:var(--text-footnote)] text-[var(--system-red)]">
                    {detail.error.message}
                  </p>
                )}
                {decide.isError && (
                  <p className="mt-3 rounded-[var(--radius-lg)] bg-[var(--fill-tertiary)] px-4 py-3 text-[length:var(--text-footnote)] text-[var(--system-red)]">
                    {decide.error instanceof Error ? decide.error.message : "Failed to record the decision."}
                  </p>
                )}
              </header>

              <section className="mt-7">
                <h2 className="mb-3 text-[length:var(--text-headline)] font-[var(--weight-semibold)]">Timeline</h2>
                <div className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[5px] shadow-[var(--shadow-card)]">
                  {timelineRows(detail).map((row) => (
                    <NodeRow
                      key={row.nodeId}
                      row={row}
                      deciding={decide.isPending}
                      onDecide={(nodeId, decision) => decide.mutate({ nodeId, decision })}
                    />
                  ))}
                </div>
              </section>
            </>
          )}
        </main>
      </div>
    </PageLayout>
  )
}
