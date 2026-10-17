'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
test('feedback clears history and invalidates an in-flight page without another query', async () => {
  const elements = new Map(); const callbacks = {}; const counts = { list: 0, detail: 0, preview: 0, status: 0 }
  const element = () => ({ value: '', textContent: '', hidden: false, checked: false, style: {}, scrollTop: 0, clientHeight: 300, children: [],
    replaceChildren() { this.children = [] }, append(...values) { this.children.push(...values) }, setAttribute() {}, removeAttribute() {}, focus() {} })
  const get = (id) => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id) }
  let resolvePage
  const api = { ready() {}, interactive() {}, close() {}, list() { counts.list++; return new Promise((resolve) => { resolvePage = resolve }) },
    detail() { counts.detail++ }, preview() { counts.preview++ }, status() { counts.status++; return { ok: true, result: {} } } }
  for (const name of ['Init', 'Hidden', 'PasteResult', 'Status', 'History', 'Language']) api[`on${name}`] = (fn) => { callbacks[name] = fn; return () => {} }
  const classes = new Set()
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../clipboard/clipboard.js'), 'utf8'), {
    window: { clipboardAPI: api, addEventListener() {} }, document: { getElementById: get, createElement: element,
      body: { classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) } }, documentElement: { classList: { toggle() {} }, style: {} } },
    ResizeObserver: class { observe() {} }, setTimeout, clearTimeout, crypto: require('node:crypto').webcrypto,
    t: (key) => key, setLanguage() {}, applyTranslations() {}, currentLanguage: () => 'zh-CN'
  })
  callbacks.Init({ language: 'zh-CN' })
  assert.equal(counts.list, 1)
  get('text').textContent = 'old synthetic detail'; get('search').value = 'old synthetic search'
  callbacks.PasteResult({ language: 'zh-CN', pasteFeedback: { outcome: 'copiedOnly', reason: 'CLIPBOARD_CHANGED' } })
  assert.equal(classes.has('feedback-only'), true)
  assert.equal(get('text').textContent, ''); assert.equal(get('search').value, ''); assert.equal(get('feedback').hidden, false)
  resolvePage({ ok: true, result: { items: [{ id: 'old', previewText: 'old synthetic record' }] } })
  await new Promise((resolve) => setImmediate(resolve))
  callbacks.History(); callbacks.Status({ itemCount: 99 })
  assert.equal(get('rows').children.length, 0)
  assert.deepEqual(counts, { list: 1, detail: 0, preview: 0, status: 0 })
})
