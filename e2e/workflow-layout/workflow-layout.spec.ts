import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { artifactWriter, gatewayToken, pollUntil, sandboxClient, verificationEnv } from './api-client.mjs'
import { authorRequests, canonicalFixtures, scenarioFixtures } from './fixtures.mjs'
import { assertCandidateBaseUrl, isBlockedStaticAsset, matrixCells, positionsMatch, summarizeMetricViolations, visibleRunEdges } from './metrics.mjs'
import { shouldCaptureScreenshot } from './harness-policy.mjs'

type Cell = ReturnType<typeof matrixCells>[number]
type Definition = {
  id: string
  nodes: Array<{ id: string; position: { x: number; y: number } }>
  edges?: Array<Record<string, unknown>>
  layout?: { source?: string; version?: number }
  version?: number
}

const env = verificationEnv()
const origin = assertCandidateBaseUrl(env.baseUrl)
const write = artifactWriter(env.artifacts)
let tokenCache: string | undefined
function token() {
  tokenCache ??= gatewayToken(env.home)
  return tokenCache
}
const api = (method: string, route: string, body?: unknown) => sandboxClient({ baseUrl: origin, token: token() })(method, route, body)
const canonicalIds = canonicalFixtures().map((definition) => definition.id)
const authoredIds = process.env.JINN_VERIFY_RUN_AUTHORS === '1' ? authorRequests().map((request) => request.expectedWorkflowId) : []
const staticIds = [...canonicalIds, ...authoredIds, 'verify-new', 'verify-manual']
const runCases = [
  { id: 'verify-run-success', terminal: 'completed' },
  { id: 'verify-run-failure', terminal: 'failed' },
  { id: 'verify-run-approval', terminal: 'parked' },
] as const

function safeNetworkUrl(raw: string) {
  const url = new URL(raw)
  return ['http:', 'ws:'].includes(url.protocol) && url.hostname === '127.0.0.1' && Number(url.port) >= 8060 && url.port === new URL(origin).port
}

type PrincipalHeaders = Record<string, string>

function managerPrincipalHeaders(): PrincipalHeaders {
  const settled = JSON.parse(fs.readFileSync(path.join(env.artifacts, 'authoring/sessions/child-linear-final.json'), 'utf8'))
  const sessionId = settled?.body?.id
  if (typeof sessionId !== 'string' || settled?.body?.employee !== 'layout-author-1') {
    throw new Error('the routed approval manager session did not settle in this sandbox')
  }
  const key = Buffer.from(fs.readFileSync(path.join(env.home, 'secrets/mcp-session-capability.key'), 'utf8').trim(), 'base64url')
  const capability = crypto.createHmac('sha256', key)
    .update('jinn:mcp-session-capability:v1\0', 'utf8')
    .update(sessionId, 'utf8')
    .digest('base64url')
  return {
    'x-jinn-caller-session': sessionId,
    'x-jinn-session-capability': capability,
  }
}

async function isolatedContext(browser: Browser, cell: Cell, principalHeaders: PrincipalHeaders = {}) {
  const violations: string[] = []
  const context = await browser.newContext({
    viewport: { width: cell.viewport.width, height: cell.viewport.height },
    screen: { width: cell.viewport.width, height: cell.viewport.height },
    deviceScaleFactor: cell.viewport.deviceScaleFactor,
    isMobile: cell.viewport.key === 'mobile',
    hasTouch: cell.viewport.key === 'mobile',
    locale: 'en-US',
    reducedMotion: cell.motion === 'reduced' ? 'reduce' : 'no-preference',
    extraHTTPHeaders: { authorization: `Bearer ${token()}`, ...principalHeaders },
  })
  await context.addInitScript(({ theme }) => localStorage.setItem('jinn-theme', theme), { theme: cell.theme })
  await context.route('**/*', async (route) => {
    const raw = route.request().url()
    if (isBlockedStaticAsset(raw)) {
      await route.fulfill({ status: 204, body: '' })
      return
    }
    if (!safeNetworkUrl(raw)) {
      violations.push(raw)
      await route.abort('blockedbyclient')
      return
    }
    await route.continue()
  })
  return { context, violations }
}

const openContexts = new Set<BrowserContext>()

async function openPage(browser: Browser, cell: Cell, route: string, principalHeaders: PrincipalHeaders = {}) {
  const { context, violations } = await isolatedContext(browser, cell, principalHeaders)
  openContexts.add(context)
  context.once('close', () => openContexts.delete(context))
  const page = await context.newPage()
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('websocket', (socket) => { if (!safeNetworkUrl(socket.url())) violations.push(socket.url()) })
  await page.goto(`${origin}${route}`, { waitUntil: 'networkidle' })
  const rendered = await page.locator('body *:visible').count()
  if (rendered === 0) throw new Error(`blank page after navigation: ${route}`)
  return { context, page, violations, consoleErrors, pageErrors }
}

function artifactKey(cell: Cell) {
  return `${cell.theme}/${cell.motion}/${cell.viewport.key}`
}

function screenshotPath(...segments: string[]) {
  const target = path.join(env.artifacts, 'screenshots', ...segments)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  return target
}

async function captureScreenshot(page: Page, ...segments: string[]) {
  const relative = path.join(...segments)
  if (!shouldCaptureScreenshot(relative)) return
  await page.screenshot({ path: screenshotPath(...segments) })
}

function visibleTestId(page: Page, testId: string) {
  return page.locator(`[data-testid="${testId}"]:visible`)
}

function visibleText(page: Page, text: RegExp) {
  return page.getByText(text).filter({ visible: true })
}

async function fitAll(page: Page) {
  await page.getByRole('button', { name: 'Fit all', exact: true }).click()
  // CanvasControls intentionally animates fitView for 300ms. Hit-testing a
  // node mid-transform can target the surface behind its eventual card.
  await page.waitForTimeout(350)
}

async function rawNodePositions(page: Page, ids: string[]) {
  return page.evaluate((wanted) => Object.fromEntries([...document.querySelectorAll<HTMLElement>('.react-flow__node')]
    .map((element) => {
      const id = element.querySelector<HTMLElement>('[data-node-id]')?.dataset.nodeId ?? element.dataset.id
      const match = element.style.transform.match(/translate\(([-+\d.]+)px,\s*([-+\d.]+)px\)/)
      return id && match && wanted.includes(id) ? [id, { x: Number(match[1]), y: Number(match[2]) }] : null
    }).filter((entry): entry is [string, { x: number; y: number }] => Boolean(entry))), ids)
}

async function captureMetrics(page: Page, viewport: string) {
  return page.evaluate(({ viewport }) => {
    const viewportElement = document.querySelector<HTMLElement>('.react-flow__viewport')
    const canvas = document.querySelector<HTMLElement>('[data-testid="wf-canvas"]')
    const transform = viewportElement ? getComputedStyle(viewportElement).transform : 'none'
    const matrix = transform.startsWith('matrix(') ? transform.slice(7, -1).split(',').map(Number) : []
    const zoom = matrix[0] || Number(transform.match(/scale\(([-+\d.eE]+)\)/)?.[1]) || 1
    const visibleRect = (element: Element) => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0
        ? { x: rect.x / zoom, y: rect.y / zoom, right: rect.right / zoom, bottom: rect.bottom / zoom }
        : null
    }
    const envelopes = [...document.querySelectorAll<HTMLElement>('.react-flow__node')].flatMap((root) => {
      const id = root.querySelector<HTMLElement>('[data-node-id]')?.dataset.nodeId ?? root.dataset.id
      if (!id) return []
      const rects = [root, ...root.querySelectorAll('*')].map(visibleRect).filter(Boolean) as Array<{ x: number; y: number; right: number; bottom: number }>
      const x = Math.min(...rects.map((rect) => rect.x))
      const y = Math.min(...rects.map((rect) => rect.y))
      const right = Math.max(...rects.map((rect) => rect.right))
      const bottom = Math.max(...rects.map((rect) => rect.bottom))
      const translate = root.style.transform.match(/translate\(([-+\d.]+)px,\s*([-+\d.]+)px\)/)
      const rank = translate ? Math.round(Number(translate[1]) / 20) : Math.round(x / 20)
      return [{ id, x, y, right, bottom, width: right - x, height: bottom - y, rank }]
    })
    const canvasRect = canvas?.getBoundingClientRect()
    const focus = canvasRect ? envelopes
      .filter((box) => box.x * zoom >= canvasRect.left - 1 && box.right * zoom <= canvasRect.right + 1 && box.y * zoom >= canvasRect.top - 1 && box.bottom * zoom <= canvasRect.bottom + 1)
      .sort((a, b) => Math.abs((a.x + a.right) * zoom / 2 - (canvasRect.left + canvasRect.right) / 2) - Math.abs((b.x + b.right) * zoom / 2 - (canvasRect.left + canvasRect.right) / 2))[0]
      : null
    const clippedLabels = [...document.querySelectorAll<HTMLElement>('[data-node-id] [title]')]
      .filter((element) => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1)
      .map((element) => element.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId ?? 'unknown')
    const scrollable = document.querySelector<HTMLElement>('[data-scrollable]')
    return {
      viewport,
      zoom,
      transform,
      focusNodeId: focus?.id ?? null,
      horizontalBodyOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      clippedLabels: [...new Set(clippedLabels)],
      canvasScrollTop: scrollable?.scrollTop ?? 0,
      scroll: scrollable ? { scrollTop: scrollable.scrollTop, scrollHeight: scrollable.scrollHeight, clientHeight: scrollable.clientHeight } : null,
      direction: canvas ? getComputedStyle(canvas).direction : null,
      envelopes,
    }
  }, { viewport })
}

async function basicAccessibility(page: Page) {
  return page.evaluate(() => ({
    unnamedButtons: [...document.querySelectorAll('button')].filter((button) => !(button.getAttribute('aria-label') || button.textContent?.trim())).length,
    duplicateIds: [...document.querySelectorAll('[id]')].map((element) => element.id).filter((id, index, all) => all.indexOf(id) !== index),
    imagesWithoutAlt: [...document.querySelectorAll('img')].filter((image) => !image.hasAttribute('alt')).length,
  }))
}

async function readDefinition(id: string): Promise<Definition> {
  const response = await api('GET', `/api/workflow-definitions/${encodeURIComponent(id)}`)
  expect(response.ok, JSON.stringify(response.body)).toBeTruthy()
  return response.body as Definition
}

async function resetManualFixture() {
  const before = await readDefinition('verify-manual')
  const fixture = scenarioFixtures().find((item) => item.scenario === 'manual')!.definition
  const response = await api('PUT', '/api/workflow-definitions/verify-manual', {
    nodes: fixture.nodes,
    edges: fixture.edges,
    layoutIntent: 'manual',
    expectedVersion: before.version,
  })
  expect(response.ok, JSON.stringify(response.body)).toBeTruthy()
  return response.body as Definition
}

async function dragNodeToNode(page: Page, sourceId: string, targetId: string) {
  const source = await page.getByTestId(`wf-node-${sourceId}`).boundingBox()
  const target = await page.getByTestId(`wf-node-${targetId}`).boundingBox()
  expect(source).not.toBeNull()
  expect(target).not.toBeNull()
  await dragCoordinates(
    page,
    source!.x + source!.width / 2,
    source!.y + source!.height / 2,
    target!.x + target!.width / 2,
    target!.y + target!.height / 2,
  )
}

async function dragCoordinates(page: Page, fromX: number, fromY: number, toX: number, toY: number) {
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
  if (!coarse) {
    await page.mouse.move(fromX, fromY)
    await page.mouse.down()
    await page.mouse.move(toX, toY, { steps: 12 })
    await page.mouse.up()
    return
  }

  const client = await page.context().newCDPSession(page)
  const touch = (x: number, y: number) => ({ x, y, id: 1, radiusX: 1, radiusY: 1, force: 1 })
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch(fromX, fromY)] })
  await page.waitForTimeout(16)
  for (let step = 1; step <= 12; step += 1) {
    const ratio = step / 12
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [touch(fromX + (toX - fromX) * ratio, fromY + (toY - fromY) * ratio)],
    })
    await page.waitForTimeout(8)
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await client.detach()
}

async function dragNodeBy(page: Page, nodeId: string, dx: number, dy: number) {
  const box = await page.getByTestId(`wf-node-${nodeId}`).boundingBox()
  expect(box).not.toBeNull()
  const x = box!.x + box!.width / 2
  const y = box!.y + box!.height / 2
  await dragCoordinates(page, x, y, x + dx, y + dy)
}

async function connectByGesture(page: Page, from: string, to: string) {
  const source = await page.getByTestId(`wf-handle-out-${from}`).boundingBox()
  const target = await page.getByTestId(`wf-handle-in-${to}`).boundingBox()
  expect(source).not.toBeNull()
  expect(target).not.toBeNull()
  await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2)
  await page.mouse.down()
  await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, { steps: 12 })
  await page.mouse.up()
}

async function selectEdgeByGesture(page: Page, edgeId: string) {
  const edge = page.locator(`.react-flow__edge[data-id="${edgeId}"]`)
  // The edge wrapper is a first-class keyboard target. Selecting with Enter
  // and deleting with Delete proves the accessible destructive gesture path.
  await edge.focus()
  await expect(edge).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(edge).toHaveClass(/selected/)
}

async function mainNodeIds(page: Page) {
  return page.locator('[data-testid^="wf-node-"][data-node-id]').evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.nodeId!))
}

async function startFromUi(browser: Browser, id: string, terminal: string) {
  const cell = matrixCells()[0]
  const opened = await openPage(browser, cell, `/workflow/${id}?mode=runs`)
  try {
    await opened.page.getByRole('button', { name: /^Run$/ }).click()
    const input = opened.page.getByLabel('Run input')
    if (await input.count()) await input.fill('{}')
    await opened.page.getByRole('button', { name: 'Start run' }).click()
    const final = await pollUntil(
      async () => api('GET', `/api/workflow-definitions/${encodeURIComponent(id)}/runs`),
      (response) => response.ok && response.body?.runs?.[0]?.status === terminal,
      { timeoutMs: 30_000, intervalMs: 250, label: `${id} ${terminal}` },
    )
    write(`interactions/${id}-${terminal}.json`, final.body)
    expect(opened.violations).toEqual([])
  } finally {
    await opened.context.close()
  }
}

test.describe.serial('isolated workflow layout verification', () => {
  test.afterEach(async () => {
    if (openContexts.size === 0) return
    const leaked = [...openContexts]
    await Promise.allSettled(leaked.map((context) => context.close()))
    throw new Error(`listener leak: ${leaked.length} browser context(s) remained open after a check`)
  })

  test('candidate health and fixtures are sandbox-local', async () => {
    const status = await api('GET', '/api/status')
    expect(status.ok).toBeTruthy()
    expect(status.body?.port).toBe(Number(new URL(origin).port))
    for (const id of staticIds.concat(runCases.map((run) => run.id))) await readDefinition(id)
  })

  for (const runCase of runCases) {
    test(`starts ${runCase.id} from the product and reaches ${runCase.terminal}`, async ({ browser }) => {
      await startFromUi(browser, runCase.id, runCase.terminal)
    })
  }

  for (const cell of matrixCells()) {
    for (const id of staticIds) {
      test(`${id} ${artifactKey(cell)} covers initial, Tidy, Apply, Save, reload, and empty runs`, async ({ browser }) => {
        const opened = await openPage(browser, cell, `/workflow/${id}?mode=edit`)
        try {
          await opened.page.getByTestId('wf-canvas').waitFor()
          await opened.page.locator('.react-flow__node').first().waitFor()
          const definition = await readDefinition(id)
          const initialMetrics = await captureMetrics(opened.page, cell.viewport.key)
          const initialViolations = summarizeMetricViolations(initialMetrics, definition)
          const a11y = await basicAccessibility(opened.page)
          const key = artifactKey(cell)
          write(`metrics/${key}/${id}-initial.json`, { metrics: initialMetrics, violations: initialViolations, a11y, networkViolations: opened.violations, consoleErrors: opened.consoleErrors, pageErrors: opened.pageErrors })
          await captureScreenshot(opened.page, key, `${id}-initial.png`)

          await opened.page.getByRole('button', { name: 'Tidy', exact: true }).click()
          const apply = opened.page.getByRole('button', { name: 'Apply layout', exact: true })
          await expect(apply).toBeVisible()
          const ids = definition.nodes.map((node) => node.id)
          const preview = await rawNodePositions(opened.page, ids)
          const previewMetrics = await captureMetrics(opened.page, cell.viewport.key)
          const previewViolations = summarizeMetricViolations(previewMetrics, definition)
          write(`metrics/${key}/${id}-tidy-preview.json`, { metrics: previewMetrics, violations: previewViolations })
          await captureScreenshot(opened.page, key, `${id}-tidy-preview.png`)

          const positionChanged = !positionsMatch(definition.nodes, preview)
          await apply.click()
          await captureScreenshot(opened.page, key, `${id}-applied.png`)
          let saved = definition
          if (positionChanged) {
            await expect(opened.page.getByTestId('wf-edit-dirty')).toBeVisible()
            await opened.page.getByTestId('wf-edit-save').click()
            await expect(opened.page.getByTestId('wf-edit-saved')).toBeVisible()
            saved = await readDefinition(id)
            expect(saved.layout?.source).toBe('manual')
            expect(Object.fromEntries(saved.nodes.map((node) => [node.id, node.position]))).toEqual(preview)
          } else {
            await expect(opened.page.getByTestId('wf-edit-dirty')).toHaveCount(0)
            expect(Object.fromEntries(saved.nodes.map((node) => [node.id, node.position]))).toEqual(preview)
          }
          await captureScreenshot(opened.page, key, `${id}-saved.png`)

          await opened.page.reload({ waitUntil: 'networkidle' })
          await opened.page.getByTestId('wf-canvas').waitFor()
          expect(await rawNodePositions(opened.page, ids)).toEqual(preview)
          const reloadMetrics = await captureMetrics(opened.page, cell.viewport.key)
          const reloadViolations = summarizeMetricViolations(reloadMetrics, saved)
          write(`metrics/${key}/${id}-reloaded.json`, { metrics: reloadMetrics, violations: reloadViolations })
          await captureScreenshot(opened.page, key, `${id}-reloaded.png`)

          await opened.page.goto(`${origin}/workflow/${id}?mode=runs`, { waitUntil: 'networkidle' })
          await expect(opened.page.getByText('No runs yet. Use Run to start the first execution.')).toBeVisible()
          await captureScreenshot(opened.page, key, `${id}-executions-empty.png`)
          write(`interactions/lifecycle/${key}/${id}.json`, { preview, savedVersion: saved.version })

          expect(opened.violations).toEqual([])
          expect(opened.pageErrors).toEqual([])
          expect(opened.consoleErrors).toEqual([])
          expect(initialMetrics.direction).toBe('ltr')
          for (const violations of [initialViolations, previewViolations, reloadViolations]) {
            expect(violations.overlap).toEqual([])
            expect(violations.strictLtr).toEqual([])
            expect(violations.vertical).toEqual([])
            expect(violations.readability).toEqual([])
          }
          expect(a11y.unnamedButtons).toBe(0)
          expect(a11y.duplicateIds).toEqual([])
          expect(a11y.imagesWithoutAlt).toBe(0)
        } finally {
          await opened.context.close()
        }
      })
    }

    test(`manual Apply and reload persists at ${artifactKey(cell)}`, async ({ browser }) => {
      const manualFixture = scenarioFixtures().find((fixture) => fixture.scenario === 'manual')!.definition
      const reset = await resetManualFixture()
      const opened = await openPage(browser, cell, '/workflow/verify-manual?mode=edit')
      try {
        await opened.page.getByTestId('wf-canvas').waitFor()
        await captureScreenshot(opened.page, artifactKey(cell), 'verify-manual-before.png')
        await opened.page.getByRole('button', { name: 'Tidy', exact: true }).click()
        const apply = opened.page.getByRole('button', { name: 'Apply layout', exact: true })
        await expect(apply).toBeVisible()
        const ids = manualFixture.nodes.map((node) => node.id)
        const preview = await rawNodePositions(opened.page, ids)
        await captureScreenshot(opened.page, artifactKey(cell), 'verify-manual-preview.png')
        await apply.click()
        await expect(opened.page.getByTestId('wf-edit-dirty')).toBeVisible()
        await opened.page.getByTestId('wf-edit-save').click()
        await expect(opened.page.getByTestId('wf-edit-saved')).toBeVisible()
        const saved = await readDefinition('verify-manual')
        expect(Object.fromEntries(saved.nodes.map((node) => [node.id, node.position]))).toEqual(preview)
        await opened.page.reload({ waitUntil: 'networkidle' })
        await opened.page.getByTestId('wf-canvas').waitFor()
        expect(await rawNodePositions(opened.page, ids)).toEqual(preview)
        await captureScreenshot(opened.page, artifactKey(cell), 'verify-manual-reloaded.png')
        write(`interactions/apply/${artifactKey(cell)}.json`, { reset, preview, saved })
        expect(opened.violations).toEqual([])
      } finally {
        await opened.context.close()
      }
    })

    test(`overlapping manual drag is rejected visibly at ${artifactKey(cell)}`, async ({ browser }) => {
      const reset = await resetManualFixture()
      const opened = await openPage(browser, cell, '/workflow/verify-manual?mode=edit')
      try {
        await opened.page.getByTestId('wf-canvas').waitFor()
        await fitAll(opened.page)
        const beforeDrag = await rawNodePositions(opened.page, ['two'])
        await dragNodeToNode(opened.page, 'two', 'one')
        const afterDrag = await rawNodePositions(opened.page, ['two'])
        expect(afterDrag.two, 'drag gesture must move the node before save validation').not.toEqual(beforeDrag.two)
        await expect(opened.page.getByTestId('wf-edit-dirty')).toBeVisible()
        await opened.page.getByTestId('wf-edit-save').click()
        const error = opened.page.getByTestId('wf-edit-save-error')
        await expect(error).toBeVisible()
        await expect(error).toContainText('Tidy')
        await expect(error).toContainText('one')
        await expect(error).toContainText('two')
        const persisted = await readDefinition('verify-manual')
        expect(persisted.version).toBe(reset.version)
        expect(persisted.nodes.map((node) => node.position)).toEqual(reset.nodes.map((node) => node.position))
        await captureScreenshot(opened.page, artifactKey(cell), 'verify-manual-invalid-overlap.png')
        write(`interactions/invalid/${artifactKey(cell)}.json`, { error: await error.textContent(), persisted })
        expect(opened.violations).toEqual([])
        expect(opened.pageErrors).toEqual([])
      } finally {
        await opened.context.close()
      }
    })

    for (const runCase of runCases) {
      test(`${runCase.id} state ${artifactKey(cell)}`, async ({ browser }) => {
        const opened = await openPage(browser, cell, `/workflow/${runCase.id}?mode=runs`)
        try {
          await opened.page.getByTestId('wf-canvas').waitFor()
          if (runCase.terminal === 'parked') {
            await opened.page.getByTestId('wf-node-approve').click()
            await expect(visibleTestId(opened.page, 'wf-gate-approve')).toHaveCount(0)
            await expect(visibleTestId(opened.page, 'wf-gate-reject')).toHaveCount(0)
            await expect(visibleText(opened.page, /Waiting on layout-author-1/i)).toBeVisible()
            await expect(visibleText(opened.page, /ask the routed owner to escalate/i)).toBeVisible()
          }
          const definition = await readDefinition(runCase.id)
          const metrics = await captureMetrics(opened.page, cell.viewport.key)
          const violations = summarizeMetricViolations(metrics, {
            ...definition,
            edges: visibleRunEdges(definition, metrics.envelopes),
          })
          const a11y = await basicAccessibility(opened.page)
          write(`metrics/${artifactKey(cell)}/${runCase.id}-${runCase.terminal}.json`, { metrics, violations, a11y, networkViolations: opened.violations, consoleErrors: opened.consoleErrors, pageErrors: opened.pageErrors })
          await captureScreenshot(opened.page, artifactKey(cell), `${runCase.id}-${runCase.terminal}.png`)
          expect(opened.violations).toEqual([])
          expect(opened.pageErrors).toEqual([])
          expect(opened.consoleErrors).toEqual([])
          expect(metrics.direction).toBe('ltr')
          expect(violations.overlap).toEqual([])
          expect(violations.strictLtr).toEqual([])
          expect(violations.vertical).toEqual([])
          expect(violations.readability).toEqual([])
          expect(a11y.unnamedButtons).toBe(0)
          expect(a11y.duplicateIds).toEqual([])
          expect(a11y.imagesWithoutAlt).toBe(0)
        } finally {
          await opened.context.close()
        }
      })
    }
  }

  test('editor gestures add, drag, connect, remove edge/node, save, and reload', async ({ browser }) => {
    await resetManualFixture()
    const cell = matrixCells().find((candidate) => candidate.viewport.key === 'desktop' && candidate.theme === 'dark' && candidate.motion === 'normal')!
    const opened = await openPage(browser, cell, '/workflow/verify-manual?mode=edit')
    try {
      await opened.page.getByTestId('wf-canvas').waitFor()
      const originalIds = new Set(await mainNodeIds(opened.page))
      await opened.page.getByRole('button', { name: 'Add', exact: true }).click()
      await opened.page.getByRole('menuitem', { name: 'Step', exact: true }).click()
      await expect(opened.page.locator('[data-testid^="wf-node-"][data-node-id]')).toHaveCount(originalIds.size + 1)
      const addedId = (await mainNodeIds(opened.page)).find((id) => !originalIds.has(id))!
      await captureScreenshot(opened.page, 'gestures', '01-added.png')

      await fitAll(opened.page)
      await dragNodeBy(opened.page, addedId, 120, 80)
      await fitAll(opened.page)
      await connectByGesture(opened.page, 'two', addedId)
      await expect(opened.page.getByTestId(`wf-edge-two-${addedId}`)).toBeVisible()
      await captureScreenshot(opened.page, 'gestures', '02-dragged-connected.png')

      const beforeTransient = new Set(await mainNodeIds(opened.page))
      await opened.page.getByRole('button', { name: 'Add', exact: true }).click()
      await opened.page.getByRole('menuitem', { name: 'Step', exact: true }).click()
      const transientId = (await mainNodeIds(opened.page)).find((id) => !beforeTransient.has(id))!
      await opened.page.locator('button:visible').filter({ hasText: /^Remove step$/ }).click()
      await expect(opened.page.getByTestId(`wf-node-${transientId}`)).toHaveCount(0)

      await fitAll(opened.page)
      await selectEdgeByGesture(opened.page, 'e2')
      await opened.page.keyboard.press('Delete')
      await expect(opened.page.getByTestId('wf-edge-e2')).toHaveCount(0)
      await connectByGesture(opened.page, 'one', 'two')
      await captureScreenshot(opened.page, 'gestures', '03-removed-reconnected.png')

      const position = (await rawNodePositions(opened.page, [addedId]))[addedId]
      await opened.page.getByTestId('wf-edit-save').click()
      await expect(opened.page.getByTestId('wf-edit-saved')).toBeVisible()
      const saved = await readDefinition('verify-manual')
      expect(saved.nodes.some((node) => node.id === addedId)).toBeTruthy()
      expect(saved.nodes.some((node) => node.id === transientId)).toBeFalsy()
      expect(saved.edges?.some((edge) => edge.id === 'e2')).toBeFalsy()
      expect(saved.edges?.some((edge) => edge.from === 'one' && edge.to === 'two')).toBeTruthy()
      expect(saved.edges?.some((edge) => edge.from === 'two' && edge.to === addedId)).toBeTruthy()
      await opened.page.reload({ waitUntil: 'networkidle' })
      await opened.page.getByTestId('wf-canvas').waitFor()
      expect((await rawNodePositions(opened.page, [addedId]))[addedId]).toEqual(position)
      await captureScreenshot(opened.page, 'gestures', '04-reloaded.png')
      write('interactions/gestures.json', { addedId, transientId, position, saved })
      expect(opened.violations).toEqual([])
      expect(opened.pageErrors).toEqual([])
    } finally {
      await opened.context.close()
    }
  })

  test('unauthorized approval stays visible and durably parked without active controls', async ({ browser }) => {
    // Own the parked run this assertion addresses. That keeps the proof valid
    // under --grep and prevents it from silently targeting an earlier run.
    await startFromUi(browser, 'verify-run-approval', 'parked')
    const opened = await openPage(browser, matrixCells()[0], '/workflow/verify-run-approval?mode=runs')
    try {
      await opened.page.getByTestId('wf-node-approve').click()
      await expect(visibleTestId(opened.page, 'wf-gate-approve')).toHaveCount(0)
      await expect(visibleTestId(opened.page, 'wf-gate-reject')).toHaveCount(0)
      await expect(visibleText(opened.page, /Waiting on layout-author-1/i)).toBeVisible()
      await expect(visibleText(opened.page, /ask the routed owner to escalate/i)).toBeVisible()
      await captureScreenshot(opened.page, 'approval', 'unauthorized-waiting.png')
      const parked = await api('GET', '/api/workflow-definitions/verify-run-approval/runs')
      expect(parked.body?.runs?.[0]?.status).toBe('parked')
      const forbidden = await api(
        'POST',
        `/api/workflow-definitions/verify-run-approval/runs/${encodeURIComponent(parked.body.runs[0].runId)}/resolve-gate`,
        { decision: 'approve' },
      )
      expect(forbidden.status).toBe(403)
      write('interactions/verify-run-approval-denied.json', { response: forbidden.body, runs: parked.body })
      await opened.page.reload({ waitUntil: 'networkidle' })
      await opened.page.getByTestId('wf-node-approve').click()
      await expect(opened.page.getByText(/awaiting human approval/i).first()).toBeVisible()
      expect(opened.violations).toEqual([])
    } finally {
      await opened.context.close()
    }
  })

  test('routed manager sees approval controls and can resume the parked run', async ({ browser }) => {
    await startFromUi(browser, 'verify-run-approval', 'parked')
    const opened = await openPage(
      browser,
      matrixCells()[0],
      '/workflow/verify-run-approval?mode=runs',
      managerPrincipalHeaders(),
    )
    try {
      await opened.page.getByTestId('wf-node-approve').click()
      await expect(visibleTestId(opened.page, 'wf-gate-approve')).toBeVisible()
      await expect(visibleTestId(opened.page, 'wf-gate-reject')).toBeVisible()
      await visibleTestId(opened.page, 'wf-gate-approve').click()
      const completed = await pollUntil(
        async () => api('GET', '/api/workflow-definitions/verify-run-approval/runs'),
        (response) => response.ok && response.body?.runs?.[0]?.status === 'completed',
        { timeoutMs: 30_000, intervalMs: 250, label: 'authorized approval completion' },
      )
      await expect(visibleText(opened.page, /^completed$/i)).toBeVisible()
      await expect(visibleTestId(opened.page, 'wf-gate-approve')).toHaveCount(0)
      write('interactions/verify-run-approval-authorized.json', completed.body)
      await captureScreenshot(opened.page, 'approval', 'authorized-completed.png')
      expect(opened.violations).toEqual([])
      expect(opened.pageErrors).toEqual([])
    } finally {
      await opened.context.close()
    }
  })
})
