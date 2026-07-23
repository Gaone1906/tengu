import { useCallback, useEffect, useRef, useState } from "react"
import { useNavigate, useNavigationType, useParams, useSearchParams } from "react-router-dom"
import { Plus } from "lucide-react"
import { PageLayout } from "@/components/page-layout"
import { filtersFromSearchParams } from "@/lib/todos"
import { NewTodoDialog } from "../page"
import {
  boardKey,
  parseBoardParam,
  recallBoardScroll,
  rememberBoardScroll,
} from "./board-route"

/* Todos v2 slice 6 — the board surface (design contract:
 * docs/superpowers/design/todos-v2-board). Stage A shell: routing, per-board
 * scroll cache, header geometry. The switcher, columns and drag land with the
 * board task; the task-page takeover is stage B. */

export default function TodoBoardPage() {
  const { board: boardParam } = useParams()
  const board = parseBoardParam(boardParam)
  const key = boardKey(board)
  const navigationType = useNavigationType()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const filters = filtersFromSearchParams(searchParams)
  void filters
  void navigate

  const scrollRef = useRef<HTMLDivElement>(null)
  const [creating, setCreating] = useState(false)

  // Per-board scroll memory: every scroll updates the module cache; a POP (back
  // from a task page / history) restores the cached offset, a PUSH starts at 0.
  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (el) rememberBoardScroll(key, el.scrollTop)
  }, [key])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = navigationType === "POP" ? recallBoardScroll(key) : 0
  }, [key, navigationType])

  const title = boardTitle(key)

  return (
    <PageLayout>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        data-testid="todo-board-scroll"
        className="h-full overflow-y-auto"
        data-scrollable
      >
        <div className="px-5 pb-20 pt-6 md:px-10 md:pt-8">
          <header className="flex items-start justify-between gap-3">
            <div>
              <h1
                tabIndex={-1}
                className="font-[var(--font-display)] text-[length:var(--text-title1)] font-bold leading-tight tracking-[var(--tracking-tight)] text-[var(--text-primary)] outline-none md:text-[length:var(--text-large-title)]"
              >
                {title}
              </h1>
            </div>
            <button
              type="button"
              data-testid="todo-new"
              onClick={() => setCreating(true)}
              aria-label="New todo"
              className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-full text-[length:var(--text-subheadline)] font-semibold transition-transform hover:scale-[0.98] md:px-4"
              style={{ background: "var(--accent-fill)", color: "var(--accent)", boxShadow: "var(--inset-shine)" }}
            >
              <Plus className="size-4" aria-hidden />
              <span className="max-md:hidden">New Todo</span>
            </button>
          </header>
        </div>
      </div>
      {creating && <NewTodoDialog onClose={() => setCreating(false)} onCreated={() => setCreating(false)} />}
    </PageLayout>
  )
}

/** Display title per board (departments render their slug until the live
 *  departments feed lands with the switcher task). */
function boardTitle(key: string): string {
  if (key === "my") return "My requests"
  if (key === "attention") return "Attention"
  if (key === "everything") return "Everything"
  return key.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}
