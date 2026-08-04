import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { patchConfigFile, ConfigDocumentError } from "../config-document.js";
import { expectPosixMode } from "../test-support/posix-mode.js";

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-config-doc-"));
  configPath = path.join(dir, "config.yaml");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const SAMPLE = `# Jinn configuration
gateway:
  # the port the dashboard is served on
  port: 7777
  host: 127.0.0.1
engines:
  claude:
    bin: claude
`;

describe("patchConfigFile", () => {
  it("changes only the requested keys and keeps comments", () => {
    fs.writeFileSync(configPath, SAMPLE);
    expect(patchConfigFile(configPath, [{ path: ["gateway", "port"], value: 8080 }])).toBe(true);

    const out = fs.readFileSync(configPath, "utf8");
    expect(out).toContain("# Jinn configuration");
    expect(out).toContain("# the port the dashboard is served on");
    expect(out).toContain("port: 8080");
    expect(out).toContain("host: 127.0.0.1");
    expect(out).toContain("bin: claude");
  });

  it("skips undefined entries so callers can build the list unconditionally", () => {
    fs.writeFileSync(configPath, SAMPLE);
    patchConfigFile(configPath, [
      { path: ["gateway", "host"], value: undefined },
      { path: ["gateway", "port"], value: 9000 },
    ]);
    expect(fs.readFileSync(configPath, "utf8")).toContain("host: 127.0.0.1");
  });

  it("does not touch the file when every value already matches", () => {
    // The running gateway watches config.yaml and reloads on write, so a no-op
    // call must not produce one.
    fs.writeFileSync(configPath, SAMPLE);
    const before = fs.statSync(configPath).mtimeMs;
    expect(patchConfigFile(configPath, [{ path: ["gateway", "port"], value: 7777 }])).toBe(false);
    expect(fs.statSync(configPath).mtimeMs).toBe(before);
  });

  it("creates missing intermediate keys", () => {
    fs.writeFileSync(configPath, SAMPLE);
    patchConfigFile(configPath, [{ path: ["portal", "companyName"], value: "Acme" }]);
    expect(fs.readFileSync(configPath, "utf8")).toMatch(/portal:\s*\n\s*companyName: Acme/);
  });

  it("leaves the result owner-only", () => {
    fs.writeFileSync(configPath, SAMPLE, { mode: 0o644 });
    patchConfigFile(configPath, [{ path: ["gateway", "port"], value: 8080 }]);
    expectPosixMode(configPath, 0o600);
  });

  it("reports invalid YAML rather than writing over it", () => {
    fs.writeFileSync(configPath, "gateway:\n  port: 7777\n bad indent: x\n");
    expect(() => patchConfigFile(configPath, [{ path: ["gateway", "port"], value: 1 }]))
      .toThrow(ConfigDocumentError);
    expect(fs.readFileSync(configPath, "utf8")).toContain("bad indent");
  });

  it("carries the fs errno so a caller can tell ENOENT from EACCES", () => {
    try {
      patchConfigFile(path.join(dir, "absent.yaml"), [{ path: ["a"], value: 1 }]);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigDocumentError);
      expect((err as ConfigDocumentError).code).toBe("ENOENT");
    }
  });
});
