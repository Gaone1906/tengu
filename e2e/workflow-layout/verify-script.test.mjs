import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import assert from "node:assert/strict"

const script = fs.readFileSync(path.resolve("scripts/verify-workflow-layout.sh"), "utf8")
const bootstrap = fs.readFileSync(path.resolve("e2e/workflow-layout/bootstrap-sandbox.mjs"), "utf8")
const author = fs.readFileSync(path.resolve("e2e/workflow-layout/author-canonical.mjs"), "utf8")

test("verification pins node to the pnpm toolchain before invoking the sandbox helper", () => {
  assert.match(script, /JINN_VERIFY_NODE_BIN/)
  assert.match(script, /export PATH="\$NODE_DIR:\$PATH"/)
  assert.ok(script.indexOf("export PATH=\"$NODE_DIR:$PATH\"") < script.indexOf("$HELPER\" create"))
})

test("sanitized sandbox config retains the required Claude engine mapping", () => {
  assert.match(bootstrap, /engines\s*=\s*\{[\s\S]*claude:\s*\{\}/)
})

test("sandbox seeds a real manager principal for authorized approval browser coverage", () => {
  assert.match(bootstrap, /name === "layout-author-1" \? "manager" : "employee"/)
})

test("five author probes settle sequentially inside the disposable gateway", () => {
  assert.doesNotMatch(author, /Promise\.all/)
  assert.match(author, /for \(const author of authorRequests\(\)\)/)
})

test("daemon auth fallback stays inside the throwaway host Codex home", () => {
  assert.match(script, /CODEX_BASE="\$HOST_HOME\/\.codex"/)
})
