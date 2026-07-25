#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(repoRoot, "packages", "web", "out");
const target = path.join(repoRoot, "packages", "jinn", "dist", "web");
const stamp = `${process.pid}-${Date.now()}`;
const nextIndex = path.join(target, `.index-next-${stamp}.html`);

function fail(message) {
  console.error(`sync-web-dist: ${message}`);
  process.exit(1);
}

function assetRefs(indexHtml) {
  return [...indexHtml.matchAll(/["']\/assets\/([^"']+)["']/g)].map((match) => match[1]);
}

function assertAssetRefsAvailable(indexHtml, dir) {
  for (const assetRef of assetRefs(indexHtml)) {
    const assetPath = path.join(dir, "assets", assetRef);
    if (!fs.existsSync(assetPath)) {
      fail(`index.html references missing asset ${path.relative(repoRoot, assetPath)}`);
    }
  }
}

function assertBuiltWeb(dir) {
  const indexPath = path.join(dir, "index.html");
  if (!fs.existsSync(indexPath)) {
    fail(`missing ${path.relative(repoRoot, indexPath)}; run the web build first`);
  }

  const indexHtml = fs.readFileSync(indexPath, "utf8");
  assertAssetRefsAvailable(indexHtml, dir);
}

function copyWebExceptIndex(fromDir, toDir) {
  fs.mkdirSync(toDir, { recursive: true });
  for (const entry of fs.readdirSync(fromDir)) {
    if (entry === "index.html") {
      continue;
    }
    fs.cpSync(path.join(fromDir, entry), path.join(toDir, entry), { recursive: true, force: true });
  }
}

function listFilesRelative(dir) {
  const files = new Set();
  if (!fs.existsSync(dir)) {
    return files;
  }
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? path.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(current, entry.name), relative);
      } else {
        files.add(relative);
      }
    }
  };
  walk(dir, "");
  return files;
}

function removeEmptyDirs(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const child = path.join(dir, entry.name);
    removeEmptyDirs(child);
    if (fs.readdirSync(child).length === 0) {
      fs.rmdirSync(child);
    }
  }
}

/**
 * Vite hashes chunk names, so every build writes new filenames instead of
 * overwriting the old ones. Without a prune the target only ever grows, and a
 * browser that revalidates index.html but still holds an older entry chunk can
 * keep booting a months-old bundle from the same directory. Prune runs *after*
 * the index swap so the copy-then-swap ordering above still holds: at this
 * point the new index.html is live and verified, and everything not in the
 * fresh build is unreachable from it.
 */
function pruneStale(fromDir, toDir) {
  const keep = listFilesRelative(fromDir);
  let removed = 0;
  for (const relative of listFilesRelative(toDir)) {
    if (keep.has(relative)) {
      continue;
    }
    fs.rmSync(path.join(toDir, relative), { force: true });
    removed += 1;
  }
  removeEmptyDirs(toDir);
  return removed;
}

assertBuiltWeb(source);
copyWebExceptIndex(source, target);
const sourceIndexHtml = fs.readFileSync(path.join(source, "index.html"), "utf8");
assertAssetRefsAvailable(sourceIndexHtml, target);
fs.writeFileSync(nextIndex, sourceIndexHtml);
fs.renameSync(nextIndex, path.join(target, "index.html"));
assertBuiltWeb(target);
const pruned = pruneStale(source, target);
assertBuiltWeb(target);

console.log(
  `synced ${path.relative(repoRoot, source)} -> ${path.relative(repoRoot, target)}` +
    (pruned > 0 ? ` (pruned ${pruned} stale file${pruned === 1 ? "" : "s"})` : ""),
);
