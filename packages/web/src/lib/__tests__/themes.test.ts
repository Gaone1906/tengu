import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { THEMES } from "../themes";

const cssPath = resolve(__dirname, "../../routes/globals.css");
const css = readFileSync(cssPath, "utf8");

function tokenSet(themeId: string): Set<string> {
  const re = new RegExp(`\\[data-theme="${themeId}"\\]\\s*\\{([^}]*)\\}`);
  const match = css.match(re);
  if (!match) throw new Error(`no CSS block for [data-theme="${themeId}"] in ${cssPath}`);
  return new Set(Array.from(match[1].matchAll(/--([a-z0-9-]+)\s*:/g), (m) => m[1]));
}

describe("theme registry", () => {
  const concreteThemes = THEMES.filter((t) => t.id !== "system").map((t) => t.id);

  it("has more than the original dark/light pair", () => {
    expect(concreteThemes.length).toBeGreaterThan(2);
  });

  it("every registered id is unique", () => {
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
  });

  const baseline = tokenSet("dark");

  it("dark defines the baseline token set", () => {
    expect(baseline.size).toBeGreaterThan(20);
  });

  for (const id of concreteThemes) {
    if (id === "dark") continue;
    it(`${id} defines the full required token set`, () => {
      const tokens = tokenSet(id);
      const missing = [...baseline].filter((name) => !tokens.has(name));
      expect(missing).toEqual([]);
    });

    it(`${id} defines no stray tokens outside the registry's set`, () => {
      const tokens = tokenSet(id);
      const extra = [...tokens].filter((name) => !baseline.has(name));
      expect(extra).toEqual([]);
    });
  }
});
