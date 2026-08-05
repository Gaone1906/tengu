import { describe, expect, it } from "vitest"
import type { GatewayContextValue } from "@/hooks/use-gateway"

// Compile lock for the browser-consumer side of the gateway protocol. If the
// subscription API is widened back to string/unknown, these directives become
// unused and `pnpm --filter @jinn/web typecheck` fails.
type SubscribeListener = Parameters<GatewayContextValue["subscribe"]>[0]

const consumer: SubscribeListener = (frame) => {
  // @ts-expect-error -- misspelled event names are not comparable to the wire union
  if (frame.event === "session:stoppped") return
  if (frame.event === "session:stopped") {
    const sessionId: string = frame.payload.sessionId
    // @ts-expect-error -- the stopped-session payload carries a string id
    const numericSessionId: number = frame.payload.sessionId
    void sessionId
    void numericSessionId
  }
}

describe("gateway event consumer compile lock", () => {
  it("remains a callable listener at runtime", () => {
    expect(typeof consumer).toBe("function")
  })
})
