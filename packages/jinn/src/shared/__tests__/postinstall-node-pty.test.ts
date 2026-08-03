import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// packages/jinn
const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = join(PKG, "scripts", "fix-node-pty-permissions.mjs");

const created: string[] = [];

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

/**
 * Build a throwaway package that looks like an installed jinn-cli: the real
 * postinstall script under scripts/, and a fake node-pty next door in
 * node_modules/ so the script's require.resolve finds it by walking up.
 */
function stagePackage(helperLayouts: Array<{ dir: string; mode: number }>): {
  root: string;
  script: string;
  helpers: string[];
} {
  const root = mkdtempSync(join(tmpdir(), "jinn-postinstall-"));
  created.push(root);

  mkdirSync(join(root, "scripts"), { recursive: true });
  const script = join(root, "scripts", "fix-node-pty-permissions.mjs");
  copyFileSync(SCRIPT, script);

  const nodePty = join(root, "node_modules", "node-pty");
  mkdirSync(nodePty, { recursive: true });
  writeFileSync(join(nodePty, "package.json"), JSON.stringify({ name: "node-pty", version: "1.1.0" }));

  const helpers: string[] = [];
  for (const { dir, mode } of helperLayouts) {
    const target = join(nodePty, dir);
    mkdirSync(target, { recursive: true });
    const helper = join(target, "spawn-helper");
    writeFileSync(helper, "#!/bin/sh\nexit 0\n");
    chmodSync(helper, mode);
    helpers.push(helper);
  }

  return { root, script, helpers };
}

/** Runs the postinstall exactly as npm would. Throws if it exits non-zero. */
function runPostinstall(script: string): string {
  return execFileSync(process.execPath, [script], { encoding: "utf-8", stdio: "pipe" });
}

const modeOf = (path: string) => statSync(path).mode & 0o777;

describe.skipIf(process.platform === "win32")("jinn-cli postinstall: node-pty permissions", () => {
  it("repairs a shipped prebuild left at 0644", () => {
    const { script, helpers } = stagePackage([
      { dir: `prebuilds/${process.platform}-${process.arch}`, mode: 0o644 },
    ]);

    runPostinstall(script);

    expect(modeOf(helpers[0]!)).toBe(0o755);
  });

  // Homebrew's std_npm_args always passes --build-from-source. node-pty then
  // COMPILES and deletes prebuilds/ entirely, leaving only build/Release. The
  // previous script did readdir("prebuilds") and threw ENOENT on exactly this
  // layout, which failed `npm install` and would have broken `brew install`
  // outright the moment lifecycle scripts were re-enabled.
  it("succeeds on a source-built layout that has no prebuilds/ directory", () => {
    const { script, helpers } = stagePackage([{ dir: "build/Release", mode: 0o755 }]);

    expect(() => runPostinstall(script)).not.toThrow();
    expect(modeOf(helpers[0]!)).toBe(0o755);
  });

  it("repairs a source-built helper that lost its exec bit", () => {
    const { script, helpers } = stagePackage([{ dir: "build/Release", mode: 0o644 }]);

    runPostinstall(script);

    expect(modeOf(helpers[0]!)).toBe(0o755);
  });

  // A permission fix-up must never be able to fail an install; the runtime
  // guard repairs the same file at startup.
  it("never fails the install when there is nothing to repair", () => {
    const { script } = stagePackage([]);

    expect(() => runPostinstall(script)).not.toThrow();
  });

  it("never fails the install when node-pty is not resolvable", () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-postinstall-bare-"));
    created.push(root);
    mkdirSync(join(root, "scripts"), { recursive: true });
    // An empty node_modules stops require.resolve from escaping to a real
    // node-pty higher up the tree.
    mkdirSync(join(root, "node_modules"), { recursive: true });
    const script = join(root, "scripts", "fix-node-pty-permissions.mjs");
    copyFileSync(SCRIPT, script);

    expect(() => runPostinstall(script)).not.toThrow();
  });
});
