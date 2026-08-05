import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gatewayEventsDist = path.resolve(packageRoot, "../gateway-events/dist");
const backupDist = `${gatewayEventsDist}.artifact-test-${process.pid}`;

test("package-local CLI build produces the neutral protocol from a missing dist", () => {
  const hadDist = fs.existsSync(gatewayEventsDist);
  fs.rmSync(backupDist, { recursive: true, force: true });
  if (hadDist) fs.renameSync(gatewayEventsDist, backupDist);

  try {
    const result = spawnSync(process.execPath, ["scripts/build.mjs"], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(fs.existsSync(path.join(gatewayEventsDist, "index.js")));
    assert.ok(fs.existsSync(path.join(gatewayEventsDist, "index.d.ts")));
  } finally {
    fs.rmSync(gatewayEventsDist, { recursive: true, force: true });
    if (hadDist) fs.renameSync(backupDist, gatewayEventsDist);
  }
});

test("embedded gateway protocol runtime matches its exported declarations", async () => {
  const runtimeUrl = pathToFileURL(path.join(packageRoot, "dist", "src", "shared", "gateway-events.js"));
  runtimeUrl.searchParams.set("artifact-test", String(Date.now()));
  const protocol = await import(runtimeUrl.href);

  assert.equal(protocol.GATEWAY_EVENTS.sessionStopped, "session:stopped");
  const frame = { event: "session:stopped", payload: { sessionId: "runtime-consumer" } };
  assert.deepEqual(protocol.decodeGatewayEvent(frame), frame);
  assert.equal(protocol.isGatewayEvent(frame), true);
});
