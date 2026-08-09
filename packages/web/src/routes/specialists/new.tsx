import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { CheckCircle2, Loader2, MessageSquare, SendHorizontal } from "lucide-react"
import { api } from "@/lib/api"
import type { Employee } from "@/lib/api"
import { queryKeys } from "@/lib/query-keys"
import { PageLayout } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { Button } from "@/components/ui/button"
import { ModelSelectorRow, type SelectorValue } from "@/components/chat/model-selector-row"

// The specialist creation wizard (docs/tengu/18-council-specialists.md's frontend
// plan, "last piece to land — the integration point across every other piece"):
// name/repo/model/effort → POST /api/specialists (write the employee YAML) →
// POST .../kb/learn (Lane A's runLearningPhase, the full-repo index) →
// POST .../kb/teach/start (an interactive session seeded with Lane A's
// teaching.ts kickoff prompt) → a live embedded Q&A, ended by →
// POST .../kb/teach/complete (Lane A's runTeachingPhase harvests the transcript
// and clears the onboarding-only `interactive` flag). Only once teach/complete
// returns is the specialist eligible for the carousel (C4) / round-table (C3)
// picker — both filter on `repo && !interactive`.

type Phase = "form" | "creating" | "learning" | "starting-teaching" | "teaching" | "completing" | "done" | "error"

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,38}$/

interface SessionMessageLike {
  id?: string
  role: string
  content: string
}

function PhaseStep({ label, state }: { label: string; state: "pending" | "active" | "done" }) {
  return (
    <div className="flex items-center gap-2 text-[length:var(--text-subheadline)]">
      {state === "done" ? (
        <CheckCircle2 size={16} className="shrink-0 text-[var(--system-green)]" aria-hidden />
      ) : state === "active" ? (
        <Loader2 size={16} className="shrink-0 animate-spin text-[var(--accent)]" aria-hidden />
      ) : (
        <span className="grid size-4 shrink-0 place-items-center rounded-full border border-[var(--separator)]" aria-hidden />
      )}
      <span
        className={
          state === "pending"
            ? "text-[var(--text-quaternary)]"
            : state === "active"
              ? "font-[var(--weight-semibold)] text-[var(--text-primary)]"
              : "text-[var(--text-secondary)]"
        }
      >
        {label}
      </span>
    </div>
  )
}

const inputCls =
  "w-full rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] border border-[var(--separator)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-subheadline)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"

export default function NewSpecialistPage() {
  useBreadcrumbs([{ label: "Specialists", href: "/specialists" }, { label: "New specialist" }])
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [phase, setPhase] = useState<Phase>("form")
  const [name, setName] = useState("")
  const [repo, setRepo] = useState("")
  const [selector, setSelector] = useState<SelectorValue>({})
  const [employee, setEmployee] = useState<Employee | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [replyText, setReplyText] = useState("")
  const [sending, setSending] = useState(false)
  const transcriptRef = useRef<HTMLDivElement>(null)

  const nameTrimmed = name.trim()
  const nameInvalid = nameTrimmed.length > 0 && !NAME_PATTERN.test(nameTrimmed)
  const canSubmit = nameTrimmed.length > 0 && !nameInvalid && repo.trim().length > 0 && phase === "form"

  // --- Learning phase: poll the KB manifest until the (real) runLearningPhase
  // run this wizard triggered has produced one. ---
  const kbQuery = useQuery({
    queryKey: queryKeys.specialists.kb(employee?.name ?? ""),
    queryFn: () => api.getSpecialistKb(employee!.name),
    enabled: !!employee && phase === "learning",
    refetchInterval: phase === "learning" ? 1500 : false,
  })

  useEffect(() => {
    if (phase === "learning" && kbQuery.data?.exists) {
      void beginTeaching()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, kbQuery.data?.exists])

  // --- Teaching phase: poll the live session transcript. ---
  const sessionQuery = useQuery({
    queryKey: queryKeys.sessions.detail(sessionId ?? ""),
    queryFn: () => api.getSession(sessionId!, { messages: true }),
    enabled: !!sessionId && phase === "teaching",
    refetchInterval: phase === "teaching" ? 2000 : false,
  })

  const messages = useMemo<SessionMessageLike[]>(() => {
    const raw = (sessionQuery.data as { messages?: unknown[] } | undefined)?.messages
    if (!Array.isArray(raw)) return []
    return raw
      .map((m) => m as Record<string, unknown>)
      .filter((m) => typeof m.role === "string" && typeof m.content === "string" && m.role !== "tool")
      .map((m) => ({ id: m.id as string | undefined, role: m.role as string, content: m.content as string }))
  }, [sessionQuery.data])

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" })
  }, [messages.length])

  async function handleSubmit() {
    if (!canSubmit) return
    setError(null)
    setPhase("creating")
    try {
      const res = await api.createSpecialist({
        name: nameTrimmed,
        repo: repo.trim(),
        model: selector.model,
        effortLevel: selector.effortLevel,
        engine: selector.engine,
      })
      if (!res.employee) throw new Error("Specialist was created but could not be re-read")
      setEmployee(res.employee)
      setPhase("learning")
      await api.triggerSpecialistLearning(res.employee.name)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create the specialist")
      setPhase("error")
    }
  }

  async function beginTeaching() {
    if (!employee) return
    setPhase("starting-teaching")
    try {
      const res = await api.startSpecialistTeaching(employee.name)
      setSessionId(res.sessionId)
      setPhase("teaching")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start the teaching session")
      setPhase("error")
    }
  }

  async function sendReply() {
    const text = replyText.trim()
    if (!text || !sessionId || sending) return
    setSending(true)
    try {
      await api.sendMessage(sessionId, { message: text })
      setReplyText("")
      await qc.invalidateQueries({ queryKey: queryKeys.sessions.detail(sessionId) })
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send your reply")
    } finally {
      setSending(false)
    }
  }

  async function finishTeaching() {
    if (!employee || !sessionId) return
    setError(null)
    setPhase("completing")
    try {
      await api.completeSpecialistTeaching(employee.name, sessionId)
      await qc.invalidateQueries({ queryKey: queryKeys.org.all })
      setPhase("done")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to complete the teaching phase")
      setPhase("error")
    }
  }

  function retry() {
    setError(null)
    if (!employee) {
      setPhase("form")
    } else if (!sessionId) {
      setPhase("learning")
    } else if (phase === "error" && sessionId) {
      setPhase("teaching")
    }
  }

  return (
    <PageLayout>
      <div className="h-full overflow-y-auto" data-scrollable>
        <div className="mx-auto max-w-[640px] px-5 pb-20 pt-6 md:pt-11">
          <header>
            <h1 className="font-[var(--font-display)] text-[length:var(--text-title1)] font-bold leading-tight tracking-[var(--tracking-tight)] text-[var(--text-primary)] md:text-[length:var(--text-large-title)]">
              New specialist
            </h1>
            <p className="mt-1 text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
              A Sonnet-tier employee that owns one repo, with a persistent, RAG-retrieved knowledge base of it.
            </p>
          </header>

          {phase === "form" && (
            <div className="mt-6 flex flex-col gap-[var(--space-4)] rounded-[var(--radius-lg)] border border-[var(--separator)] bg-[var(--material-regular)] p-[var(--space-5)]">
              <div className="flex flex-col gap-[var(--space-1)]">
                <label className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)]">
                  Name
                </label>
                <input
                  className={inputCls}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="billing-api"
                  aria-invalid={nameInvalid}
                  data-testid="specialist-name-input"
                />
                {nameInvalid && (
                  <span className="text-[length:var(--text-caption2)] text-[var(--system-red)]">
                    Lowercase letters, digits, and hyphens only, starting with a letter.
                  </span>
                )}
              </div>

              <div className="flex flex-col gap-[var(--space-1)]">
                <label className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)]">
                  Repo
                </label>
                <input
                  className={inputCls}
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  placeholder="~/repos/billing-api"
                  style={{ fontFamily: "var(--font-code)" }}
                  data-testid="specialist-repo-input"
                />
                <span className="text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">
                  Absolute or ~-relative path. This is the one repo this specialist owns and is confined to.
                </span>
              </div>

              <div className="flex flex-col gap-[var(--space-1)]">
                <label className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)]">
                  Model · Effort
                </label>
                <div className="rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] border border-[var(--separator)] px-[var(--space-3)] py-[var(--space-2)]">
                  <ModelSelectorRow mode="new" value={selector} onChange={setSelector} />
                </div>
              </div>

              <div
                className="rounded-[var(--radius-md)] px-[var(--space-3)] py-[var(--space-2.5)] text-[length:var(--text-caption1)] leading-relaxed text-[var(--text-secondary)]"
                style={{ background: "color-mix(in srgb, var(--accent) 8%, transparent)" }}
                data-testid="embedding-download-notice"
              >
                Submitting starts the learning phase, which indexes this repo for retrieval. If this is the
                first specialist created on this machine, that downloads a local embedding model
                (~130MB) once — after that it runs fully offline. This can take a while on a slow
                connection.
              </div>

              {error && (
                <div className="text-[length:var(--text-caption1)] text-[var(--system-red)]">{error}</div>
              )}

              <div className="flex justify-end">
                <Button onClick={() => void handleSubmit()} disabled={!canSubmit} data-testid="specialist-submit">
                  Create specialist
                </Button>
              </div>
            </div>
          )}

          {phase !== "form" && (
            <div className="mt-6 flex flex-col gap-[var(--space-5)] rounded-[var(--radius-lg)] border border-[var(--separator)] bg-[var(--material-regular)] p-[var(--space-5)]">
              <div className="flex flex-col gap-[var(--space-2.5)]" data-testid="specialist-progress">
                <PhaseStep
                  label={`Creating "${nameTrimmed}"`}
                  state={phase === "creating" ? "active" : "done"}
                />
                <PhaseStep
                  label="Indexing your repo (learning phase)…"
                  state={phase === "learning" ? "active" : phase === "creating" ? "pending" : "done"}
                />
                <PhaseStep
                  label="Awaiting your input (teaching phase)…"
                  state={
                    phase === "starting-teaching" || phase === "teaching"
                      ? "active"
                      : phase === "completing" || phase === "done"
                        ? "done"
                        : "pending"
                  }
                />
              </div>

              {phase === "error" && (
                <div className="flex flex-col gap-[var(--space-2)]">
                  <div className="text-[length:var(--text-subheadline)] text-[var(--system-red)]">
                    {error}
                  </div>
                  <div>
                    <Button variant="outline" onClick={retry} data-testid="specialist-retry">
                      Retry
                    </Button>
                  </div>
                </div>
              )}

              {phase === "teaching" && sessionId && (
                <div className="flex flex-col gap-[var(--space-3)]" data-testid="teaching-panel">
                  <div
                    ref={transcriptRef}
                    className="max-h-80 min-h-32 overflow-y-auto rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] p-3 flex flex-col gap-2"
                    data-testid="teaching-transcript"
                  >
                    {messages.length === 0 ? (
                      <p className="text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
                        {nameTrimmed} is looking over the repo and will ask its first question shortly…
                      </p>
                    ) : (
                      messages.map((m, i) => (
                        <div
                          key={m.id ?? i}
                          className={`max-w-[85%] rounded-[var(--radius-md)] px-3 py-1.5 text-[length:var(--text-subheadline)] leading-relaxed ${
                            m.role === "user"
                              ? "self-end bg-[var(--accent-fill)] text-[var(--text-primary)]"
                              : "self-start bg-[var(--bg-secondary)] text-[var(--text-primary)]"
                          }`}
                        >
                          {m.content}
                        </div>
                      ))
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      className={inputCls}
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault()
                          void sendReply()
                        }
                      }}
                      placeholder="Reply…"
                      data-testid="teaching-reply-input"
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => void sendReply()}
                      disabled={!replyText.trim() || sending}
                      aria-label="Send reply"
                    >
                      <SendHorizontal size={16} />
                    </Button>
                  </div>

                  <div className="flex justify-end">
                    <Button onClick={() => void finishTeaching()} data-testid="specialist-finish-teaching">
                      Finish teaching
                    </Button>
                  </div>
                </div>
              )}

              {phase === "done" && employee && (
                <div className="flex flex-col items-start gap-[var(--space-3)]" data-testid="specialist-done">
                  <p className="text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">
                    <span className="font-[var(--weight-semibold)] text-[var(--text-primary)]">{employee.name}</span>{" "}
                    is ready — it now appears in the specialist carousel and the round-table picker.
                  </p>
                  <div className="flex gap-2">
                    <Button onClick={() => navigate(`/?employee=${encodeURIComponent(employee.name)}`)}>
                      <MessageSquare size={14} className="mr-1.5" />
                      Start chatting
                    </Button>
                    <Button variant="outline" onClick={() => navigate("/specialists")}>
                      View in carousel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </PageLayout>
  )
}
