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

assertBuiltWeb(source);
copyWebExceptIndex(source, target);
const sourceIndexHtml = fs.readFileSync(path.join(source, "index.html"), "utf8");
assertAssetRefsAvailable(sourceIndexHtml, target);
fs.writeFileSync(nextIndex, sourceIndexHtml);
fs.renameSync(nextIndex, path.join(target, "index.html"));
assertBuiltWeb(target);

console.log(`synced ${path.relative(repoRoot, source)} -> ${path.relative(repoRoot, target)}`);
