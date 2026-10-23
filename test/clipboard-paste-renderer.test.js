'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// Minimal selector support: just enough for the handful of selectors the panel
// uses (`.tile[data-item-id]`, `img`, `.row`). Written as a parser rather than a
// list of exact strings, and it THROWS on a selector it cannot parse. Silently
// returning no matches would make every assertion built on it vacuous: the
// product could stop rendering tiles and the "renders tiles" test would still
// pass because the query returned an empty list either way.
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

// The clipboard renderer runs inside a real Chromium window; this harness runs
// the same file inside a vm context with a minimal DOM so the state machine
// (query generations, selection hand-off, thumbnail batching) can be pinned
// without an Electron launch. The stub only provides what the panel actually
// touches; anything new the renderer starts using must be added explicitly here,
// which is deliberate: a silently missing stub would make these tests vacuous.
function harness(overrides = {}) {
  const elements = new Map(); const callbacks = {}; const calls = []
  const element = (id, tagName = 'div') => {
    const node = {
      id, tagName, value: '', textContent: '', hidden: false, checked: false, title: '', className: '',
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
  const deferred = []
  let resolveList = () => ({ ok: true, result: { items: [], cursor: null } })
  const api = {
    ready() {}, interactive() {}, close() {},
    list() { calls.push('list'); return Promise.resolve(resolveList()) },
    detail() { calls.push('detail'); return Promise.resolve({ ok: true, result: { text: '', truncated: false, kind: 'text' } }) },
    previews(ids) {
      const copy = Array.from(ids)
      thumbnailCalls.push(copy)
      // A deferred batch lets a test hold a request "in flight" while the panel
      // hides or the history changes, which is exactly the window where the
      // in-flight bookkeeping used to leak.
      if (!overrides.manualPreviews) {
        return Promise.resolve({ ok: true, result: copy.map((id) => ({ id, url: `highlighter-clipboard://preview/${id}` })) })
      }
      return new Promise((resolve) => {
        deferred.push({ ids: copy, resolve: () => resolve({ ok: true, result: copy.map((id) => ({ id, url: `highlighter-clipboard://preview/${id}` })) }) })
      })
    },
    status() { return Promise.resolve({ ok: true, result: {} }) },
    copy() { calls.push('copy'); return Promise.resolve({ ok: true, result: {} }) },
    paste() { calls.push('paste'); return Promise.resolve({ ok: true, result: { copied: true, outcome: 'copiedOnly' } }) },
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
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../clipboard/clipboard.js'), 'utf8'), context)
  return { api, callbacks, calls, thumbnailCalls, deferred, get, media,
    page: (value) => { resolveList = typeof value === 'function' ? value : () => value } }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('feedback clears history and invalidates an in-flight page without another query', async () => {
  const h = harness()
  h.callbacks.Init({ language: 'zh-CN' })
  await tick()
  assert.equal(h.calls.includes('list'), true)
  h.get('text').textContent = 'old synthetic detail'; h.get('search').value = 'old synthetic search'
  h.callbacks.PasteResult({ language: 'zh-CN', pasteFeedback: { outcome: 'copiedOnly', reason: 'CLIPBOARD_CHANGED' } })
  assert.equal(h.get('text').textContent, ''); assert.equal(h.get('search').value, '')
  assert.equal(h.get('feedback').hidden, false)
  h.callbacks.History(); h.callbacks.Status({ itemCount: 99 })
  assert.equal(h.get('rows').children.length, 0)
})

test('selecting a record never fetches a detail entry (the removed interaction)', async () => {
  const items = [
    { id: 'a', kind: 'text', previewText: 'first record', sourceDisplayName: 'App', lastCopiedAt: 1, byteLength: 10 },
    { id: 'b', kind: 'image', width: 1280, height: 720, sourceDisplayName: 'App', lastCopiedAt: 2, byteLength: 20 }
  ]
  const h = harness({ api: { list: () => Promise.resolve({ ok: true, result: { items, cursor: null } }) } })
  h.callbacks.Init({ language: 'zh-CN' })
  await tick(); await tick()
  const before = h.calls.filter((call) => call === 'detail').length
  h.callbacks.Status({ itemCount: 2 })
  assert.equal(h.calls.filter((call) => call === 'detail').length, before, 'selection must not request detail')
})

test('the first render batches every visible thumbnail into one previews call', async () => {
  const items = [
    { id: 'i1', kind: 'image', width: 10, height: 10, sourceDisplayName: 'App', lastCopiedAt: 1, byteLength: 1 },
    { id: 'i2', kind: 'image', width: 10, height: 10, sourceDisplayName: 'App', lastCopiedAt: 1, byteLength: 1 },
    { id: 'i3', kind: 'image', width: 10, height: 10, sourceDisplayName: 'App', lastCopiedAt: 1, byteLength: 1 }
  ]
  const h = harness({ api: { list: () => Promise.resolve({ ok: true, result: { items, cursor: null } }) } })
  h.callbacks.Init({ language: 'zh-CN' })
  await tick(); await tick(); await tick()
  // One call, not one per tile: separate preview() calls would revoke each
  // other's capability tokens and leave every tile but the last one blank.
  assert.equal(h.thumbnailCalls.length, 1)
  // Array.from: the ids array is allocated inside the vm realm, so its
  // prototype differs from this realm's Array.prototype.
  assert.deepEqual(Array.from(h.thumbnailCalls[0]).sort(), ['i1', 'i2', 'i3'])
})

test('a language switch rebuilds the DOM so aria-labels follow the new table', async () => {
  const items = [
    { id: 'i1', kind: 'image', width: 10, height: 10, sourceDisplayName: 'App', lastCopiedAt: 1, byteLength: 1 }
  ]
  const h = harness({ api: { list: () => Promise.resolve({ ok: true, result: { items, cursor: null } }) } })
  h.callbacks.Init({ language: 'zh-CN' })
  await tick(); await tick()
  const rowsBefore = h.get('rows').children.length
  h.callbacks.Language('en-US')
  // Rebuild is synchronous; the grid row must be re-created rather than reused
  // with a stale localized description.
  assert.equal(h.get('rows').children.length, rowsBefore)
  assert.equal(h.get('paste').title, 'clipboard.paste-hint')
})

test('the device pixel ratio change listener re-reads geometry', async () => {
  const h = harness()
  h.callbacks.Init({ language: 'zh-CN' })
  await tick()
  assert.ok(h.media.listeners.length >= 1, 'the panel watches the DPR media query')
})

test('arrow keys move by visual row in a mixed grid, not by raw index', async () => {
  // Eight images fill two grid rows, then a text row follows. Vertical movement
  // must map "same column, next row", which the layout model exposes as
  // itemRow/itemCol; deriving the row by searching for a row object would break
  // as soon as the model is rebuilt.
  const layout = require('../clipboard/clipboard-layout.js')
  const items = []
  for (let index = 0; index < 8; index++) {
    items.push({ id: `i${index}`, kind: 'image', width: 4, height: 3 })
  }
  items.push({ id: 'text', kind: 'text' })
  const model = layout.layout(items, { rowH: 64, cellH: 92, gap: 8, cols: 4 })
  assert.equal(model.rows.length, 3, 'eight images fill two grid rows, then one text row')
  assert.deepEqual(Array.from(model.rows[0].items), [0, 1, 2, 3])
  assert.deepEqual(Array.from(model.rows[1].items), [4, 5, 6, 7])
  // Row 0 col 1 -> row 1 col 1 is items 1 -> 5: neither index + 1 nor index + cols.
  assert.equal(model.itemRow[1], 0)
  assert.equal(model.itemRow[5], 1)
  assert.equal(model.itemCol[1], 1)
  assert.equal(model.itemCol[5], 1)
  // And the wrap from the last image cell to the text row keeps column 0.
  assert.equal(model.itemRow[7], 1)
  assert.equal(model.itemRow[8], 2)
  assert.equal(model.itemCol[8], 0)
})


// --- regressions for the failure modes found in review -----------------------

test('a batch that resolves after the panel hid does not wedge the ids forever', async () => {
  // Tokens are revoked on hide, so the batch result must be discarded - but the
  // in-flight marks have to be released too. When they were not, every id in
  // that batch was skipped by the next requestThumbnails() for the rest of the
  // session and those plates stayed blank permanently.
  const items = [
    { id: 'i1', kind: 'image', width: 4, height: 3, sourceDisplayName: 'A', lastCopiedAt: 1, byteLength: 1 },
    { id: 'i2', kind: 'image', width: 4, height: 3, sourceDisplayName: 'A', lastCopiedAt: 1, byteLength: 1 }
  ]
  const h = harness({ manualPreviews: true, api: { list: () => Promise.resolve({ ok: true, result: { items, cursor: null } }) } })
  h.callbacks.Init({ language: 'zh-CN' })
  await tick(); await tick()
  assert.equal(h.deferred.length, 1, 'the first render issued one batch')
  // Hide the panel while the batch is still on the wire, then let it resolve.
  h.callbacks.Hidden()
  h.deferred[0].resolve()
  await tick(); await tick()
  // Reopen: the same ids must be requestable again, not silently skipped.
  h.callbacks.Init({ language: 'zh-CN' })
  await tick(); await tick(); await tick()
  assert.ok(h.thumbnailCalls.length >= 2, 'a reopen re-requests the ids instead of skipping them')
})

test('more mounted tiles than one batch carries are requested in follow-up batches', async () => {
  // A tall or wide panel can mount more than 64 plates. Truncating the batch and
  // dropping the remainder left every plate past the first 64 blank forever.
  const items = []
  for (let index = 0; index < 70; index++) {
    items.push({ id: `i${index}`, kind: 'image', width: 4, height: 3, sourceDisplayName: 'A', lastCopiedAt: 1, byteLength: 1 })
  }
  // Force a window that mounts all 70: clientHeight large enough for the rows.
  const h = harness({ api: { list: () => Promise.resolve({ ok: true, result: { items, cursor: null } }) } })
  h.get('list').clientHeight = 100000
  h.callbacks.Init({ language: 'zh-CN' })
  for (let index = 0; index < 12; index++) await tick()
  const requested = new Set(h.thumbnailCalls.flat())
  assert.equal(requested.size, 70, 'every mounted image was requested, not just the first batch')
  assert.ok(h.thumbnailCalls.length >= 2, 'the remainder came from a follow-up batch')
})

test('a failed thumbnail is not re-requested on every scroll, and says so to a screen reader', async () => {
  const items = [
    { id: 'bad', kind: 'image', width: 4, height: 3, sourceDisplayName: 'App', lastCopiedAt: 1, byteLength: 1 }
  ]
  const attempts = []
  const h = harness({
    api: {
      list: () => Promise.resolve({ ok: true, result: { items, cursor: null } }),
      previews: (ids) => {
        const copy = Array.from(ids)
        attempts.push(copy)
        return Promise.resolve({ ok: true, result: copy.map((id) => ({ id, error: 'NOT_FOUND' })) })
      }
    }
  })
  h.callbacks.Init({ language: 'zh-CN' })
  for (let index = 0; index < 4; index++) await tick()
  const afterFirst = attempts.length
  assert.ok(afterFirst >= 1, 'the failed id was requested once')
  // Force more render passes; a permanently broken record must not be re-asked
  // on every virtual-window change.
  h.callbacks.Status({ itemCount: 1 })
  h.get('list').scrollTop = 10
  h.get('list').onscroll()
  for (let index = 0; index < 4; index++) await tick()
  assert.equal(attempts.length, afterFirst, 'a known-failed id is not re-requested')
  // The plate must announce itself as unavailable rather than as a normal image.
  const tile = h.get('rows').querySelector('.tile[data-item-id]')
  assert.ok(tile, 'the failed plate stays mounted')
  assert.equal(tile.getAttribute('data-state'), 'failed')
  assert.match(tile.getAttribute('aria-label'), /thumbnail-unavailable/)
})
