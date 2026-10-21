const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const base = require('@playwright/test')
const { launchHighlighter } = require('./electron-app')

const test = base.test.extend({
  highlighter: async ({}, use, testInfo) => {
    // A normal desktop/CI shell can use the OS temp dir. Confined automation
    // hosts may deny writes outside the repository; HIGHLIGHTER_E2E_DATA_ROOT_BASE
    // lets such a run keep the throwaway data root inside the checkout.
    const dataRootBase = process.env.HIGHLIGHTER_E2E_DATA_ROOT_BASE
      ? path.resolve(process.env.HIGHLIGHTER_E2E_DATA_ROOT_BASE)
      : os.tmpdir()
    fs.mkdirSync(dataRootBase, { recursive: true })
    const dataRoot = fs.mkdtempSync(path.join(dataRootBase, 'highlighter-playwright-'))
    const artifactsDir = testInfo.outputPath('electron-artifacts')
    fs.mkdirSync(artifactsDir, { recursive: true })
    const highlighter = await launchHighlighter({ dataRoot, artifactsDir })
    try {
      await use(highlighter)
    } finally {
      await highlighter.close()
      fs.rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

module.exports = { test, expect: base.expect }
