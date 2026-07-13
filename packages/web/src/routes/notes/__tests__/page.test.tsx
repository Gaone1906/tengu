import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter, useLocation } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  listNotes: vi.fn(),
  readNote: vi.fn(),
  createNote: vi.fn(),
  updateNote: vi.fn(),
}))

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      ...actual.api,
      listNotes: mocks.listNotes,
      readNote: mocks.readNote,
      createNote: mocks.createNote,
      updateNote: mocks.updateNote,
    },
  }
})

vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock("@/hooks/use-stt", () => ({
  useStt: () => ({
    state: "idle", available: true, downloadProgress: null, analyser: null,
    languages: ["en"], selectedLanguage: "en", error: null,
    cycleLanguage: vi.fn(), handleMicClick: vi.fn(), startRecording: vi.fn(),
    stopRecording: vi.fn(async () => null), cancelRecording: vi.fn(),
    startDownload: vi.fn(), dismissDownload: vi.fn(), dismissError: vi.fn(),
  }),
}))

vi.mock("@/hooks/use-gateway", () => ({
  useGateway: () => ({
    events: [],
    connected: true,
    connectionSeq: 1,
    skillsVersion: 1,
    subscribe: vi.fn(() => vi.fn()),
  }),
}))

import { ApiError } from "@/lib/api"
import { queryKeys } from "@/lib/query-keys"
import { NotePage } from "../page"
import { noteDraftKey, persistNoteDraft } from "../note-content"

const summaries = [
  {
    path: "knowledge/product/principles.md",
    title: "Product principles",
    preview: "Quiet interfaces create room for thought.",
    folder: "product",
    updatedAt: "2026-07-14T08:42:00.000Z",
    revision: "revision-1",
  },
  {
    path: "knowledge/research/interviews.md",
    title: "Interview notes",
    preview: "The next action should stay obvious.",
    folder: "research",
    updatedAt: "2026-07-10T12:00:00.000Z",
    revision: "revision-r1",
  },
]

const folders = [
  { path: "product", name: "Product", count: 1 },
  { path: "product/roadmap", name: "Roadmap", count: 0 },
  { path: "research", name: "Research", count: 1 },
]

const productDocument = {
  ...summaries[0],
  body: "Objects get cards. Voices get text.",
}

function setMobile(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches,
      media: "(max-width: 1023px)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  })
}

function renderPage(entry = "/notes") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const rendered = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <NotePage />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { ...rendered, client }
}

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname}{location.search}</output>
}

beforeEach(() => {
  vi.useRealTimers()
  localStorage.clear()
  setMobile(false)
  mocks.listNotes.mockReset().mockResolvedValue({ notes: summaries, folders })
  mocks.readNote.mockReset().mockImplementation(async (path: string) => ({
    note: path === productDocument.path
      ? productDocument
      : { ...summaries[1], body: "Research body" },
  }))
  mocks.createNote.mockReset().mockResolvedValue({
    note: {
      path: "knowledge/product/new-note.md",
      title: "New Note",
      preview: "",
      folder: "product",
      updatedAt: "2026-07-14T09:00:00.000Z",
      revision: "revision-new",
      body: "",
    },
  })
  mocks.updateNote.mockReset().mockImplementation(async (input: {
    path: string; expectedRevision: string; title: string; body: string
  }) => ({
    note: {
      ...productDocument,
      title: input.title,
      body: input.body,
      revision: input.expectedRevision === "revision-1" ? "revision-2" : "revision-3",
    },
  }))
})

afterEach(() => vi.useRealTimers())

describe("Notes page", () => {
  it("renders API-derived titles, updated-desc rows, previews, and folder filtering", async () => {
    renderPage()

    expect(await screen.findByDisplayValue("Product principles")).toBeTruthy()
    expect(screen.getByText("Quiet interfaces create room for thought.")).toBeTruthy()
    expect(screen.getByText("Interview notes")).toBeTruthy()

    fireEvent.click(await screen.findByRole("button", { name: "Product" }))
    expect(screen.getByText("Product principles")).toBeTruthy()
    expect(screen.queryByText("Interview notes")).toBeNull()
  })

  it("creates a new note inside the selected folder", async () => {
    renderPage()
    await screen.findByDisplayValue("Product principles")
    fireEvent.click(screen.getByRole("button", { name: "Product" }))
    fireEvent.click(screen.getByRole("button", { name: "New note" }))

    await waitFor(() => expect(mocks.createNote).toHaveBeenCalledWith({
      title: "New Note",
      body: "",
      folder: "product",
    }))
    expect(screen.getByTestId("location").textContent).toBe(
      "/notes?folder=product&note=knowledge%2Fproduct%2Fnew-note.md",
    )
  })

  it("keeps All Notes selected when creating a note there", async () => {
    setMobile(true)
    renderPage("/notes?folder=__all__")
    fireEvent.click(await screen.findByRole("button", { name: "New note" }))

    await waitFor(() => expect(mocks.createNote).toHaveBeenCalledWith({
      title: "New Note",
      body: "",
    }))
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe(
      "/notes?folder=__all__&note=knowledge%2Fproduct%2Fnew-note.md",
    ))
  })

  it("quietly indents nested folders according to their path depth", async () => {
    renderPage()

    const nested = await screen.findByRole("button", { name: "Roadmap" })
    expect(nested.style.paddingInlineStart).toBe("26px")
  })

  it("debounces saves, then uses only the acknowledged revision for the next save", async () => {
    renderPage()
    const title = await screen.findByDisplayValue("Product principles")
    const body = screen.getByLabelText("Note body")
    vi.useFakeTimers()

    fireEvent.change(title, { target: { value: "Product principles revised" } })
    fireEvent.change(body, { target: { value: "First local edit" } })
    await act(async () => vi.advanceTimersByTimeAsync(500))
    expect(mocks.updateNote).toHaveBeenNthCalledWith(1, {
      path: productDocument.path,
      expectedRevision: "revision-1",
      title: "Product principles revised",
      body: "First local edit",
    })

    await act(async () => {})
    fireEvent.change(body, { target: { value: "Second local edit" } })
    await act(async () => vi.advanceTimersByTimeAsync(500))
    expect(mocks.updateNote).toHaveBeenNthCalledWith(2, {
      path: productDocument.path,
      expectedRevision: "revision-2",
      title: "Product principles revised",
      body: "Second local edit",
    })
  })

  it("keeps the local draft on conflict and overwrites only after re-reading the current revision", async () => {
    const current = { ...productDocument, revision: "revision-9", body: "Remote body" }
    mocks.readNote
      .mockResolvedValueOnce({ note: productDocument })
      .mockResolvedValueOnce({ note: current })
    mocks.updateNote
      .mockRejectedValueOnce(new ApiError(409, "conflict"))
      .mockResolvedValueOnce({ note: { ...current, body: "Protected local draft", revision: "revision-10" } })

    renderPage()
    const body = await screen.findByLabelText("Note body")
    vi.useFakeTimers()
    fireEvent.change(body, { target: { value: "Protected local draft" } })
    await act(async () => vi.advanceTimersByTimeAsync(500))
    await act(async () => {})
    vi.useRealTimers()

    expect(await screen.findByRole("status", { name: "Note changed elsewhere" })).toBeTruthy()
    expect(localStorage.getItem(noteDraftKey(productDocument.path))).toContain("Protected local draft")
    expect(screen.getByRole("button", { name: "Reload remote note" })).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Overwrite remote note" }))
    await waitFor(() => expect(mocks.updateNote).toHaveBeenLastCalledWith({
      path: productDocument.path,
      expectedRevision: "revision-9",
      title: "Product principles",
      body: "Protected local draft",
    }))
  })

  it("autosaves a restored stale draft against its persisted base revision", async () => {
    const remote = { ...productDocument, revision: "revision-9", body: "New remote body" }
    mocks.readNote.mockResolvedValue({ note: remote })
    persistNoteDraft(productDocument.path, {
      title: "Product principles",
      body: "Offline local draft",
      baseRevision: "revision-1",
      updatedAt: 42,
    })
    vi.useFakeTimers()

    renderPage("/notes?folder=__all__&note=knowledge%2Fproduct%2Fprinciples.md")
    await act(async () => vi.advanceTimersByTimeAsync(10))
    expect((screen.getByLabelText("Note body") as HTMLTextAreaElement).value).toBe("Offline local draft")
    await act(async () => vi.advanceTimersByTimeAsync(500))

    expect(mocks.updateNote).toHaveBeenCalledWith({
      path: productDocument.path,
      expectedRevision: "revision-1",
      title: "Product principles",
      body: "Offline local draft",
    })
  })

  it("refreshes a clean same-path editor when an external revision is refetched", async () => {
    const { client } = renderPage(
      "/notes?folder=__all__&note=knowledge%2Fproduct%2Fprinciples.md",
    )
    expect(await screen.findByDisplayValue("Product principles")).toBeTruthy()

    const external = {
      ...productDocument,
      title: "Principles from another session",
      body: "Fresh remote body",
      updatedAt: "2026-07-14T10:20:00.000Z",
      revision: "revision-external",
    }
    mocks.readNote.mockResolvedValue({ note: external })
    await act(async () => {
      await client.invalidateQueries({
        queryKey: queryKeys.notes.document(productDocument.path),
      })
    })

    expect(await screen.findByDisplayValue("Principles from another session")).toBeTruthy()
    expect((screen.getByLabelText("Note body") as HTMLTextAreaElement).value).toBe("Fresh remote body")
    expect(screen.getByText(/Edited Jul 14 at 1:20 PM/i)).toBeTruthy()
  })

  it("uses a reversible folder to list to editor stack on mobile", async () => {
    setMobile(true)
    renderPage()
    expect(await screen.findByRole("heading", { name: "Folders" })).toBeTruthy()

    fireEvent.click(await screen.findByRole("button", { name: "Product" }))
    expect(await screen.findByRole("heading", { name: "Notes" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /Product principles/ }))
    expect(await screen.findByLabelText("Note body")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Back to notes" }))
    expect(await screen.findByRole("heading", { name: "Notes" })).toBeTruthy()
    expect(screen.getByTestId("location").textContent).toBe("/notes?folder=product")

    fireEvent.click(screen.getByRole("button", { name: "Back to folders" }))
    expect(await screen.findByRole("heading", { name: "Folders" })).toBeTruthy()
    expect(screen.getByTestId("location").textContent).toBe("/notes")
  })

  it("uses deterministic URL-state back transitions from a direct mobile editor link", async () => {
    setMobile(true)
    renderPage("/notes?folder=product&note=knowledge%2Fproduct%2Fprinciples.md")
    expect(await screen.findByLabelText("Note body")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Back to notes" }))
    expect(await screen.findByRole("heading", { name: "Notes" })).toBeTruthy()
    expect(screen.getByTestId("location").textContent).toBe("/notes?folder=product")

    fireEvent.click(screen.getByRole("button", { name: "Back to folders" }))
    expect(await screen.findByRole("heading", { name: "Folders" })).toBeTruthy()
    expect(screen.getByTestId("location").textContent).toBe("/notes")
  })

  it("normalizes a note-only mobile direct link back to the All Notes list", async () => {
    setMobile(true)
    renderPage("/notes?note=knowledge%2Fproduct%2Fprinciples.md")
    expect(await screen.findByLabelText("Note body")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Back to notes" }))
    expect(await screen.findByRole("heading", { name: "Notes" })).toBeTruthy()
    expect(screen.getByTestId("location").textContent).toBe("/notes?folder=__all__")
  })
})
