import { describe, it, expect, beforeEach } from "vitest"
import {
  parseBoardParam,
  boardKey,
  boardPath,
  isSameBoard,
  rememberBoardScroll,
  recallBoardScroll,
  clearBoardScrollCache,
  DEFAULT_BOARD_PATH,
} from "../board/board-route"

describe("parseBoardParam", () => {
  it("maps the three reserved keywords", () => {
    expect(parseBoardParam("my")).toEqual({ kind: "my" })
    expect(parseBoardParam("attention")).toEqual({ kind: "attention" })
    expect(parseBoardParam("everything")).toEqual({ kind: "everything" })
  })

  it("treats any other slug as a department board", () => {
    expect(parseBoardParam("platform")).toEqual({ kind: "department", slug: "platform" })
    expect(parseBoardParam("customer-success")).toEqual({ kind: "department", slug: "customer-success" })
  })

  it("falls back to My requests for empty or malformed params", () => {
    expect(parseBoardParam(undefined)).toEqual({ kind: "my" })
    expect(parseBoardParam("")).toEqual({ kind: "my" })
    expect(parseBoardParam("   ")).toEqual({ kind: "my" })
    expect(parseBoardParam("-bad")).toEqual({ kind: "my" })
    expect(parseBoardParam("has space")).toEqual({ kind: "my" })
  })

  it("normalizes case", () => {
    expect(parseBoardParam("Platform")).toEqual({ kind: "department", slug: "platform" })
    expect(parseBoardParam("MY")).toEqual({ kind: "my" })
  })
})

describe("boardKey / boardPath / isSameBoard", () => {
  it("serializes keywords and department slugs", () => {
    expect(boardKey({ kind: "my" })).toBe("my")
    expect(boardKey({ kind: "department", slug: "platform" })).toBe("platform")
    expect(boardPath({ kind: "attention" })).toBe("/todos/b/attention")
    expect(boardPath({ kind: "department", slug: "platform" })).toBe("/todos/b/platform")
    expect(DEFAULT_BOARD_PATH).toBe("/todos/b/my")
  })

  it("round-trips parse ⇄ path", () => {
    for (const raw of ["my", "attention", "everything", "platform"]) {
      const id = parseBoardParam(raw)
      expect(parseBoardParam(boardPath(id).split("/").pop()!)).toEqual(id)
    }
  })

  it("compares by key", () => {
    expect(isSameBoard({ kind: "my" }, parseBoardParam("my"))).toBe(true)
    expect(isSameBoard({ kind: "department", slug: "a" }, { kind: "department", slug: "b" })).toBe(false)
  })
})

describe("board scroll cache", () => {
  beforeEach(() => clearBoardScrollCache())

  it("remembers and recalls per board key", () => {
    rememberBoardScroll("platform", 420)
    rememberBoardScroll("my", 12)
    expect(recallBoardScroll("platform")).toBe(420)
    expect(recallBoardScroll("my")).toBe(12)
  })

  it("returns 0 for boards never scrolled", () => {
    expect(recallBoardScroll("everything")).toBe(0)
  })

  it("ignores invalid values", () => {
    rememberBoardScroll("my", Number.NaN)
    rememberBoardScroll("my", -5)
    expect(recallBoardScroll("my")).toBe(0)
  })
})
