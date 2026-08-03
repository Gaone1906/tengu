import { describe, it, expect } from "vitest"
import { isNavItemActive } from "../pill-nav"
import { navigationFor } from "@/lib/nav"

// The single active-route rule shared by the rail (retired), drawer, popover and
// pill. Root "/" matches ONLY the exact chat root; every other item matches by
// path prefix so nested routes (e.g. /todos/123) keep their nav item lit.
describe("isNavItemActive", () => {
  it("matches root only on the exact chat path", () => {
    expect(isNavItemActive("/", "/")).toBe(true)
    expect(isNavItemActive("/", "/org")).toBe(false)
    expect(isNavItemActive("/", "/todos")).toBe(false)
  })

  it("matches non-root items by prefix", () => {
    expect(isNavItemActive("/org", "/org")).toBe(true)
    expect(isNavItemActive("/todos", "/todos/123")).toBe(true)
    expect(isNavItemActive("/logs", "/logs")).toBe(true)
  })

  it("does not cross-match sibling routes", () => {
    expect(isNavItemActive("/org", "/todos")).toBe(false)
    expect(isNavItemActive("/settings", "/skills")).toBe(false)
  })
})

describe("Experiments navigation", () => {
  it("keeps Experiments in desktop and More navigation, not the mobile primary bar", () => {
    const navigation = navigationFor(true)

    expect(navigation.items.map((item) => item.href)).toContain("/experiments")
    expect(navigation.overflowHrefs).toContain("/experiments")
    expect(navigation.mobileItems.map((item) => item.href)).not.toContain("/experiments")
  })
})
