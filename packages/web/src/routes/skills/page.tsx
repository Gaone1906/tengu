import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { ChevronRight, Search } from "lucide-react"
import { api } from "@/lib/api"
import { filterSkills, type SkillSummary } from "@/lib/skills"
import { PageLayout } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"

/* Skills as a calm grouped-inset list (the Todos idiom): ONE --bg-secondary
 * container carrying the page's only card shadow, flat hoverable rows inside.
 * The card-tile grid is retired — a skill opens as a full page (view + edit)
 * instead of a modal. */

function SkillRow({ skill, onOpen }: { skill: SkillSummary; onOpen: (name: string) => void }) {
  return (
    <button
      type="button"
      data-testid={`skill-row-${skill.name}`}
      onClick={() => onOpen(skill.name)}
      className="flex w-full items-center gap-3 rounded-[13px] py-[9px] pl-3.5 pr-3 text-left transition-colors duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-quaternary)]"
      style={{ minHeight: 56 }}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[length:var(--text-subheadline)] font-medium leading-[1.35] text-[var(--text-primary)]">
          {skill.name}
        </span>
        <span className="mt-0.5 block truncate text-[length:var(--text-footnote)] leading-[1.4] text-[var(--text-tertiary)]">
          {skill.description || "No description"}
        </span>
      </span>
      <ChevronRight size={14} strokeWidth={2.4} className="flex-none text-[var(--text-quaternary)]" aria-hidden />
    </button>
  )
}

function ListSkeleton() {
  const widths = ["34%", "46%", "28%", "40%"]
  return (
    <div className="mt-[22px] rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[5px] shadow-[var(--shadow-card)]" data-testid="skills-skeleton" aria-hidden>
      {widths.map((w, i) => (
        <div key={i} className="flex min-h-[56px] flex-col justify-center gap-2 py-[9px] pl-3.5 pr-3">
          <span
            className="h-3 rounded-[6px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]"
            style={{ width: w, animationDelay: `${i * 200}ms` }}
          />
          <span
            className="h-2.5 rounded-[6px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]"
            style={{ width: "62%", animationDelay: `${i * 200}ms` }}
          />
        </div>
      ))}
    </div>
  )
}

export default function SkillsPage() {
  useBreadcrumbs([{ label: "Skills" }])
  const navigate = useNavigate()
  const [query, setQuery] = useState("")

  const skillsQuery = useQuery({
    queryKey: ["skills"],
    queryFn: api.getSkills,
    staleTime: 30_000,
  })

  const skills: SkillSummary[] = useMemo(
    () =>
      (skillsQuery.data ?? [])
        .map((s) => ({ name: s.name, description: s.description ?? "" }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [skillsQuery.data],
  )
  const shown = useMemo(() => filterSkills(skills, query), [skills, query])

  const onOpen = (name: string) => navigate(`/skills/${encodeURIComponent(name)}`)

  return (
    <PageLayout>
      <div className="h-full overflow-y-auto" data-scrollable>
        <div className="mx-auto max-w-[840px] px-5 pb-20 pt-6 md:pt-11">
          <header className="flex flex-wrap items-end justify-between gap-x-3 gap-y-3.5">
            <div>
              <h1 className="font-[var(--font-display)] text-[length:var(--text-title1)] font-bold leading-tight tracking-[var(--tracking-tight)] text-[var(--text-primary)] md:text-[length:var(--text-large-title)]">
                Skills
              </h1>
              <div className="mt-1 text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
                {skillsQuery.isSuccess
                  ? `${skills.length} ${skills.length === 1 ? "skill" : "skills"} · playbooks your employees load on demand`
                  : "Playbooks your employees load on demand"}
              </div>
            </div>
            <label className="inline-flex h-[30px] w-[220px] items-center gap-[7px] rounded-full bg-[var(--fill-tertiary)] px-3 text-[length:var(--text-footnote)] text-[var(--text-quaternary)] transition-colors focus-within:text-[var(--text-tertiary)] max-[500px]:w-full">
              <Search size={12} strokeWidth={2.4} className="flex-none" aria-hidden />
              <input
                data-testid="skills-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search skills"
                className="w-full min-w-0 border-none bg-transparent text-[length:var(--text-footnote)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)]"
              />
            </label>
          </header>

          {skillsQuery.isLoading ? (
            <ListSkeleton />
          ) : skillsQuery.isError ? (
            <div
              className="mt-[22px] rounded-[var(--radius-lg)] p-4 text-[length:var(--text-subheadline)] text-[var(--system-red)]"
              style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}
            >
              {skillsQuery.error instanceof Error ? skillsQuery.error.message : "Failed to load skills"}
            </div>
          ) : skills.length === 0 ? (
            <div className="mt-[22px] rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] shadow-[var(--shadow-card)]" data-testid="skills-empty">
              <div className="px-6 py-12 text-center">
                <h3 className="text-[length:var(--text-title3)] font-bold tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
                  No skills yet
                </h3>
                <p className="mx-auto mt-2 max-w-[320px] text-[length:var(--text-subheadline)] leading-relaxed text-[var(--text-tertiary)]">
                  Teach one in chat — new skills land here the moment they're saved.
                </p>
              </div>
            </div>
          ) : shown.length === 0 ? (
            <div className="px-6 py-14 text-center" data-testid="skills-no-match">
              <p className="text-[length:var(--text-subheadline)] text-[var(--text-tertiary)]">No skills match.</p>
              <button
                type="button"
                onClick={() => setQuery("")}
                className="mt-2 text-[length:var(--text-footnote)] font-medium text-[var(--accent)] transition-opacity hover:opacity-80"
              >
                Clear search
              </button>
            </div>
          ) : (
            <div className="mt-[22px] rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[5px] shadow-[var(--shadow-card)]" data-testid="skills-list">
              {shown.map((skill) => (
                <SkillRow key={skill.name} skill={skill} onOpen={onOpen} />
              ))}
            </div>
          )}
        </div>
      </div>
    </PageLayout>
  )
}
