import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { FileText } from "lucide-react"
import { useLocation, useNavigate, useNavigationType } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { PageLayout } from "@/components/page-layout"
import { useTheme } from "@/routes/providers"
import { queryKeys } from "@/lib/query-keys"
import { NoteSidebar } from "./note-sidebar"
import { NoteList } from "./note-list"
import { NoteEditor } from "./note-editor"
import { useCreateNote, useNote, useNotes } from "./use-notes"
import {
  buildNotesPath,
  loadLastNotesLocation,
  parseNotesLocation,
  persistLastNotesLocation,
  type NotesLocation,
} from "./notes-route"
import type { NoteDocument, NoteSummary } from "./types"

function useMobileNotesLayout(): boolean {
  const [mobile, setMobile] = useState(() => (
    typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches
  ))

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px)")
    const update = () => setMobile(media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])

  return mobile
}

function useIsDark(): boolean {
  const { theme } = useTheme()
  return useMemo(() => {
    if (typeof document !== "undefined") {
      const attr = document.documentElement.getAttribute("data-theme")
      if (attr) return attr !== "light"
    }
    return theme !== "light"
  }, [theme])
}

export function NotePage() {
  const mobile = useMobileNotesLayout()
  const isDark = useIsDark()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const navigationType = useNavigationType()
  const { pathname } = useLocation()
  const [query, setQuery] = useState("")

  const location = useMemo(() => parseNotesLocation(pathname), [pathname])
  const { folder: selectedFolder, notePath: selectedPath, listOpen } = location

  const notesQuery = useNotes(query)
  const documentQuery = useNote(selectedPath)
  const createNote = useCreateNote()

  const visibleNotes = useMemo(() => {
    const notes = notesQuery.data?.notes ?? []
    return notes
      .filter((note) => selectedFolder === null || note.folder === selectedFolder)
      .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  }, [notesQuery.data?.notes, selectedFolder])

  const go = useCallback((next: NotesLocation, opts?: { replace?: boolean }) => {
    navigate(buildNotesPath(next), opts)
  }, [navigate])

  // Persist the current location so a later fresh visit can restore it.
  useEffect(() => {
    persistLastNotesLocation(location)
  }, [location])

  // Restore the last-open folder/note on a fresh landing at bare /notes — but
  // only on a real page load / back-forward (POP), never when the operator taps
  // the Notes tab (PUSH), where landing on the folders home is intended. Runs
  // at most once per mount.
  const restoredRef = useRef(false)
  useEffect(() => {
    if (restoredRef.current) return
    if (listOpen || selectedFolder || selectedPath) { restoredRef.current = true; return }
    if (navigationType === "PUSH") { restoredRef.current = true; return }
    if (!notesQuery.data) return
    restoredRef.current = true
    const last = loadLastNotesLocation()
    if (!last) return
    const notes = notesQuery.data.notes
    const noteStillExists = last.notePath ? notes.some((n) => n.path === last.notePath) : true
    const folderStillExists = last.folder
      ? notesQuery.data.folders.some((f) => f.path === last.folder)
      : true
    if (!noteStillExists && !folderStillExists) return
    go({
      folder: folderStillExists ? last.folder : null,
      notePath: noteStillExists ? last.notePath : null,
      listOpen: true,
    }, { replace: true })
  }, [go, listOpen, navigationType, notesQuery.data, selectedFolder, selectedPath])

  // Desktop keeps a note open at all times: auto-select the newest visible note
  // when none is chosen. Mobile leaves the list showing until the operator taps.
  useEffect(() => {
    if (mobile || selectedPath || visibleNotes.length === 0) return
    go({ folder: selectedFolder, notePath: visibleNotes[0].path, listOpen: true }, { replace: true })
  }, [go, mobile, selectedFolder, selectedPath, visibleNotes])

  function selectFolder(folder: string | null) {
    go({ folder, notePath: null, listOpen: true })
  }

  function selectNote(path: string) {
    go({ folder: selectedFolder, notePath: path, listOpen: true })
  }

  function returnToList() {
    go({ folder: selectedFolder, notePath: null, listOpen: true })
  }

  function returnToFolders() {
    go({ folder: null, notePath: null, listOpen: false })
  }

  async function createNewNote() {
    const { note } = await createNote.mutateAsync({
      title: "New Note",
      body: "",
      ...(selectedFolder !== null ? { folder: selectedFolder } : {}),
    })
    go({ folder: selectedFolder, notePath: note.path, listOpen: true })
  }

  function acceptSavedNote(note: NoteDocument) {
    queryClient.setQueryData(queryKeys.notes.document(note.path), { note })
    queryClient.setQueriesData<{ notes: NoteSummary[]; folders: unknown[] }>(
      { queryKey: queryKeys.notes.all },
      (existing) => existing
        ? {
            ...existing,
            notes: existing.notes.map((item) => item.path === note.path ? { ...item, ...note } : item),
          }
        : existing,
    )
  }

  const folderTitle = selectedFolder === null
    ? "All Notes"
    : (notesQuery.data?.folders.find((f) => f.path === selectedFolder)?.name || selectedFolder || "Notes")

  const sidebar = (
    <NoteSidebar
      folders={notesQuery.data?.folders ?? []}
      total={notesQuery.data?.notes.length ?? 0}
      selectedFolder={selectedFolder}
      listOpen={listOpen}
      mobile={mobile}
      onSelect={selectFolder}
    />
  )

  const list = (
    <NoteList
      title={folderTitle}
      notes={visibleNotes}
      selectedPath={selectedPath}
      query={query}
      loading={notesQuery.isPending}
      error={notesQuery.isError}
      mobile={mobile}
      onQueryChange={setQuery}
      onSelect={selectNote}
      onCreate={() => { void createNewNote() }}
      onBack={mobile ? returnToFolders : undefined}
    />
  )

  const editor = documentQuery.data?.note ? (
    <NoteEditor
      key={documentQuery.data.note.path}
      note={documentQuery.data.note}
      isDark={isDark}
      onBack={mobile ? returnToList : undefined}
      backLabel={folderTitle}
      onSaved={acceptSavedNote}
    />
  ) : (
    <EditorState loading={documentQuery.isPending && !!selectedPath} error={documentQuery.isError} />
  )

  return (
    <PageLayout>
      {mobile ? (
        <div className="h-full overflow-hidden bg-[var(--bg)]">
          {!listOpen ? sidebar : selectedPath ? editor : list}
        </div>
      ) : (
        <div className="grid h-full min-w-0 grid-cols-[212px_320px_minmax(0,1fr)] overflow-hidden">
          {sidebar}
          {list}
          {editor}
        </div>
      )}
    </PageLayout>
  )
}

function EditorState({ loading, error }: { loading: boolean; error: boolean }) {
  return (
    <section className="flex h-full min-w-0 items-center justify-center bg-[var(--bg)] px-8 text-center">
      <div className="flex max-w-xs flex-col items-center gap-3 text-[var(--text-secondary)]">
        <span className="flex size-12 items-center justify-center rounded-full bg-[var(--fill-tertiary)]">
          <FileText size={22} aria-hidden />
        </span>
        <p className="text-pretty text-[length:var(--text-footnote)]">
          {loading ? "Opening note…" : error ? "This note could not be opened." : "Choose a note to begin writing."}
        </p>
      </div>
    </section>
  )
}

export default NotePage
