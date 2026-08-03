import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyNativeDbFailure,
  nativeDbFailureReport,
  repairNodePtySpawnHelper,
} from "../runtime-guard.js";

const created: string[] = [];

function fakeNodePty(layout: string, mode: number): { root: string; helper: string } {
  const root = mkdtempSync(join(tmpdir(), "jinn-node-pty-"));
  created.push(root);
  const dir = join(root, layout);
  mkdirSync(dir, { recursive: true });
  const helper = join(dir, "spawn-helper");
  writeFileSync(helper, "#!/bin/sh\nexit 0\n");
  chmodSync(helper, mode);
  return { root, helper };
}

const modeOf = (path: string) => statSync(path).mode & 0o777;

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

// The exact message a Homebrew install produces (issue #108). node-pty and
// better-sqlite3 both fail *after* a successful require, which is why a
// require-only guard let this reach users.
const BINDINGS_MISSING =
  "Could not locate the bindings file. Tried:\n → .../better-sqlite3/build/better_sqlite3.node";

const ABI_MISMATCH =
  "The module was compiled against a different Node.js version using NODE_MODULE_VERSION 127.";

describe("classifyNativeDbFailure", () => {
  it("recognises a binding that was never built", () => {
    expect(classifyNativeDbFailure(BINDINGS_MISSING)).toBe("binding-missing");
    expect(classifyNativeDbFailure("Cannot find module './build/Release/better_sqlite3.node'")).toBe(
      "binding-missing",
    );
  });

  it("still recognises an ABI mismatch", () => {
    expect(classifyNativeDbFailure(ABI_MISMATCH)).toBe("abi-mismatch");
    expect(classifyNativeDbFailure("ERR_DLOPEN_FAILED")).toBe("abi-mismatch");
  });

  it("does not claim unrelated failures", () => {
    expect(classifyNativeDbFailure("SQLITE_CANTOPEN: unable to open database file")).toBe("unknown");
  });
});

describe("nativeDbFailureReport", () => {
  it("tells a binding-less install to reinstall rather than to switch Node", () => {
    const report = nativeDbFailureReport("binding-missing", BINDINGS_MISSING);
    expect(report).toContain("never built");
    expect(report).toContain("brew reinstall jinn");
    expect(report).toContain("npm rebuild better-sqlite3");
    // The old message blamed the Node version, which is wrong here and sent
    // users to `nvm use` for a problem no Node switch can fix.
    expect(report).not.toContain("nvm use");
  });

  it("keeps the Node-version instruction for a real ABI mismatch", () => {
    const report = nativeDbFailureReport("abi-mismatch", ABI_MISMATCH);
    expect(report).toContain("different Node.js version");
    expect(report).toContain("nvm use");
  });
});

describe.skipIf(process.platform === "win32")("repairNodePtySpawnHelper", () => {
  it("restores the exec bit on a prebuilt spawn-helper left at 0644", () => {
    const { root, helper } = fakeNodePty(`prebuilds/${process.platform}-${process.arch}`, 0o644);
    expect(modeOf(helper)).toBe(0o644);

    expect(repairNodePtySpawnHelper(root)).toEqual([helper]);
    expect(modeOf(helper)).toBe(0o755);
  });

  it("also repairs a source-built build/Release layout", () => {
    const { root, helper } = fakeNodePty("build/Release", 0o644);

    expect(repairNodePtySpawnHelper(root)).toEqual([helper]);
    expect(modeOf(helper)).toBe(0o755);
  });

  it("is a no-op on a healthy install", () => {
    const { root, helper } = fakeNodePty(`prebuilds/${process.platform}-${process.arch}`, 0o755);

    expect(repairNodePtySpawnHelper(root)).toEqual([]);
    expect(modeOf(helper)).toBe(0o755);
  });

  it("never throws when there is no spawn-helper to repair", () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-node-pty-empty-"));
    created.push(root);

    expect(repairNodePtySpawnHelper(root)).toEqual([]);
  });
});
