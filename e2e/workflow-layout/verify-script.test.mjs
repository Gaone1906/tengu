import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import assert from "node:assert/strict"

const script = fs.readFileSync(path.resolve("scripts/verify-workflow-layout.sh"), "utf8")

test("verification pins node to the pnpm toolchain before invoking the sandbox helper", () => {
  assert.match(script, /JINN_VERIFY_NODE_BIN/)
  assert.match(script, /export PATH="\$NODE_DIR:\$PATH"/)
  assert.ok(script.indexOf("export PATH=\"$NODE_DIR:$PATH\"") < script.indexOf("$HELPER\" create"))
})
