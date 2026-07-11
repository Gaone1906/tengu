import path from 'node:path'
import { defineConfig } from '@playwright/test'
import { assertCandidateBaseUrl } from './e2e/workflow-layout/metrics.mjs'

const baseURL = assertCandidateBaseUrl(process.env.JINN_VERIFY_BASE_URL ?? 'http://127.0.0.1:7800')
const artifacts = process.env.JINN_VERIFY_ARTIFACTS ?? path.join('/tmp', 'jinn-workflow-layout-static-artifacts')

export default defineConfig({
  testDir: './e2e/workflow-layout',
  testMatch: 'workflow-layout.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: path.join(artifacts, 'playwright-results'),
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(artifacts, 'report', 'playwright-html'), open: 'never' }],
    ['junit', { outputFile: path.join(artifacts, 'report', 'junit.xml') }],
  ],
  use: {
    baseURL,
    headless: true,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
})
