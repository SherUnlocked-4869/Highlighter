const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const base = require('@playwright/test')
const { launchHighlighter } = require('./electron-app')

const test = base.test.extend({
  highlighter: async ({}, use, testInfo) => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-playwright-'))
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
