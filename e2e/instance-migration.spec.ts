import { expect, test } from "@playwright/test"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { allocateSafeEphemeralServer } from "../scripts/upgrade-lab/run.mjs"

let server: http.Server
let baseUrl: string

test.beforeAll(async () => {
  const webRoot = path.resolve("packages/web/out")
  if (!fs.existsSync(path.join(webRoot, "index.html"))) {
    throw new Error("Build the isolated web fixture first with `pnpm --filter web build`.")
  }
  const createServer = () => http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://fixture.invalid").pathname
    const candidate = path.resolve(webRoot, `.${pathname}`)
    const file = candidate.startsWith(`${webRoot}${path.sep}`) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
      ? candidate
      : path.join(webRoot, "index.html")
    const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html"
    response.writeHead(200, { "Content-Type": type })
    fs.createReadStream(file).pipe(response)
  })
  const allocated = await allocateSafeEphemeralServer(createServer)
  server = allocated.server
  baseUrl = `http://127.0.0.1:${allocated.port}`
})

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

const pending = {
  required: true,
  fromVersion: "0.25.0",
  toVersion: "0.26.0",
  versions: ["0.26.0"],
  changedFiles: [{ path: "CLAUDE.md", operation: "modify" }],
  prompt: "canonical migration prompt\n",
  migrationKey: "e2e-key",
}

for (const fixture of [
  { name: "desktop-light", width: 1440, height: 900, theme: "light" },
  { name: "desktop-dark", width: 1440, height: 900, theme: "dark" },
  { name: "mobile-light", width: 390, height: 844, theme: "light" },
] as const) {
  test(`${fixture.name} migration handoff`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: fixture.width, height: fixture.height })
    await page.addInitScript((theme) => localStorage.setItem("jinn-theme", theme), fixture.theme)
    await page.route("**/api/auth/state", (route) => route.fulfill({ json: { authRequired: false, authenticated: true, canBootstrapLocal: false, networkExposed: false } }))
    await page.route("**/api/instance-migration", (route) => route.fulfill({ json: pending }))
    await page.route("**/api/instance-migration/open", (route) => route.fulfill({ json: { sessionId: "migration-session", reused: false, migrationKey: "e2e-key" } }))
    const response = await page.goto(baseUrl)
    expect(response?.ok()).toBe(true)
    const dialog = page.getByRole("dialog", { name: /v0\.26\.0 is installed/ })
    await expect(dialog).toBeVisible()
    await expect(page.getByRole("button", { name: "Open with COO" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Copy migration prompt" })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`${fixture.name}.png`), fullPage: true })
    await page.getByRole("button", { name: "Later" }).click()
    await expect(page.getByRole("button", { name: "Finish v0.26.0 setup" })).toBeVisible()
  })
}
