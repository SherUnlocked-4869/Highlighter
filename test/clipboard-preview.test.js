'use strict'

// A05: on-demand image preview + search-hit snippets.
//
// Two layers, matching the review's acceptance criteria:
//   1. the pure helpers (fragment cut, hit range, scale limit) are exercised
//      directly, including the surrogate-pair and long-tail cases;
//   2. the renderer is run in a vm with a minimal DOM so the key state machine
//      (Space/Escape, focus return, one-image-at-a-time release and 30 previews)
//      is measured instead of inferred from source text.
//
// The main process half of "hide revokes every token" already has a dedicated
// regression in test/clipboard-preview-batch.test.js; this file pins the
// renderer that now consumes those tokens.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '..')
const preview = require(path.join(root, 'clipboard', 'clipboard-preview.js'))

const html = fs.readFileSync(path.join(root, 'clipboard', 'clipboard.html'), 'utf8')
const css = fs.readFileSync(path.join(root, 'clipboard', 'clipboard.css'), 'utf8')
const script = fs.readFileSync(path.join(root, 'clipboard', 'clipboard.js'), 'utf8')
const moduleSource = fs.readFileSync(path.join(root, 'clipboard', 'clipboard-preview.js'), 'utf8')

// ---------------------------------------------------------------------------
// 1. pure helpers
// ---------------------------------------------------------------------------

test('findMatch reports code point ranges, not UTF-16 offsets', () => {
  const match = preview.findMatch('😀abc', 'abc')
  assert.deepEqual({ ...match }, { start: 1, end: 4 })
  assert.equal([...'😀abc'.slice(0, 2)].length, 1, 'the UTF-16 offset would have been 2')
  // Empty or absent queries are "no hit", never an empty range at 0.
  assert.equal(preview.findMatch('text', ''), null)
  assert.equal(preview.findMatch('text', '   '), null)
  assert.equal(preview.findMatch('', 'text'), null)
  assert.equal(preview.findMatch(null, 'text'), null)
  assert.equal(preview.findMatch('text', 'missing'), null)
})

test('findMatch is case-insensitive and keeps the original casing', () => {
  const match = preview.findMatch('Alpha BETA gamma', 'beta')
  assert.ok(match)
  assert.equal(match.start, 6)
  assert.equal(match.end, 10)
  const snippet = preview.snippetAround('Alpha BETA gamma', 'beta')
  assert.equal(snippet.match, 'BETA')
  // A trimmed query is what the backend tokenizes; the spaces around it do not
  // have to exist in the record.
  assert.equal(preview.snippetAround('a shot here', '  shot  ').match, 'shot')
})

test('a case mapping that changes the string length still matches', () => {
  // 'İ'.toLowerCase() is two code points, so the fast indexOf path cannot map
  // offsets; the code-point scan has to find the hit on its own.
  assert.deepEqual({ ...preview.findMatch('İstanbul', 'İstanbul') }, { start: 0, end: 8 })
  assert.equal(preview.snippetAround('İstanbul', 'İSTANBUL').match, 'İstanbul')
})

test('snippetAround keeps 48 code points on each side and flags the cuts', () => {
  const text = 'x'.repeat(100) + 'NEEDLE' + 'y'.repeat(100)
  const snippet = preview.snippetAround(text, 'needle')
  assert.equal(snippet.prefix, true)
  assert.equal(snippet.suffix, true)
  assert.equal([...snippet.before].length, preview.DEFAULT_RADIUS)
  assert.equal([...snippet.after].length, preview.DEFAULT_RADIUS)
  assert.equal(snippet.match, 'NEEDLE')
  assert.equal(snippet.start, 100)
  assert.equal(snippet.end, 106)
  assert.equal(snippet.length, 206)
})

test('a hit at the end of a long text stays inside the fragment', () => {
  const text = 'A'.repeat(300) + 'needle'
  const snippet = preview.snippetAround(text, 'needle')
  assert.ok(snippet, 'the tail hit is found')
  assert.equal(snippet.suffix, false)
  assert.equal(snippet.after, '')
  assert.equal(snippet.match, 'needle')
  assert.ok(snippet.before.endsWith('A'.repeat(preview.DEFAULT_RADIUS)))
  assert.equal(snippet.prefix, true)
})

test('surrogate pairs are never cut in half at either edge', () => {
  // 48 UTF-16 units would stop inside an emoji; 48 code points must not.
  const text = 'a' + '😀'.repeat(60) + 'HIT' + '😀'.repeat(60)
  const snippet = preview.snippetAround(text, 'hit')
  assert.ok(snippet)
  // The before fragment is 48 code points: 96 UTF-16 units, every unit pair
  // complete. A unit-based slice would have produced an unpaired surrogate.
  assert.equal([...snippet.before].length, 48)
  assert.equal(snippet.before.length, 96)
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(snippet.before), false, 'no lone high surrogate')
  assert.equal([...snippet.after].length, 48)
  assert.equal(snippet.after.length, 96)
  // The hit itself is intact and the flags say the edges were cut.
  assert.equal(snippet.match, 'HIT')
  assert.equal(snippet.prefix, true)
  assert.equal(snippet.suffix, true)
})

test('snippets render on one line: whitespace runs collapse', () => {
  const snippet = preview.snippetAround('line one\n\nneedle\tvalue tail', 'needle')
  assert.equal(snippet.before, 'line one ')
  assert.equal(snippet.match, 'needle')
  assert.equal(snippet.after, ' value tail')
  assert.equal(snippet.prefix, false)
  assert.equal(snippet.suffix, false)
  assert.doesNotMatch(snippet.before + snippet.after, /[\r\n\t]/)
})

test('the first occurrence wins and a missing literal hit returns null', () => {
  const snippet = preview.snippetAround('one hit two hit three', 'hit', { radius: 4 })
  assert.equal(snippet.start, 4)
  // FTS removes diacritics; a query that only matches that way has no literal
  // range, so the renderer keeps the existing preview text (pre-A05 behaviour).
  assert.equal(preview.findMatch('café', 'cafe'), null)
  assert.equal(preview.snippetAround('café', 'cafe'), null)
})

test('a radius option and a full-text edge are honoured', () => {
  const short = preview.snippetAround('abc needle xyz', 'needle', { radius: 2 })
  assert.equal(short.before, 'c ')
  assert.equal(short.after, ' x')
  assert.equal(short.prefix, true)
  assert.equal(short.suffix, true)
  const exact = preview.snippetAround('needle', 'needle')
  assert.equal(exact.before, '')
  assert.equal(exact.after, '')
  assert.equal(exact.prefix, false)
  assert.equal(exact.suffix, false)
})

test('fitPreview scales down to the box and caps magnification at 2x', () => {
  const landscape = preview.fitPreview(640, 360, { width: 424, height: 400 })
  assert.equal(landscape.width, 424)
  assert.equal(landscape.height, 238)
  assert.ok(landscape.width <= 424 && landscape.height <= 400)
  assert.ok(Math.abs((landscape.width / landscape.height) - (640 / 360)) < 0.01, 'aspect ratio preserved')
  // A small source is allowed to grow, but only to the documented 2x cap.
  assert.deepEqual({ ...preview.fitPreview(100, 50, { width: 400, height: 400 }) }, { width: 200, height: 100, scale: 2 })
  assert.deepEqual({ ...preview.fitPreview(10, 10, { width: 400, height: 400 }, { maxScale: 1 }) }, { width: 10, height: 10, scale: 1 })
  // A large original fits the box exactly; the overlay never scrolls.
  const huge = preview.fitPreview(4000, 3000, { width: 400, height: 300 })
  assert.deepEqual([huge.width, huge.height], [400, 300])
  assert.equal(preview.MAX_PREVIEW_SCALE, 2)
})

test('fitPreview rejects unmeasurable input instead of dividing by zero', () => {
  for (const [width, height, box] of [
    [0, 10, { width: 100, height: 100 }],
    [10, 0, { width: 100, height: 100 }],
    [-1, 10, { width: 100, height: 100 }],
    [10, 10, { width: 0, height: 100 }],
    [10, 10, { width: 100, height: NaN }],
    [NaN, 10, { width: 100, height: 100 }]
  ]) {
    assert.equal(preview.fitPreview(width, height, box), null, `${width}x${height} in ${JSON.stringify(box)}`)
  }
})

test('fitPreview never overflows its box, for any finite input', () => {
  for (let index = 0; index < 200; index++) {
    const width = 1 + Math.random() * 5000
    const height = 1 + Math.random() * 5000
    const box = { width: 1 + Math.random() * 800, height: 1 + Math.random() * 800 }
    const fitted = preview.fitPreview(width, height, box)
    assert.ok(fitted.width >= 1 && fitted.height >= 1)
    assert.ok(fitted.width <= Math.floor(box.width), 'width stays inside the box')
    assert.ok(fitted.height <= Math.floor(box.height), 'height stays inside the box')
  }
})

// ---------------------------------------------------------------------------
// 2. renderer harness (minimal DOM, no Electron)
// ---------------------------------------------------------------------------

function matches(node, selector) {
  const parts = selector.match(/^([a-z0-9]*)((?:\[[^\]]+\]|\.[\w-]+)*)$/i)
  if (!parts) throw new Error(`harness cannot parse selector: ${selector}`)
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
      if (node.getAttribute(name) !== body.slice(equals + 1).replace(/^["']|["']$/g, '')) return false
    } else if (node.getAttribute(name) == null) return false
  }
  return true
}

function descendants(node) {
  const found = []
  const walk = (current) => {
    for (const child of current.children || []) {
      found.push(child)
      walk(child)
    }
  }
  walk(node)
  return found
}

function makeElement(tagName = 'div', id = '') {
  const node = {
    id, tagName, value: '', title: '', className: '', textContent: '', hidden: false,
    width: 0, height: 0, src: '', alt: '', decoding: '',
    scrollTop: 0, scrollHeight: 0, clientHeight: 300, clientWidth: 469,
    children: [], dataset: {}, attributes: {}, listeners: {},
    style: { setProperty(name, value) { node.style[name] = value } },
    classList: { add() {}, remove() {}, toggle() {} },
    replaceChildren(...values) { this.children = values.slice(); for (const value of values) value.parent = this },
    append(...values) { for (const value of values) value.parent = this; this.children.push(...values) },
    appendChild(value) { value.parent = this; this.children.push(value); return value },
    setAttribute(name, value) {
      node.attributes[name] = String(value)
      if (name.startsWith('data-')) node.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value)
    },
    getAttribute(name) {
      if (name === 'src') return node.src || null
      return Object.hasOwn(node.attributes, name) ? node.attributes[name] : null
    },
    removeAttribute(name) {
      delete node.attributes[name]
      if (name === 'src') node.src = ''
      if (name === 'data-state') delete node.dataset.state
    },
    querySelector(selector) { return descendants(node).find((child) => matches(child, selector)) || null },
    querySelectorAll(selector) { return descendants(node).filter((child) => matches(child, selector)) },
    closest(selector) { let current = node.parent; while (current) { if (matches(current, selector)) return current; current = current.parent } return null },
    focus() { throw new Error('harness focus stub was not replaced') },
    addEventListener(type, fn) { node.listeners[type] = fn },
    dispatchEvent() {},
    isConnected: true
  }
  return node
}

function textOf(node) {
  let value = node.textContent || ''
  for (const child of node.children || []) value += textOf(child)
  return value
}

function harness(options = {}) {
  const elements = new Map()
  const callbacks = {}
  const focusCalls = []
  const listCalls = []
  const previewCalls = []
  const detailCalls = []
  const deferredDetail = []
  const detailStats = { active: 0, maxActive: 0 }
  const counts = { previews: 0, detail: 0, close: 0 }
  const get = (id) => {
    if (!elements.has(id)) {
      const node = makeElement('div', id)
      node.focus = () => focusCalls.push(id)
      elements.set(id, node)
    }
    return elements.get(id)
  }
  for (const id of ['preview', 'detail', 'media', 'image', 'truncated', 'more', 'new', 'empty', 'feedback']) get(id).hidden = true
  get('list').clientWidth = 469
  get('list').clientHeight = 300
  // A hidden overlay has no layout yet; the renderer falls back to a finite box.
  get('previewBody').clientWidth = 0
  get('previewBody').clientHeight = 0

  const items = options.items || [
    {
      id: 'img-1', kind: 'image', width: 1280, height: 720, isPinned: false,
      previewText: '', sourceDisplayName: 'Snipper', createdAt: 1792720271035,
      lastCopiedAt: 1792720271035, lastUsedAt: 0, byteLength: 2048
    }
  ]

  const api = {
    ready() {}, interactive() {}, close() { counts.close++ },
    list(args) { listCalls.push(args); return Promise.resolve({ ok: true, result: { items, cursor: null } }) },
    detail(id) {
      detailCalls.push(id); counts.detail++
      detailStats.active++
      detailStats.maxActive = Math.max(detailStats.maxActive, detailStats.active)
      if (options.manualDetail) {
        return new Promise((resolve) => {
          deferredDetail.push({
            id,
            resolve: () => {
              detailStats.active--
              resolve({ ok: true, result: { text: options.detailText || 'needle', truncated: false, kind: 'text' } })
            }
          })
        })
      }
      const answer = options.detail ? options.detail(id) : { text: '', truncated: false, kind: 'text' }
      detailStats.active--
      return Promise.resolve(answer && answer.ok === false ? answer : { ok: true, result: answer })
    },
    previews(ids) {
      const copy = Array.from(ids)
      previewCalls.push(copy); counts.previews++
      if (typeof options.previews === 'function') return Promise.resolve(options.previews(copy))
      return Promise.resolve({ ok: true, result: copy.map((id) => ({ id, url: `highlighter-clipboard://preview/${id}` })) })
    },
    status() { return Promise.resolve({ ok: true, result: { phase: 'running', itemCount: items.length } }) },
    copy() { return Promise.resolve({ ok: true, result: {} }) },
    paste() { return Promise.resolve({ ok: true, result: {} }) },
    setPinned() { return Promise.resolve({ ok: true, result: {} }) },
    delete() { return Promise.resolve({ ok: true, result: {} }) },
    prepareClear() { return Promise.resolve({ ok: true, result: { canceled: true } }) },
    commitClear() { return Promise.resolve({ ok: true, result: {} }) },
    setPaused() { return Promise.resolve({ ok: true, result: {} }) }
  }
  for (const name of ['Init', 'Hidden', 'PasteResult', 'Status', 'History', 'Language']) {
    api[`on${name}`] = (fn) => { callbacks[name] = fn; return () => {} }
  }

  const media = { addEventListener() {}, removeEventListener() {} }
  const document = {
    getElementById: get,
    createElement: (tag) => makeElement(tag),
    documentElement: { classList: { toggle() {} }, style: { setProperty() {} } },
    body: { classList: { add() {}, remove() {}, toggle() {} } },
    querySelectorAll: () => []
  }
  const context = {
    window: {
      clipboardAPI: api,
      clipboardLayout: require(path.join(root, 'clipboard', 'clipboard-layout.js')),
      clipboardPreview: preview,
      devicePixelRatio: 1,
      addEventListener() {},
      matchMedia: () => media
    },
    document,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    ResizeObserver: class { observe() {} },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    setTimeout, clearTimeout, setImmediate,
    crypto: require('node:crypto').webcrypto,
    t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
    setLanguage() {}, applyTranslations() {}, currentLanguage: () => 'en-US'
  }
  vm.runInNewContext(script, context)
  return {
    api, callbacks, counts, focusCalls, listCalls, previewCalls, detailCalls, deferredDetail, detailStats, get, document,
    init: (payload = { language: 'en-US' }) => callbacks.Init(payload)
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))
const settle = async (count = 4) => { for (let index = 0; index < count; index++) await tick() }
const keyEvent = (key, extra = {}) => ({ key, isComposing: false, preventDefault() {}, stopPropagation() {}, ...extra })

function nodeById(node, id) {
  return node.querySelectorAll('[data-item-id]').find((child) => child.getAttribute('data-item-id') === id)
}

test('Space opens a scaled preview with dimensions and creation time, and Space closes it', async () => {
  const h = harness()
  h.init()
  await settle()
  const tile = nodeById(h.get('rows'), 'img-1')
  assert.ok(tile, 'the image plate mounted')
  tile.onclick()
  h.get('list').onkeydown(keyEvent(' '))
  assert.equal(h.get('preview').hidden, false, 'Space opens the overlay')
  const image = h.get('previewBody').children.find((child) => child.tagName === 'img')
  assert.ok(image, 'the overlay holds exactly the selected image')
  assert.equal(h.get('previewBody').children.length, 1)
  assert.equal(image.getAttribute('src'), 'highlighter-clipboard://preview/img-1', 'the grid URL is reused, no new token')
  // 1280x720 in the fallback 360x300 box, capped at 2x: 360x202.
  assert.equal(image.width, 360)
  assert.equal(image.height, 202)
  assert.match(h.get('previewMeta').textContent, /clipboard\.image-size/)
  assert.match(h.get('previewMeta').textContent, /clipboard\.preview-created/)
  assert.match(h.get('previewMeta').textContent, /Snipper/)
  assert.equal(h.focusCalls.at(-1), 'previewClose', 'focus moves into the dialog')

  h.get('preview').onkeydown(keyEvent(' '))
  assert.equal(h.get('preview').hidden, true, 'the same key closes the overlay')
  assert.equal(h.get('previewBody').children.length, 0, 'the image element is detached')
  assert.equal(image.getAttribute('src'), null, 'the capability src is removed before the element is dropped')
  assert.equal(h.focusCalls.at(-1), 'list', 'focus returns to the list, hence to the original item')
})

test('Escape closes the preview before the detail sheet and the panel', async () => {
  const h = harness()
  h.init()
  await settle()
  nodeById(h.get('rows'), 'img-1').onclick()
  h.get('list').onkeydown(keyEvent(' '))
  assert.equal(h.get('preview').hidden, false)
  h.get('preview').onkeydown(keyEvent('Escape'))
  assert.equal(h.get('preview').hidden, true)
  assert.equal(h.counts.close, 0, 'Escape must not close the whole panel while a preview is open')
  // With no preview open, Escape still reaches the pre-existing handler.
  h.document.onkeydown(keyEvent('Escape'))
  assert.equal(h.counts.close, 1)
})

test('30 consecutive previews leave one image at a time and reuse the issued token', async () => {
  const h = harness()
  h.init()
  await settle()
  nodeById(h.get('rows'), 'img-1').onclick()
  assert.equal(h.previewCalls.length, 1, 'the first render issued one thumbnail batch')
  for (let index = 0; index < 30; index++) {
    h.get('list').onkeydown(keyEvent(' '))
    assert.equal(h.get('preview').hidden, false, `preview ${index + 1} opened`)
    assert.equal(h.get('previewBody').children.length, 1, `preview ${index + 1} mounted exactly one image`)
    h.get('preview').onkeydown(keyEvent(' '))
    assert.equal(h.get('preview').hidden, true, `preview ${index + 1} closed`)
    assert.equal(h.get('previewBody').children.length, 0, `preview ${index + 1} released its image`)
  }
  assert.equal(h.previewCalls.length, 1, 'the cached capability URL is reused, so 30 previews issued no extra tokens')
  // Hiding the panel is the main process's revocation point; the renderer has
  // to drop its own copy of the resource first.
  h.get('list').onkeydown(keyEvent(' '))
  assert.equal(h.get('previewBody').children.length, 1)
  h.callbacks.Hidden()
  assert.equal(h.get('preview').hidden, true, 'hide closes the overlay')
  assert.equal(h.get('previewBody').children.length, 0, 'hide releases the image')
})

test('a plate without a URL is loaded lazily, then the preview reuses that URL', async () => {
  const h = harness({
    previews: (ids) => {
      // The first batch (the grid) fails for this record; the preview's own
      // request succeeds and repairs both the overlay and the tile cache.
      if (h.previewCalls.length === 1) return { ok: true, result: ids.map((id) => ({ id, error: 'NOT_FOUND' })) }
      return { ok: true, result: ids.map((id) => ({ id, url: `highlighter-clipboard://preview/${id}` })) }
    }
  })
  h.init()
  await settle()
  assert.equal(h.get('rows').querySelector('.tile[data-item-id]').getAttribute('data-state'), 'failed')
  nodeById(h.get('rows'), 'img-1').onclick()
  h.get('list').onkeydown(keyEvent(' '))
  await settle()
  assert.equal(h.counts.previews, 2, 'the preview issued exactly one lazy request')
  const image = h.get('previewBody').children.find((child) => child.tagName === 'img')
  assert.equal(image.getAttribute('src'), 'highlighter-clipboard://preview/img-1')
  h.get('preview').onkeydown(keyEvent('Escape'))
  h.get('list').onkeydown(keyEvent(' '))
  assert.equal(h.counts.previews, 2, 'the repaired URL is cached for later previews')
})

test('opening and closing the preview preserves the selection, filters and focus target', async () => {
  const h = harness()
  h.init()
  await settle()
  h.get('search').value = 'needle'
  h.get('refresh').onclick()
  await settle()
  nodeById(h.get('rows'), 'img-1').onclick()
  h.get('list').onkeydown(keyEvent(' '))
  h.get('preview').onkeydown(keyEvent('Escape'))
  assert.equal(h.get('search').value, 'needle', 'the active search is untouched')
  const tile = nodeById(h.get('rows'), 'img-1')
  assert.equal(tile.getAttribute('aria-selected'), 'true', 'the same record stays selected')
  assert.equal(h.focusCalls.at(-1), 'list')
  assert.equal(h.listCalls.at(-1).search, 'needle', 'the filter state did not change')
})

test('Space still opens the full-text sheet for a text record', async () => {
  const items = [{
    id: 'text-0', kind: 'text', previewText: 'plain text', isPinned: false,
    sourceDisplayName: 'Editor', createdAt: 1792720271035, lastCopiedAt: 1792720271035, lastUsedAt: 0, byteLength: 10
  }]
  const h = harness({ items, detail: () => ({ text: 'plain text', truncated: false, kind: 'text' }) })
  h.init()
  await settle()
  nodeById(h.get('rows'), 'text-0').onclick()
  h.get('list').onkeydown(keyEvent(' '))
  assert.equal(h.get('preview').hidden, true, 'text records do not get an image preview')
  assert.equal(h.get('detail').hidden, false, 'the existing full-text behaviour is unchanged')
  assert.equal(h.counts.detail, 1)
})

test('a hit in the stored preview is highlighted without a detail request', async () => {
  const items = [{
    id: 'text-1', kind: 'text', previewText: 'prefix NEEDLE suffix', isPinned: false,
    sourceDisplayName: 'Editor', createdAt: 1792720271035, lastCopiedAt: 1792720271035, lastUsedAt: 0, byteLength: 22
  }]
  const h = harness({ items })
  h.init()
  await settle()
  h.get('search').value = 'needle'
  h.get('refresh').onclick()
  await settle()
  const span = nodeById(h.get('rows'), 'text-1').querySelector('.row-preview')
  assert.equal(textOf(span), 'prefix NEEDLE suffix')
  assert.equal(span.querySelector('.snippet-hit').textContent, 'NEEDLE')
  assert.equal(h.counts.detail, 0, 'the 500-character preview already contained the hit')
})

test('a hit at the end of a long text is visible in the row, not just after opening detail', async () => {
  const longText = 'A'.repeat(300) + 'needle' + 'B'.repeat(10)
  const items = [{
    id: 'text-2', kind: 'text', previewText: 'short stored preview without the hit', isPinned: false,
    sourceDisplayName: 'Editor', createdAt: 1792720271035, lastCopiedAt: 1792720271035, lastUsedAt: 0, byteLength: longText.length
  }]
  const h = harness({ items, detail: () => ({ text: longText, truncated: false, kind: 'text' }) })
  h.init()
  await settle()
  h.get('search').value = 'needle'
  h.get('refresh').onclick()
  await settle(8)
  assert.equal(h.counts.detail, 1, 'the row asked for the full text exactly once')
  const span = nodeById(h.get('rows'), 'text-2').querySelector('.row-preview')
  const text = textOf(span)
  assert.ok(text.startsWith('…'), 'the fragment starts after the cut')
  assert.ok(text.endsWith('needle' + 'B'.repeat(10)), 'the hit and its tail are inside the visible fragment')
  assert.equal(span.querySelector('.snippet-hit').textContent, 'needle', 'the hit is marked')
  assert.equal(h.detailCalls[0], 'text-2')
})

test('snippet lookups are queued, so a fast scroll cannot hit native backpressure', async () => {
  const items = Array.from({ length: 20 }, (_value, index) => ({
    id: `text-${index}`, kind: 'text', previewText: 'stored preview without the hit', isPinned: false,
    sourceDisplayName: 'Editor', createdAt: 1792720271035, lastCopiedAt: 1792720271035, lastUsedAt: 0, byteLength: 30
  }))
  const h = harness({ items, manualDetail: true })
  h.get('list').clientHeight = 100000 // mount every row at once
  h.init()
  await settle()
  h.get('search').value = 'needle'
  h.get('refresh').onclick()
  await settle()
  // ClipboardService rejects once 16 requests are pending; the queue keeps a
  // burst of mounted rows well below that.
  assert.ok(h.counts.detail <= 4, `only the queue width is in flight (got ${h.counts.detail})`)
  assert.ok(h.detailStats.maxActive <= 4, `max concurrency is bounded (got ${h.detailStats.maxActive})`)
  while (h.deferredDetail.length) {
    const pending = h.deferredDetail.splice(0, h.deferredDetail.length)
    for (const job of pending) job.resolve()
    await settle()
  }
  assert.equal(h.counts.detail, 20, 'every mounted row eventually asked once')
  assert.ok(h.detailStats.maxActive <= 4, 'the bound held while the queue drained')
})

test('a failed detail request falls back to the existing preview text', async () => {
  const items = [{
    id: 'text-3', kind: 'text', previewText: 'fallback preview', isPinned: false,
    sourceDisplayName: 'Editor', createdAt: 1792720271035, lastCopiedAt: 1792720271035, lastUsedAt: 0, byteLength: 15
  }]
  const h = harness({ items, detail: () => ({ ok: false, error: { code: 'NOT_FOUND' } }) })
  h.init()
  await settle()
  h.get('search').value = 'needle'
  h.get('refresh').onclick()
  await settle(8)
  const span = nodeById(h.get('rows'), 'text-3').querySelector('.row-preview')
  assert.equal(textOf(span), 'fallback preview')
  assert.equal(span.querySelector('.snippet-hit'), null)
})

// ---------------------------------------------------------------------------
// 3. source / CSS contract
// ---------------------------------------------------------------------------

test('the preview is an in-panel dialog and the module loads before the renderer', () => {
  assert.match(html, /<section id="preview"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="previewTitle"[^>]*aria-describedby="previewMeta"/)
  assert.match(html, /id="previewClose"[^>]*data-i18n-aria-label="clipboard\.preview-close"/)
  assert.match(html, /id="previewBody"/)
  assert.match(html, /id="previewMeta"/)
  assert.ok(html.indexOf('<script src="clipboard-preview.js"></script>') > 0)
  assert.ok(html.indexOf('<script src="clipboard-preview.js"></script>') < html.indexOf('<script src="clipboard.js"></script>'),
    'the pure helper is defined before the renderer runs')
  assert.doesNotMatch(script, /new BrowserWindow\(/)
})

test('Space discriminates images from text; Enter and Ctrl+Enter are unchanged', () => {
  const spaceBranch = script.slice(script.indexOf("else if (event.key === ' ')"), script.indexOf('document.onkeydown'))
  assert.match(spaceBranch, /item\.kind === 'image'/)
  assert.match(spaceBranch, /openPreview\(\)/)
  assert.match(spaceBranch, /openDetail\(\)/)
  assert.match(script, /perform\(event\.ctrlKey \|\| event\.metaKey \? 'paste' : 'copy'\)/)
  assert.match(script, /event\.key === 'Delete'.*perform\('delete'\)/)
  // IME protection must still gate every keyboard path.
  const guards = script.match(/event\.isComposing \|\| composing/g) || []
  assert.ok(guards.length >= 3, 'list, preview and document handlers all guard IME composition')
})

test('closing restores focus and releases the image instead of caching URLs', () => {
  const closeBody = script.slice(script.indexOf('function closePreview('), script.indexOf('// ---------- A05: search-hit snippet'))
  assert.match(closeBody, /\+\+previewGeneration/)
  assert.match(closeBody, /releasePreviewImage\(\)/)
  assert.match(closeBody, /\$\('list'\)\.focus\(\)/)
  assert.match(closeBody, /scrollSelectionIntoView\(\)/)
  const releaseBody = script.slice(script.indexOf('function releasePreviewImage('), script.indexOf('function markPreviewFailed('))
  assert.match(releaseBody, /removeAttribute\('src'\)/)
  assert.match(releaseBody, /replaceChildren\(\)/)
  assert.doesNotMatch(script, /createObjectURL|Blob\(/)
  assert.doesNotMatch(script, /previewUrls|previewCache/)
  // One lazy request per open, for the selected id only.
  assert.match(script, /api\.previews\(\[item\.id\]\)/)
  // A filter change and the hide path both retire the overlay and the cached
  // detail text; hide must not steal focus back into a window about to go away.
  const refreshBody = script.slice(script.indexOf('async function refresh('), script.indexOf('// Trimming past 150'))
  assert.match(refreshBody, /closePreview\(\{ restoreFocus: false \}\)/)
  assert.match(refreshBody, /resetSnippets\(\)/)
  const clearBody = script.slice(script.indexOf('function clearHistory()'), script.indexOf('applyTranslations()', script.indexOf('function clearHistory()')))
  assert.match(clearBody, /closePreview\(\{ restoreFocus: false \}\)/)
  assert.match(clearBody, /resetSnippets\(\)/)
  assert.match(script, /api\.onHidden\(clearHistory\)/)
})

test('the preview uses the 2x scale cap, the pure fragment cut and no new browser window', () => {
  assert.equal(preview.MAX_PREVIEW_SCALE, 2)
  assert.equal(preview.DEFAULT_RADIUS, 48)
  assert.match(script, /previewApi\.fitPreview\(/)
  assert.match(script, /maxScale: PREVIEW_MAX_SCALE/)
  assert.match(script, /previewApi\.snippetAround\(/)
  assert.match(script, /naturalWidth/)
  assert.match(moduleSource, /codePoints/)
  assert.doesNotMatch(moduleSource, /\bBuffer\b|\bTextEncoder\b|\bBlob\b|\bdocument\b/)
})

test('the two densities only change the text row height', () => {
  const compact = css.match(/body\.compact #list\s*\{([^}]*)\}/)
  assert.ok(compact, 'clipboard.css declares the compact density')
  assert.match(compact[1], /--row-h:\s*\d+px/)
  assert.doesNotMatch(compact[1], /--cell-h|--grid-gap|--grid-pad-x|--tile-/,
    'compact must not move the image grid or its gaps')
  assert.match(script, /classList\.toggle\('compact', data\.compact === true\)/)
  assert.match(script, /layoutApi\.layout\(items, \{ rowH: metrics\.rowH, cellH: metrics\.cellH, gap: metrics\.gap, cols \}\)/,
    'row positions still come from the shared layout model')
})

test('the highlight and preview styles stay inside the FILM token ladder', () => {
  const hit = css.match(/\.snippet-hit\s*\{([^}]*)\}/)
  assert.ok(hit, 'the hit has a style block')
  assert.match(hit[1], /var\(--primary-text\)/)
  assert.match(hit[1], /var\(--primary-soft\)/)
  const body = css.match(/\.preview-body\s*\{([^}]*)\}/)
  assert.ok(body, 'the preview body has a style block')
  assert.match(body[1], /var\(--surface-2\)/)
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'no raw colours in the new panel styles')
})

test('the preview copy exists in all three locale tables', () => {
  globalThis.__LOCALES = {}
  const localeFile = path.join(root, 'shared', 'locales', 'clipboard.js')
  delete require.cache[require.resolve(localeFile)]
  require(localeFile)
  const tables = globalThis.__LOCALES
  const keys = ['clipboard.preview-title', 'clipboard.preview-close', 'clipboard.preview-hint', 'clipboard.preview-created']
  for (const language of ['zh-CN', 'en-US', 'zh-TW']) {
    for (const key of keys) {
      assert.equal(typeof tables[language][key], 'string', `${key} exists in ${language}`)
      assert.ok(tables[language][key].length > 0)
    }
    assert.match(tables[language]['clipboard.preview-created'], /\{time\}/, 'the creation label is parameterized')
  }
})
