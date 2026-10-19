'use strict'

// S13 (P0-1-T6) main-process copy migration.
//
// What this file nails down:
//   1. main/services/i18n-bootstrap.js populates globalThis.__LOCALES for the
//      CommonJS main process, including after a caller replaced the bag (the
//      test files that reload shared/locales/* themselves);
//   2. setLanguage() drives those tables, so the tray/update/status/AI copy
//      really changes with the UI language;
//   3. the five migrated modules carry no bare CJK copy any more, while their
//      diagnostic `new Error(...)` text is untouched (decision D6).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const bootstrapPath = path.join(root, 'main', 'services', 'i18n-bootstrap.js')
const { t, setLanguage, currentLanguage, registerLocales, localeFiles } = require(bootstrapPath)

// The migrated modules, plus the reason each one is in scope.
const MIGRATED_FILES = [
  'main/services/tray-menu.js',
  'main/services/update-service.js',
  'main/services/everything-service.js',
  'main/services/ai/client.js',
  'main/services/function-router.js'
]

const LANGUAGES = ['zh-CN', 'en-US', 'zh-TW']

function withLanguage(language, run) {
  const previous = currentLanguage()
  setLanguage(language)
  try {
    return run()
  } finally {
    setLanguage(previous)
  }
}

test('the bootstrap registers every shared/locales file into the process bag', () => {
  // Reset first: the bootstrap has to be able to rebuild the tables a caller
  // threw away, which is exactly what test/i18n.test.js does between its cases.
  globalThis.__LOCALES = {}
  registerLocales()
  const files = localeFiles().map((file) => path.relative(root, file).split(path.sep).join('/'))
  assert.ok(files.includes('shared/locales/main.js'), 'the main-process domain file must be registered')
  for (const language of LANGUAGES) {
    const table = globalThis.__LOCALES[language]
    assert.ok(table && typeof table === 'object', `${language} table is missing`)
    assert.equal(typeof table['main.tray.screenshot'], 'string', `${language} lost the tray keys`)
    // The keys owned by the other per-language/domain files survive the reload.
    assert.equal(typeof table['common.button.save'], 'string', `${language} lost the shared keys`)
  }
})

test('the main-process tables cover all three languages for every main.* key', () => {
  registerLocales()
  const keysOf = (language) => Object.keys(globalThis.__LOCALES[language]).filter((key) => key.startsWith('main.'))
  const reference = keysOf('zh-CN')
  assert.ok(reference.length > 0, 'the main domain defines no keys')
  for (const language of LANGUAGES.slice(1)) {
    const keys = keysOf(language)
    assert.deepEqual(reference.filter((key) => !keys.includes(key)), [], `${language} is missing main.* keys`)
    assert.deepEqual(keys.filter((key) => !reference.includes(key)), [], `${language} defines extra main.* keys`)
  }
})

test('setLanguage switches the tray, update and Everything copy', () => {
  registerLocales()
  withLanguage('zh-CN', () => {
    assert.equal(t('main.tray.game-mode'), '游戏模式')
    assert.equal(t('main.everything.ready'), 'Everything 已就绪')
  })
  withLanguage('en-US', () => {
    assert.equal(t('main.tray.game-mode'), 'Game Mode')
    assert.equal(t('main.everything.ready'), 'Everything is ready')
  })
  withLanguage('zh-TW', () => {
    assert.equal(t('main.tray.game-mode'), '遊戲模式')
    assert.equal(t('main.everything.ready'), 'Everything 已就緒')
  })
})

test('interpolated main.* keys carry the placeholder through every language', () => {
  registerLocales()
  for (const language of LANGUAGES) {
    withLanguage(language, () => {
      const value = t('main.ai.http-status', { status: 503 })
      assert.ok(value.includes('503'), `${language}: placeholder was not interpolated (${value})`)
    })
  }
})

test('the tray menu resolves its 12 labels from the table instead of hard-coding them', () => {
  const { buildTrayMenuTemplate } = require('../main/services/tray-menu')
  registerLocales()
  const template = buildTrayMenuTemplate({
    executeFunction: () => {},
    setGameModeEnabled: () => {},
    openHistory: () => {},
    openMainWindow: () => {},
    showConversation: () => {},
    quit: () => {}
  })
  const labels = template.filter((item) => item.label).map((item) => item.label)
  const expected = withLanguage('zh-CN', () => [
    t('main.tray.screenshot'),
    t('main.tray.screenshot-full-screen'),
    t('main.tray.screenshot-focused-window'),
    t('main.tray.pin-image'),
    t('main.tray.video-record'),
    t('main.tray.local-search'),
    // The clipboard-history entry (main/services/tray-menu.js:69) sits between the
    // local-search and game-mode items; its label is the shared `clipboard.title`
    // key rather than a main.tray one.
    t('clipboard.title'),
    t('main.tray.game-mode'),
    t('main.tray.exit-all-click-through'),
    t('main.tray.show-selection-chat'),
    t('main.tray.capture-history'),
    t('main.tray.show-main-window'),
    t('main.tray.quit')
  ])
  assert.deepEqual(labels, expected)
  // A missing key falls back to the key itself, so this catches an unmigrated
  // or misspelled label without duplicating the table here.
  assert.deepEqual(labels.filter((label) => label.startsWith('main.')), [])
})

test('every main.* key the migrated modules ask for exists in all three tables', () => {
  registerLocales()
  const offenders = []
  for (const relative of MIGRATED_FILES) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8')
    for (const match of source.matchAll(/\bt\(\s*'(main\.[^']+)'/g)) {
      const key = match[1]
      for (const language of LANGUAGES) {
        // t() falls back to the key itself, which is how a typo would reach the
        // UI unnoticed; requiring a string here is the cheap invariant.
        if (typeof globalThis.__LOCALES[language][key] !== 'string') {
          offenders.push(`${relative}: ${language} has no "${key}"`)
        }
      }
    }
  }
  assert.deepEqual(offenders, [])
})

test('no migrated module still ships the copy owned by its own locale keys', () => {
  // A migrated string must live in shared/locales/main.js only. This derives the
  // forbidden text from the table (so it cannot drift) and looks for it in the
  // modules.
  //
  // Tolerated exceptions, each listed here so that adding one is a visible
  // decision rather than an accident: these five keys name an error that the
  // service also raises as a diagnostic, and decision D6 keeps that diagnostic
  // text verbatim — so the zh-CN diagnostic happens to equal the zh-CN UI copy.
  // The displayed `status.message` still goes through t(); only the thrown text
  // is duplicated. Translating the diagnostics in the follow-up release removes
  // them from this list.
  const verbatimDiagnosticMirrors = new Set([
    'main.everything.ipc-mismatch',
    'main.everything.not-installed',
    'main.everything.timeout-index',
    'main.everything.timeout-start',
    'main.everything.unavailable'
  ])
  registerLocales()
  const ownerless = new Set(['main.ai.fallback', 'main.dialog.image-filter', 'main.update.cancelled'])
  const forbidden = []
  for (const [key, value] of Object.entries(globalThis.__LOCALES['zh-CN'])) {
    if (!key.startsWith('main.') || ownerless.has(key) || verbatimDiagnosticMirrors.has(key)) continue
    if (typeof value === 'string' && value.length >= 4 && !value.includes('{')) forbidden.push([key, value])
  }
  assert.ok(forbidden.length >= 25, `expected the main table to carry the migrated copy, saw ${forbidden.length} entries`)

  const offenders = []
  for (const relative of MIGRATED_FILES) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8')
    for (const [key, value] of forbidden) {
      if (source.includes(value)) offenders.push(`${relative} still hard-codes "${key}"`)
    }
    // Inside the tolerated exceptions the migration still has to be visible:
    // the thrown diagnostic may stay, but the module must also reach for the key.
    for (const key of verbatimDiagnosticMirrors) {
      if (source.includes(globalThis.__LOCALES['zh-CN'][key]) && !source.includes(`t('${key}')`)) {
        offenders.push(`${relative} carries "${key}" text without calling t('${key}')`)
      }
    }
  }
  assert.deepEqual(offenders, [])
})

test('the AI connection error keeps its zh-CN wording and its empty-detail fallback', () => {
  const { describeConnectionError } = require('../main/services/ai/client')
  registerLocales()
  withLanguage('zh-CN', () => {
    assert.match(describeConnectionError({ status: 404 }), /接口地址不存在/)
    assert.match(describeConnectionError({ status: 401 }), /API 密钥/)
    assert.match(describeConnectionError({ status: 500, message: 'boom' }), /HTTP 500：boom/)
    // An Error object stringifies with an `Error:` prefix; the previous
    // single-template version stripped it, and so must the table version.
    assert.equal(describeConnectionError({ message: 'Error: socket hang up' }), '连接失败：socket hang up')
    // No upstream detail at all falls back to the guidance text rather than
    // rendering an empty sentence.
    assert.equal(describeConnectionError(undefined), '连接失败：网络请求失败，请检查 API 地址')
    assert.equal(describeConnectionError(''), '连接失败：网络请求失败，请检查 API 地址')
  })
  withLanguage('en-US', () => {
    assert.equal(describeConnectionError(undefined), 'Connection failed: the network request failed. Check the API address')
  })
})

test('main-process diagnostics keep their verbatim Chinese text (decision D6)', () => {
  // The counterweight to the test above: this release deliberately leaves the
  // `throw`/`new Error` text alone, so a later "cleanup" cannot quietly translate
  // it and break test/everything-service.test.js, test/function-router.test.js
  // and the other 430-odd lines of Chinese assertions the plan warns about.
  const expected = [
    { file: 'main/services/everything-service.js', text: 'Everything 组件不存在' },
    { file: 'main/services/everything-service.js', text: 'Everything 组件启动超时' },
    { file: 'main/services/everything-service.js', text: 'Everything 请求超时' },
    { file: 'main/services/everything-service.js', text: 'Everything 组件已停止' },
    { file: 'main/services/function-router.js', text: '未知功能：' },
    { file: 'main/services/update-service.js', text: 'UpdateService requires version and install type' }
  ]
  for (const { file, text } of expected) {
    assert.ok(
      fs.readFileSync(path.join(root, file), 'utf8').includes(text),
      `${file} must keep the diagnostic text "${text}" (D6 defers it to a later release)`
    )
  }
})
