import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { artifactWriter, gatewayToken, pollUntil, sandboxClient, verificationEnv } from './api-client.mjs'
import { authorRequests, canonicalFixtures, scenarioFixtures } from './fixtures.mjs'
import { assertCandidateBaseUrl, isBlockedStaticAsset, matrixCells, positionsMatch, summarizeMetricViolations, visibleRunEdges } from './metrics.mjs'

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
  return ['http:', 'ws:'].includes(url.protocol) && url.hostname === '127.0.0.1' && Number(url.port) >= 7800 && url.port === new URL(origin).port
}

async function isolatedContext(browser: Browser, cell: Cell) {
  const violations: string[] = []
  const context = await browser.newContext({
    viewport: { width: cell.viewport.width, height: cell.viewport.height },
    screen: { width: cell.viewport.width, height: cell.viewport.height },
    deviceScaleFactor: cell.viewport.deviceScaleFactor,
    isMobile: cell.viewport.key === 'mobile',
    hasTouch: cell.viewport.key === 'mobile',
    locale: 'en-US',
    reducedMotion: cell.motion === 'reduced' ? 'reduce' : 'no-preference',
    extraHTTPHeaders: { authorization: `Bearer ${token()}` },
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

async function openPage(browser: Browser, cell: Cell, route: string) {
  const { context, violations } = await isolatedContext(browser, cell)
  const page = await context.newPage()
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('websocket', (socket) => { if (!safeNetworkUrl(socket.url())) violations.push(socket.url()) })
  await page.goto(`${origin}${route}`, { waitUntil: 'networkidle' })
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

function visibleTestId(page: Page, testId: string) {
  return page.locator(`[data-testid="${testId}"]:visible`)
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
  await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2)
  await page.mouse.down()
  await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, { steps: 12 })
  await page.mouse.up()
}

async function dragNodeBy(page: Page, nodeId: string, dx: number, dy: number) {
  const box = await page.getByTestId(`wf-node-${nodeId}`).boundingBox()
  expect(box).not.toBeNull()
  const x = box!.x + box!.width / 2
  const y = box!.y + box!.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 12 })
  await page.mouse.up()
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
          await opened.page.screenshot({ path: screenshotPath(key, `${id}-initial.png`) })

          await opened.page.getByRole('button', { name: 'Tidy', exact: true }).click()
          const apply = opened.page.getByRole('button', { name: 'Apply layout', exact: true })
          await expect(apply).toBeVisible()
          const ids = definition.nodes.map((node) => node.id)
          const preview = await rawNodePositions(opened.page, ids)
          const previewMetrics = await captureMetrics(opened.page, cell.viewport.key)
          const previewViolations = summarizeMetricViolations(previewMetrics, definition)
          write(`metrics/${key}/${id}-tidy-preview.json`, { metrics: previewMetrics, violations: previewViolations })
          await opened.page.screenshot({ path: screenshotPath(key, `${id}-tidy-preview.png`) })

          const positionChanged = !positionsMatch(definition.nodes, preview)
          await apply.click()
          await opened.page.screenshot({ path: screenshotPath(key, `${id}-applied.png`) })
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
          await opened.page.screenshot({ path: screenshotPath(key, `${id}-saved.png`) })

          await opened.page.reload({ waitUntil: 'networkidle' })
          await opened.page.getByTestId('wf-canvas').waitFor()
          expect(await rawNodePositions(opened.page, ids)).toEqual(preview)
          const reloadMetrics = await captureMetrics(opened.page, cell.viewport.key)
          const reloadViolations = summarizeMetricViolations(reloadMetrics, saved)
          write(`metrics/${key}/${id}-reloaded.json`, { metrics: reloadMetrics, violations: reloadViolations })
          await opened.page.screenshot({ path: screenshotPath(key, `${id}-reloaded.png`) })

          await opened.page.goto(`${origin}/workflow/${id}?mode=runs`, { waitUntil: 'networkidle' })
          await expect(opened.page.getByText('No runs yet. Use Run to start the first execution.')).toBeVisible()
          await opened.page.screenshot({ path: screenshotPath(key, `${id}-executions-empty.png`) })
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
        await opened.page.screenshot({ path: screenshotPath(artifactKey(cell), 'verify-manual-before.png') })
        await opened.page.getByRole('button', { name: 'Tidy', exact: true }).click()
        const apply = opened.page.getByRole('button', { name: 'Apply layout', exact: true })
        await expect(apply).toBeVisible()
        const ids = manualFixture.nodes.map((node) => node.id)
        const preview = await rawNodePositions(opened.page, ids)
        await opened.page.screenshot({ path: screenshotPath(artifactKey(cell), 'verify-manual-preview.png') })
        await apply.click()
        await expect(opened.page.getByTestId('wf-edit-dirty')).toBeVisible()
        await opened.page.getByTestId('wf-edit-save').click()
        await expect(opened.page.getByTestId('wf-edit-saved')).toBeVisible()
        const saved = await readDefinition('verify-manual')
        expect(Object.fromEntries(saved.nodes.map((node) => [node.id, node.position]))).toEqual(preview)
        await opened.page.reload({ waitUntil: 'networkidle' })
        await opened.page.getByTestId('wf-canvas').waitFor()
        expect(await rawNodePositions(opened.page, ids)).toEqual(preview)
        await opened.page.screenshot({ path: screenshotPath(artifactKey(cell), 'verify-manual-reloaded.png') })
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
        await opened.page.getByRole('button', { name: 'Fit all', exact: true }).click()
        await dragNodeToNode(opened.page, 'two', 'one')
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
        await opened.page.screenshot({ path: screenshotPath(artifactKey(cell), 'verify-manual-invalid-overlap.png') })
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
            await expect(visibleTestId(opened.page, 'wf-gate-approve')).toBeVisible()
          }
          const definition = await readDefinition(runCase.id)
          const metrics = await captureMetrics(opened.page, cell.viewport.key)
          const violations = summarizeMetricViolations(metrics, {
            ...definition,
            edges: visibleRunEdges(definition, metrics.envelopes),
          })
          const a11y = await basicAccessibility(opened.page)
          write(`metrics/${artifactKey(cell)}/${runCase.id}-${runCase.terminal}.json`, { metrics, violations, a11y, networkViolations: opened.violations, consoleErrors: opened.consoleErrors, pageErrors: opened.pageErrors })
          await opened.page.screenshot({ path: screenshotPath(artifactKey(cell), `${runCase.id}-${runCase.terminal}.png`) })
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
      await opened.page.screenshot({ path: screenshotPath('gestures', '01-added.png') })

      await opened.page.getByRole('button', { name: 'Fit all', exact: true }).click()
      await dragNodeBy(opened.page, addedId, 120, 80)
      await opened.page.getByRole('button', { name: 'Fit all', exact: true }).click()
      await connectByGesture(opened.page, 'two', addedId)
      await expect(opened.page.getByTestId(`wf-edge-two-${addedId}`)).toBeVisible()
      await opened.page.screenshot({ path: screenshotPath('gestures', '02-dragged-connected.png') })

      const beforeTransient = new Set(await mainNodeIds(opened.page))
      await opened.page.getByRole('button', { name: 'Add', exact: true }).click()
      await opened.page.getByRole('menuitem', { name: 'Step', exact: true }).click()
      const transientId = (await mainNodeIds(opened.page)).find((id) => !beforeTransient.has(id))!
      await opened.page.locator('button:visible').filter({ hasText: /^Remove step$/ }).click()
      await expect(opened.page.getByTestId(`wf-node-${transientId}`)).toHaveCount(0)

      await opened.page.getByTestId('wf-edge-e2').click({ force: true })
      await opened.page.keyboard.press('Delete')
      await expect(opened.page.getByTestId('wf-edge-e2')).toHaveCount(0)
      await connectByGesture(opened.page, 'one', 'two')
      await opened.page.screenshot({ path: screenshotPath('gestures', '03-removed-reconnected.png') })

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
      await opened.page.screenshot({ path: screenshotPath('gestures', '04-reloaded.png') })
      write('interactions/gestures.json', { addedId, transientId, position, saved })
      expect(opened.violations).toEqual([])
      expect(opened.pageErrors).toEqual([])
    } finally {
      await opened.context.close()
    }
  })

  test('operator approval resolves durably after parked-state captures', async ({ browser }) => {
    const opened = await openPage(browser, matrixCells()[0], '/workflow/verify-run-approval?mode=runs')
    try {
      await opened.page.getByTestId('wf-node-approve').click()
      await visibleTestId(opened.page, 'wf-gate-approve').click()
      const final = await pollUntil(
        async () => api('GET', '/api/workflow-definitions/verify-run-approval/runs'),
        (response) => response.ok && response.body?.runs?.[0]?.status === 'completed',
        { timeoutMs: 30_000, intervalMs: 250, label: 'approval completion' },
      )
      write('interactions/verify-run-approval-completed.json', final.body)
      await opened.page.reload({ waitUntil: 'networkidle' })
      await expect(opened.page.getByText(/completed/i).first()).toBeVisible()
      expect(opened.violations).toEqual([])
    } finally {
      await opened.context.close()
    }
  })
})
