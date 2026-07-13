import { beforeEach, describe, expect, it } from "vitest"
import {
  clearNoteDraft,
  insertTranscript,
  loadNoteDraft,
  noteDraftKey,
  persistNoteDraft,
} from "../note-content"

describe("insertTranscript", () => {
  it("inserts a transcript at the editor selection", () => {
    expect(insertTranscript("Alpha beta", "voice", 6, 6)).toEqual({
      value: "Alpha voice beta",
      selection: 11,
    })
  })

  it("replaces a selection and preserves readable word spacing", () => {
    expect(insertTranscript("Alpha old beta", "new words", 6, 9)).toEqual({
      value: "Alpha new words beta",
      selection: 15,
    })
  })

  it("does not invent spaces around punctuation", () => {
    expect(insertTranscript("Hello, world", "friend", 7, 12)).toEqual({
      value: "Hello, friend",
      selection: 13,
    })
  })
})
describe("item-scoped note drafts", () => {
  const path = "knowledge/product/principles.md"

  beforeEach(() => localStorage.clear())

  it("persists and restores the exact local title, body, and base revision", () => {
    persistNoteDraft(path, {
      title: "Local title",
      body: "Local body",
      baseRevision: "revision-1",
      updatedAt: 42,
    })

    expect(localStorage.getItem(noteDraftKey(path))).not.toBeNull()
    expect(loadNoteDraft(path)).toEqual({
      title: "Local title",
      body: "Local body",
      baseRevision: "revision-1",
      updatedAt: 42,
    })

    clearNoteDraft(path)
    expect(loadNoteDraft(path)).toBeNull()
  })

  it("ignores malformed persisted data", () => {
    localStorage.setItem(noteDraftKey(path), "{not-json")
    expect(loadNoteDraft(path)).toBeNull()
  })
})
