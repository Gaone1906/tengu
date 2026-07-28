import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

const workflowPath = path.resolve(".github/workflows/publish-npm.yml")

test("publishes jinn-cli from an exact version tag through npm Trusted Publishing", () => {
  assert.equal(fs.existsSync(workflowPath), true, "publish-npm.yml must exist")

  const workflow = fs.readFileSync(workflowPath, "utf8")

  assert.match(workflow, /push:\s*\n\s+tags:\s*\n\s+- ["']v\*["']/)
  assert.doesNotMatch(workflow, /^\s*(pull_request|pull_request_target|workflow_dispatch):/m)
  assert.doesNotMatch(workflow, /^\s*environment:/m)
  assert.match(workflow, /permissions:\s*\n\s+contents: read\s*\n\s+id-token: write/)
  assert.match(workflow, /fetch-depth: 0/)
  assert.match(workflow, /persist-credentials: false/)
  assert.match(workflow, /node-version-file: \.nvmrc/)
  assert.match(workflow, /registry-url: ["']https:\/\/registry\.npmjs\.org["']/)
  assert.match(workflow, /pnpm install --frozen-lockfile/)

  assert.match(workflow, /github\.ref_name/)
  assert.match(workflow, /packages\/jinn\/package\.json/)
  assert.match(workflow, /git\+https:\/\/github\.com\/hristo2612\/jinn\.git/)
  assert.match(workflow, /merge-base --is-ancestor "\$TAGGED_COMMIT" refs\/remotes\/origin\/main/)
  assert.match(workflow, /npm CLI 11\.5\.1 or newer/)

  for (const gate of ["pnpm build", "pnpm test", "pnpm typecheck"]) {
    assert.match(workflow, new RegExp(`run: ${gate.replace(" ", "\\s+")}`))
  }

  assert.match(workflow, /working-directory: packages\/jinn\s*\n\s+run: npm publish/)
  assert.doesNotMatch(workflow, /(NODE_AUTH_TOKEN|NPM_TOKEN|_authToken)/)
})
