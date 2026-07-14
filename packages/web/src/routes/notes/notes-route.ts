// Path-based deep links for Notes. The URL is the single source of truth for
// which folder is selected and which note is open, so a refresh or a shared
// link lands on exactly the same place. Folder and note are carried
// independently — desktop shows the folder-filtered list AND the open note at
// once, so deriving the folder from the note's directory would collapse the
// list when a note is opened from "All Notes".
//
//   /notes                          → folders home (mobile), nothing open
//   /notes/all                      → All Notes list open
//   /notes/all/n/<rel>              → a note open under All Notes
//   /notes/f/<folder>               → a folder's list open
//   /notes/f/<folder>/n/<rel>       → a note open under a folder
//
// `listOpen` distinguishes the mobile "folders home" (/notes) from an open list
// (/notes/all or /notes/f/…). Desktop always shows all three panes and ignores
// it. <folder> is one URL segment (encodeURIComponent, so nested "a/b" becomes
// "a%2Fb"). <rel> is the note path with the "knowledge/" prefix and ".md"
// suffix stripped, kept multi-segment for readability
// (knowledge/product/roadmap.md → product/roadmap).

export interface NotesLocation {
  /** Selected folder (knowledge-relative dir), or null for All Notes. */
  folder: string | null
  /** Open note's full store path (knowledge/…​.md), or null for none. */
  notePath: string | null
  /** A list (All Notes or a folder) is open, vs the bare folders home. */
  listOpen: boolean
}

const NOTE_PREFIX = "knowledge/"
const NOTE_SUFFIX = ".md"

function notePathToRel(notePath: string): string {
  let rel = notePath
  if (rel.startsWith(NOTE_PREFIX)) rel = rel.slice(NOTE_PREFIX.length)
  if (rel.endsWith(NOTE_SUFFIX)) rel = rel.slice(0, -NOTE_SUFFIX.length)
  return rel
}

function relToNotePath(rel: string): string {
  return `${NOTE_PREFIX}${rel}${NOTE_SUFFIX}`
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** Build the URL path for a folder/note selection. */
export function buildNotesPath({ folder, notePath, listOpen }: NotesLocation): string {
  let out = "/notes"
  if (folder) {
    out += `/f/${encodeURIComponent(folder)}`
  } else if (listOpen || notePath) {
    out += "/all"
  }
  if (notePath) {
    const rel = notePathToRel(notePath).split("/").map(encodeURIComponent).join("/")
    out += `/n/${rel}`
  }
  return out
}

/** Parse a location pathname back into folder/note selection. Unknown or
 *  malformed shapes fall back to the folders home rather than throwing. */
export function parseNotesLocation(pathname: string): NotesLocation {
  const result: NotesLocation = { folder: null, notePath: null, listOpen: false }
  const afterNotes = pathname.replace(/^\/notes\/?/, "")
  const segments = afterNotes.split("/").filter(Boolean)
  let i = 0
  if (segments[i] === "all") {
    result.listOpen = true
    i += 1
  } else if (segments[i] === "f" && segments[i + 1] !== undefined) {
    result.folder = decode(segments[i + 1]) || null
    result.listOpen = true
    i += 2
  }
  if (segments[i] === "n" && segments[i + 1] !== undefined) {
    const rel = segments.slice(i + 1).map(decode).join("/")
    if (rel) {
      result.notePath = relToNotePath(rel)
      result.listOpen = true
    }
  }
  return result
}

const LAST_LOCATION_KEY = "jinn:notes:last-location:v1"

/** Remember the last folder/note the operator had open, so a fresh visit to a
 *  bare /notes can restore it. Best-effort — storage may be unavailable. */
export function persistLastNotesLocation(location: NotesLocation): void {
  try {
    if (!location.folder && !location.notePath && !location.listOpen) {
      localStorage.removeItem(LAST_LOCATION_KEY)
      return
    }
    localStorage.setItem(LAST_LOCATION_KEY, JSON.stringify(location))
  } catch {
    // Deep links still work without the memory; ignore storage failures.
  }
}

export function loadLastNotesLocation(): NotesLocation | null {
  try {
    const raw = localStorage.getItem(LAST_LOCATION_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<NotesLocation>
    const folder = typeof value.folder === "string" ? value.folder : null
    const notePath = typeof value.notePath === "string" ? value.notePath : null
    if (!folder && !notePath) return null
    return { folder, notePath, listOpen: true }
  } catch {
    return null
  }
}
