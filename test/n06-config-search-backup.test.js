'use strict'

// N06 — docs/reviews/2026-11-26-code-review-and-optimization-report.md section 5.6:
// the settings-window global search (Ctrl+K) and the optional-password single-file
// `.hlbackup.zip` backup archive.
//
// The two halves are tested differently on purpose:
//   * the search index + matcher are pure data/functions, so they are driven
//     behaviourally (route coverage, multi-word AND, ranking, locale keys);
//   * the archive service is exercised against temporary directories with the
//     REAL data-root backup service, so the encrypted round-trip, the tamper
//     detection and the manifest compatibility are real files, not mocks;
//   * the UI/IPC half is pinned with source assertions plus a fake secure facade,
//     which is the repo convention for classic-script windows.

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const vm = require('node:vm')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const AdmZip = require('adm-zip')

const ROOT = path.join(__dirname, '..')
const LANGUAGES = ['zh-CN', 'en-US', 'zh-TW']

const search = require('../config/routes/settings-search')
const archive = require('../main/services/encrypted-backup')
const backup = require('../main/services/data-root-backup')
const { registerDataRootIpc, ARCHIVE_CHANNELS } = require('../main/ipc/data-root-ipc')
const { buildIpcPolicies } = require('../main/services/ipc-security')
const { readConfigSource } = require('./helpers/config-source')

const html = fs.readFileSync(path.join(ROOT, 'config', 'config.html'), 'utf8')
const css = fs.readFileSync(path.join(ROOT, 'config', 'config.css'), 'utf8')
const shell = fs.readFileSync(path.join(ROOT, 'config', 'config.js'), 'utf8')
const settingsSource = fs.readFileSync(path.join(ROOT, 'config', 'routes', 'settings.js'), 'utf8')
const searchSource = fs.readFileSync(path.join(ROOT, 'config', 'routes', 'settings-search.js'), 'utf8')
const preloadSource = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8')
const dataRootIpcSource = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'data-root-ipc.js'), 'utf8')
const ipcSecuritySource = fs.readFileSync(path.join(ROOT, 'main', 'services', 'ipc-security.js'), 'utf8')
const configSource = readConfigSource()

const CONFIG_ROUTES = [
  'home', 'translation', 'chat', 'history', 'recording', 'device-battery',
  'selection-toolbar', 'local-search', 'clipboard-history', 'usage',
  'settings-general', 'settings-function', 'models', 'settings-system', 'about'
]

function loadLocaleTables () {
  globalThis.__LOCALES = {}
  const directory = path.join(ROOT, 'shared', 'locales')
  for (const name of fs.readdirSync(directory).filter((entry) => entry.endsWith('.js')).sort()) {
    const file = path.join(directory, name)
    delete require.cache[require.resolve(file)]
    require(file)
  }
  const tables = {}
  for (const language of LANGUAGES) tables[language] = globalThis.__LOCALES[language] || {}
  return tables
}

async function temporaryRoot (t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'highlighter-n06-'))
  t.after(() => fsp.rm(directory, { recursive: true, force: true }))
  return directory
}

async function writeFile (filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, value)
}

async function writeJson (filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

async function exists (filePath) {
  return fsp.lstat(filePath).then(() => true, () => false)
}

// Minimal data root with the two cheapest modules: a history image plus a
// settings snapshot that carries a credential (the archive must still redact it,
// because that work stays in data-root-backup.js).
async function createFixture (t) {
  const parent = await temporaryRoot(t)
  const dataRoot = path.join(parent, 'data-root')
  await writeFile(path.join(dataRoot, 'history', 'capture.png'), 'png-bytes')
  await writeJson(path.join(dataRoot, 'config', 'config.json'), {
    credentials: { apiKey: 'sk-must-be-redacted', providerApiKeys: { openai: 'sk-provider' } },
    settings: { screenshot: { historyDirectory: path.join(dataRoot, 'history') } }
  })
  return {
    parent,
    dataRoot,
    tmpRoot: path.join(parent, 'archive-tmp'),
    output: path.join(parent, 'out', 'backup.hlbackup.zip')
  }
}

async function exportFixture (fixture, options = {}) {
  const result = await archive.exportArchive({
    dataRoot: fixture.dataRoot,
    modules: ['history', 'settings'],
    version: '5.0.1',
    outputPath: fixture.output,
    tmpRoot: fixture.tmpRoot,
    now: Date.parse('2026-11-26T10:00:00Z'),
    ...options
  })
  assert.equal(result.ok, true, `archive export failed: ${result.code} ${result.message}`)
  return result
}

function readZip (filePath) {
  return new AdmZip(fs.readFileSync(filePath))
}

function readDescriptor (zip) {
  return JSON.parse(zip.getEntry(archive.ARCHIVE_DESCRIPTOR).getData().toString('utf8'))
}

async function listDirectory (directory) {
  return fsp.readdir(directory).catch(() => [])
}

// ---------------------------------------------------------------------------
// A. Global settings search: index, matcher, wiring
// ---------------------------------------------------------------------------

test('N06: the search index covers all 15 config routes and their sub-tabs', () => {
  const index = search.SETTINGS_SEARCH_INDEX
  assert.ok(Array.isArray(index) && index.length >= 80, `expected a substantial index, got ${index.length}`)
  const routes = [...new Set(index.map((entry) => entry.route))].sort()
  assert.deepEqual(routes, CONFIG_ROUTES.slice().sort(), 'every config route is searchable')
  // Sub-tabs the report calls out explicitly: function settings, models, home,
  // recording. Each is activated by clicking the route's own tab button.
  const tabs = new Set(index.filter((entry) => entry.tab).map((entry) => `${entry.route}:${entry.tab}`))
  for (const expected of [
    'home:screenshot', 'home:ai', 'home:shortcuts',
    'settings-function:capture', 'settings-function:ocr', 'settings-function:record',
    'models:providers', 'models:features', 'models:defaults',
    'recording:recent', 'recording:all'
  ]) {
    assert.ok(tabs.has(expected), `missing sub-tab entry ${expected}`)
  }
  // Every schema field the report names is present on at least one entry.
  assert.ok(index.every((entry) => typeof entry.key === 'string' && Object.hasOwn(search.ROUTE_SEARCH_KEYS, entry.route)))
  assert.ok(index.every((entry) => Array.isArray(entry.keywords)))
  assert.ok(index.some((entry) => entry.sectionId), 'section anchors are indexed')
  assert.ok(index.some((entry) => entry.target), 'focus targets are indexed')
})

test('N06: index keywords are locale keys and carry no hardcoded Chinese', () => {
  const tables = loadLocaleTables()
  assert.deepEqual(Object.keys(search.ROUTE_SEARCH_KEYS).sort(), CONFIG_ROUTES.slice().sort())
  for (const entry of search.SETTINGS_SEARCH_INDEX) {
    assert.equal(typeof tables['zh-CN'][entry.key], 'string', `zh-CN missing ${entry.key}`)
    for (const language of LANGUAGES) {
      assert.equal(typeof tables[language][entry.key], 'string', `${language} missing ${entry.key}`)
      if (entry.tabKey) assert.equal(typeof tables[language][entry.tabKey], 'string', `${language} missing ${entry.tabKey}`)
    }
    for (const keyword of entry.keywords) {
      assert.doesNotMatch(keyword, /[\u4e00-\u9fff]/, `keyword "${keyword}" hardcodes Chinese`)
      if (keyword.includes('.')) {
        for (const language of LANGUAGES) {
          assert.equal(typeof tables[language][keyword], 'string', `${language} is missing keyword key ${keyword}`)
        }
      } else {
        assert.match(keyword, /^[a-z0-9][a-z0-9+#._ -]*$/i, `plain keyword "${keyword}" must be an ASCII search token`)
      }
    }
  }
  for (const key of Object.values(search.ROUTE_SEARCH_KEYS)) {
    for (const language of LANGUAGES) assert.equal(typeof tables[language][key], 'string', `${language} missing ${key}`)
  }
})

test('N06: searchSettings is case-insensitive and ANDs whitespace-separated words', () => {
  const translate = (key) => ({
    'config.route.home': 'Quick functions',
    'config.label.backup': 'Backup archive',
    'config.label.password': 'Master password',
    'config.label.theme': 'Appearance theme',
    'config.label.watermark': 'Screenshot watermark',
    'config.kw.copy': 'copy to clipboard'
  })[key] || key
  const entries = search.resolveSettingsSearchIndex([
    { route: 'home', key: 'config.label.backup', keywords: ['config.kw.copy'] },
    { route: 'home', key: 'config.label.password', keywords: ['config.label.backup'] },
    { route: 'home', key: 'config.label.theme', keywords: [] },
    { route: 'home', key: 'config.label.watermark', keywords: [] }
  ], translate)

  assert.equal(search.searchSettings(entries, '').length, 0)
  assert.equal(search.searchSettings(entries, '   ').length, 0)
  const backup = search.searchSettings(entries, 'BACKUP').map((entry) => entry.key)
  assert.deepEqual(backup, ['config.label.backup', 'config.label.password'])
  const theme = search.searchSettings(entries, 'Theme').map((entry) => entry.key)
  assert.deepEqual(theme, ['config.label.theme'])
  // Multi-word AND: both tokens must hit the same entry.
  assert.deepEqual(search.searchSettings(entries, 'backup password').map((entry) => entry.key), ['config.label.password'])
  assert.deepEqual(search.searchSettings(entries, 'backup zzzzz').map((entry) => entry.key), [])
  // Plain ASCII alias tokens are searchable too ("copy to clipboard" phrasing).
  assert.deepEqual(search.searchSettings(entries, 'clipboard').map((entry) => entry.key), ['config.label.backup'])
  // A raw (unresolved) index entry still matches its own key names.
  const raw = search.searchSettings(search.SETTINGS_SEARCH_INDEX, 'backup-archive')
  assert.ok(raw.length > 0, 'searchSettings works on the raw index without t()')
  assert.ok(raw.every((entry) => entry.key.includes('backup-archive') || entry.keywords.some((keyword) => keyword.includes('backup-archive'))))
})

test('N06: searchSettings ranks an earlier/label hit above a keyword hit', () => {
  const translate = (key) => ({
    'config.route.settings-system': 'System and data',
    'config.label.backup-archive': 'Backup archive',
    'config.label.history': 'Screenshot history',
    'config.other.backup': 'Backup destination'
  })[key] || key
  const entries = search.resolveSettingsSearchIndex([
    // Label hit at position 0.
    { route: 'settings-system', key: 'config.label.backup-archive', keywords: [] },
    // Only keyword hit: the label itself says nothing about backups.
    { route: 'settings-system', key: 'config.label.history', keywords: ['config.other.backup'] }
  ], translate)
  const ranked = search.searchSettings(entries, 'backup')
  assert.deepEqual(ranked.map((entry) => entry.key), ['config.label.backup-archive', 'config.label.history'])
  assert.ok(ranked[0].score < ranked[1].score, 'label hit has the lower (better) score')
})

test('N06: the real index finds settings in Chinese and English via t()', () => {
  const tables = loadLocaleTables()
  const cases = [
    ['zh-CN', '备份', 'config.settings-system.backup-archive-section'],
    ['zh-CN', '主题', 'config.appearance.theme'],
    ['zh-CN', '翻译提示', 'config.selection-toolbar.translate-prompt'],
    ['en-US', 'backup', 'config.settings-system.backup-archive-section'],
    ['en-US', 'theme', 'config.appearance.theme'],
    ['en-US', 'update', 'config.about.update-section']
  ]
  for (const [language, query, expectedKey] of cases) {
    const resolved = search.resolveSettingsSearchIndex(search.SETTINGS_SEARCH_INDEX, (key) => tables[language][key] ?? key)
    const keys = search.searchSettings(resolved, query).map((entry) => entry.key)
    assert.ok(keys.includes(expectedKey), `${language} query "${query}" did not reach ${expectedKey}`)
  }
})

test('N06: resolveSettingsSearchIndex translates keywords at search time (no baked copy)', () => {
  const translate = (key) => `T(${key})`
  const resolved = search.resolveSettingsSearchIndex([
    { route: 'settings-general', tab: 'defaults', tabKey: 'config.models.tab-defaults', key: 'config.label.theme', keywords: ['config.label.theme-hint', 'scrypt'] }
  ], translate)
  assert.equal(resolved.length, 1)
  assert.equal(resolved[0].label, 'T(config.label.theme)')
  assert.equal(resolved[0].routeLabel, 'T(config.route.settings-general)')
  assert.equal(resolved[0].tabLabel, 'T(config.models.tab-defaults)')
  const texts = resolved[0].terms.map((term) => term.text)
  assert.ok(texts.includes('T(config.label.theme-hint)'), 'keyword keys go through translate()')
  assert.ok(texts.includes('scrypt'), 'plain tokens are kept verbatim')
  // The index itself stays raw data: no resolved sentences, no terms cache.
  for (const entry of search.SETTINGS_SEARCH_INDEX) {
    assert.equal(entry.terms, undefined, 'the index must not cache resolved terms')
    assert.equal(entry.label, undefined, 'the index must not cache resolved labels')
  }
})

test('N06: every indexed target exists in the settings-window sources', () => {
  const tabAttribute = search.TAB_ATTRIBUTE_BY_ROUTE
  for (const entry of search.SETTINGS_SEARCH_INDEX) {
    if (entry.tab) {
      const attribute = tabAttribute[entry.route]
      assert.ok(attribute, `${entry.route} has no tab attribute mapping`)
      assert.ok(configSource.includes(`'${entry.tab}'`) || configSource.includes(`"${entry.tab}"`),
        `tab value "${entry.tab}" is not produced by ${entry.route}`)
    }
    if (entry.target) {
      if (entry.target.startsWith('[')) {
        const value = /^\[[^=]+="([^"]+)"\]$/.exec(entry.target)?.[1]
        assert.ok(value, `${entry.target} is not a supported attribute selector`)
        assert.ok(configSource.includes(`'${value}'`) || configSource.includes(`"${value}"`),
          `attribute target ${entry.target} is not rendered by the settings window`)
      } else {
        assert.ok(configSource.includes(`id="${entry.target}"`), `target #${entry.target} is missing from the settings window`)
      }
    }
  }
})

test('N06: the sidebar exposes the search box and Ctrl+K is wired to the pure matcher', () => {
  assert.match(html, /id="settingsSearchInput"/)
  assert.match(html, /id="settingsSearchResults"[^>]*role="listbox"/)
  assert.match(html, /routes\/settings-search\.js/)
  assert.match(html, /data-i18n-placeholder="config\.search\.placeholder"/)
  // Ctrl+K focuses the input, arrows move, Enter opens, Escape closes.
  assert.match(searchSource, /ctrlKey \|\| event\.metaKey/)
  assert.match(searchSource, /event\.key === 'k' \|\| event\.key === 'K'/)
  assert.match(searchSource, /event\.key === 'ArrowDown'[\s\S]*event\.key === 'ArrowUp'[\s\S]*event\.key === 'Enter'[\s\S]*event\.key === 'Escape'/)
  // Click-through: navigate(route), activate the tab, focus/scroll the target and
  // add the short-lived highlight class (reduced-motion aware).
  assert.match(searchSource, /async function openSearchResult/)
  assert.match(searchSource, /typeof navigate === 'function'\) navigate\(entry\.route\)/)
  assert.match(searchSource, /scrollIntoView\(\{ block: 'center'/)
  assert.match(searchSource, /classList\.add\(HIGHLIGHT_CLASS\)/)
  assert.match(searchSource, /prefers-reduced-motion: reduce/)
  assert.match(css, /\.search-hit\{animation:search-hit-pulse/)
  assert.match(css, /\.search-results\{position:absolute/)
  // The shell boots the wiring and refreshes the resolved labels on a language
  // switch through the module's published namespace.
  assert.match(shell, /window\.settingsSearch\?\.initSettingsSearch\?\.\(\)/)
  assert.match(shell, /window\.settingsSearch\?\.refreshSettingsSearchLanguage\?\.\(\)/)
})

// Regression (real-device verification, 2026-11-28): the module is UMD, so its
// functions only exist on `window.settingsSearch`. The shell used to call bare
// `initSettingsSearch()` / `refreshSettingsSearchLanguage()` guarded by
// `typeof ... === 'function'`; both names were undefined, the guards silently
// skipped the wiring and Ctrl+K did nothing on a real install. Load the file the
// way the window does (classic script, no `module`) and resolve the exact calls
// the shell makes, so producer and consumer cannot drift apart again.
test('N06: the published search namespace resolves every call the shell makes', () => {
  const browserGlobal = { console, setTimeout, clearTimeout }
  browserGlobal.globalThis = browserGlobal
  browserGlobal.window = browserGlobal
  vm.createContext(browserGlobal)
  vm.runInContext(searchSource, browserGlobal, { filename: 'settings-search.js' })

  assert.equal(typeof browserGlobal.settingsSearch, 'object', 'the browser branch publishes window.settingsSearch')
  assert.equal(typeof browserGlobal.settingsSearch.initSettingsSearch, 'function')
  assert.equal(typeof browserGlobal.settingsSearch.refreshSettingsSearchLanguage, 'function')

  // Every `window.settingsSearch?.<name>(...)` access in the shell must resolve
  // on the API the window actually publishes.
  const shellCalls = [...shell.matchAll(/window\.settingsSearch\?\.([A-Za-z_$][\w$]*)\?\.\(/g)].map((match) => match[1])
  assert.ok(shellCalls.length >= 2, 'the shell still boots the search wiring')
  for (const name of shellCalls) {
    assert.equal(typeof browserGlobal.settingsSearch[name], 'function', `window.settingsSearch.${name} must exist`)
  }
  // The old bare-global form must not come back: it is what shipped broken.
  assert.doesNotMatch(shell, /typeof initSettingsSearch === 'function'/)
})

test('N06: the Ctrl+K wiring renders results, navigates and highlights the target (DOM stub)', async () => {
  // A minimal DOM harness: enough to execute the browser half of
  // routes/settings-search.js, which the source assertions above cannot catch.
  function createElement (tagName = 'div') {
    const listeners = new Map()
    const attributes = new Map()
    const children = []
    return {
      tagName: tagName.toUpperCase(),
      id: '',
      className: '',
      type: '',
      textContent: '',
      hidden: false,
      value: '',
      dataset: {},
      children,
      focused: false,
      scrolled: false,
      listeners,
      classList: {
        set: new Set(),
        add (name) { this.set.add(name) },
        remove (name) { this.set.delete(name) },
        toggle (name, force) {
          if (force === undefined) {
            if (this.set.has(name)) this.set.delete(name)
            else this.set.add(name)
          } else if (force) this.set.add(name)
          else this.set.delete(name)
        },
        contains (name) { return this.set.has(name) }
      },
      addEventListener (type, handler) { listeners.set(type, handler) },
      setAttribute (name, value) { attributes.set(name, String(value)) },
      getAttribute (name) { return attributes.has(name) ? attributes.get(name) : null },
      removeAttribute (name) { attributes.delete(name) },
      hasAttribute (name) { return attributes.has(name) },
      focus () { this.focused = true },
      select () {},
      blur () { this.focused = false },
      scrollIntoView () { this.scrolled = true },
      append (...nodes) { children.push(...nodes) },
      replaceChildren (...nodes) { children.length = 0; children.push(...nodes) },
      contains (node) { return node === this || children.includes(node) },
      querySelectorAll (selector) {
        if (selector === '[data-search-result]') return children.filter((child) => Object.hasOwn(child.dataset, 'searchResult'))
        return []
      }
    }
  }

  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    navigate: globalThis.navigate,
    t: globalThis.t
  }
  const input = createElement('input')
  input.id = 'settingsSearchInput'
  const panel = createElement('div')
  panel.id = 'settingsSearchResults'
  panel.hidden = true
  const section = createElement('div')
  section.setAttribute('data-section', 'backup-archive')
  const targets = new Map([
    ['exportBackupArchive', createElement('button')],
    ['backupArchivePassword', createElement('input')]
  ])
  const documentListeners = new Map()
  const document = {
    getElementById: (id) => (id === 'settingsSearchInput' ? input : id === 'settingsSearchResults' ? panel : targets.get(id) || null),
    querySelector: (selector) => {
      const match = /^\[data-section="([^"]+)"\]$/.exec(selector)
      if (match) return match[1] === 'backup-archive' ? section : null
      return null
    },
    querySelectorAll: () => [],
    createElement: (tagName) => createElement(tagName),
    addEventListener: (type, handler) => documentListeners.set(type, handler)
  }
  const navigated = []
  globalThis.document = document
  globalThis.window = {
    setTimeout: (handler) => { handler(); return 0 },
    matchMedia: () => ({ matches: true })
  }
  globalThis.navigate = (route) => navigated.push(route)
  globalThis.t = (key) => key
  try {
    const instance = search.initSettingsSearch()
    assert.ok(instance, 'initSettingsSearch wires the sidebar markup')
    assert.equal(panel.hidden, true)

    // Ctrl+K focuses and opens the panel, typing filters through the real index.
    documentListeners.get('keydown')({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, key: 'k', preventDefault () {} })
    assert.equal(input.focused, true)
    input.value = 'backup'
    input.listeners.get('input')({})
    assert.equal(panel.hidden, false, 'the result panel opens for a non-empty query')
    assert.ok(panel.children.length > 0, 'the real search index produced results')

    // Escape closes the panel and clears the in-memory query.
    input.listeners.get('keydown')({ key: 'Escape', preventDefault () {} })
    assert.equal(panel.hidden, true)
    assert.equal(input.value, '')

    // Click-through: navigate(route) first, then scroll/focus/highlight the field.
    const target = targets.get('exportBackupArchive')
    const navigatedOk = await search.openSearchResult({
      route: 'settings-system',
      target: 'exportBackupArchive',
      key: 'config.settings-system.backup-archive-export',
      label: 'Export',
      terms: [{ text: 'export', kind: 'label' }],
      order: 0
    })
    assert.equal(navigatedOk, true)
    assert.deepEqual(navigated, ['settings-system'])
    assert.equal(target.scrolled, true)
    assert.equal(target.focused, true)
    assert.equal(target.classList.contains(search.HIGHLIGHT_CLASS), false, 'the highlight is removed after the timeout')
  } finally {
    search.initSettingsSearch.instance = null
    if (previous.document === undefined) delete globalThis.document
    else globalThis.document = previous.document
    if (previous.window === undefined) delete globalThis.window
    else globalThis.window = previous.window
    if (previous.navigate === undefined) delete globalThis.navigate
    else globalThis.navigate = previous.navigate
    if (previous.t === undefined) delete globalThis.t
    else globalThis.t = previous.t
  }
})

// ---------------------------------------------------------------------------
// B. Single-file encrypted backups: crypto round-trip, tamper, compatibility
// ---------------------------------------------------------------------------

test('N06: an encrypted archive round-trips through scrypt + AES-256-GCM', async (t) => {
  const fixture = await createFixture(t)
  const password = 'correct horse battery staple'
  const exported = await exportFixture(fixture, { password })

  assert.equal(exported.encrypted, true)
  assert.equal(exported.extension, archive.ARCHIVE_EXTENSION)
  assert.equal(exported.formatVersion, archive.ARCHIVE_FORMAT_VERSION)
  assert.ok(await exists(fixture.output), 'the single output file exists')
  const files = await fsp.readdir(path.dirname(fixture.output))
  assert.deepEqual(files, ['backup.hlbackup.zip'], 'one single file, no sidecar key material')
  assert.deepEqual(await listDirectory(fixture.tmpRoot), [], 'no temp package is left behind')

  const zip = readZip(fixture.output)
  assert.deepEqual(zip.getEntries().map((entry) => entry.entryName).sort(), [archive.ARCHIVE_DESCRIPTOR, archive.ENCRYPTED_PAYLOAD_ENTRY].sort())
  const descriptor = readDescriptor(zip)
  assert.equal(descriptor.format, archive.ARCHIVE_FORMAT)
  assert.equal(descriptor.encrypted, true)
  assert.equal(descriptor.encryption.algorithm, 'aes-256-gcm')
  assert.equal(descriptor.encryption.keyDerivation, 'scrypt')
  assert.equal(descriptor.encryption.keyLength, 32)
  assert.equal(Buffer.from(descriptor.encryption.salt, 'base64').length, archive.SALT_BYTES)
  assert.equal(Buffer.from(descriptor.encryption.iv, 'base64').length, archive.IV_BYTES)
  assert.equal(Buffer.from(descriptor.encryption.authTag, 'base64').length, archive.AUTH_TAG_BYTES)
  const payload = zip.getEntry(archive.ENCRYPTED_PAYLOAD_ENTRY).getData()
  assert.doesNotMatch(payload.toString('latin1'), /modules\.json|highlighter-backup/,
    'the encrypted payload does not leak the plaintext zip structure')

  const inspected = await archive.inspectArchive({
    archivePath: fixture.output,
    password,
    tmpRoot: fixture.tmpRoot
  })
  try {
    assert.equal(inspected.ok, true, `${inspected.code} ${inspected.message}`)
    assert.equal(inspected.encrypted, true)
    assert.equal(inspected.inspection.ok, true)
    assert.deepEqual(inspected.inspection.moduleOrder, ['history', 'settings'])
    assert.ok(await exists(path.join(inspected.directory, backup.MANIFEST_FILE)))
    assert.ok(await exists(path.join(inspected.directory, backup.MARKER_FILE)))
    // The settings module is still the redacted snapshot the D04 service wrote.
    const settingsConfig = JSON.parse(await fsp.readFile(path.join(inspected.directory, 'modules', 'settings', 'config.json'), 'utf8'))
    assert.doesNotMatch(JSON.stringify(settingsConfig), /sk-must-be-redacted|sk-provider/)
  } finally {
    await inspected.cleanup()
  }
  assert.deepEqual(await listDirectory(fixture.tmpRoot), [], 'inspection temp directory is removable and gone')
})

test('N06: a wrong password is rejected with a clear code and leaves no temp extraction', async (t) => {
  const fixture = await createFixture(t)
  await exportFixture(fixture, { password: 'right-password' })
  const result = await archive.inspectArchive({ archivePath: fixture.output, password: 'wrong-password', tmpRoot: fixture.tmpRoot })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'decrypt-failed')
  assert.match(result.message, /password is wrong|modified/)
  assert.doesNotMatch(JSON.stringify(result), /wrong-password|right-password/, 'the password is never echoed back')
  assert.deepEqual(await listDirectory(fixture.tmpRoot), [], 'no half-extracted directory survives a rejected password')
})

test('N06: tampering with the auth tag or ciphertext is detected', async (t) => {
  const fixture = await createFixture(t)
  await exportFixture(fixture, { password: 'tamper-check' })

  const zip = readZip(fixture.output)
  const descriptorEntry = zip.getEntry(archive.ARCHIVE_DESCRIPTOR)
  const descriptor = JSON.parse(descriptorEntry.getData().toString('utf8'))
  const tag = Buffer.from(descriptor.encryption.authTag, 'base64')
  tag[0] ^= 0xff
  descriptor.encryption.authTag = tag.toString('base64')
  zip.updateFile(descriptorEntry, Buffer.from(JSON.stringify(descriptor, null, 2), 'utf8'))
  await fsp.writeFile(fixture.output, zip.toBuffer())

  const tampered = await archive.inspectArchive({ archivePath: fixture.output, password: 'tamper-check', tmpRoot: fixture.tmpRoot })
  assert.equal(tampered.ok, false)
  assert.equal(tampered.code, 'decrypt-failed')
  assert.deepEqual(await listDirectory(fixture.tmpRoot), [], 'tampered archive produces no temp directory')

  // Same for a flipped ciphertext bit, rebuilt from a clean export.
  const cleanOutput = path.join(fixture.parent, 'clean.hlbackup.zip')
  const exported = await exportFixture(fixture, { password: 'tamper-check', outputPath: cleanOutput })
  assert.equal(exported.ok, true)
  const cipherZip = readZip(cleanOutput)
  const payloadEntry = cipherZip.getEntry(archive.ENCRYPTED_PAYLOAD_ENTRY)
  const ciphertext = payloadEntry.getData()
  ciphertext[Math.min(10, ciphertext.length - 1)] ^= 0x01
  cipherZip.updateFile(payloadEntry, ciphertext)
  const corrupted = path.join(fixture.parent, 'corrupted.hlbackup.zip')
  await fsp.writeFile(corrupted, cipherZip.toBuffer())
  const corruptedResult = await archive.inspectArchive({ archivePath: corrupted, password: 'tamper-check', tmpRoot: fixture.tmpRoot })
  assert.equal(corruptedResult.ok, false)
  assert.equal(corruptedResult.code, 'decrypt-failed')
})

test('N06: a password-less archive stays a single plain zip whose manifest matches modules.json', async (t) => {
  const fixture = await createFixture(t)
  const exported = await exportFixture(fixture)
  assert.equal(exported.encrypted, false)

  const zip = readZip(fixture.output)
  const names = zip.getEntries().map((entry) => entry.entryName)
  for (const expected of [archive.ARCHIVE_DESCRIPTOR, backup.MARKER_FILE, backup.MANIFEST_FILE]) {
    assert.ok(names.includes(expected), `plain archive carries ${expected}`)
  }
  const descriptor = readDescriptor(zip)
  assert.equal(descriptor.encrypted, false)
  assert.equal(descriptor.backup.format, backup.BACKUP_FORMAT)

  // The zip entry IS the existing manifest: same format marker, same per-file
  // sha256 list, same format version. No second manifest shape is introduced.
  const manifest = JSON.parse(zip.getEntry(backup.MANIFEST_FILE).getData().toString('utf8'))
  assert.equal(manifest.format, backup.BACKUP_FORMAT)
  assert.equal(manifest.formatVersion, backup.BACKUP_FORMAT_VERSION)
  assert.match(manifest.checksum, /^[a-f0-9]{64}$/)
  assert.deepEqual(Object.keys(manifest.modules).sort(), ['history', 'settings'])
  for (const entry of Object.values(manifest.modules)) {
    for (const file of entry.files) {
      assert.equal(typeof file.path, 'string')
      assert.match(file.sha256, /^[a-f0-9]{64}$/)
      assert.equal(typeof file.size, 'number')
    }
  }
  const marker = JSON.parse(zip.getEntry(backup.MARKER_FILE).getData().toString('utf8'))
  assert.equal(marker.format, backup.BACKUP_FORMAT)

  let inspectedDirectory = ''
  let inspectOptions = null
  const inspected = await archive.inspectArchive({
    archivePath: fixture.output,
    tmpRoot: fixture.tmpRoot,
    inspectBackup: async (directory, options) => {
      inspectedDirectory = directory
      inspectOptions = options
      return backup.inspectBackup(directory, options)
    }
  })
  try {
    assert.equal(inspected.ok, true, `${inspected.code} ${inspected.message}`)
    assert.equal(inspected.encrypted, false)
    assert.equal(inspectedDirectory, inspected.directory, 'the extracted package is handed to the existing inspector')
    assert.equal(inspectOptions.verifyChecksums, true, 'the existing sha256 verification is not skipped')
  } finally {
    await inspected.cleanup()
  }
})

test('N06: archive validation reuses the existing service and rejects a future format', async (t) => {
  const fixture = await createFixture(t)
  await exportFixture(fixture)

  // Unknown module ids never reach the backup service.
  const rejectedOutput = path.join(fixture.parent, 'must-not-exist.hlbackup.zip')
  const rejected = await archive.exportArchive({
    dataRoot: fixture.dataRoot,
    modules: ['history', 'not-a-module'],
    outputPath: rejectedOutput,
    tmpRoot: fixture.tmpRoot
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'invalid-request')
  assert.equal(await exists(rejectedOutput), false, 'a rejected export writes no partial file')

  // A descriptor from a newer build is refused before any extraction.
  const zip = readZip(fixture.output)
  const descriptorEntry = zip.getEntry(archive.ARCHIVE_DESCRIPTOR)
  const descriptor = JSON.parse(descriptorEntry.getData().toString('utf8'))
  descriptor.formatVersion = archive.ARCHIVE_FORMAT_VERSION + 1
  zip.updateFile(descriptorEntry, Buffer.from(JSON.stringify(descriptor, null, 2), 'utf8'))
  const future = path.join(fixture.parent, 'future.hlbackup.zip')
  await fsp.writeFile(future, zip.toBuffer())
  const result = await archive.inspectArchive({ archivePath: future, tmpRoot: fixture.tmpRoot })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'future-archive')
  assert.equal(result.supportedFormatVersion, archive.ARCHIVE_FORMAT_VERSION)

  // A file that is not a zip at all is rejected as a structured failure, not a
  // thrown exception (the IPC handler must always be able to answer the page).
  const garbage = path.join(fixture.parent, 'garbage.hlbackup.zip')
  await fsp.writeFile(garbage, Buffer.from('this is not a zip file'))
  const garbageResult = await archive.inspectArchive({ archivePath: garbage, tmpRoot: fixture.tmpRoot })
  assert.equal(garbageResult.ok, false)
  assert.equal(garbageResult.code, 'invalid-archive')

  // Encrypted archives demand the password before touching the filesystem.
  const encryptedFixture = await createFixture(t)
  await exportFixture(encryptedFixture, { password: 'pw', outputPath: path.join(encryptedFixture.parent, 'enc.hlbackup.zip') })
  const noPassword = await archive.inspectArchive({ archivePath: path.join(encryptedFixture.parent, 'enc.hlbackup.zip'), tmpRoot: encryptedFixture.tmpRoot })
  assert.equal(noPassword.ok, false)
  assert.equal(noPassword.code, 'password-required')
})

test('N06: raw password/derived-key guards and the archive file name are bounded', () => {
  assert.equal(archive.normalizePassword('').password, '')
  assert.equal(archive.normalizePassword(undefined).password, '')
  assert.equal(archive.normalizePassword('  spaced  ').password, '  spaced  ', 'the password is used verbatim')
  assert.equal(archive.normalizePassword(42).error.code, 'invalid-password')
  assert.equal(archive.normalizePassword('x'.repeat(archive.MAX_PASSWORD_LENGTH + 1)).error.code, 'password-too-long')
  assert.equal(archive.normalizeModuleIds(['history', 'settings']).join(','), 'history,settings')
  assert.equal(archive.normalizeModuleIds(['history', 'history', 'settings']).join(','), 'history,settings')
  assert.equal(archive.normalizeModuleIds(['nope']), null)
  assert.equal(archive.normalizeEntryName('modules/history/a.png'), 'modules/history/a.png')
  assert.equal(archive.normalizeEntryName('../escape'), null)
  assert.equal(archive.normalizeEntryName('/absolute'), null)
  assert.equal(archive.normalizeEntryName('C:\\windows\\evil'), null)
  assert.equal(archive.normalizeEntryName('a/../../b'), null)
  assert.match(archive.archiveFileName('5.0.1', Date.parse('2026-11-26T10:00:00Z')), /^highlighter-backup-5\.0\.1-20261126-100000Z\.hlbackup\.zip$/)
})

// ---------------------------------------------------------------------------
// C. IPC + UI wiring (source assertions and a fake secure facade)
// ---------------------------------------------------------------------------

test('N06: the two archive channels have a sender policy, a preload API and no renderer paths', () => {
  assert.deepEqual(ARCHIVE_CHANNELS, ['data-root:backup-export-archive', 'data-root:backup-import-archive'])
  const policies = buildIpcPolicies(ROOT)
  for (const channel of ARCHIVE_CHANNELS) {
    const policy = policies.get(channel)
    assert.ok(policy, `${channel} has no sender policy`)
    assert.equal(policy.kind, 'handle')
    assert.deepEqual(policy.pages.map(({ role }) => role), ['main'], 'only the settings window may call it')
  }
  assert.match(ipcSecuritySource, /'data-root:backup-export-archive'/)
  assert.match(ipcSecuritySource, /'data-root:backup-import-archive'/)
  assert.match(dataRootIpcSource, /ipcMain\.handle\('data-root:backup-export-archive'/)
  assert.match(dataRootIpcSource, /ipcMain\.handle\('data-root:backup-import-archive'/)

  for (const [method, channel] of [
    ['backupExportArchive', 'data-root:backup-export-archive'],
    ['backupImportArchive', 'data-root:backup-import-archive']
  ]) {
    assert.match(preloadSource, new RegExp(`${method}:`), `preload exposes ${method}`)
    assert.match(preloadSource, new RegExp(`ipcRenderer\\.invoke\\('${channel}'`))
  }
  // The preload forwards module ids + password only; no path is accepted.
  assert.doesNotMatch(preloadSource, /backupExportArchive[\s\S]{0,400}?(outputPath|filePath|targetRoot|archivePath)/)
  assert.doesNotMatch(preloadSource, /backupImportArchive[\s\S]{0,400}?(outputPath|filePath|targetRoot|archivePath)/)

  // The settings page renders the block and clears the in-memory password after
  // submitting; the dialogs are opened by the main process.
  for (const id of ['backupArchivePassword', 'exportBackupArchive', 'importBackupArchive', 'toggleBackupArchivePassword']) {
    assert.match(settingsSource, new RegExp(`id="${id}"`), `settings page has #${id}`)
  }
  assert.match(settingsSource, /data-section="backup-archive"/)
  assert.match(settingsSource, /api\.backupExportArchive\(\{ modules, password \}\)/)
  assert.match(settingsSource, /api\.backupImportArchive\(\{ password \}\)/)
  assert.match(settingsSource, /passwordInput\.value = ''/)
  // No hardcoded Chinese in the new logic: all copy is resolved through t().
  const archiveBind = /function bindBackupArchiveControls[\s\S]*?\n\}/.exec(settingsSource)?.[0] || ''
  assert.ok(archiveBind.length > 0, 'bindBackupArchiveControls must stay recognisable')
  assert.doesNotMatch(archiveBind, /[\u4e00-\u9fff]/)
})

function fakeController () {
  const calls = []
  return {
    calls,
    get: () => ({ path: 'D:\\fixture-data-root', customized: true }),
    open: async () => { calls.push(['open']) },
    change: async () => { calls.push(['change']) },
    backupCreate: async (options) => { calls.push(['backupCreate', options]); return { ok: true } },
    backupInspect: async (directory) => { calls.push(['backupInspect', directory]); return { ok: true, code: 'ok' } },
    backupRestore: async (options) => { calls.push(['backupRestore', options]); return { ok: true, code: 'ok', restarting: true } },
    backupDelete: async (directory) => { calls.push(['backupDelete', directory]); return { ok: true } }
  }
}

function createIpcHost ({ secure }) {
  const handlers = new Map()
  const listeners = new Map()
  const host = {
    handlers,
    listeners,
    handle: (channel, handler) => handlers.set(channel, handler),
    on: (channel, listener) => listeners.set(channel, listener)
  }
  if (secure) host.assertComplete = () => true
  return host
}

function fakeElectron ({ save, opens = [] } = {}) {
  const calls = { save: 0, open: 0 }
  return {
    calls,
    app: {
      getVersion: () => '5.0.1',
      getPath: (name) => path.join(os.tmpdir(), `n06-electron-${name}`)
    },
    BrowserWindow: { fromWebContents: () => null },
    dialog: {
      showSaveDialog: async (...args) => {
        calls.save += 1
        calls.lastSave = args
        return typeof save === 'function' ? save(args) : save || { canceled: true }
      },
      showOpenDialog: async (...args) => {
        calls.open += 1
        calls.lastOpen = args
        const next = opens[calls.open - 1]
        return typeof next === 'function' ? next(args) : next || { canceled: true }
      }
    }
  }
}

test('N06: only the secure IPC facade registers the archive channels', async () => {
  const plainHost = createIpcHost({ secure: false })
  registerDataRootIpc({ ipcMain: plainHost, controller: fakeController() })
  assert.deepEqual([...plainHost.handlers.keys()], [
    'data-root:get',
    'data-root:open',
    'data-root:change',
    'data-root:backup-create',
    'data-root:backup-inspect',
    'data-root:backup-restore',
    'data-root:backup-delete'
  ])

  const secureHost = createIpcHost({ secure: true })
  registerDataRootIpc({
    ipcMain: secureHost,
    controller: fakeController(),
    archive: {
      archiveFileName: () => 'highlighter-backup-5.0.1-20261126T100000Z.hlbackup.zip',
      exportArchive: async () => ({ ok: true, code: 'ok' }),
      inspectArchive: async () => ({ ok: true, code: 'ok' })
    },
    electron: fakeElectron()
  })
  assert.deepEqual([...secureHost.handlers.keys()].slice(-2), [...ARCHIVE_CHANNELS])

  // A ninth/sixth registration attempt would throw in the real facade; the fake
  // host simply stores them, so pin the count as well.
  assert.equal(secureHost.handlers.size, 9)
})

test('N06: export IPC opens the save dialog in main and never trusts a renderer path', async () => {
  const controller = fakeController()
  let archivedOptions = null
  const electron = fakeElectron({ save: { canceled: false, filePath: 'C:\\chosen\\backup.hlbackup.zip' } })
  const host = createIpcHost({ secure: true })
  registerDataRootIpc({
    ipcMain: host,
    controller,
    archive: {
      archiveFileName: () => 'highlighter-backup-5.0.1-20261126T100000Z.hlbackup.zip',
      exportArchive: async (options) => {
        archivedOptions = options
        return { ok: true, code: 'ok', filePath: options.outputPath, encrypted: Boolean(options.password) }
      },
      inspectArchive: async () => ({ ok: true, code: 'ok' })
    },
    electron
  })
  const handler = host.handlers.get('data-root:backup-export-archive')
  const result = await handler({ sender: {} }, {
    modules: ['history', 'settings', 'not-real', 'history'],
    password: 'memory-only',
    outputPath: 'Z:\\renderer-must-not-choose.zip',
    targetRoot: 'Z:\\renderer-must-not-choose'
  })
  assert.equal(result.ok, true)
  assert.equal(result.filePath, 'C:\\chosen\\backup.hlbackup.zip')
  assert.equal(archivedOptions.outputPath, 'C:\\chosen\\backup.hlbackup.zip', 'the main-process dialog owns the path')
  assert.deepEqual(archivedOptions.modules, ['history', 'settings'], 'unknown/duplicate module ids are filtered')
  assert.equal(archivedOptions.password, 'memory-only')
  assert.equal(archivedOptions.dataRoot, 'D:\\fixture-data-root')
  assert.equal(archivedOptions.version, '5.0.1')
  assert.equal(typeof archivedOptions.createBackup, 'function', 'the export reuses the data-root write path')
  assert.equal(archivedOptions.tmpRoot, path.join(os.tmpdir(), 'n06-electron-temp', 'Highlighter', 'backup-archive'))
  assert.equal(electron.calls.save, 1)
  // A canceled save dialog answers canceled without calling the service.
  const cancelHost = createIpcHost({ secure: true })
  let called = 0
  registerDataRootIpc({
    ipcMain: cancelHost,
    controller: fakeController(),
    archive: { exportArchive: async () => { called += 1; return { ok: true } }, inspectArchive: async () => ({ ok: true }) },
    electron: fakeElectron({ save: { canceled: true } })
  })
  const canceled = await cancelHost.handlers.get('data-root:backup-export-archive')({}, { modules: ['history'], password: '' })
  assert.equal(canceled.canceled, true)
  assert.equal(called, 0)
  assert.doesNotMatch(JSON.stringify(canceled), /memory-only/)
})

test('N06: import IPC decrypts in main, asks for a new root and reuses the restore path', async () => {
  const controller = fakeController()
  let inspectedOptions = null
  let cleaned = 0
  const electron = fakeElectron({
    opens: [
      { canceled: false, filePaths: ['C:\\chosen\\backup.hlbackup.zip'] },
      { canceled: false, filePaths: ['D:\\restored-root'] }
    ]
  })
  const host = createIpcHost({ secure: true })
  registerDataRootIpc({
    ipcMain: host,
    controller,
    archive: {
      inspectArchive: async (options) => {
        inspectedOptions = options
        return {
          ok: true,
          code: 'ok',
          directory: 'C:\\temp\\extracted-package',
          encrypted: true,
          formatVersion: archive.ARCHIVE_FORMAT_VERSION,
          createdAt: '2026-11-26T10:00:00.000Z',
          appVersion: '5.0.1',
          inspection: { ok: true, code: 'ok', modules: {} },
          cleanup: async () => { cleaned += 1 }
        }
      }
    },
    electron
  })
  const handler = host.handlers.get('data-root:backup-import-archive')
  const result = await handler({ sender: {} }, {
    password: 'memory-only',
    archivePath: 'Z:\\renderer-must-not-choose.hlbackup.zip',
    targetRoot: 'Z:\\renderer-must-not-choose'
  })
  assert.equal(result.ok, true)
  assert.equal(result.restarting, true)
  assert.equal(inspectedOptions.archivePath, 'C:\\chosen\\backup.hlbackup.zip', 'the main-process file dialog owns the archive path')
  assert.equal(inspectedOptions.password, 'memory-only')
  assert.equal(typeof inspectedOptions.inspectBackup, 'function')
  await inspectedOptions.inspectBackup('C:\\temp\\extracted-package')
  assert.ok(controller.calls.some(([name, value]) => name === 'backupInspect' && value === 'C:\\temp\\extracted-package'))
  assert.ok(controller.calls.some(([name, value]) => name === 'backupRestore' && value.backupDirectory === 'C:\\temp\\extracted-package' && value.targetRoot === 'D:\\restored-root'))
  assert.equal(cleaned, 1, 'the extracted temp package is cleaned up after the restore')
  assert.deepEqual(result.archive, { encrypted: true, formatVersion: archive.ARCHIVE_FORMAT_VERSION, createdAt: '2026-11-26T10:00:00.000Z', appVersion: '5.0.1' })
  assert.doesNotMatch(JSON.stringify(result), /memory-only/)

  // Cancelling either dialog cancels the whole flow without restoring, and the
  // extracted package still gets cleaned up.
  const cancelHost = createIpcHost({ secure: true })
  const cancelController = fakeController()
  let canceledCleanup = 0
  registerDataRootIpc({
    ipcMain: cancelHost,
    controller: cancelController,
    archive: {
      inspectArchive: async () => ({
        ok: true,
        directory: 'x',
        encrypted: false,
        cleanup: async () => { canceledCleanup += 1 }
      })
    },
    electron: fakeElectron({ opens: [{ canceled: false, filePaths: ['C:\\chosen.hlbackup.zip'] }, { canceled: true }] })
  })
  const canceled = await cancelHost.handlers.get('data-root:backup-import-archive')({}, { password: '' })
  assert.equal(canceled.canceled, true)
  assert.equal(canceledCleanup, 1, 'a canceled restore target still removes the extracted package')
  assert.equal(cancelController.calls.some(([name]) => name === 'backupRestore'), false)
})

test('N06: the archive copy exists in all three languages and stays translatable', () => {
  const tables = loadLocaleTables()
  const keys = [
    'config.search.placeholder',
    'config.search.label',
    'config.search.results-label',
    'config.search.shortcut',
    'config.search.empty',
    'config.settings-system.backup-archive-section',
    'config.settings-system.backup-archive-hint',
    'config.settings-system.backup-archive-password',
    'config.settings-system.backup-archive-password-hint',
    'config.settings-system.backup-archive-show',
    'config.settings-system.backup-archive-hide',
    'config.settings-system.backup-archive-actions',
    'config.settings-system.backup-archive-actions-hint',
    'config.settings-system.backup-archive-export',
    'config.settings-system.backup-archive-exporting',
    'config.settings-system.backup-archive-import',
    'config.settings-system.backup-archive-importing',
    'config.settings-system.backup-archive-exported',
    'config.settings-system.backup-archive-restored',
    'config.settings-system.backup-archive-import-confirm',
    'config.settings-system.backup-archive-export-failed',
    'config.settings-system.backup-archive-import-failed',
    'config.settings-system.backup-archive-unavailable',
    'config.settings-system.backup-archive-error-failed',
    'config.settings-system.backup-archive-error-invalid',
    'config.settings-system.backup-archive-error-future',
    'config.settings-system.backup-archive-error-write',
    'config.settings-system.backup-archive-error-too-large',
    'config.settings-system.backup-archive-error-password-required',
    'config.settings-system.backup-archive-error-password-too-long',
    'config.settings-system.backup-archive-error-decrypt'
  ]
  for (const language of LANGUAGES) {
    for (const key of keys) {
      const value = tables[language][key]
      assert.equal(typeof value, 'string', `${language} is missing ${key}`)
      assert.ok(value.trim().length > 0, `${language} has an empty ${key}`)
    }
  }
  for (const key of keys) {
    // "Ctrl K" is intentionally identical in all three languages; every key
    // that carries prose must be translated and the en-US value must be Latin.
    if (!/[\u4e00-\u9fff]/.test(tables['zh-CN'][key])) continue
    assert.notEqual(tables['zh-CN'][key], tables['en-US'][key], `${key} must be translated`)
    assert.doesNotMatch(tables['en-US'][key], /[\u4e00-\u9fff]/, `en-US ${key} contains Chinese`)
  }
  assert.equal(tables['zh-CN']['config.search.shortcut'], 'Ctrl K')
})

// ---------------------------------------------------------------------------
// D. N06 / DEV-09: the credential boundary of the single-file archive.
// The archive is only a wrapper around the existing D04 package, and that
// package strips credentials. Both the plain ZIP and the decrypted payload of
// the encrypted archive therefore have to be key-free, and a wrong password or
// a tampered archive must fail BEFORE the import touches the restore target.
// Decision and user-facing guidance:
// docs/plans/2026-11-28-dev09-credential-migration-decision.md
// ---------------------------------------------------------------------------

const SECRET_MARKERS = /sk-must-be-redacted|sk-provider/

function zipEntriesText(entries) {
  return entries.map((entry) => `${entry.entryName}\n${entry.getData().toString('latin1')}`).join('\n')
}

test('DEV-09: the unencrypted .hlbackup.zip carries no API key in any entry', async (t) => {
  const fixture = await createFixture(t)
  await exportFixture(fixture)

  const zip = readZip(fixture.output)
  const names = zip.getEntries().map((entry) => entry.entryName)
  assert.ok(names.includes('modules/settings/config.json'), 'the settings snapshot is inside the archive')
  // Whole-archive scan, including the descriptor, marker, manifest and every module file.
  assert.doesNotMatch(zipEntriesText(zip.getEntries()), SECRET_MARKERS)
  const settingsConfig = JSON.parse(zip.getEntry('modules/settings/config.json').getData().toString('utf8'))
  assert.equal(Object.hasOwn(settingsConfig, 'credentials'), false)
  assert.equal(Object.hasOwn(settingsConfig, 'providerApiKeys'), false)
  // The manifest itself declares the redaction, so the package states what it stripped.
  const manifest = JSON.parse(zip.getEntry(backup.MANIFEST_FILE).getData().toString('utf8'))
  assert.ok(manifest.modules.settings.redactedCount >= 1, 'the archive manifest records the redaction')
  assert.equal(manifest.modules.settings.files.some((file) => file.path === 'credentials.json'), false)
})

test('DEV-09: the encrypted archive payload decodes to a package with no API key', async (t) => {
  const fixture = await createFixture(t)
  const password = 'dev09-encrypted-payload'
  await exportFixture(fixture, { password })

  const zip = readZip(fixture.output)
  const descriptor = readDescriptor(zip)
  assert.equal(descriptor.encrypted, true)
  const payload = zip.getEntry(archive.ENCRYPTED_PAYLOAD_ENTRY).getData()
  assert.doesNotMatch(payload.toString('latin1'), SECRET_MARKERS, 'the ciphertext never carries a plaintext key')
  assert.doesNotMatch(payload.toString('latin1'), /modules\.json|highlighter-backup/)

  // Decrypt the payload the way inspectArchive does and assert on the PLAINTEXT package: the key
  // has to be absent from the payload, not merely from the extracted directory afterwards.
  const key = await archive.deriveKey(password, Buffer.from(descriptor.encryption.salt, 'base64'), descriptor.encryption.scrypt)
  try {
    const decipher = crypto.createDecipheriv(
      descriptor.encryption.algorithm,
      key,
      Buffer.from(descriptor.encryption.iv, 'base64')
    )
    decipher.setAAD(archive.encryptionAssociatedData(descriptor.encryption))
    decipher.setAuthTag(Buffer.from(descriptor.encryption.authTag, 'base64'))
    const plainZip = Buffer.concat([decipher.update(payload), decipher.final()])

    const inner = new AdmZip(plainZip)
    assert.doesNotMatch(zipEntriesText(inner.getEntries()), SECRET_MARKERS)
    const innerSettings = JSON.parse(inner.getEntry('modules/settings/config.json').getData().toString('utf8'))
    assert.equal(Object.hasOwn(innerSettings, 'credentials'), false)
    assert.doesNotMatch(zipEntriesText(inner.getEntries()), /api[-_]?keys?/i, 'no credential field name survives redaction')
  } finally {
    key.fill(0)
  }
})

test('DEV-09: a wrong password or a tampered archive fails before the import writes anything', async (t) => {
  const fixture = await createFixture(t)
  const password = 'dev09-right-password'
  await exportFixture(fixture, { password })
  const target = path.join(fixture.parent, 'restore-target')

  const controller = fakeController()
  const runImport = async (chosenPassword) => {
    const electron = fakeElectron({
      opens: [
        { canceled: false, filePaths: [fixture.output] },
        { canceled: false, filePaths: [target] }
      ]
    })
    const host = createIpcHost({ secure: true })
    registerDataRootIpc({ ipcMain: host, controller, archive, electron })
    return host.handlers.get('data-root:backup-import-archive')({ sender: {} }, { password: chosenPassword })
  }

  const wrong = await runImport('dev09-wrong-password')
  assert.equal(wrong.ok, false)
  assert.equal(wrong.code, 'decrypt-failed')
  assert.equal(await exists(target), false, 'a refused password never creates the restore target')
  assert.equal(controller.calls.some(([name]) => name === 'backupRestore'), false, 'the restore path is never reached')

  // Flip one authentication-tag bit: the same pre-write gate has to stop the import.
  const zip = readZip(fixture.output)
  const descriptorEntry = zip.getEntry(archive.ARCHIVE_DESCRIPTOR)
  const descriptor = JSON.parse(descriptorEntry.getData().toString('utf8'))
  const tag = Buffer.from(descriptor.encryption.authTag, 'base64')
  tag[0] ^= 0xff
  descriptor.encryption.authTag = tag.toString('base64')
  zip.updateFile(descriptorEntry, Buffer.from(JSON.stringify(descriptor, null, 2), 'utf8'))
  await fsp.writeFile(fixture.output, zip.toBuffer())

  const tampered = await runImport(password)
  assert.equal(tampered.ok, false)
  assert.equal(tampered.code, 'decrypt-failed')
  assert.equal(await exists(target), false)
  assert.equal(controller.calls.some(([name]) => name === 'backupRestore'), false)
  assert.deepEqual(
    await listDirectory(path.join(os.tmpdir(), 'n06-electron-temp', 'Highlighter', 'backup-archive')),
    [],
    'no temp package survives a refused import'
  )
  assert.doesNotMatch(JSON.stringify([wrong, tampered]), /dev09-wrong-password|dev09-right-password/, 'the password is never echoed back')
})

test('DEV-09: the archive card sits under the shared API-key re-entry guidance', () => {
  // The settings page states the credential rule once, above both backup cards. The single-file
  // archive's own copy may only promise the password/other-machine import, never key migration.
  const section = settingsSource.slice(settingsSource.indexOf('const backupSettings'), settingsSource.indexOf('const diagnosticsSettings'))
  const guidanceIndex = section.indexOf('config.settings-system.backup-key-hint')
  const archiveIndex = section.indexOf('data-section="backup-archive"')
  assert.ok(guidanceIndex > 0, 'the re-entry guidance is rendered on the backup page')
  assert.ok(archiveIndex > 0, 'the single-file archive card is in the same section')
  assert.ok(guidanceIndex < archiveIndex, 'the guidance is visible above the archive card')

  const tables = loadLocaleTables()
  const guidance = tables['en-US']['config.settings-system.backup-key-hint']
  assert.equal(typeof guidance, 'string')
  assert.match(guidance, /not included|excluded/i)
  assert.match(guidance, /re-enter|enter them again/i)
  for (const language of LANGUAGES) {
    assert.match(tables[language]['config.settings-system.backup-key-hint'], /[\s\S]+/)
    assert.doesNotMatch(tables[language]['config.settings-system.backup-archive-hint'], /api[- ]?key|credential/i,
      `${language}: the archive copy must not claim API keys are included`)
    assert.doesNotMatch(tables[language]['config.settings-system.backup-archive-restored'], /api[- ]?key|credential/i,
      `${language}: the import receipt must not claim key migration`)
  }
})
