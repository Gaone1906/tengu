import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronLeft, PencilLine } from "lucide-react"
import { api } from "@/lib/api"
import { extraFrontmatter, parseSkillMd } from "@/lib/skills"
import { MarkdownView } from "@/components/markdown-view"
import { PageLayout } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { useTheme } from "@/routes/providers"

/* A skill opens as a document, not a modal: large-title header (name +
 * frontmatter description), the rendered SKILL.md as the body, and an Edit
 * mode that swaps the body for the raw file in a calm monospace editor.
 * Saving PUTs the whole file back; gateways that predate the write endpoint
 * get a friendly explanation instead of a raw 404. */

/** The gateway rejects the write when the endpoint doesn't exist yet. */
function saveErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (/API error: (404|405)/.test(msg)) {
    return "This gateway version can't save skills yet — update the gateway to edit skills from here."
  }
  return msg || "Couldn't save the skill"
}

function DetailSkeleton() {
  return (
    <div aria-hidden data-testid="skill-detail-skeleton">
      <div className="h-8 w-[46%] rounded-[8px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]" />
      <div className="mt-3 h-3.5 w-[70%] rounded-[6px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]" style={{ animationDelay: "150ms" }} />
      <div className="mt-10 space-y-3">
        {["92%", "84%", "88%", "60%"].map((w, i) => (
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

export default function SkillDetailPage() {
  const params = useParams<{ name: string }>()
  const name = params.name ? decodeURIComponent(params.name) : ""
  useBreadcrumbs(useMemo(() => [{ label: "Skills", href: "/skills" }, { label: name }], [name]))
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { theme } = useTheme()

  const isDark = useMemo(() => {
    if (typeof document !== "undefined") {
      const attr = document.documentElement.getAttribute("data-theme")
      if (attr) return attr !== "light"
    }
    return theme !== "light"
  }, [theme])

  const skillQuery = useQuery({
    queryKey: ["skill", name],
    queryFn: () => api.getSkill(name),
    enabled: !!name,
    retry: (failureCount, error) =>
      !(error instanceof Error && /API error: 404/.test(error.message)) && failureCount < 2,
  })

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [saveError, setSaveError] = useState<string | null>(null)
  const editorRef = useRef<HTMLTextAreaElement | null>(null)

  const content = skillQuery.data?.content ?? ""
  const parsed = useMemo(() => parseSkillMd(content), [content])
  const description = parsed.frontmatter.description ?? ""
  const meta = useMemo(() => extraFrontmatter(parsed.frontmatter), [parsed.frontmatter])
  const dirty = editing && draft !== content

  const save = useMutation({
    mutationFn: (next: string) => api.updateSkill(name, next),
    onSuccess: (_data, next) => {
      // Reflect the save immediately; the invalidations re-sync with disk.
      qc.setQueryData(["skill", name], { name, content: next })
      void qc.invalidateQueries({ queryKey: ["skill", name] })
      void qc.invalidateQueries({ queryKey: ["skills"] })
      setEditing(false)
      setSaveError(null)
    },
    onError: (e) => setSaveError(saveErrorMessage(e)),
  })

  const beginEdit = useCallback(() => {
    setDraft(content)
    setSaveError(null)
    setEditing(true)
  }, [content])

  const cancelEdit = useCallback(() => {
    if (draft !== content && !window.confirm("Discard your changes?")) return
    setEditing(false)
    setSaveError(null)
  }, [draft, content])

  const commit = useCallback(() => {
    if (!dirty || save.isPending) return
    save.mutate(draft)
  }, [dirty, save, draft])

  // The editor grows with its content (no inner scrollbar fighting the page).
  useLayoutEffect(() => {
    if (!editing) return
    const el = editorRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.max(el.scrollHeight + 2, 320)}px`
  }, [editing, draft])

  // Focus the editor when entering edit mode.
  useEffect(() => {
    if (editing) editorRef.current?.focus()
  }, [editing])

  const onEditorKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault()
        commit()
      } else if (e.key === "Escape") {
        e.preventDefault()
        cancelEdit()
      }
    },
    [commit, cancelEdit],
  )

  const notFound =
    skillQuery.isError && skillQuery.error instanceof Error && /API error: 404/.test(skillQuery.error.message)

  return (
    <PageLayout>
      <div className="h-full overflow-y-auto" data-scrollable>
        <div className="mx-auto max-w-[840px] px-5 pb-24 pt-6 md:pt-11">
          <Link
            to="/skills"
            className="mb-3.5 inline-flex items-center gap-1 text-[length:var(--text-footnote)] font-medium text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]"
          >
            <ChevronLeft size={13} strokeWidth={2.4} aria-hidden />
            Skills
          </Link>

          {skillQuery.isLoading ? (
            <DetailSkeleton />
          ) : notFound ? (
            <div className="px-2 py-12 text-center" data-testid="skill-not-found">
              <h1 className="text-[length:var(--text-title3)] font-bold tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
                Skill not found
              </h1>
              <p className="mt-2 text-[length:var(--text-subheadline)] text-[var(--text-tertiary)]">
                “{name}” isn't installed on this gateway.
              </p>
              <button
                type="button"
                onClick={() => navigate("/skills")}
                className="mt-4 text-[length:var(--text-footnote)] font-medium text-[var(--accent)] transition-opacity hover:opacity-80"
              >
                Back to Skills
              </button>
            </div>
          ) : skillQuery.isError ? (
            <div
              className="rounded-[var(--radius-lg)] p-4 text-[length:var(--text-subheadline)] text-[var(--system-red)]"
              style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}
            >
              {skillQuery.error instanceof Error ? skillQuery.error.message : "Failed to load the skill"}
            </div>
          ) : (
            <>
              <header className="flex flex-wrap items-end justify-between gap-x-3 gap-y-4">
                <div className="min-w-0 flex-1 basis-[320px]">
                  <h1 className="font-[var(--font-display)] text-[length:var(--text-title1)] font-bold leading-tight tracking-[var(--tracking-tight)] text-[var(--text-primary)] [overflow-wrap:anywhere] md:text-[length:var(--text-large-title)]">
                    {name}
                  </h1>
                  {description && (
                    <p className="mt-1.5 max-w-[620px] text-[length:var(--text-subheadline)] leading-[var(--leading-normal)] text-[var(--text-secondary)]">
                      {description}
                    </p>
                  )}
                  <div
                    className="mt-2.5 text-[length:var(--text-caption1)] text-[var(--text-quaternary)] [overflow-wrap:anywhere]"
                    style={{ fontFamily: "var(--font-code)" }}
                  >
                    skills/{name}/SKILL.md
                  </div>
                  {meta.length > 0 && !editing && (
                    <div className="mt-1.5 space-y-0.5">
                      {meta.map(([k, v]) => (
                        <div
                          key={k}
                          className="text-[length:var(--text-caption1)] text-[var(--text-quaternary)] [overflow-wrap:anywhere]"
                          style={{ fontFamily: "var(--font-code)" }}
                        >
                          {k}: {v}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {editing ? (
                  <div className="flex flex-none items-center gap-2">
                    <button
                      type="button"
                      data-testid="skill-cancel"
                      onClick={cancelEdit}
                      className="h-9 rounded-full px-3.5 text-[length:var(--text-subheadline)] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)]"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      data-testid="skill-save"
                      disabled={!dirty || save.isPending}
                      onClick={commit}
                      className="h-9 rounded-full bg-[var(--accent)] px-[18px] text-[length:var(--text-subheadline)] font-semibold text-[var(--accent-contrast)] transition-transform hover:scale-[0.98] disabled:opacity-40"
                    >
                      {save.isPending ? "Saving…" : "Save"}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    data-testid="skill-edit"
                    onClick={beginEdit}
                    className="inline-flex h-[38px] flex-none items-center gap-1.5 rounded-full px-4 text-[length:var(--text-subheadline)] font-semibold transition-transform hover:scale-[0.98]"
                    style={{ background: "var(--accent-fill)", color: "var(--accent)", boxShadow: "var(--inset-shine)" }}
                  >
                    <PencilLine className="size-[15px]" aria-hidden />
                    Edit
                  </button>
                )}
              </header>

              {saveError && (
                <div
                  data-testid="skill-save-error"
                  className="mt-4 rounded-[var(--radius-md)] p-[10px_13px] text-[length:var(--text-footnote)] text-[var(--system-red)]"
                  style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}
                >
                  {saveError}
                </div>
              )}

              {editing ? (
                <>
                  <div className="mt-[26px] rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] shadow-[var(--shadow-card)]">
                    <textarea
                      ref={editorRef}
                      data-testid="skill-editor"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={onEditorKeyDown}
                      spellCheck={false}
                      className="block w-full resize-none rounded-[var(--radius-xl)] border-none bg-transparent px-[22px] py-5 leading-[1.65] text-[var(--text-primary)] outline-none"
                      style={{ minHeight: 320, fontFamily: "var(--font-code)", fontSize: 13 }}
                    />
                  </div>
                  <div className="mt-2.5 flex justify-end text-[length:var(--text-caption1)] text-[var(--text-quaternary)]">
                    Editing the raw SKILL.md — frontmatter included
                  </div>
                </>
              ) : (
                <article className="mt-6" data-testid="skill-body">
                  <MarkdownView content={parsed.body || content} isDark={isDark} />
                </article>
              )}
            </>
          )}
        </div>
      </div>
    </PageLayout>
  )
}
