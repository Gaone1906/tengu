import { useEffect, useMemo, useState } from "react"
import { FileText } from "lucide-react"
import { useSearchParams } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { PageLayout } from "@/components/page-layout"
import { queryKeys } from "@/lib/query-keys"
import { NoteSidebar } from "./note-sidebar"
import { NoteList } from "./note-list"
import { NoteEditor } from "./note-editor"
import { useCreateNote, useNote, useNotes } from "./use-notes"
import type { NoteDocument, NoteSummary } from "./types"

const ALL_FOLDER = "__all__"

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

export function NotePage() {
  const mobile = useMobileNotesLayout()
  const queryClient = useQueryClient()
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState("")
  const folderParam = params.get("folder")
  const selectedFolder = folderParam === null || folderParam === ALL_FOLDER ? null : folderParam
  const selectedPath = params.get("note")
  const hasMobileFolder = folderParam !== null || selectedPath !== null
  const notesQuery = useNotes(query)
  const documentQuery = useNote(selectedPath)
  const createNote = useCreateNote()

  const visibleNotes = useMemo(() => {
    const notes = notesQuery.data?.notes ?? []
    return notes
      .filter((note) => selectedFolder === null || note.folder === selectedFolder)
      .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  }, [notesQuery.data?.notes, selectedFolder])

  useEffect(() => {
    if (mobile || selectedPath || visibleNotes.length === 0) return
    const next = new URLSearchParams(params)
    next.set("note", visibleNotes[0].path)
    if (!next.has("folder")) next.set("folder", ALL_FOLDER)
    setParams(next, { replace: true })
  }, [mobile, params, selectedPath, setParams, visibleNotes])

  function selectFolder(folder: string | null) {
    const next = new URLSearchParams(params)
    next.set("folder", folder === null ? ALL_FOLDER : folder)
    next.delete("note")
    setParams(next)
  }

  function selectNote(path: string) {
    const next = new URLSearchParams(params)
    if (!next.has("folder")) next.set("folder", ALL_FOLDER)
    next.set("note", path)
    setParams(next)
  }

  function returnToList() {
    const next = new URLSearchParams(params)
    if (!next.has("folder")) next.set("folder", ALL_FOLDER)
    next.delete("note")
    setParams(next)
  }

  function returnToFolders() {
    const next = new URLSearchParams(params)
    next.delete("folder")
    next.delete("note")
    setParams(next)
  }

  async function createNewNote() {
    const { note } = await createNote.mutateAsync({
      title: "New Note",
      body: "",
      ...(selectedFolder !== null ? { folder: selectedFolder } : {}),
    })
    const next = new URLSearchParams(params)
    next.set("folder", folderParam ?? ALL_FOLDER)
    next.set("note", note.path)
    setParams(next)
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

  const sidebar = (
    <NoteSidebar
      folders={notesQuery.data?.folders ?? []}
      total={notesQuery.data?.notes.length ?? 0}
      selectedFolder={selectedFolder}
      onSelect={selectFolder}
    />
  )

  const list = (
    <NoteList
      notes={visibleNotes}
      selectedPath={selectedPath}
      query={query}
      loading={notesQuery.isPending}
      error={notesQuery.isError}
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
      onBack={mobile ? returnToList : undefined}
      onSaved={acceptSavedNote}
    />
  ) : (
    <EditorState loading={documentQuery.isPending && !!selectedPath} error={documentQuery.isError} />
  )

  return (
    <PageLayout>
      {mobile ? (
        <div className="h-full overflow-hidden bg-[var(--bg)]">
          {!hasMobileFolder ? sidebar : selectedPath ? editor : list}
        </div>
      ) : (
        <div className="grid h-full min-w-0 grid-cols-[208px_320px_minmax(0,1fr)] overflow-hidden">
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
