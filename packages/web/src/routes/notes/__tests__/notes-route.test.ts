import { describe, expect, it, beforeEach } from "vitest"
import {
  buildNotesPath,
  parseNotesLocation,
  persistLastNotesLocation,
  loadLastNotesLocation,
} from "../notes-route"

describe("buildNotesPath", () => {
  it("builds the folders-home path", () => {
    expect(buildNotesPath({ folder: null, notePath: null, listOpen: false })).toBe("/notes")
  })

  it("builds the All Notes list path", () => {
    expect(buildNotesPath({ folder: null, notePath: null, listOpen: true })).toBe("/notes/all")
  })

  it("encodes a selected folder as one segment", () => {
    expect(buildNotesPath({ folder: "Product", notePath: null, listOpen: true })).toBe("/notes/f/Product")
    expect(buildNotesPath({ folder: "a/b", notePath: null, listOpen: true })).toBe("/notes/f/a%2Fb")
  })

  it("strips the knowledge prefix and .md suffix for a note, keeping segments readable", () => {
    expect(buildNotesPath({ folder: null, notePath: "knowledge/product/roadmap.md", listOpen: true }))
      .toBe("/notes/all/n/product/roadmap")
  })

  it("carries folder and note together", () => {
    expect(buildNotesPath({ folder: "Product", notePath: "knowledge/product/roadmap.md", listOpen: true }))
      .toBe("/notes/f/Product/n/product/roadmap")
  })

  it("encodes note segments that contain reserved characters", () => {
    expect(buildNotesPath({ folder: null, notePath: "knowledge/a b/c?d.md", listOpen: true }))
      .toBe("/notes/all/n/a%20b/c%3Fd")
  })
})

describe("parseNotesLocation", () => {
  it("reads the folders-home path", () => {
    expect(parseNotesLocation("/notes")).toEqual({ folder: null, notePath: null, listOpen: false })
    expect(parseNotesLocation("/notes/")).toEqual({ folder: null, notePath: null, listOpen: false })
  })

  it("reads the All Notes list", () => {
    expect(parseNotesLocation("/notes/all")).toEqual({ folder: null, notePath: null, listOpen: true })
  })

  it("reads a folder selection", () => {
    expect(parseNotesLocation("/notes/f/Product")).toEqual({ folder: "Product", notePath: null, listOpen: true })
    expect(parseNotesLocation("/notes/f/a%2Fb")).toEqual({ folder: "a/b", notePath: null, listOpen: true })
  })

  it("reads an open note under All Notes", () => {
    expect(parseNotesLocation("/notes/all/n/product/roadmap")).toEqual({
      folder: null,
      notePath: "knowledge/product/roadmap.md",
      listOpen: true,
    })
  })

  it("reads folder and note together", () => {
    expect(parseNotesLocation("/notes/f/Product/n/product/roadmap")).toEqual({
      folder: "Product",
      notePath: "knowledge/product/roadmap.md",
      listOpen: true,
    })
  })

  it("falls back to folders home on unknown shapes", () => {
    expect(parseNotesLocation("/notes/garbage")).toEqual({ folder: null, notePath: null, listOpen: false })
  })

  it("round-trips build → parse for reserved characters", () => {
    const loc = { folder: "Design/Team", notePath: "knowledge/a b/c?d.md", listOpen: true }
    expect(parseNotesLocation(buildNotesPath(loc))).toEqual(loc)
  })
})

describe("last-location memory", () => {
  beforeEach(() => localStorage.clear())

  it("persists and reloads a location", () => {
    persistLastNotesLocation({ folder: "Product", notePath: "knowledge/product/roadmap.md", listOpen: true })
    expect(loadLastNotesLocation()).toEqual({
      folder: "Product",
      notePath: "knowledge/product/roadmap.md",
      listOpen: true,
    })
  })

  it("clears memory when nothing is selected", () => {
    persistLastNotesLocation({ folder: "Product", notePath: null, listOpen: true })
    persistLastNotesLocation({ folder: null, notePath: null, listOpen: false })
    expect(loadLastNotesLocation()).toBeNull()
  })

  it("returns null when empty", () => {
    expect(loadLastNotesLocation()).toBeNull()
  })
})
