import { describe, expect, it } from "vitest"
import { COLOR_POOL, colorForName } from "../color-pool"

describe("colorForName", () => {
  it("is stable across repeat calls for the same name", () => {
    expect(colorForName("content-writer")).toBe(colorForName("content-writer"))
    expect(colorForName("lead-developer")).toBe(colorForName("lead-developer"))
  })

  it("always returns a color from the pool", () => {
    expect(COLOR_POOL).toContain(colorForName("content-writer"))
    expect(COLOR_POOL).toContain(colorForName(""))
  })

  it("falls back to the first pool color for an empty name", () => {
    expect(colorForName("")).toBe(COLOR_POOL[0])
  })
})
