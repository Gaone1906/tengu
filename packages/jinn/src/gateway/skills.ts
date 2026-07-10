import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { SKILLS_DIR } from "../shared/paths.js";
import { syncSkillSymlinks } from "./watcher.js";

export type SkillUpdateResult =
  | { ok: true; content: string }
  | { ok: false; status: 400 | 403 | 404; error: string };

function validateSkillContent(name: string, content: string): { ok: true } | { ok: false; error: string } {
  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:[ \t]*\r?\n|[ \t]*$)/);
  if (!match) return { ok: false, error: "SKILL.md must start with YAML frontmatter delimited by ---" };

  let frontmatter: unknown;
  try {
    frontmatter = yaml.load(match[1]);
  } catch (err) {
    return { ok: false, error: `SKILL.md frontmatter is invalid YAML: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    return { ok: false, error: "SKILL.md frontmatter must be a YAML object" };
  }

  const record = frontmatter as Record<string, unknown>;
  if (typeof record.name !== "string" || !record.name.trim()) {
    return { ok: false, error: "SKILL.md frontmatter requires a non-empty name" };
  }
  if (record.name.trim() !== name) {
    return { ok: false, error: `SKILL.md frontmatter name must match skill directory "${name}"` };
  }
  if (typeof record.description !== "string" || !record.description.trim()) {
    return { ok: false, error: "SKILL.md frontmatter requires a non-empty description" };
  }
  return { ok: true };
}

function resolveSkillFile(name: string): { ok: true; path: string; mode: number } | { ok: false; status: 403 | 404; error: string } {
  let rootRealPath: string;
  try {
    rootRealPath = fs.realpathSync(SKILLS_DIR);
  } catch {
    return { ok: false, status: 404, error: "Skill not found" };
  }

  const skillDir = path.resolve(SKILLS_DIR, name);
  if (path.dirname(skillDir) !== path.resolve(SKILLS_DIR)) {
    return { ok: false, status: 403, error: "Skill path must stay inside the skills directory" };
  }

  let dirStat: fs.Stats;
  let dirRealPath: string;
  try {
    dirStat = fs.lstatSync(skillDir);
    dirRealPath = fs.realpathSync(skillDir);
  } catch {
    return { ok: false, status: 404, error: "Skill not found" };
  }
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    return { ok: false, status: 403, error: "Skill path must be a directory inside the skills directory" };
  }
  if (path.dirname(dirRealPath) !== rootRealPath) {
    return { ok: false, status: 403, error: "Skill path must stay inside the skills directory" };
  }

  const skillFile = path.join(skillDir, "SKILL.md");
  let fileStat: fs.Stats;
  try {
    fileStat = fs.lstatSync(skillFile);
  } catch {
    return { ok: false, status: 404, error: "Skill not found" };
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    return { ok: false, status: 403, error: "SKILL.md must be a regular file inside its skill directory" };
  }
  return { ok: true, path: skillFile, mode: fileStat.mode };
}

export function updateSkillContent(name: string, content: unknown): SkillUpdateResult {
  if (typeof content !== "string") {
    return { ok: false, status: 400, error: "content must be a string" };
  }
  const validation = validateSkillContent(name, content);
  if (!validation.ok) return { ok: false, status: 400, error: validation.error };

  const resolved = resolveSkillFile(name);
  if (!resolved.ok) return resolved;

  const tempPath = path.join(path.dirname(resolved.path), `.SKILL.md.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tempPath, content, { encoding: "utf-8", flag: "wx", mode: resolved.mode });
    fs.renameSync(tempPath, resolved.path);
  } catch (err) {
    fs.rmSync(tempPath, { force: true });
    throw err;
  }

  syncSkillSymlinks();
  return { ok: true, content };
}
