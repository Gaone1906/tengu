import { describe, expect, it } from "vitest"
import * as todoId from "../todo-id"

describe("Todo ID mentions", () => {
  it("exports the mention grammar for inline renderers", () => {
    expect(todoId.TODO_ID_MENTION_SOURCE).toBeTypeOf("string")
  })

  it("matches valid IDs within prose", () => {
    const regex = new RegExp(todoId.TODO_ID_MENTION_SOURCE, "g")

    expect("Open ICI-637 and PLA-18 now".match(regex)).toEqual(["ICI-637", "PLA-18"])
  })

  it("rejects shape-adjacent junk and zero ordinals", () => {
    const regex = new RegExp(todoId.TODO_ID_MENTION_SOURCE, "g")

    expect("XICI-637 ICI-637-2 ICI-5.6 ICI-0 -ICI-8".match(regex)).toBeNull()
  })
})
