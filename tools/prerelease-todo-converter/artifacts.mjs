import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HELPER_SOURCE = fileURLToPath(new URL("./openat-helper.c", import.meta.url));
const LEGACY_TODO_TOKEN = /wi_[0-9a-f]{12}/g;
const PROSE_KEYS = new Set(["prompt", "title", "body", "summary", "note", "notes", "label", "error", "message"]);
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function helperSession() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-openat-helper-"));
  const binary = path.join(root, "openat-helper");
  const compile = spawnSync("/usr/bin/cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", HELPER_SOURCE, "-o", binary], {
    encoding: "utf8",
  });
  if (compile.status !== 0) {
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error("failed to compile the descriptor-relative artifact reader");
  }
  return { binary, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function decodeHexPath(value) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) throw new Error("invalid artifact helper output");
  return Buffer.from(value, "hex").toString("utf8");
}

function listRoot(binary, rootPath) {
  const result = spawnSync(binary, ["list", rootPath, "10000"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error("unsafe or unreadable artifact root");
  return result.stdout.trim().split("\n").filter(Boolean).map((line) => {
    const [type, size, encoded] = line.split("\t");
    if (!type || !size || !encoded) throw new Error("invalid artifact helper output");
    return { type, size: Number(size), relative: decodeHexPath(encoded) };
  }).sort((a, b) => a.relative.localeCompare(b.relative));
}

function readFile(binary, rootPath, relative) {
  const result = spawnSync(binary, ["read", rootPath, relative, String(16 * 1024 * 1024)], {
    encoding: null,
    maxBuffer: 17 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error("unsafe or unreadable artifact");
  return result.stdout;
}

function validateRootDescriptor(root) {
  if (!root || typeof root !== "object" || typeof root.path !== "string" || root.path.length === 0
    || !["workflow", "poll"].includes(root.kind) || !Array.isArray(root.files)) {
    throw new Error("invalid artifact root descriptor");
  }
  const unique = new Set();
  for (const relative of root.files) {
    if (typeof relative !== "string" || relative.startsWith("/") || relative.includes("//")
      || relative.split("/").some((segment) => !segment || segment === "." || segment === "..")
      || unique.has(relative)) {
      throw new Error("unsafe artifact allowlist path");
    }
    unique.add(relative);
  }
}

function allowedDirectories(files) {
  const directories = new Set();
  for (const relative of files) {
    const parts = relative.split("/");
    for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join("/"));
  }
  return directories;
}

function strictSnapshot(roots) {
  if (!Array.isArray(roots)) throw new Error("artifact roots are required");
  const helper = helperSession();
  const files = [];
  try {
    roots.forEach((root, rootIndex) => {
      validateRootDescriptor(root);
      const allowedFiles = new Set(root.files);
      const directories = allowedDirectories(root.files);
      const entries = listRoot(helper.binary, root.path);
      for (const entry of entries) {
        if (entry.type === "D" && directories.has(entry.relative)) continue;
        if (entry.type !== "F" || !allowedFiles.has(entry.relative)) {
          throw new Error("artifact root contains an unsafe or unexpected entry");
        }
        const bytes = readFile(helper.binary, root.path, entry.relative);
        files.push({ rootIndex, pathDigest: sha256(entry.relative), size: bytes.length, digest: sha256(bytes) });
      }
      for (const relative of allowedFiles) {
        if (!entries.some((entry) => entry.type === "F" && entry.relative === relative)) {
          throw new Error("artifact backup is missing an allowlisted file");
        }
      }
    });
  } finally {
    helper.cleanup();
  }
  files.sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
  const base = { rootCount: roots.length, files, helperSourceDigest: sha256(fs.readFileSync(HELPER_SOURCE)) };
  return { ...base, reportDigest: sha256(stableJson(base)) };
}

function assertMatchingDescriptors(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    throw new Error("artifact root sets do not match");
  }
  left.forEach((root, index) => {
    validateRootDescriptor(root);
    validateRootDescriptor(right[index]);
    if (root.kind !== right[index].kind || stableJson(root.files) !== stableJson(right[index].files)) {
      throw new Error("artifact root allowlists do not match");
    }
  });
}

export function verifyArtifactBackups({ sourceRoots, backupRoots }) {
  assertMatchingDescriptors(sourceRoots, backupRoots);
  const source = strictSnapshot(sourceRoots);
  const backup = strictSnapshot(backupRoots);
  if (stableJson(source.files) !== stableJson(backup.files)) {
    throw new Error("artifact backup digest does not match the offline source roots");
  }
  const base = { ok: true, rootCount: sourceRoots.length, files: source.files, helperSourceDigest: source.helperSourceDigest };
  return { ...base, reportDigest: sha256(stableJson(base)) };
}

export function rehearseArtifactRestore({ backupRoots, restoreRoots }) {
  assertMatchingDescriptors(backupRoots, restoreRoots);
  const helper = helperSession();
  const created = [];
  try {
    restoreRoots.forEach((root, index) => {
      if (fs.existsSync(root.path)) throw new Error("artifact restore rehearsal target already exists");
      const parent = path.dirname(root.path);
      let parentStat;
      try {
        parentStat = fs.lstatSync(parent);
      } catch {
        throw new Error("artifact restore parent must be an existing real directory");
      }
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("artifact restore parent must be a real directory");
      fs.mkdirSync(root.path, { mode: 0o700 });
      created.push(root.path);
      for (const relative of backupRoots[index].files) {
        const copy = spawnSync(helper.binary, [
          "copy", backupRoots[index].path, root.path, relative, String(16 * 1024 * 1024),
        ], { encoding: "utf8" });
        if (copy.status !== 0) throw new Error("failed to restore an artifact through the descriptor-relative helper");
      }
    });
    const backup = strictSnapshot(backupRoots);
    const restored = strictSnapshot(restoreRoots);
    if (stableJson(backup.files) !== stableJson(restored.files)) throw new Error("restored artifact digest mismatch");
    const base = { ok: true, rootCount: restoreRoots.length, files: restored.files, helperSourceDigest: restored.helperSourceDigest };
    return { ...base, reportDigest: sha256(stableJson(base)) };
  } catch (error) {
    for (const target of created) fs.rmSync(target, { recursive: true, force: true });
    throw error;
  } finally {
    helper.cleanup();
  }
}

function tokens(value) {
  return typeof value === "string" ? [...new Set(value.match(LEGACY_TODO_TOKEN) ?? [])] : [];
}

function structuredTokens(value, key = "") {
  if (Array.isArray(value)) return value.flatMap((entry) => structuredTokens(entry, key));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([childKey, entry]) => structuredTokens(entry, childKey));
  }
  if (typeof value !== "string" || PROSE_KEYS.has(key)) return [];
  if (key === "todoId" || key === "workItemId" || /(?:^|_)(?:id|ref)$/i.test(key) || key === "href") return tokens(value);
  return [];
}

function safeBlocker(code, rootIndex, relative, value = "") {
  return {
    code,
    rootIndex,
    pathDigest: sha256(relative),
    valueDigest: value ? sha256(value) : undefined,
  };
}

export function inventoryArtifactRoots(roots, mapping) {
  if (!Array.isArray(roots) || !(mapping instanceof Map)) throw new Error("artifact roots and Todo mapping are required");
  const helper = helperSession();
  const blockers = [];
  const files = [];
  try {
    roots.forEach((root, rootIndex) => {
      validateRootDescriptor(root);
      const allowedFiles = new Set(root.files);
      const expectedDirectories = allowedDirectories(root.files);
      let entries;
      try {
        entries = listRoot(helper.binary, root.path);
      } catch {
        blockers.push(safeBlocker("unsafe-artifact-root", rootIndex, "root"));
        return;
      }
      for (const entry of entries) {
        if (entry.type === "D") {
          if (!expectedDirectories.has(entry.relative)) blockers.push(safeBlocker("unexpected-artifact", rootIndex, entry.relative));
          continue;
        }
        if (entry.type !== "F") {
          blockers.push(safeBlocker("unsafe-artifact", rootIndex, entry.relative));
          continue;
        }
        if (!allowedFiles.has(entry.relative)) {
          blockers.push(safeBlocker("unexpected-artifact", rootIndex, entry.relative));
          continue;
        }
        let bytes;
        try {
          bytes = readFile(helper.binary, root.path, entry.relative);
        } catch {
          blockers.push(safeBlocker("unsafe-artifact", rootIndex, entry.relative));
          continue;
        }
        const fileEvidence = { rootIndex, pathDigest: sha256(entry.relative), size: bytes.length, digest: sha256(bytes) };
        files.push(fileEvidence);
        let parsed;
        try {
          parsed = JSON.parse(bytes.toString("utf8"));
        } catch {
          blockers.push(safeBlocker("malformed-artifact", rootIndex, entry.relative, fileEvidence.digest));
          continue;
        }
        const refs = structuredTokens(parsed);
        const orphans = refs.filter((token) => !mapping.has(token));
        for (const orphan of orphans) blockers.push(safeBlocker("orphan-artifact-todo-reference", rootIndex, entry.relative, orphan));
        if (refs.length === 0) continue;
        if (root.kind === "poll" && parsed.activation !== "inactive") {
          blockers.push(safeBlocker("executable-poll-todo-reference", rootIndex, entry.relative, refs.join("\0")));
        } else if (root.kind === "workflow" && !TERMINAL_RUN_STATUSES.has(parsed.status)) {
          blockers.push(safeBlocker("nonterminal-workflow-todo-reference", rootIndex, entry.relative, refs.join("\0")));
        }
      }
      for (const relative of allowedFiles) {
        if (!entries.some((entry) => entry.type === "F" && entry.relative === relative)) {
          blockers.push(safeBlocker("missing-artifact", rootIndex, relative));
        }
      }
    });
  } finally {
    helper.cleanup();
  }
  files.sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
  blockers.sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
  const base = { ok: blockers.length === 0, files, blockers, helperSourceDigest: sha256(fs.readFileSync(HELPER_SOURCE)) };
  return { ...base, reportDigest: sha256(stableJson(base)) };
}
