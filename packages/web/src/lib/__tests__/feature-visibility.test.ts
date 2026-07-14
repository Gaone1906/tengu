import { describe, expect, it } from "vitest"
import { navigationFor } from "../nav"
import { staticPagesFor } from "@/components/global-search"

describe("Notes feature visibility", () => {
  it("removes Notes from navigation and global search when disabled", () => {
    const navigation = navigationFor(false)

    expect(navigation.items.map((item) => item.href)).not.toContain("/notes")
    expect(navigation.mobileItems.map((item) => item.href)).not.toContain("/notes")
    expect(staticPagesFor(false).map((page) => page.href)).not.toContain("/notes")
  })

  it("restores Notes when explicitly enabled", () => {
    expect(navigationFor(true).items.map((item) => item.href)).toContain("/notes")
    expect(staticPagesFor(true).map((page) => page.href)).toContain("/notes")
  })
})
