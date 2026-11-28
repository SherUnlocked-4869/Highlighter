// U05 —— docs/reviews/2026-11-26-code-review-and-optimization-report.md section 4.5
//
// The settings window and the main-window lifecycle. These are classic-script/HTML surfaces,
// so the repo's convention applies: read the sources (test/helpers/config-source.js) and pin
// the contract, plus a real locale-table check for the watermark copy. Where the logic lives
// in a testable function (the locale tables) the assertion is behavioural.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { readConfigSource, readConfigShell } = require('./helpers/config-source')

const root = path.join(__dirname, '..')
const shell = readConfigShell()
const configSource = readConfigSource()
const historyRoute = fs.readFileSync(path.join(root, 'config', 'routes', 'history.js'), 'utf8')
const recordingRoute = fs.readFileSync(path.join(root, 'config', 'routes', 'recording.js'), 'utf8')
const translationRoute = fs.readFileSync(path.join(root, 'config', 'routes', 'translation.js'), 'utf8')
const settingsRoute = fs.readFileSync(path.join(root, 'config', 'routes', 'settings.js'), 'utf8')
const modelsProviderRoute = fs.readFileSync(path.join(root, 'config', 'routes', 'models-provider.js'), 'utf8')

function routeDraftReasonTable() {
  const match = /const ROUTE_DRAFT_REASONS = \{([\s\S]*?)\n\}/.exec(shell)
  assert.ok(match, 'ROUTE_DRAFT_REASONS must stay a literal table in the shell')
  const body = match[1]
  const table = {}
  for (const entry of body.matchAll(/(?:'([a-z-]+)'|([a-z-]+)):\s*\[([^\]]*)\]/g)) {
    const route = entry[1] || entry[2]
    table[route] = [...entry[3].matchAll(/'([^']+)'/g)].map((reason) => reason[1])
  }
  return table
}

test('U05: every reported draft reason is registered on its route so it can be cleared', () => {
  const table = routeDraftReasonTable()
  // The models provider form reports this reason; without a matching table entry the shell can
  // never clear it and the main window stays "busy" forever (the reported reclaim leak).
  assert.deepEqual(table.models.includes('models-provider-settings'), true)
  assert.deepEqual(table.models.includes('models-provider-editor'), true)
  assert.match(modelsProviderRoute, /setConfigDirty\?\.\('models-provider-settings', true\)/)
  // The price editors were added to the same mechanism.
  for (const route of ['chat', 'translation', 'usage']) {
    assert.ok(Array.isArray(table[route]) && table[route].length > 0, `${route} has a draft reason`)
  }
})

test('U05: leaving the history route clears the debounced search timer and in-flight renders bail out', () => {
  // The shell calls the page's deactivate hook next to the thumbnail observer teardown.
  assert.match(shell, /if \(currentRoute === 'history' && route !== 'history'\) \{[\s\S]*historyThumbnailObserver = null[\s\S]*historyDeactivate\(\)/)
  // The page owns the timer and clears it.
  assert.match(historyRoute, /function historyDeactivate\(\) \{[\s\S]*clearTimeout\(historySearchTimer\)[\s\S]*historySearchTimer = null/)
  // A render that finishes after navigation must not write into the next route's DOM.
  assert.match(historyRoute, /async function renderHistoryPage\(renderVersion\) \{\s*\n\s*\/\/[\s\S]{0,300}?if \(currentRoute !== 'history'\) return/)
})

test('U05: leaving the recording route cancels a pending audio preflight', () => {
  assert.match(recordingRoute, /function recordingDeactivate\(\) \{[\s\S]*stopRecordingWorkbenchPolling\(\)[\s\S]*cancelRecordingPreflight\(\)/)
  // The preflight really owns cancellation (existing 5 s deadline keeps working as the backstop).
  assert.match(recordingRoute, /function cancelRecordingPreflight\(\) \{/)
})

test('U05: the swap-language button swaps the language pair, not only the text', () => {
  const swap = /getElementById\('swapLanguage'\)\.onclick = \(\) => \{([\s\S]*?)\n  \}/.exec(translationRoute)
  assert.ok(swap, 'the swap handler must stay recognisable')
  const body = swap[1]
  assert.match(body, /getElementById\('sourceText'\)/)
  assert.match(body, /getElementById\('targetLanguage'\)/)
  assert.match(body, /sourceSelect\.value = previousTarget/)
  assert.match(body, /targetSelect\.value = previousSource === 'auto'/)
})

test('U05: the screenshot watermark settings are exposed on the capture tab', () => {
  // Rows.
  assert.match(settingsRoute, /id="watermarkContent"/)
  assert.match(settingsRoute, /id="watermarkOpacity"/)
  assert.match(settingsRoute, /id="watermarkDateSuffix"/)
  // Bindings merge into the stored watermark object, so the fields capture.js owns (colour,
  // spacing, font size, rotation) are never dropped by a settings save.
  assert.match(settingsRoute, /const saveWatermark = \(patch\) => \{[\s\S]*watermark: \{ \.\.\.current, \.\.\.patch \}/)
  assert.match(settingsRoute, /watermarkContent\.onchange = \(\) => saveWatermark\(\{ content: watermarkContent\.value\.trim\(\) \}\)/)
  assert.match(settingsRoute, /watermarkOpacity\.onchange = \(\) => \{[\s\S]*saveWatermark\(\{ opacity: value \}\)/)
  assert.match(settingsRoute, /watermarkDateSuffix\.onclick = \(\) => \{[\s\S]*saveWatermark\(\{ dateSuffix: next \}\)/)
  // The stored default shape the form edits (settings-defaults.js) is unchanged.
  const defaults = fs.readFileSync(path.join(root, 'main', 'services', 'settings-defaults.js'), 'utf8')
  assert.match(defaults, /watermark: \{ content: '', opacity: 80, color: '#ffffff', spacing: 30, fontSize: 24, rotation: 30, dateSuffix: false \}/)
})

test('U05: the watermark copy exists in all three language tables', () => {
  globalThis.__LOCALES = {}
  for (const name of fs.readdirSync(path.join(root, 'shared', 'locales')).filter((entry) => entry.endsWith('.js')).sort()) {
    delete require.cache[require.resolve(path.join(root, 'shared', 'locales', name))]
    require(path.join(root, 'shared', 'locales', name))
  }
  const keys = [
    'config.function-settings.watermark',
    'config.function-settings.watermark-content',
    'config.function-settings.watermark-content-hint',
    'config.function-settings.watermark-opacity',
    'config.function-settings.watermark-date-suffix'
  ]
  for (const key of keys) {
    for (const language of ['zh-CN', 'en-US', 'zh-TW']) {
      const value = globalThis.__LOCALES[language]?.[key]
      assert.equal(typeof value, 'string', `${language} must carry ${key}`)
      assert.ok(value.length > 0, `${key} must not be empty in ${language}`)
    }
    assert.notEqual(globalThis.__LOCALES['zh-CN'][key], globalThis.__LOCALES['en-US'][key], `${key} must be translated`)
  }
  // The form actually uses the keys (no hard-coded copy on the row).
  for (const key of keys.slice(1)) assert.ok(configSource.includes(`'${key}'`), `settings form uses ${key}`)
})
