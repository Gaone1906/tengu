import { render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { EmployeeAvatar } from "../employee-avatar"
import { colorForName } from "@/lib/color-pool"

const employeeOverrides: Record<string, { emoji?: string; profileImage?: string; color?: string }> = {}

vi.mock("@/routes/settings-provider", () => ({
  useSettings: () => ({ settings: { employeeOverrides } }),
}))

describe("EmployeeAvatar", () => {
  it("renders the explicit override color as its ring", () => {
    employeeOverrides["lead-developer"] = { color: "#123456" }

    const { container } = render(<EmployeeAvatar name="lead-developer" />)
    const avatar = container.querySelector("span") as HTMLSpanElement

    expect(avatar.style.boxShadow).toContain("#123456")

    delete employeeOverrides["lead-developer"]
  })

  it("falls back to a stable color-pool color when no override is set", () => {
    const { container: first } = render(<EmployeeAvatar name="content-writer" />)
    const firstSpan = first.querySelector("span") as HTMLSpanElement

    const { container: second } = render(<EmployeeAvatar name="content-writer" />)
    const secondSpan = second.querySelector("span") as HTMLSpanElement

    const expected = colorForName("content-writer")
    expect(firstSpan.style.boxShadow).toContain(expected)
    expect(secondSpan.style.boxShadow).toBe(firstSpan.style.boxShadow)
  })
})
