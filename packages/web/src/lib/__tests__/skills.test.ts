import { describe, expect, it } from "vitest"
import { extraFrontmatter, filterSkills, parseSkillMd } from "../skills"

describe("parseSkillMd", () => {
  it("splits frontmatter from body", () => {
    const { frontmatter, body } = parseSkillMd(
      "---\nname: deep-research\ndescription: Multi-engine research.\n---\n\n# Title\n\nBody text.\n",
    )
    expect(frontmatter).toEqual({ name: "deep-research", description: "Multi-engine research." })
    expect(body).toBe("# Title\n\nBody text.\n")
  })

  it("returns the whole content as body when there is no frontmatter", () => {
    const { frontmatter, body } = parseSkillMd("# Just markdown\n")
    expect(frontmatter).toEqual({})
    expect(body).toBe("# Just markdown\n")
  })

  it("treats an unclosed fence as body, not frontmatter", () => {
    const content = "---\nname: broken\n\n# Oops no closing fence\n"
    const { frontmatter, body } = parseSkillMd(content)
    expect(frontmatter).toEqual({})
    expect(body).toBe(content)
  })

  it("joins indented continuation lines onto the previous key", () => {
    const { frontmatter } = parseSkillMd(
      "---\ndescription: First line\n  second line\n  third line\nname: x\n---\nbody",
    )
    expect(frontmatter.description).toBe("First line second line third line")
    expect(frontmatter.name).toBe("x")
  })

  it("handles block scalars and quoted values", () => {
    const { frontmatter } = parseSkillMd(
      '---\ndescription: >-\n  Folded block\n  value here\nname: "quoted"\n---\nbody',
    )
    expect(frontmatter.description).toBe("Folded block value here")
    expect(frontmatter.name).toBe("quoted")
  })

  it("ignores comments and blank lines inside the frontmatter", () => {
    const { frontmatter } = parseSkillMd("---\n# comment\n\nname: a\n---\nbody")
    expect(frontmatter).toEqual({ name: "a" })
  })

  it("strips only leading blank lines from the body", () => {
    const { body } = parseSkillMd("---\nname: a\n---\n\n\nFirst.\n\nSecond.\n")
    expect(body).toBe("First.\n\nSecond.\n")
  })
})

describe("filterSkills", () => {
  const skills = [
    { name: "deep-research", description: "Multi-engine research" },
    { name: "release", description: "Publish to npm and GitHub" },
    { name: "browser-use", description: "Drive Chrome for QA" },
  ]

  it("returns everything for an empty query", () => {
    expect(filterSkills(skills, "")).toHaveLength(3)
    expect(filterSkills(skills, "   ")).toHaveLength(3)
  })

  it("matches on name, case-insensitively", () => {
    expect(filterSkills(skills, "RELEASE").map((s) => s.name)).toEqual(["release"])
  })

  it("matches on description", () => {
    expect(filterSkills(skills, "chrome").map((s) => s.name)).toEqual(["browser-use"])
  })

  it("returns empty when nothing matches", () => {
    expect(filterSkills(skills, "zzz")).toEqual([])
  })
})

describe("extraFrontmatter", () => {
  it("excludes name/description and empty values", () => {
    expect(
      extraFrontmatter({ name: "a", description: "b", license: "MIT", empty: "  " }),
    ).toEqual([["license", "MIT"]])
  })
})
