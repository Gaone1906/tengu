/** Client-side helpers for the Skills pages.
 *
 * A skill is a directory holding a SKILL.md whose YAML frontmatter carries at
 * least `name` and `description`. The gateway returns the RAW file
 * (`GET /api/skills/:name` → `{ name, content }`), so the view splits
 * frontmatter from body here. The parser handles the simple frontmatter
 * subset skills actually use — single-line `key: value` pairs plus indented
 * continuation lines — and never throws: a malformed header just renders as
 * body text.
 */

export interface ParsedSkill {
  frontmatter: Record<string, string>
  /** SKILL.md content with the frontmatter block removed. */
  body: string
}

const FENCE = /^---\s*$/

export function parseSkillMd(content: string): ParsedSkill {
  const lines = content.split("\n")
  if (!lines.length || !FENCE.test(lines[0])) return { frontmatter: {}, body: content }

  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      close = i
      break
    }
  }
  if (close === -1) return { frontmatter: {}, body: content }

  const frontmatter: Record<string, string> = {}
  let lastKey: string | null = null
  for (const raw of lines.slice(1, close)) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue
    const m = /^([A-Za-z0-9_-]+):\s?(.*)$/.exec(raw)
    if (m) {
      lastKey = m[1]
      // ">"/"|" block scalars: the value accumulates from continuation lines.
      const v = m[2].trim()
      frontmatter[lastKey] = /^[>|][+-]?$/.test(v) ? "" : unquote(v)
    } else if (lastKey && /^\s/.test(raw)) {
      const cont = raw.trim()
      frontmatter[lastKey] = frontmatter[lastKey] ? `${frontmatter[lastKey]} ${cont}` : cont
    }
  }

  const body = lines
    .slice(close + 1)
    .join("\n")
    .replace(/^\n+/, "")
  return { frontmatter, body }
}

function unquote(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1)
  }
  return v
}

export interface SkillSummary {
  name: string
  description: string
}

/** Case-insensitive name+description filter for the list's search field. */
export function filterSkills<T extends SkillSummary>(skills: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return skills
  return skills.filter(
    (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
  )
}

/** Frontmatter keys already surfaced by the detail header. */
const HEADER_KEYS = new Set(["name", "description"])

/** Extra frontmatter entries worth showing as quiet metadata rows. */
export function extraFrontmatter(fm: Record<string, string>): [string, string][] {
  return Object.entries(fm).filter(([k, v]) => !HEADER_KEYS.has(k) && v.trim() !== "")
}
