import { fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter, useLocation } from "react-router-dom"
import { describe, expect, it } from "vitest"
import { TodoPrefixContext } from "../todo-prefix-context"
import { formatMessage } from "../chat-messages"

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>
}

function renderMessage(content: string, prefixes: ReadonlySet<string>) {
  return render(
    <MemoryRouter initialEntries={["/chat"]}>
      <TodoPrefixContext.Provider value={prefixes}>
        <div data-testid="message">{formatMessage(content)}</div>
        <LocationProbe />
      </TodoPrefixContext.Provider>
    </MemoryRouter>,
  )
}

describe("Todo links in chat messages", () => {
  it("renders a live bare Todo ID as a relative in-app link", () => {
    renderMessage("Open ICI-637", new Set(["ICI"]))

    const link = screen.getByRole("link", { name: "ICI-637" })
    expect(link.getAttribute("href")).toBe("/todos/ICI-637")
    expect(link.outerHTML).not.toContain("://")

    fireEvent.click(link)
    expect(screen.getByTestId("location").textContent).toBe("/todos/ICI-637")
  })

  it("renders a backticked live Todo ID as the same link instead of code", () => {
    const { container } = renderMessage("Check `PLA-18`", new Set(["PLA"]))

    expect(screen.getByRole("link", { name: "PLA-18" }).getAttribute("href")).toBe("/todos/PLA-18")
    expect(container.querySelector("code")).toBeNull()
  })

  it("leaves non-live prefixes byte-identical as plain text", () => {
    renderMessage("GPT-5 SHA-256 UTF-8", new Set(["ICI", "PLA"]))

    expect(screen.getByTestId("message").textContent).toBe("GPT-5 SHA-256 UTF-8")
    expect(screen.queryByRole("link")).toBeNull()
  })

  it("leaves Todo-shaped text unlinked without a provider", () => {
    const { container } = render(<div>{formatMessage("ICI-637")}</div>)

    expect(container.textContent).toBe("ICI-637")
    expect(container.querySelector("a")).toBeNull()
  })

  it("preserves the inline-code chip for a backticked ID without a live prefix", () => {
    const { container } = render(<div>{formatMessage("`ICI-637`")}</div>)

    expect(container.querySelector("code")?.textContent).toBe("ICI-637")
    expect(container.querySelector("a")).toBeNull()
  })

  it("does not link IDs inside URLs, fenced code, or shape-adjacent junk", () => {
    const content = [
      "https://example.test/todos/ICI-637",
      "```text",
      "ICI-637",
      "```",
      "XICI-637 ICI-637-2 ICI-5.6 ICI-0",
    ].join("\n")
    const { container } = renderMessage(content, new Set(["ICI"]))

    const links = screen.getAllByRole("link")
    expect(links).toHaveLength(1)
    expect(links[0].getAttribute("href")).toBe("https://example.test/todos/ICI-637")
    expect(container.querySelector("pre code")?.textContent).toBe("ICI-637")
    expect(screen.getByTestId("message").textContent).toContain("XICI-637 ICI-637-2 ICI-5.6 ICI-0")
  })
})
