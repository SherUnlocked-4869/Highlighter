const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const packageJson = require('../package.json')

test('renderer E2E uses a thin Playwright Electron adapter and isolated per-test roots', () => {
  const config = fs.readFileSync(path.join(root, 'playwright.config.js'), 'utf8')
  const adapter = fs.readFileSync(path.join(root, 'e2e', 'electron-app.js'), 'utf8')
  const fixtures = fs.readFileSync(path.join(root, 'e2e', 'fixtures.js'), 'utf8')
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')

  assert.equal(packageJson.devDependencies['@playwright/test'], '1.62.1')
  assert.match(packageJson.scripts['test:e2e'], /playwright test/)
  assert.match(config, /workers: 1/)
  assert.match(adapter, /_electron: electron/)
  // The sandbox stays on by default; confined automation hosts can opt out for a
  // single run (Chromium's sandbox cannot start there) and must keep the escape
  // hatch explicit and env-gated rather than silently defaulting to off.
  assert.match(adapter, /const noSandbox = process\.env\.HIGHLIGHTER_E2E_NO_SANDBOX === '1'/)
  assert.match(adapter, /chromiumSandbox: !noSandbox/)
  assert.match(adapter, /dialog\.showOpenDialog = async/)
  assert.match(adapter, /dialog\.showSaveDialog = async/)
  assert.match(adapter, /dialog\.showMessageBox = async/)
  assert.match(adapter, /renderer-console|pageerror|page-crash/)
  assert.match(adapter, /render-process-gone/)
  assert.match(adapter, /child-process-gone/)
  assert.match(fixtures, /mkdtempSync/)
  assert.match(fixtures, /fs\.rmSync\(dataRoot/)
  // Throwaway roots default to the OS temp dir but may be relocated inside the
  // checkout when the automation host denies writes outside the repository.
  assert.match(fixtures, /HIGHLIGHTER_E2E_DATA_ROOT_BASE/)
  assert.match(main, /configureE2eEnvironment\(\{ app \}\)[\s\S]*prepareDataRoot/)
  assert.match(main, /if \(!e2eContext\.enabled\) \{[\s\S]*createTrayIcon\(\)[\s\S]*initSelectionHook\(\)/)
})

test('coverage gates pin overall and per-file release thresholds', () => {
  assert.equal(packageJson.devDependencies.c8, '12.0.0')
  assert.match(packageJson.scripts['test:coverage:loaded'], /--lines 85/)
  assert.match(packageJson.scripts['test:coverage:native'], /--per-file --lines 60/)
  assert.match(packageJson.scripts['test:coverage:native'], /ocr-service\.js/)
  assert.match(packageJson.scripts['test:coverage:native'], /long-capture-session\.js/)
  assert.match(packageJson.scripts['test:coverage:critical'], /--per-file --lines 90/)
  assert.match(packageJson.scripts['test:coverage:critical'], /update-service\.js/)
  assert.match(packageJson.scripts['test:coverage:critical'], /diagnostics-service\.js/)
  assert.match(packageJson.scripts['test:coverage:critical'], /window-security\.js/)
})
