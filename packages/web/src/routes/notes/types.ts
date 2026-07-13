export interface NoteSummary {
  path: string
  title: string
  preview: string
  folder: string
  updatedAt: string
  revision: string
}
export interface NoteDocument extends NoteSummary {
  body: string
}

export interface NoteFolder {
  path: string
  name: string
  count: number
}

export interface NotesListResponse {
  notes: NoteSummary[]
  folders: NoteFolder[]
}

export interface NoteDocumentResponse {
  note: NoteDocument
}

export interface CreateNoteInput {
  title: string
  body?: string
  folder?: string
}

export interface UpdateNoteInput {
  path: string
  expectedRevision: string
  title?: string
  body?: string
  append?: string
}
