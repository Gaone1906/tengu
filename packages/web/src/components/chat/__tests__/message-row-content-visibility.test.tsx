import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { Message } from "@/lib/conversations"
import { ChatMessages } from "../chat-messages"

describe("chat message row scrolling", () => {
  it("lets offscreen message rows skip layout and paint", () => {
    const messages: Message[] = [{
      id: "message-1",
      role: "user",
      content: "A short message",
      timestamp: 100,
    }]

    const { container } = render(<ChatMessages messages={messages} loading={false} />)
    const row = container.querySelector<HTMLElement>('[data-message-id="message-1"]')

    expect(row?.style.contentVisibility).toBe("auto")
    expect(row?.style.containIntrinsicSize).toBe("auto 120px")
  })
})
