import { describe, expect, it } from "vitest"
import { buildNewSessionParams } from "../new-chat-helpers"

describe("buildNewSessionParams speech provenance", () => {
  it("omits the speech flag for a typed-only first message", () => {
    const params = buildNewSessionParams({ message: "hi", selectedEmployee: null })
    expect(params.speech).toBeUndefined()
  })

  it("carries the speech flag when the first message is speech-derived", () => {
    const params = buildNewSessionParams({ message: "hi", selectedEmployee: null, speech: true })
    expect(params.speech).toBe(true)
  })
})
