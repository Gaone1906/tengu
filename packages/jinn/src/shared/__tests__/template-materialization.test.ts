import { describe, expect, it } from "vitest"
import {
  deriveTemplateMaterializationInputs,
  findUnresolvedTemplatePlaceholders,
  materializeTemplateBytes,
  materializeTemplateContent,
} from "../template-materialization.js"

describe("template materialization", () => {
  it("derives the default Tengu replacements", () => {
    expect(deriveTemplateMaterializationInputs({})).toEqual({
      portalName: "Tengu",
      portalSlug: "tengu",
    })
  })

  it("preserves a custom portal name and applies setup's deterministic slug rule", () => {
    const inputs = deriveTemplateMaterializationInputs({
      portal: { portalName: "My Mixed CASE Portal" },
    })

    expect(inputs).toEqual({
      portalName: "My Mixed CASE Portal",
      portalSlug: "my-mixed-case-portal",
    })
    expect(materializeTemplateContent(
      "docs/overview.md",
      "# {{portalName}}\nRun `{{portalSlug}} start`.\n",
      inputs,
    )).toBe("# My Mixed CASE Portal\nRun `my-mixed-case-portal start`.\n")
  })

  it("does not normalize or reinterpret genuine user edits", () => {
    const edited = "# My Mixed CASE Portal\nKeep  double  spaces and MIXED case.\n"

    expect(materializeTemplateContent(
      "docs/overview.md",
      edited,
      deriveTemplateMaterializationInputs({ portal: { portalName: "My Mixed CASE Portal" } }),
    )).toBe(edited)
  })

  it("leaves unresolved and unknown placeholders intact for conservative handling", () => {
    const materialized = materializeTemplateContent(
      "config.yaml",
      "name: {{portalName}}\nunknown: {{futureValue}}\n",
      deriveTemplateMaterializationInputs({}),
    )

    expect(materialized).toBe("name: Tengu\nunknown: {{futureValue}}\n")
    expect(findUnresolvedTemplatePlaceholders(materialized)).toEqual(["{{futureValue}}"])
  })

  it("never transforms non-Markdown/YAML payloads", () => {
    const source = '{"name":"{{portalName}}","slug":"{{portalSlug}}"}\n'

    expect(materializeTemplateContent(
      "state/template.json",
      source,
      deriveTemplateMaterializationInputs({ portal: { portalName: "Custom Portal" } }),
    )).toBe(source)
  })

  it("preserves invalid UTF-8 bytes in non-Markdown/YAML payloads", () => {
    const source = Buffer.from([0xff, 0xfe, 0x00, 0x7b, 0x7b, 0x70, 0x6f, 0x72, 0x74, 0x61, 0x6c, 0x4e, 0x61, 0x6d, 0x65, 0x7d, 0x7d])

    expect(materializeTemplateBytes(
      "assets/template.bin",
      source,
      deriveTemplateMaterializationInputs({ portal: { portalName: "Custom Portal" } }),
    )).toEqual(source)
  })
})
