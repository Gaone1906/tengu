import { describe, expect, it } from "vitest"

import { decodeGatewayEvent } from "./index.js"

describe("decodeGatewayEvent", () => {
  it("accepts experiment lifecycle events", () => {
    for (const action of ["created", "updated", "reading-recorded", "concluded"]) {
      expect(decodeGatewayEvent({
        event: "experiments:changed",
        payload: { id: "experiment-1", action },
      })).toEqual({
        event: "experiments:changed",
        payload: { id: "experiment-1", action },
      })
    }
  })

  it("accepts video media in session attachment events", () => {
    expect(decodeGatewayEvent({
      event: "session:attachment",
      payload: {
        sessionId: "session-1",
        id: "message-1",
        content: "Demo",
        media: [{ type: "video", url: "/api/files/video-1", mimeType: "video/mp4" }],
        timestamp: 1,
      },
    })).not.toBeNull()
  })

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
