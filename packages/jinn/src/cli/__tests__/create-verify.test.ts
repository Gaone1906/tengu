import { test, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finalizeCreatedInstance, instanceHomeIsPopulated } from "../create.js";

test("empty/half-built home is not considered populated", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-create-"));
  expect(instanceHomeIsPopulated(dir)).toBe(false);
  fs.writeFileSync(path.join(dir, "config.yaml"), "jinn: {}\n");
  expect(instanceHomeIsPopulated(dir)).toBe(true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("finalizes a new instance with its port, portal name, and owner-only gateway token", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-create-finalize-"));
  try {
    fs.writeFileSync(
      path.join(home, "config.yaml"),
      'gateway:\n  port: 7777\n  host: "127.0.0.1"\n  authRequired: true\nportal: {}\n',
    );

    finalizeCreatedInstance(home, "auth-test", 7891);

    const config = fs.readFileSync(path.join(home, "config.yaml"), "utf-8");
    expect(config).toContain("port: 7891");
    expect(config).toContain('portalName: "Auth-test"');

    const gatewayPath = path.join(home, "gateway.json");
    const gateway = JSON.parse(fs.readFileSync(gatewayPath, "utf-8")) as { token?: string };
    expect(gateway.token?.length).toBeGreaterThanOrEqual(32);
    expect(fs.statSync(gatewayPath).mode & 0o777).toBe(0o600);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
