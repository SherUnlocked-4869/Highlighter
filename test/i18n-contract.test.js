'use strict'

// P0-1-T7 (S1, batch C): framework-level i18n invariants.
//
// Scope note, deliberately narrow: this file asserts the invariants that hold for
// EVERY window, whatever stage its migration is in —
//   1. a window that loads shared/i18n.js also loads its own domain table
//      (shared/locales/<area>.js), otherwise its t() calls resolve to the key
//      itself and the window silently renders "config.route.home";
//   2. every data-i18n* key a window uses exists in all three tables, otherwise
//      the marked element renders the raw key in one of the languages;
//   3. the three tables have an empty key-set symmetric difference.
//
// It deliberately does NOT assert "all eleven windows are migrated yet": S11/S12
// migrate capture/ and the remaining renderer windows in the same wave, so such a
// test would only be red for work that is still in flight (the un-migrated CJK
// count is scripts/check-i18n.js' job, tightened per batch).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const localesDirectory = path.join(root, 'shared', 'locales')
const LANGUAGES = ['zh-CN', 'en-US', 'zh-TW']

// Every directory that ships a renderer window (plan §10.1). `main` is the main
// process and has no HTML of its own; its copy is a separate stream (S13).
const WINDOW_AREAS = [
  'config', 'capture', 'record', 'long-capture', 'action',
  'search', 'clipboard', 'recognition', 'toolbar', 'pin'
]

function loadTables () {
  globalThis.__LOCALES = {}
  delete require.cache[require.resolve(path.join(root, 'shared', 'i18n.js'))]
  for (const name of fs.readdirSync(localesDirectory).filter((entry) => entry.endsWith('.js')).sort()) {
    const file = path.join(localesDirectory, name)
    delete require.cache[require.resolve(file)]
    require(file)
  }
  const tables = {}
  for (const language of LANGUAGES) tables[language] = globalThis.__LOCALES[language] || {}
  return tables
}

function htmlFiles (directory, out = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) htmlFiles(full, out)
    else if (entry.name.endsWith('.html')) out.push(full)
  }
  return out
}

function windowPages () {
  const pages = []
  for (const area of WINDOW_AREAS) {
    const directory = path.join(root, area)
    if (!fs.existsSync(directory)) continue
    for (const file of htmlFiles(directory)) pages.push({ area, file })
  }
  return pages
}

function relative (file) {
  return path.relative(root, file).split(path.sep).join('/')
}

test('every window that loads the i18n runtime also loads its own domain table', () => {
  const offenders = []
  let migrated = 0
  for (const { area, file } of windowPages()) {
    const html = fs.readFileSync(file, 'utf8')
    if (!html.includes('shared/i18n.js')) continue
    migrated += 1
    // The table has to be reachable from this window: shared/locales/<area>.js
    // (the per-domain layout decision of plan §10.3).
    if (!html.includes(`shared/locales/${area}.js`)) {
      offenders.push(`${relative(file)} loads shared/i18n.js but not shared/locales/${area}.js`)
    }
    if (!fs.existsSync(path.join(localesDirectory, `${area}.js`))) {
      offenders.push(`shared/locales/${area}.js does not exist for ${relative(file)}`)
    }
  }
  assert.deepEqual(offenders, [])
  assert.ok(migrated >= 1, 'at least the settings window is expected to load the runtime')
})

test('every data-i18n key a window uses exists in all three tables', () => {
  const tables = loadTables()
  const missing = []
  for (const { file } of windowPages()) {
    const html = fs.readFileSync(file, 'utf8')
    for (const match of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) {
      const key = match[1]
      for (const language of LANGUAGES) {
        if (!Object.hasOwn(tables[language], key)) missing.push(`${relative(file)} uses "${key}" missing from ${language}`)
      }
    }
  }
  assert.deepEqual(missing, [])
})

test('the three locale tables have an empty key-set symmetric difference', () => {
  const tables = loadTables()
  const reference = Object.keys(tables['zh-CN']).sort()
  assert.ok(reference.length > 0, 'the reference table is empty')
  for (const language of LANGUAGES.slice(1)) {
    const keys = Object.keys(tables[language]).sort()
    assert.deepEqual(reference.filter((key) => !keys.includes(key)), [], `${language} is missing keys present in zh-CN`)
    assert.deepEqual(keys.filter((key) => !reference.includes(key)), [], `${language} defines keys absent from zh-CN`)
  }
})

test('the config window loads its domain table before the runtime and the shell', () => {
  // The settings window is the one this stream owns, so its wiring is pinned here
  // as well as in test/config-routes.test.js: `t()` has to exist before the shell
  // calls it, and the tables cannot be fetched (connect-src 'none').
  const html = fs.readFileSync(path.join(root, 'config', 'config.html'), 'utf8')
  const domain = html.indexOf('shared/locales/config.js')
  const runtime = html.indexOf('shared/i18n.js')
  const shell = html.indexOf('<script src="config.js"></script>')
  assert.ok(domain >= 0, 'config.html loads shared/locales/config.js')
  assert.ok(runtime >= 0, 'config.html loads shared/i18n.js')
  assert.ok(domain < runtime, 'the locale tables load before the runtime')
  assert.ok(runtime < shell, 'the runtime loads before the shell that calls t()')
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'config.html must stay inline-script free')
})

// --- per-window key resolution ----------------------------------------------
//
// A window only sees the locale files its own <script> tags load. Resolving keys
// against the merged bag — which scripts/check-i18n.js and the data-i18n test
// above both do — hides the failure that shipped twice in batch C: the settings
// window consumed `toolbar.action.*` and `search.category.*`, which are defined
// only in domain tables it never loaded, so t() returned the key and the page
// rendered "toolbar.action.copy.label" and "search.category.all" verbatim.
//
// A key reached through a computed argument (t(category.label) over
// DEFAULT_CATEGORIES, t(action.label) over TOOLBAR_ACTION_META) is invisible to a
// plain t('...') scan, so key-shaped string literals count too when the literal's
// first two segments match a real key prefix. A failure means either the window
// is missing a table it needs, or the literal is a data contract that this window
// never resolves — in which case narrow the check rather than the production code.

const KEY_SHAPE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/

function localeKeysByFile () {
  const byFile = new Map()
  const allKeys = new Set()
  for (const name of fs.readdirSync(localesDirectory).filter((entry) => entry.endsWith('.js')).sort()) {
    const file = path.join(localesDirectory, name)
    globalThis.__LOCALES = {}
    delete require.cache[require.resolve(file)]
    require(file)
    const per = {}
    for (const language of LANGUAGES) {
      per[language] = new Set(Object.keys(globalThis.__LOCALES[language] || {}))
      for (const key of per[language]) allKeys.add(key)
    }
    byFile.set(name, per)
  }
  return { byFile, allKeys }
}

function prefixIsDefined (key, allKeys) {
  const segments = key.split('.')
  if (segments.length < 3) return false
  const prefix = `${segments.slice(0, 2).join('.')}.`
  for (const candidate of allKeys) if (candidate.startsWith(prefix)) return true
  return false
}

test('every key a window resolves exists in the tables that window loads', () => {
  const { byFile, allKeys } = localeKeysByFile()
  const offenders = []
  for (const { file } of windowPages()) {
    const html = fs.readFileSync(file, 'utf8')
    if (!html.includes('shared/i18n.js')) continue
    const sources = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1])
    const loaded = sources
      .filter((src) => /shared\/locales\/[A-Za-z-]+\.js$/.test(src))
      .map((src) => path.basename(src))
      .filter((name) => byFile.has(name))
    const table = {}
    for (const language of LANGUAGES) table[language] = new Set()
    for (const name of loaded) {
      for (const language of LANGUAGES) {
        for (const key of byFile.get(name)[language]) table[language].add(key)
      }
    }
    const used = new Map()
    for (const match of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) used.set(match[1], relative(file))
    for (const src of sources) {
      if (/shared\/locales\//.test(src) || /shared\/i18n\.js$/.test(src) || /node_modules\//.test(src)) continue
      const scriptPath = path.resolve(path.dirname(file), src)
      if (!fs.existsSync(scriptPath)) continue
      const code = fs.readFileSync(scriptPath, 'utf8')
      const where = relative(scriptPath)
      for (const match of code.matchAll(/(?<![\w$.])t\(\s*(['"])([^'"]*)\1/g)) {
        if (KEY_SHAPE.test(match[2])) used.set(match[2], where)
      }
      for (const match of code.matchAll(/(['"])([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+)\1/g)) {
        if (KEY_SHAPE.test(match[2]) && prefixIsDefined(match[2], allKeys)) used.set(match[2], `${where} (key literal)`)
      }
    }
    for (const [key, where] of used) {
      const absent = LANGUAGES.filter((language) => !table[language].has(key))
      if (absent.length) {
        offenders.push(`${relative(file)} resolves "${key}" (${where}) but loads no table defining it (loads: ${loaded.join(', ') || 'none'})`)
      }
    }
  }
  assert.deepEqual(offenders, [])
})
