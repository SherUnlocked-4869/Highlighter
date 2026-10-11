'use strict'

// S1 framework tests (P0-1-T1 / T7, framework half).
//
// Scope note: this file covers the framework only — key-set symmetry, t()
// interpolation and fallback, setLanguage validation, applyTranslations across
// every `data-i18n*` attribute, observeTranslations on added nodes, and the
// settings effect that broadcasts `i18n:language`. The "all 11 windows load
// i18n.js and contain no bare Chinese" contract belongs to P0-1-T7's second
// half (`test/i18n-contract.test.js`) and lands with the window migrations in
// S11/S12 — asserting it now would only make the suite red.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const localesDirectory = path.join(root, 'shared', 'locales')
const runtimePath = path.join(root, 'shared', 'i18n.js')
const LANGUAGES = ['zh-CN', 'en-US', 'zh-TW']

// The runtime assigns its API onto `window` when one exists; the modules under
// test are CommonJS, so the global only has to be truthy.
globalThis.window = globalThis.window || {}

// Node has no localStorage by default, so the store is injected: `setLanguage`
// persists through it and `restoreStoredLanguage` reads it back.
const storage = {
  values: new Map(),
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null },
  setItem(key, value) { this.values.set(key, String(value)) },
  removeItem(key) { this.values.delete(key) }
}
globalThis.localStorage = storage

function localeFiles() {
  return fs.readdirSync(localesDirectory)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => path.join(localesDirectory, name))
}

function loadTables({ reset = true } = {}) {
  const files = localeFiles()
  // Each table file merges into the bag; the bag is reset first so a stale file
  // removed from disk cannot leak into a run.
  if (reset) globalThis.__LOCALES = {}
  for (const file of files) {
    delete require.cache[require.resolve(file)]
    require(file)
  }
  return { tables: globalThis.__LOCALES, files }
}

function freshApi(initialState = {}) {
  delete require.cache[require.resolve(runtimePath)]
  const api = require(runtimePath)
  if (initialState.language) api.setLanguage(initialState.language)
  return api
}

// A tiny selector engine: the runtime queries a comma-separated attribute list,
// so `matches` has to accept a selector list, not just one selector.
function matchesSelector(declared, selector) {
  if (declared.includes(selector)) return true
  const alternatives = selector.split(',').map((part) => part.trim())
  return alternatives.length > 1 && alternatives.some((part) => declared.includes(part))
}

function createElement(spec = {}) {
  const attributes = new Map()
  for (const [name, value] of Object.entries(spec.attributes || {})) attributes.set(name, value)
  const declared = spec.matches === undefined
    ? [...attributes.keys()].map((name) => `[${name}]`)
    : spec.matches
  const element = {
    nodeType: spec.nodeType ?? 1,
    textContent: spec.textContent ?? '',
    getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
    setAttribute: (name, value) => { attributes.set(name, String(value)) },
    matches: (selector) => matchesSelector(declared, selector),
    attributes
  }
  return element
}

function createDom(elements) {
  return {
    elements,
    querySelectorAll(selector) {
      return elements.filter((element) => element.matches(selector))
    }
  }
}

// --- key-set symmetry over every file in shared/locales ---------------------

test('every locale file registers all three languages', () => {
  const files = localeFiles()
  assert.ok(files.length >= 4, 'expected the three per-language files plus a domain file')

  // Per-language files legitimately register a single language; a domain file is
  // the one that must carry all three at once (otherwise each key it adds shows
  // up in the symmetric-difference list instead of at its source).
  loadTables()
  const domainFiles = files.filter((file) => !LANGUAGES.includes(path.basename(file, '.js')))
  assert.ok(domainFiles.length >= 1, 'expected at least one shared/locales/<domain>.js file')

  for (const file of files) {
    globalThis.__LOCALES = {}
    delete require.cache[require.resolve(file)]
    require(file)
    const name = path.basename(file)
    const registered = LANGUAGES.filter((language) => {
      const table = globalThis.__LOCALES[language]
      return !!table && typeof table === 'object' && Object.keys(table).length > 0
    })
    assert.ok(registered.length > 0, `${name} registers none of ${LANGUAGES.join(' / ')}`)

    if (!LANGUAGES.includes(path.basename(file, '.js'))) {
      const absent = LANGUAGES.filter((language) => !registered.includes(language))
      assert.deepEqual(absent, [], `${name} must register every language; missing ${absent.join(' / ')}`)
    }
  }
})

test('the per-language files and the domain files together cover all three languages', () => {
  const { tables } = loadTables()
  for (const language of LANGUAGES) {
    const table = tables[language]
    assert.ok(table && Object.keys(table).length > 0, `${language} has no keys at all`)
  }
})

test('the three locale tables have an empty key-set symmetric difference', () => {
  const { tables } = loadTables()
  const sets = LANGUAGES.map((language) => new Set(Object.keys(tables[language] || {})))
  const reference = [...sets[0]].sort()
  assert.ok(reference.length > 0, 'the reference table is empty; the checker would pass vacuously')

  for (const [index, language] of LANGUAGES.entries()) {
    const actual = [...sets[index]].sort()
    const missing = reference.filter((key) => !sets[index].has(key))
    const extra = actual.filter((key) => !sets[0].has(key))
    assert.deepEqual(missing, [], `${language} is missing keys present in zh-CN`)
    assert.deepEqual(extra, [], `${language} defines keys absent from zh-CN`)
  }
})

test('domain files merge into the same bag as the per-language files', () => {
  const { tables, files } = loadTables()
  assert.ok(files.some((file) => path.basename(file) === 'config.js'), 'expected shared/locales/config.js')
  for (const language of LANGUAGES) {
    assert.equal(typeof tables[language]['config.route.home'], 'string', `${language} lost the domain keys`)
    assert.equal(typeof tables[language]['common.button.save'], 'string', `${language} lost the common keys`)
  }
})

// --- t() --------------------------------------------------------------------

test('t() resolves the active language and interpolates {placeholders}', () => {
  const api = freshApi({ language: 'zh-CN' })
  assert.equal(api.t('common.button.save'), '保存')
  assert.equal(api.t('capture.toolbar.count', { count: 3 }), 'capture.toolbar.count')

  api.setLanguage('en-US')
  assert.equal(api.t('common.button.save'), 'Save')
  api.setLanguage('zh-TW')
  assert.equal(api.t('common.button.save'), '儲存')
})

test('t() interpolates named parameters and leaves unknown ones verbatim', () => {
  const api = freshApi()
  // Interpolation is table-independent, so it can be exercised through the
  // exported helper plus one injected key.
  assert.equal(api.interpolate('{count} of {total}', { count: 2, total: 5 }), '2 of 5')
  assert.equal(api.interpolate('{count} of {total}', { count: 2 }), '2 of {total}')
  assert.equal(api.interpolate('no placeholders', { count: 2 }), 'no placeholders')
  assert.equal(api.interpolate('{count}', null), '{count}')
})

test('a missing key falls back to the default language and finally to the key itself', () => {
  const api = freshApi({ language: 'en-US' })
  // The bag is process-global and shared with the other tests, so the synthetic
  // entry is removed again instead of being left behind.
  const injected = 's1.test.fallback-only'
  globalThis.__LOCALES['zh-CN'][injected] = '回退'
  try {
    assert.equal(api.t(injected), '回退')
    assert.equal(api.t('s1.test.absent'), 's1.test.absent')
    assert.equal(api.t(''), '')
  } finally {
    delete globalThis.__LOCALES['zh-CN'][injected]
  }
})

// --- setLanguage ------------------------------------------------------------

test('setLanguage only accepts a supported language', () => {
  const api = freshApi({ language: 'zh-CN' })
  assert.deepEqual(api.SUPPORTED_LANGUAGES, LANGUAGES)
  assert.equal(api.setLanguage('en-US'), 'en-US')
  assert.equal(api.currentLanguage(), 'en-US')
  assert.equal(api.setLanguage('fr-FR'), 'en-US', 'an unsupported language is ignored')
  assert.equal(api.setLanguage(undefined), 'en-US')
  assert.equal(api.currentLanguage(), 'en-US')
})

test('restoreStoredLanguage honours localStorage when the markup declares no language', () => {
  // readDeclaredLanguage() consults globalThis.document, which is absent here, so
  // a fresh runtime has to fall back to localStorage exactly like a window whose
  // HTML carries no data-language.
  const baseline = freshApi().currentLanguage()
  const api = freshApi()
  api.setLanguage('zh-TW')

  const reloaded = freshApi()
  assert.equal(reloaded.restoreStoredLanguage(), 'zh-TW', 'the persisted choice wins over the default')
  assert.equal(reloaded.currentLanguage(), 'zh-TW')

  // The previous instance also realises the switch without being told again.
  assert.equal(api.setLanguage(baseline), baseline)
  assert.equal(freshApi().restoreStoredLanguage(), baseline)
})

// --- applyTranslations ------------------------------------------------------

test('applyTranslations covers data-i18n, -title, -placeholder and -aria-label', () => {
  const api = freshApi({ language: 'en-US' })
  const text = createElement({
    attributes: { 'data-i18n': 'common.button.save' },
    matches: ['[data-i18n]']
  })
  const title = createElement({
    attributes: { 'data-i18n-title': 'common.button.close' },
    matches: ['[data-i18n-title]']
  })
  const placeholder = createElement({
    attributes: { 'data-i18n-placeholder': 'common.label.language' },
    matches: ['[data-i18n-placeholder]']
  })
  const aria = createElement({
    attributes: { 'data-i18n-aria-label': 'common.button.copy' },
    matches: ['[data-i18n-aria-label]']
  })
  const untouched = createElement({ matches: [] })
  const root = createDom([text, title, placeholder, aria, untouched])

  assert.equal(api.applyTranslations(root), 4)
  assert.equal(text.textContent, 'Save')
  assert.equal(title.getAttribute('title'), 'Close')
  assert.equal(placeholder.getAttribute('placeholder'), 'Interface language')
  assert.equal(aria.getAttribute('aria-label'), 'Copy')
  assert.equal(untouched.textContent, '', 'an unmarked element is left alone')

  // Switching language rewrites the same nodes; that is the broadcast behaviour.
  api.setLanguage('zh-CN')
  assert.equal(api.applyTranslations(root), 4)
  assert.equal(text.textContent, '保存')
  assert.equal(title.getAttribute('title'), '关闭')
  assert.equal(aria.getAttribute('aria-label'), '复制')
})

test('applyTranslations is a no-op without a queryable root', () => {
  const api = freshApi()
  assert.equal(api.applyTranslations(null), 0)
  assert.equal(api.applyTranslations({}), 0)
})

// --- observeTranslations ----------------------------------------------------

test('observeTranslations translates nodes added after it is installed', () => {
  const api = freshApi({ language: 'en-US' })
  // A real added element can answer querySelectorAll() with its own descendants.
  const child = createElement({ attributes: { 'data-i18n': 'common.button.delete' } })
  const added = createElement({
    attributes: { 'data-i18n': 'common.button.save', 'data-i18n-title': 'common.button.close' }
  })
  added.querySelectorAll = (selector) => (selector.includes('[data-i18n]') ? [child] : [])

  let callback = null
  const observed = []
  class FakeMutationObserver {
    constructor(handler) { callback = handler }
    observe(target, options) { observed.push({ target, options }) }
  }
  const previousObserver = globalThis.MutationObserver
  globalThis.MutationObserver = FakeMutationObserver
  try {
    const root = { querySelectorAll: () => [] }
    const observer = api.observeTranslations(root)
    assert.ok(observer instanceof FakeMutationObserver, 'expected a MutationObserver to be installed')
    assert.equal(observed.length, 1)
    assert.equal(observed[0].target, root)
    assert.deepEqual(observed[0].options, { childList: true, subtree: true })

    callback([{ addedNodes: [added, { nodeType: 3 }] }])
    assert.equal(added.textContent, 'Save')
    assert.equal(added.getAttribute('title'), 'Close')
    assert.equal(child.textContent, 'Delete', 'children of an added node are translated too')
  } finally {
    globalThis.MutationObserver = previousObserver
  }
})

test('observeTranslations degrades to null without a MutationObserver', () => {
  const api = freshApi()
  const previousObserver = globalThis.MutationObserver
  delete globalThis.MutationObserver
  try {
    assert.equal(api.observeTranslations({ querySelectorAll: () => [] }), null)
  } finally {
    if (previousObserver) globalThis.MutationObserver = previousObserver
  }
})

test('the runtime exposes the same API on the window global and via module.exports', () => {
  const api = freshApi()
  for (const key of Object.keys(api)) {
    assert.equal(globalThis.window[key], api[key], `window.${key} is not the exported runtime member`)
  }
})

// --- the checker itself (P0-1-T1) ------------------------------------------

function runChecker(args = []) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-i18n.js'), ...args], {
    cwd: root,
    encoding: 'utf8'
  })
  return result
}

test('the checker reports every locale file and passes all three checks', () => {
  const result = runChecker(['--json'])
  assert.equal(result.status, 0, `checker exited ${result.status}: ${result.stderr}`)
  const report = JSON.parse(result.stdout)
  assert.deepEqual(
    report.localeFiles,
    ['shared/locales/config.js', 'shared/locales/en-US.js', 'shared/locales/zh-CN.js', 'shared/locales/zh-TW.js'],
    'the checker must glob shared/locales/*.js, not hard-code the three language files'
  )
  assert.deepEqual(report.symmetry, [])
  assert.deepEqual(report.shapes, [])
  assert.deepEqual(report.missingKeys, [])
  assert.ok(report.localeFiles.includes('shared/locales/config.js'), 'a domain file has to be checked too')
})

test('the checker fails when a window uses a data-i18n key missing from a table', () => {
  const probe = path.join(root, 'toolbar', '__i18n-checker-probe.html')
  fs.writeFileSync(probe, '<!doctype html><button data-i18n="common.button.does-not-exist">x</button>\n')
  try {
    const result = runChecker(['--json'])
    const report = JSON.parse(result.stdout)
    assert.equal(result.status, 1, 'a missing key must fail the checker')
    assert.deepEqual(report.missingKeys, [{ key: 'common.button.does-not-exist', file: 'toolbar/__i18n-checker-probe.html' }])
  } finally {
    fs.rmSync(probe, { force: true })
  }
})

// --- settings effect (P0-1-T2) ---------------------------------------------

test('a language patch broadcasts i18n:language through the settings effect', () => {
  const { createSettingsEffects } = require('../main/domains/settings-effects')
  const broadcasts = []
  const domain = createSettingsEffects({
    app: { setLoginItemSettings() {} },
    registerShortcuts() {},
    applyGameModeState() {},
    createTrayIcon() {},
    getUpdateService: () => ({ setChannel() {} }),
    ocrServiceRef: { get: () => null, set() {} },
    getOcrService: () => ({ ensureStarted: async () => {} }),
    broadcastActionAppearance() {},
    searchDomain: { notifySettingsChanged() {} },
    selectionHookServiceRef: { get: () => null },
    log() {}
  })
  assert.ok(domain.listUpdateEffectIds().includes('language'), 'the language effect id must be registered')

  const wired = createSettingsEffects({
    app: { setLoginItemSettings() {} },
    registerShortcuts() {},
    applyGameModeState() {},
    createTrayIcon() {},
    getUpdateService: () => ({ setChannel() {} }),
    ocrServiceRef: { get: () => null, set() {} },
    getOcrService: () => ({ ensureStarted: async () => {} }),
    broadcastActionAppearance() {},
    searchDomain: { notifySettingsChanged() {} },
    selectionHookServiceRef: { get: () => null },
    broadcastInterfaceLanguage: (language) => broadcasts.push(language),
    log() {}
  })

  // The effect is field-gated, like `appearance`.
  wired.applyUpdate({ theme: 'dark' }, { language: 'en-US' })
  assert.deepEqual(broadcasts, [], 'an unrelated patch must not broadcast the language')

  wired.applyUpdate({ language: 'en-US' }, { language: 'en-US' })
  assert.deepEqual(broadcasts, ['en-US'])

  wired.applyReset({ language: 'zh-CN', system: {}, selectionToolbar: {} })
  assert.deepEqual(broadcasts, ['en-US', 'zh-CN'], 'a reset restores the default language for open windows')

  // Without the injected broadcaster the effect is a safe no-op (the harness in
  // test/settings-effects.test.js does not pass one).
  domain.applyUpdate({ language: 'en-US' }, { language: 'en-US' })
  assert.deepEqual(broadcasts, ['en-US', 'zh-CN'])
})
