import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalCwd = process.cwd();
const originalHome = process.env.JINN_HOME;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-relative-home-root-"));
const home = path.join(root, "home");
fs.mkdirSync(home, { recursive: true });

process.chdir(root);
process.env.JINN_HOME = "home";
const publicHome = path.resolve("home");

const { buildGatewayChildEnv } = await import("../lifecycle.js");

afterAll(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.JINN_HOME;
  else process.env.JINN_HOME = originalHome;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("gateway child JINN_HOME identity", () => {
  it("exports the public absolute JINN_HOME plus a canonical identity when the starter used a relative home", () => {
    const env = buildGatewayChildEnv({
      gateway: { port: 7851, host: "127.0.0.1" },
      engines: { default: "claude" },
    } as any);

    expect(env.JINN_HOME).toBe(publicHome);
    expect(env.JINN_HOME).not.toBe("home");
    expect(env.JINN_HOME_IDENTITY).toBe(fs.realpathSync.native(home));
  });
});
