import { describe, it, expect } from "vitest";
import { compareSemver, isStrictSemver } from "../version.js";

describe("isStrictSemver", () => {
  it("accepts only plain X.Y.Z", () => {
    expect(isStrictSemver("0.26.0")).toBe(true);
    expect(isStrictSemver("10.4.123")).toBe(true);
  });

  it("rejects prerelease, build metadata, partial, and non-numeric versions", () => {
    for (const v of ["0.26.0-beta.1", "0.26.0+build", "1.2", "1", "v1.2.3", "latest", ""]) {
      expect(isStrictSemver(v)).toBe(false);
    }
  });
});

describe("compareSemver", () => {
  it("orders plain versions correctly", () => {
    expect(compareSemver("0.9.0", "0.10.0")).toBeLessThan(0);
    expect(compareSemver("1.0.0", "0.26.0")).toBeGreaterThan(0);
    expect(compareSemver("0.26.0", "0.26.0")).toBe(0);
  });

  // Round-3 MEDIUM 4: a prerelease must NOT produce NaN (which broke range/future
  // scans). It compares by its X.Y.Z core instead.
  it("is NaN-proof for prerelease/build suffixes (compares by core)", () => {
    expect(Number.isNaN(compareSemver("0.26.0", "0.26.0-beta.1"))).toBe(false);
    expect(Number.isNaN(compareSemver("0.26.0-beta.1", "0.26.0"))).toBe(false);
    // Same core → equal.
    expect(compareSemver("0.26.0", "0.26.0-beta.1")).toBe(0);
    expect(compareSemver("0.27.0-rc.1", "0.26.0")).toBeGreaterThan(0);
  });

  it("never returns NaN even for garbage input", () => {
    for (const [a, b] of [
      ["", "1.0.0"],
      ["not-a-version", "0.1.0"],
      ["1.x.0", "1.2.0"],
    ] as const) {
      expect(Number.isNaN(compareSemver(a, b))).toBe(false);
      expect(Number.isNaN(compareSemver(b, a))).toBe(false);
    }
  });
});
