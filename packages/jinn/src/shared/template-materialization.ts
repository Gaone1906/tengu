import path from "node:path"

export interface TemplateMaterializationInputs {
  portalName: string
  portalSlug: string
}

export interface TemplateMaterializationConfig {
  portal?: {
    portalName?: string
  }
}

const MATERIALIZED_EXTENSIONS = new Set([".md", ".yaml", ".yml"])

export function isTemplateMaterializationPath(filePath: string): boolean {
  return MATERIALIZED_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

export function deriveTemplateMaterializationInputs(
  config: TemplateMaterializationConfig | null | undefined,
): TemplateMaterializationInputs {
  const portalName = config?.portal?.portalName || "Jinn"
  return {
    portalName,
    portalSlug: portalName.toLowerCase().replace(/\s+/g, "-"),
  }
}

export function materializeTemplateContent(
  filePath: string,
  content: string,
  inputs: TemplateMaterializationInputs,
): string {
  if (!isTemplateMaterializationPath(filePath)) return content
  return content
    .replaceAll("{{portalName}}", inputs.portalName)
    .replaceAll("{{portalSlug}}", inputs.portalSlug)
}

export function materializeTemplateBytes(
  filePath: string,
  content: Buffer,
  inputs: TemplateMaterializationInputs,
): Buffer {
  if (!isTemplateMaterializationPath(filePath)) return content
  return Buffer.from(materializeTemplateContent(filePath, content.toString("utf8"), inputs), "utf8")
}

export function findUnresolvedTemplatePlaceholders(content: string): string[] {
  return [...new Set(content.match(/\{\{[^{}\r\n]+\}\}/g) ?? [])].sort()
}
