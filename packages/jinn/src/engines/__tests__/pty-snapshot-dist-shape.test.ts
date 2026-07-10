import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Live built-dist regression guard. Vitest's source transform can synthesize
 * named exports from CommonJS packages that plain Node ESM rejects, so this
 * test imports exactly the module shape used during gateway boot.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "../../..");
const distModule = path.join(packageRoot, "dist", "src", "engines", "pty-snapshot.js");

let output = "";

beforeAll(() => {
  if (!existsSync(distModule)) {
    execFileSync("pnpm", ["build"], { cwd: packageRoot, stdio: "ignore", timeout: 180_000 });
  }
  const script = `
const { PtySnapshot } = await import(${JSON.stringify(pathToFileURL(distModule).href)});
const terminal = new PtySnapshot({ cols: 80, rows: 24 });
await terminal.write('built terminal');
const snapshot = await terminal.capture();
terminal.dispose();
process.stdout.write(snapshot.data);
`;
  output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: packageRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
}, 200_000);

describe("PtySnapshot built dist / plain Node ESM shape", () => {
  it("imports the CommonJS xterm runtime and constructs a terminal", () => {
    expect(output).toContain("built terminal");
  });
});
