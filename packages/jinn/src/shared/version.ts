import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { CONFIG_PATH, TEMPLATE_DIR } from "./paths.js";

/** True only for a plain `X.Y.Z` release version (no prerelease/build suffix). */
export function isStrictSemver(v: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(v);
}

/**
 * Parse the leading numeric `X.Y.Z` core of a version, ignoring any
 * `-prerelease` / `+build` suffix. A non-numeric or missing part reads as 0 so
 * the comparator is TOTAL and never returns NaN — malformed input can't poison
 * a range/marker comparison (see `compareSemver`). Callers that need to reject
 * non-plain versions use `isStrictSemver` at their boundary instead.
 */
function coreParts(v: string): [number, number, number] {
  const core = v.split(/[-+]/, 1)[0]; // drop prerelease/build before splitting
  const p = core.split(".");
  const at = (i: number) => {
    const n = Number.parseInt(p[i] ?? "0", 10);
    return Number.isNaN(n) ? 0 : n;
  };
  return [at(0), at(1), at(2)];
}

/**
 * Compare two semver strings by their `X.Y.Z` core. Returns negative if a < b,
 * 0 if equal, positive if a > b. NaN-proof: any non-numeric part reads as 0, so
 * a prerelease like `0.26.0-beta.1` compares as its core `0.26.0` rather than
 * producing NaN. Strict `X.Y.Z`-only enforcement is the caller's job.
 */
export function compareSemver(a: string, b: string): number {
  const pa = coreParts(a);
  const pb = coreParts(b);
  for (let i = 0; i < 3; i++) {
    const diff = pa[i] - pb[i];
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Read the package version from jinn-cli's package.json. */
export function getPackageVersion(): string {
  const pkgPath = path.join(TEMPLATE_DIR, "..", "package.json");
  return JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version;
}

/** Read the instance version from config.yaml. Returns "0.0.0" if not set. */
export function getInstanceVersion(): string {
  if (!fs.existsSync(CONFIG_PATH)) return "0.0.0";
  try {
    const config = yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as any;
    return config?.jinn?.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
