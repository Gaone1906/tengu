import fs from "node:fs"
import path from "node:path"
import { seed as seedCustomized } from "./customized.mjs"

export const name = "heavily-customized"
export function seed(home) {
  seedCustomized(home)
  fs.appendFileSync(path.join(home, "CLAUDE.md"), "\n## Renamed local doctrine\nHEAVY-CUSTOM-SURVIVES\n")
  fs.rmSync(path.join(home, "skills", "sync"), { recursive: true, force: true })
  fs.mkdirSync(path.join(home, "org"), { recursive: true })
  fs.writeFileSync(path.join(home, "org", "local-operator.yaml"), "name: local-operator\ndisplayName: Local Operator\ndepartment: lab\nrank: employee\nengine: codex\npersona: Fixture sentinel.\n")
  fs.mkdirSync(path.join(home, "docs"), { recursive: true })
  fs.writeFileSync(path.join(home, "docs", "local-runbook.md"), "LOCAL-DOC-SURVIVES\n")
  fs.mkdirSync(path.join(home, "cron"), { recursive: true })
  fs.writeFileSync(path.join(home, "cron", "jobs.json"), "[{\"id\":\"local-lab-job\",\"enabled\":false}]\n")
  const config = path.join(home, "config.yaml")
  fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace(/^\s*version:\s*["']?\d+\.\d+\.\d+["']?\s*$/m, ""))
}
