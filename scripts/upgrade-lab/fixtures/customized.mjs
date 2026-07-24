import fs from "node:fs"
import path from "node:path"

export const name = "customized"
export function seed(home) {
  fs.appendFileSync(path.join(home, "CLAUDE.md"), "\n## Local operating note\nKeep this sentinel: CUSTOM-CLAUDE-SURVIVES\n")
  fs.appendFileSync(path.join(home, "config.yaml"), "\nlabPreference: CUSTOM-CONFIG-SURVIVES\n")
  const skill = path.join(home, "skills", "management", "SKILL.md")
  if (fs.existsSync(skill)) fs.appendFileSync(skill, "\n<!-- CUSTOM-STOCK-SKILL-SURVIVES -->\n")
  const custom = path.join(home, "skills", "local-helper")
  fs.mkdirSync(custom, { recursive: true })
  fs.writeFileSync(path.join(custom, "SKILL.md"), "---\nname: local-helper\ndescription: Lab-only custom skill sentinel.\n---\nCUSTOM-SKILL-SURVIVES\n")
}
