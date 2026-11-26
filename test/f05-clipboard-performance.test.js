'use strict'
// F05 (docs/reviews/2026-11-26-code-review-and-optimization-report.md report section 3.5):
// the clipboard thumbnail cache is content-addressed per item id. A `history`
// event caused by a new record or a pin toggle must no longer empty it; only an
// explicit delete/clear (or a must-verify record the backend reports gone) may
// drop a key. Everything here is mock-only: no native sidecar, no Electron
// window, no real clipboard. The Rust half of F05 is covered by the crate's own
// `cargo test` unit tests (`f05_*` in storage.rs / writer.rs).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { createClipboardDomain } = require('../main/domains/clipboard')

const ROOT = path.resolve(__dirname, '..')
const PNG = Buffer.from('89504e470d0a1a0a', 'hex')
const uuid = (n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`
const OPERATION = '22222222-2222-4222-8222-222222222222'
const tick = () => new Promise((resolve) => setImmediate(resolve))
const settle = async (count = 6) => { for (let index = 0; index < count; index++) await tick() }

// ---------------------------------------------------------------------------
// Main process domain harness: a fake ClipboardService plus the smallest fake
// BrowserWindow the panel domain touches. The domain owns the byte cache, so
// the assertions read `domain.thumbnails` (its documented test seam) and the
// native `thumbnail` command log.
// ---------------------------------------------------------------------------
function mainHarness() {
  const handlers = new Map()
  const listeners = new Map()
  const protocols = new Map()
  const service = new EventEmitter()
  const commands = []
  const answers = new Map()
  service.snapshot = () => ({ datasetId: 'dataset', revision: 1, itemCount: 0, pinnedCount: 0 })
  service.refresh = async () => service.snapshot()
  service.command = async (method, args = {}) => {
    commands.push({ method, args })
    if (method !== 'thumbnail') return {}
    const answer = answers.get(args.id)
    if (typeof answer === 'function') return answer(args)
    if (answer instanceof Error) throw answer
    const bytes = Buffer.from(`${args.id}:png`)
    return answer || { bytes, value: { mime: 'image/png', byteLength: bytes.length } }
  }
  let win
  const domain = createClipboardDomain({
    app: { isPackaged: false }, rootDirectory: ROOT, directory: 'unused',
    nativeTheme: {}, getSettings: () => ({ clipboard: { enabled: true, releaseAfterMs: 60000 }, language: 'en-US', theme: 'dark' }),
    getHook: () => null, isGameModeEnabled: () => false, isMigrationInProgress: () => false,
    positionAutomationWindow() {}, dialog: {},
    screen: { getCursorScreenPoint: () => ({}), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 900 } }), getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 900 } }) },
    session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, protocol: { handle: (scheme, fn) => protocols.set(scheme, fn), unhandle: (scheme) => protocols.delete(scheme) } }) },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: (name, handler) => listeners.set(name, handler) },
    createLocalWindow: () => {
      win = new EventEmitter(); win.visible = false; win.focused = false; win.destroyed = false
      win.messages = []
      win.webContents = new EventEmitter(); win.webContents.id = 1
      win.webContents.send = (channel, data) => win.messages.push({ channel, data }); win.webContents.isDestroyed = () => win.destroyed
      win.isDestroyed = () => win.destroyed; win.isVisible = () => win.visible; win.isFocused = () => win.focused
      win.getNativeWindowHandle = () => Buffer.from('3412000000000000', 'hex')
      win.loadFile = async () => {}
      win.show = () => { win.visible = true }
      win.focus = () => { win.focused = true }
      win.hide = () => { win.visible = false; win.focused = false; win.emit('blur') }
      win.destroy = () => { win.destroyed = true; win.emit('closed') }
      return win
    }
  })
  domain.service.command = service.command
  domain.service.refresh = service.refresh
  domain.service.snapshot = service.snapshot
  const resource = (url) => protocols.get('highlighter-clipboard')({ url, method: 'GET' })
  const previews = (ids) => handlers.get('clipboard:previews')({ sender: win.webContents }, { ids })
  return {
    domain, commands, answers, protocols, listeners, resource,
    get win() { return win },
    thumbnailCalls: () => commands.filter((call) => call.method === 'thumbnail'),
    async open() {
      domain.show()
      listeners.get('clipboard:ready')({ sender: win.webContents })
      await tick()
    },
    async previewUrls(ids) {
      const response = await previews(ids)
      assert.equal(response.ok, true, JSON.stringify(response.error))
      return response.result
    },
    async previews(ids) {
      const response = await previews(ids)
      assert.equal(response.ok, true, JSON.stringify(response.error))
      return response.result
    },
    // The IPC delete handler is what calls domain.revokePreviews() before the
    // native command; drive it directly so the cache/token effect is pinned.
    async deleteIds(ids) {
      const response = await handlers.get('clipboard:delete')({ sender: win.webContents }, { ids, operationId: OPERATION })
      assert.equal(response.ok, true, JSON.stringify(response.error))
      return response.result
    },
    emitHistory(revision) { domain.service.emit('history', { datasetId: 'dataset', revision }) },
    cacheSize() { return domain.thumbnails.size() }
  }
}

test('F05 main: a history event does not empty the thumbnail cache; only the touched id is revalidated', async () => {
  const h = mainHarness()
  await h.open()
  const entries = await h.previewUrls([uuid(1), uuid(2)])
  assert.equal(h.thumbnailCalls().length, 2, 'one native read per id before history')
  assert.equal(h.cacheSize().entries, 2)

  h.emitHistory(2)
  assert.equal(h.cacheSize().entries, 2, 'a new record / pin toggle must not clear every cached thumbnail')
  assert.ok(h.domain.thumbnails.get(uuid(1)), 'the previously cached bytes are still there')
  assert.ok(h.domain.thumbnails.get(uuid(2)))
  assert.ok(
    h.win.messages.some((message) => message.channel === 'clipboard:history-changed' && message.data.revision === 2),
    'the renderer is still told that history changed'
  )

  // A protocol hit on one entry revalidates that entry only: one extra native
  // read, the other cached key is untouched.
  assert.equal((await h.resource(entries[0].url)).status, 200)
  assert.equal(h.thumbnailCalls().length, 3, 'exactly one stale entry went back to native')
  assert.equal(h.thumbnailCalls()[2].args.id, uuid(1))
  assert.equal(h.cacheSize().entries, 2)
})

test('F05 main: a natively deleted record drops exactly one cached key (targeted eviction)', async () => {
  const h = mainHarness()
  await h.open()
  const entries = await h.previewUrls([uuid(1), uuid(2)])
  assert.equal(h.cacheSize().entries, 2)

  h.emitHistory(2)
  // The native retention pass removed record 1 between the two revisions.
  h.answers.set(uuid(1), Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' }))
  assert.equal((await h.resource(entries[0].url)).status, 404)
  assert.equal(h.cacheSize().entries, 1, 'only the deleted id lost its entry')
  assert.equal(h.domain.thumbnails.get(uuid(1)), undefined)
  assert.ok(h.domain.thumbnails.get(uuid(2)), 'the surviving record kept its thumbnail')

  // The batch path evicts the same single key, with the stable error code.
  const retried = await h.previews([uuid(1)])
  assert.equal(retried[0].error, 'NOT_FOUND')
  assert.equal(h.cacheSize().entries, 1)

  // A later history event still does not clear the surviving entry.
  h.emitHistory(3)
  assert.equal(h.cacheSize().entries, 1)
})

test('F05 main: delete/clear still invalidate the whole cache and its tokens', async () => {
  const h = mainHarness()
  await h.open()
  const entries = await h.previewUrls([uuid(1), uuid(2)])
  assert.equal(h.cacheSize().entries, 2)
  // The IPC delete and commit-clear handlers both go through revokePreviews().
  await h.deleteIds([uuid(1)])
  assert.equal(h.cacheSize().entries, 0, 'an explicit delete/clear still empties the table')
  assert.equal((await h.resource(entries[0].url)).status, 404, 'and revokes the capability URLs')
})

// ---------------------------------------------------------------------------
// Renderer harness: the real clipboard.js in a vm with a minimal DOM. Same
// approach as test/clipboard-paste-renderer.test.js; the selector parser throws
// on anything it cannot parse so the tile assertions cannot silently pass.
// ---------------------------------------------------------------------------
function matches(node, selector) {
  const parts = selector.match(/^([a-z0-9]*)((?:\[[^\]]+\]|\.[\w-]+)*)$/i)
  if (!parts) throw new Error(`test stub cannot parse selector: ${selector}`)
  const [, tag, tail] = parts
  if (tag && String(node.tagName || '').toLowerCase() !== tag.toLowerCase()) return false
  for (const token of (tail.match(/\[[^\]]+\]|\.[\w-]+/g) || [])) {
    if (token.startsWith('.')) {
      if (!String(node.className || '').split(/\s+/).includes(token.slice(1))) return false
      continue
    }
    const body = token.slice(1, -1)
    const equals = body.indexOf('=')
    const name = equals < 0 ? body : body.slice(0, equals)
    if (equals >= 0) {
      const expected = body.slice(equals + 1).replace(/^["']|["']$/g, '')
      if (node.getAttribute(name) !== expected) return false
    } else if (node.getAttribute(name) == null) return false
  }
  return true
}

function descendants(node, selector) {
  const found = []
  const walk = (current) => {
    for (const child of current.children || []) {
      if (matches(child, selector)) found.push(child)
      walk(child)
    }
  }
  walk(node)
  return found
}

function rendererHarness(overrides = {}) {
  const elements = new Map()
  const callbacks = {}
  const calls = []
  const element = (id, tagName = 'div') => {
    const node = {
      id, tagName, value: '', textContent: '', hidden: false, title: '', className: '',
      style: { setProperty(name, value) { node.style[name] = value } },
      scrollTop: 0, clientHeight: 300, clientWidth: 469, children: [],
      dataset: {}, attributes: {},
      classList: { add() {}, remove() {}, toggle() {} },
      replaceChildren(...values) { this.children = values.slice(); for (const value of values) value.parent = this },
      append(...values) { for (const value of values) value.parent = this; this.children.push(...values) },
      appendChild(value) { value.parent = this; this.children.push(value); return value },
      setAttribute(name, value) {
        node.attributes[name] = String(value)
        if (name.startsWith('data-')) node.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value)
      },
      getAttribute(name) { return Object.hasOwn(node.attributes, name) ? node.attributes[name] : null },
      removeAttribute(name) { delete node.attributes[name] },
      querySelector(selector) { return descendants(node, selector)[0] || null },
      querySelectorAll(selector) { return descendants(node, selector) },
      closest(selector) { let current = node.parent; while (current) { if (matches(current, selector)) return current; current = current.parent } return null },
      focus() {},
      addEventListener(type, fn) { (node.listeners ||= {})[type] = fn },
      dispatchEvent() {},
      isConnected: true
    }
    return node
  }
  const get = (id) => { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id) }
  const thumbnailCalls = []
  let resolveList = () => ({ ok: true, result: { items: [], cursor: null } })
  const api = {
    ready() {}, interactive() {}, close() {},
    list() { calls.push('list'); return Promise.resolve(resolveList()) },
    detail() { return Promise.resolve({ ok: true, result: { text: '', truncated: false, kind: 'text' } }) },
    previews(ids) {
      const copy = Array.from(ids)
      thumbnailCalls.push(copy)
      return Promise.resolve({ ok: true, result: copy.map((id) => ({ id, url: `highlighter-clipboard://preview/${id}` })) })
    },
    status() { return Promise.resolve({ ok: true, result: {} }) },
    copy() { return Promise.resolve({ ok: true, result: {} }) },
    paste() { return Promise.resolve({ ok: true, result: {} }) },
    setPinned() { return Promise.resolve({ ok: true, result: {} }) },
    delete() { return Promise.resolve({ ok: true, result: {} }) },
    prepareClear() { return Promise.resolve({ ok: true, result: { canceled: true } }) },
    commitClear() { return Promise.resolve({ ok: true, result: {} }) },
    setPaused(value) { return Promise.resolve({ ok: true, result: { userPaused: value } }) },
    ...overrides.api
  }
  for (const name of ['Init', 'Hidden', 'PasteResult', 'Status', 'History', 'Language']) {
    api[`on${name}`] = (fn) => { callbacks[name] = fn; return () => {} }
  }
  const media = { listeners: [], matches: false, addEventListener(type, fn) { this.listeners.push(fn) } }
  const context = {
    window: {
      clipboardAPI: api,
      clipboardLayout: require('../clipboard/clipboard-layout.js'),
      devicePixelRatio: 1,
      addEventListener() {},
      matchMedia: () => media
    },
    document: {
      getElementById: get,
      createElement: (tag) => element(`created-${tag}`, tag),
      documentElement: { classList: { toggle() {} }, style: { setProperty() {} } },
      body: { classList: { add() {}, remove() {}, toggle() {} } }
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    ResizeObserver: class { observe() {} },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    setTimeout, clearTimeout, setImmediate,
    crypto: require('node:crypto').webcrypto,
    t: (key) => key,
    setLanguage() {}, applyTranslations() {}, currentLanguage: () => 'zh-CN'
  }
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'clipboard', 'clipboard.js'), 'utf8'), context)
  return {
    api, callbacks, calls, thumbnailCalls, get,
    page: (value) => { resolveList = typeof value === 'function' ? value : () => value },
    tiles() { return get('rows').querySelectorAll('[data-item-id]') }
  }
}

const IMAGE_ITEMS = [
  { id: 'i1', kind: 'image', width: 10, height: 10, sourceDisplayName: 'App', lastCopiedAt: 1, byteLength: 1 },
  { id: 'i2', kind: 'image', width: 10, height: 10, sourceDisplayName: 'App', lastCopiedAt: 2, byteLength: 1 }
]

test('F05 renderer: a new history record keeps the cached thumbnail URLs', async () => {
  const h = rendererHarness()
  h.page({ ok: true, result: { items: IMAGE_ITEMS, cursor: null } })
  h.callbacks.Init({ language: 'zh-CN' })
  await settle()
  assert.equal(h.thumbnailCalls.length, 1, 'the first render batches both visible thumbnails')
  assert.deepEqual(h.thumbnailCalls[0], ['i1', 'i2'])

  h.callbacks.History()
  assert.equal(h.get('new').hidden, false, 'history still surfaces the refresh action')
  // Re-rendering after a new record must reuse the cached capability URLs; the
  // old implementation cleared the map here and re-requested every thumbnail.
  h.callbacks.Language('zh-CN')
  await settle()
  assert.equal(h.thumbnailCalls.length, 1, 'a new record must not clear the whole thumbnail cache')
})

test('F05 renderer: deleting one record evicts only that record thumbnail', async () => {
  const h = rendererHarness()
  h.page({ ok: true, result: { items: IMAGE_ITEMS, cursor: null } })
  h.callbacks.Init({ language: 'zh-CN' })
  await settle()
  assert.equal(h.thumbnailCalls.length, 1)

  const tile = h.tiles().find((node) => node.getAttribute('data-item-id') === 'i1')
  assert.ok(tile, 'the first image tile is mounted')
  tile.onclick()
  await h.get('delete').onclick()
  await settle()
  // The fake backend still lists both records, so the re-render only requests the
  // deleted record: i2 must still be served from the cache.
  assert.equal(h.thumbnailCalls.length, 2, 'exactly one thumbnail was re-requested')
  assert.deepEqual(h.thumbnailCalls[1], ['i1'], 'only the deleted record lost its cached URL')
})

test('F05 renderer: only clearing the whole history empties the thumbnail cache', async () => {
  const h = rendererHarness({
    api: {
      prepareClear: () => Promise.resolve({ ok: true, result: { token: 'clear-token', count: 2 } }),
      commitClear: () => Promise.resolve({ ok: true, result: {} })
    }
  })
  h.page({ ok: true, result: { items: IMAGE_ITEMS, cursor: null } })
  h.callbacks.Init({ language: 'zh-CN' })
  await settle()
  assert.equal(h.thumbnailCalls.length, 1)

  await h.get('clear').onclick()
  await settle()
  assert.equal(h.thumbnailCalls.length, 2, 'the clear re-requests every thumbnail from native')
  assert.deepEqual(h.thumbnailCalls[1].slice().sort(), ['i1', 'i2'])
})

test('F05 main: the history listener only forwards the event (no cache clear on new records)', async () => {
  // Static half of the previous assertions: the listener must call noteHistory(),
  // which bumps the epoch but never clears the LRU.
  const source = fs.readFileSync(path.join(ROOT, 'main', 'domains', 'clipboard', 'index.js'), 'utf8')
  assert.match(source, /service\.on\('history', \(value\) => noteHistory\(value\)\)/)
  assert.doesNotMatch(source, /service\.on\('history'[^\n]*invalidateThumbnails/)
  assert.match(source, /function noteHistory\(value\)[\s\S]{0,400}cacheEpoch\+\+/)
})
