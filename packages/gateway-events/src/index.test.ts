import { describe, expect, it } from "vitest"

import { decodeGatewayEvent } from "./index.js"

describe("decodeGatewayEvent", () => {
  it("rejects non-JSON values nested in company Todo snapshots", () => {
    expect(decodeGatewayEvent({
      event: "company:changed",
      payload: {
        entity: "todo",
        action: "updated",
        id: "todo-1",
        version: 2,
        value: { score: Number.POSITIVE_INFINITY },
      },
    })).toBeNull()
  })
})
