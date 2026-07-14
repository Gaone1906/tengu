import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const converterRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = path.resolve(converterRoot, "../..");

function filesBelow(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? filesBelow(target) : entry.isFile() ? [target] : [];
  });
}

test("the converter is root-only, unshipped, and has no apply entry point", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "packages/jinn/package.json"), "utf8"));
  assert.deepEqual(packageJson.files, ["dist/", "template/", "assets/"]);

  for (const file of filesBelow(path.join(repositoryRoot, "packages"))) {
    if (!/\.(?:[cm]?[jt]sx?|json|md)$/.test(file) || file.includes(`${path.sep}dist${path.sep}`)) continue;
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /prerelease-todo-converter/);
  }

  const executableSources = ["dry-run.mjs", "inventory.mjs", "backup.mjs", "artifacts.mjs", "openat-helper.c"]
    .map((file) => fs.readFileSync(path.join(converterRoot, file), "utf8"))
    .join("\n");
  assert.doesNotMatch(executableSources, /--apply|\bapplyTodo|\brewriteTodo|\bUPDATE\s+work_|\bDELETE\s+FROM\s+work_|\bINSERT\s+INTO\s+work_/i);
});
