import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { queryKeys } from "@/lib/query-keys"
import type { CreateNoteInput, UpdateNoteInput } from "./types"

export function useNotes(query = "") {
  return useQuery({
    queryKey: queryKeys.notes.list(query),
    queryFn: () => api.listNotes(query || undefined),
  })
}
export function useNote(path: string | null) {
  return useQuery({
    queryKey: path ? queryKeys.notes.document(path) : ["note", "none"],
    queryFn: () => api.readNote(path!),
    enabled: !!path,
  })
}

export function useCreateNote() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateNoteInput) => api.createNote(input),
    onSuccess: ({ note }) => {
      client.setQueryData(queryKeys.notes.document(note.path), { note })
      void client.invalidateQueries({ queryKey: queryKeys.notes.all })
    },
  })
}

export function useUpdateNote() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: UpdateNoteInput) => api.updateNote(input),
    onSuccess: ({ note }) => {
      client.setQueryData(queryKeys.notes.document(note.path), { note })
      void client.invalidateQueries({ queryKey: queryKeys.notes.all })
    },
  })
}
