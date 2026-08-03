import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// packages/jinn
const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// repo root — the tap and the source repo are the same repository, so the
// Homebrew formula is version-controlled here and is ours to keep correct.
const FORMULA = join(PKG, "..", "..", "Formula", "jinn.rb");

const formula = () => readFileSync(FORMULA, "utf-8");

describe("Homebrew formula", () => {
  it("is present in this repo", () => {
    expect(existsSync(FORMULA)).toBe(true);
  });

  // Issues #108 and #109 both trace to this one call. Homebrew's
  // npm_install_security_args defaults ignore_scripts: true, so a bare
  // *std_npm_args installs with --ignore-scripts: better-sqlite3's addon is
  // never built and node-pty's spawn-helper never regains its exec bit.
  it("opts out of --ignore-scripts so native addons are actually built", () => {
    const src = formula();
    expect(src).toMatch(/std_npm_args\(ignore_scripts:\s*false\)/);
    // No bare *std_npm_args left anywhere — that is the broken form.
    expect(src).not.toMatch(/\*std_npm_args(?!\()/);
  });

  it("keeps the build toolchain the source compile needs", () => {
    const src = formula();
    expect(src).toMatch(/depends_on "python" => :build/);
  });

  describe("test block", () => {
    // A bare require('better-sqlite3') SUCCEEDS on a binding-less install,
    // because the binding is resolved lazily in the Database constructor. The
    // old assertion was therefore a false negative and could never have caught
    // #108. Only opening a database exercises the addon.
    it("opens a database instead of only requiring better-sqlite3", () => {
      const src = formula();
      expect(src).toMatch(/new \(require\('better-sqlite3'\)\)\(':memory:'\)/);
      expect(src).not.toMatch(/"require\('better-sqlite3'\)"/);
    });

    // Likewise require('node-pty') passes while spawn-helper is mode 0644;
    // only a real spawn posix_spawns the helper (#109).
    it("really spawns through node-pty instead of only requiring it", () => {
      const src = formula();
      expect(src).toMatch(/require\('node-pty'\)/);
      expect(src).toMatch(/pty\.spawn\(/);
    });

    // The block previously asserted require('classic-level'), which is a root
    // workspace dependency and is not published inside jinn-cli — so the
    // assertion could only ever fail once someone actually ran `brew test`.
    it("only requires modules the published package actually depends on", () => {
      const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf-8")) as {
        dependencies?: Record<string, string>;
      };
      const declared = new Set(Object.keys(pkg.dependencies ?? {}));

      const required = [...formula().matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
      expect(required.length).toBeGreaterThan(0);
      for (const name of required) {
        expect(declared, `formula requires "${name}"`).toContain(name);
      }
    });
  });
});
