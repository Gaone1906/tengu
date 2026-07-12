import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import assert from "node:assert/strict"

const script = fs.readFileSync(path.resolve("scripts/verify-workflow-layout.sh"), "utf8")
const bootstrap = fs.readFileSync(path.resolve("e2e/workflow-layout/bootstrap-sandbox.mjs"), "utf8")
const author = fs.readFileSync(path.resolve("e2e/workflow-layout/author-canonical.mjs"), "utf8")
const config = fs.readFileSync(path.resolve("playwright.workflow-layout.config.ts"), "utf8")
const readme = fs.readFileSync(path.resolve("e2e/workflow-layout/README.md"), "utf8")
const browserSpec = fs.readFileSync(path.resolve("e2e/workflow-layout/workflow-layout.spec.ts"), "utf8")

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
  assert.match(bootstrap, /approval\/manager-session\.json/)
  assert.match(browserSpec, /approval\/manager-session\.json/)
  assert.doesNotMatch(browserSpec, /authoring\/sessions\/child-linear-final\.json/)
})

test("five author probes settle sequentially inside the disposable gateway", () => {
  assert.doesNotMatch(author, /Promise\.all/)
  assert.match(author, /for \(const author of authorRequests\(\)\)/)
})

test("daemon auth fallback stays inside the throwaway host Codex home", () => {
  assert.match(script, /CODEX_BASE="\$HOST_HOME\/\.codex"/)
})

test("verification preflights both free bytes and free inodes before creating a sandbox", () => {
  assert.match(script, /preflight/)
  assert.match(script, /JINN_VERIFY_MIN_FREE_BYTES/)
  assert.match(script, /JINN_VERIFY_MIN_FREE_INODES/)
  assert.ok(script.indexOf("preflight") < script.indexOf("mktemp -d"))
})

test("verification defaults to 8060 and refuses both 7777 and non-sandbox targets", () => {
  assert.match(script, /PORT="\$\{JINN_VERIFY_PORT:-8060\}"/)
  assert.match(script, /PORT < 8060/)
  assert.doesNotMatch(script, /:-7800|PORT < 7800/)
  assert.match(script, /\.jinn-workflow-layout-verification/)
  assert.match(script, /refus/i)
})

test("Playwright uses only compact reporters and one bounded artifact root", () => {
  assert.match(config, /\['line'\]/)
  assert.match(config, /bounded-reporter\.mjs/)
  assert.doesNotMatch(config, /\['html'|\['junit'|playwright-html|junit\.xml/)
  assert.match(config, /jinn-workflow-layout-static-artifacts/)
})

test("cleanup is limited to exact paths created beneath the current verification root", () => {
  assert.match(script, /cleanup-run/)
  assert.match(script, /"\$VERIFY_ROOT"/)
  assert.doesNotMatch(script, /find "\$SANDBOX_HOME\/tmp\/codex-homes"/)
  assert.doesNotMatch(script, /\/tmp\/jinn-workflow-layout\.\*/)
})

test("cleanup hard-fails when the candidate listener survives sandbox stop", () => {
  assert.match(script, /listener leak/i)
  assert.match(script, /lsof -nP -iTCP:"\$PORT" -sTCP:LISTEN/)
  assert.ok(script.indexOf("$HELPER\" stop") < script.lastIndexOf("listener leak"))
})

test("each author overlay is removed only after sanitized results and definition are retained", () => {
  assert.match(author, /sanitize/i)
  assert.match(author, /removeAuthorCodexHome/)
  assert.ok(author.lastIndexOf("removeAuthorCodexHome") > author.indexOf("authoring/definitions/"))
})

test("documentation records bounded retention and the confirmed deterministic/full counts", () => {
  assert.match(readme, /111 browser checks/)
  assert.match(readme, /151/)
  assert.match(readme, /64 screenshots/)
  assert.match(readme, /16 MiB/)
  assert.match(readme, /128 MiB/)
})

test("browser evidence captures the unauthorized waiting state", () => {
  assert.match(browserSpec, /unauthorized-waiting\.png/)
})
