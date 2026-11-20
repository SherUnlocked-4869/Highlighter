'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
const shellHtml = read('config/config.html')
const scripts = Object.fromEntries([
  'shared/locales/config.js', 'shared/i18n.js', 'config/routes/device-battery.js', 'config/config.js'
].map((file) => [file, read(file)]))
const settle = () => new Promise((resolve) => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const now = Date.UTC(2026, 10, 20, 4, 0)
const system = (overrides = {}) => ({ state: 'ready', percent: 0, charging: false, acOnline: true, ...overrides })
const device = (overrides = {}) => ({
  id: 'mouse', name: 'Mouse', kind: 'mouse', source: 'bluetooth', percent: null, charging: null,
  estimated: false, stale: false, parts: [], ...overrides
})
const snapshot = (revision, overrides = {}) => ({ status: 'ready', updatedAt: now, revision, system: system(), devices: [], ...overrides })
const refreshResult = (value, status = 'complete') => ({ status, snapshot: value })

// A narrow test DOM: the static route template provides the named targets; DOM
// operations performed on live data must work on real node objects, not HTML.
class Node extends EventTarget {
  constructor(tagName) {
    super()
    this.tagName = tagName
    this.children = []
    this.attributes = new Map()
    this.dataset = {}
    this.style = {}
    this.classList = { toggle() {} }
    this.hidden = false
    this.parent = null
    this.writes = []
  }
  set textContent(text) {
    this.replaceChildren()
    this.text = String(text)
    this.writes.push(this.text)
  }
  get textContent() { return (this.text ?? '') + this.children.map((node) => node.textContent).join('') }
  setAttribute(key, value) { this.attributes.set(key, String(value)) }
  removeAttribute(key) { this.attributes.delete(key) }
  getAttribute(key) { return this.attributes.get(key) ?? null }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = null
  }
  insertBefore(node, before) {
    node.remove()
    this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, node)
    node.parent = this
  }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null) }
  replaceChildren(...nodes) {
    for (const node of this.children) node.parent = null
    this.children = []
    this.text = ''
    this.append(...nodes)
  }
  get firstElementChild() { return this.children[0] || null }
  get nextElementSibling() { return this.parent?.children[this.parent.children.indexOf(this) + 1] || null }
}

function makeHarness({ hidden = false, bridge = true, shell = false } = {}) {
  const calls = []
  const reads = []
  const refreshes = []
  const watchers = new Set()
  const document = new EventTarget()
  const view = new Node('main')
  const title = new Node('div')
  const routeButtons = [...shellHtml.matchAll(/data-route="([a-z-]+)"/g)].map(([, route]) => {
    const button = new Node('button')
    button.dataset.route = route
    return button
  })
  const ids = new Map()
  let markup = ''
  let visibleListenerCount = 0
  let navigate, changeLanguage
  const settings = deferred()
  const shortcuts = deferred()
  Object.assign(document, {
    documentElement: { dataset: {} }, hidden,
    createElement: (tag) => new Node(tag),
    getElementById: (id) => ({ view, pageTitle: title })[id] || new Node('div'),
    querySelectorAll: (selector) => selector === '.nav-item' ? routeButtons : [],
    addEventListener(type, handler) { visibleListenerCount++; EventTarget.prototype.addEventListener.call(this, type, handler) },
    removeEventListener(type, handler) { visibleListenerCount--; EventTarget.prototype.removeEventListener.call(this, type, handler) }
  })
  Object.defineProperty(view, 'innerHTML', {
    get: () => markup,
    set(html) {
      markup = html
      document.activeElement = null
      ids.clear()
      for (const [, tag, before, id, after] of html.matchAll(/<([a-z\d]+)\b([^<>]*)\bid="([^"]+)"([^<>]*)>/g)) {
        const node = new Node(tag)
        for (const [, key, value] of (before + after).matchAll(/([a-z-]+)="([^"]+)"/g)) node.setAttribute(key, value)
        ids.set(id, node)
      }
    }
  })
  view.querySelector = (selector) => ids.get(selector.slice(1)) || null
  view.replaceChildren = () => { view.innerHTML = '' }
  const electronAPI = {
    onNavigate(fn) { navigate = fn },
    onGameModeChanged() {}, onHistoryChanged() {}, onUpdateStatus() {},
    onInterfaceLanguage(fn) { changeLanguage = fn },
    getSettings: () => settings.promise,
    reportWindowState({ route, dirty }) { calls.push(['report', route, dirty]) },
    ...(bridge ? {
      onDeviceBatterySnapshot(callback) {
        calls.push('subscribe')
        watchers.add(callback)
        return () => { calls.push('unsubscribe'); watchers.delete(callback) }
      },
      getDeviceBatterySnapshot(...args) {
        calls.push(['get', ...args])
        const request = deferred()
        reads.push(request)
        return request.promise
      },
      refreshDeviceBattery(...args) {
        calls.push(['refresh', ...args])
        const request = deferred()
        refreshes.push(request)
        return request.promise
      }
    } : {})
  }
  const sandbox = {
    document, electronAPI,
    pageHeader: (title, description, extra) => `<div class="page-head"><div><h1>${title}</h1><p>${description}</p></div>${extra}</div>`,
    iconMarkup: () => '<span class="svg-icon" aria-hidden="true"></span>',
    refreshShortcutStatuses: () => shortcuts.promise,
    refreshStatusRail() {}, applyAppearance() {}, modalOverlay: null,
    matchMedia: () => ({ addEventListener() {} })
  }
  if (!shell) Object.assign(sandbox, { view, currentRoute: 'device-battery' })
  sandbox.window = sandbox
  const ctx = vm.createContext(sandbox)
  const run = (code) => vm.runInContext(code, ctx)
  for (const [file, source] of Object.entries(scripts)) {
    if (file === 'config/config.js' && !shell) continue
    vm.runInContext(source, ctx, { filename: file })
  }
  return {
    run, calls, reads, refreshes, watchers, title, settings, shortcuts, routeButtons, document, view,
    get visibilityListeners() { return visibleListenerCount },
    get refresh() { return ids.get('deviceBatteryRefresh') },
    get refreshLabel() { return ids.get('deviceBatteryRefreshLabel') },
    get updated() { return ids.get('deviceBatteryUpdated') },
    get feedback() { return ids.get('deviceBatteryFeedback') },
    get system() { return ids.get('deviceBatterySystem') },
    get empty() { return ids.get('deviceBatteryEmpty') },
    get list() { return ids.get('deviceBatteryDevices') },
    render: (language = 'en-US') => run(`setLanguage('${language}'); window.configRoutes.renderDeviceBattery()`),
    leave: () => run("deviceBatteryDeactivate(); currentRoute = 'home'"),
    navigate: (route) => navigate(route),
    changeLanguage: (language) => changeLanguage(language),
    setHidden(value) { document.hidden = value; document.dispatchEvent(new Event('visibilitychange')) },
    push(value) { for (const callback of watchers) callback(value) },
    clickRefresh() { this.refresh.dispatchEvent(new Event('click')) }
  }
}

const nodeWithClass = (node, cls) => {
  if (node.className?.split(' ').includes(cls)) return node
  for (const child of node.children) {
    const match = nodeWithClass(child, cls)
    if (match) return match
  }
  return null
}

test('the main window places Device Battery in Toolbox and opens the early route after initialization', async () => {
  assert.match(shellHtml, /data-i18n="config.nav.toolbox"[\s\S]*data-route="recording"[^\n]*\r?\n +<button[^>]*data-route="device-battery"[^\n]*\r?\n +<div[^\n]*config.nav.tool-settings/)
  assert.ok(shellHtml.indexOf('<script src="routes/recording.js"></script>') < shellHtml.indexOf('<script src="routes/device-battery.js"></script>'))
  const h = makeHarness({ shell: true })
  h.navigate('device-battery')
  h.settings.resolve({ language: 'zh-CN' })
  await settle()
  h.changeLanguage('en-US')
  assert.deepEqual(h.calls, [], 'a language event during boot must not overwrite queued navigation')
  h.shortcuts.resolve()
  await settle()
  assert.deepEqual(h.calls, [['report', 'device-battery', false], 'subscribe', ['get']])
  assert.equal(h.title.textContent, 'Device Battery')
  assert.equal(h.document.documentElement.lang, 'en-US')
  assert.equal(h.routeButtons.find((button) => button.dataset.route === 'device-battery').getAttribute('aria-current'), 'page')
  h.navigate('device-battery')
  assert.equal(h.reads.length, 1, 'repeat navigation does not duplicate the subscription or read')
  h.changeLanguage('zh-TW')
  assert.equal(h.title.textContent, '裝置電量')
  assert.equal(h.document.documentElement.lang, 'zh-TW')
  assert.equal(h.watchers.size, 1)
  h.navigate('home')
  assert.deepEqual(h.calls.slice(-2), ['unsubscribe', ['report', 'home', false]])
  assert.equal(h.visibilityListeners, 0)
})

test('renders 0%, unknown, power vs charging, estimated and stale values, and Apple parts as plain text', async () => {
  const h = makeHarness()
  h.render()
  assert.equal(h.refresh.tagName, 'button')
  assert.equal(h.refresh.getAttribute('type'), 'button')
  assert.equal(h.feedback.getAttribute('role'), 'status')
  assert.equal(h.list.tagName, 'ul')
  assert.equal(h.empty.textContent, 'Reading battery levels…')
  assert.equal(h.feedback.textContent, '', 'loading does not announce')
  const name = '<img src=x onerror=alert(1)> & "test"'
  const devices = [
    device({ id: 'z', name: 'XInput Pad', kind: 'controller', source: 'gaming', percent: 88, estimated: true }),
    device({ id: 'a', name, percent: 4, stale: true }),
    device({ id: 'b', name: 'Buds', kind: 'earbuds', source: 'apple', parts: [
      { part: 'case', percent: null, charging: null },
      { part: 'right', percent: 20, charging: true },
      { part: 'left', percent: 0, charging: false }
    ] })
  ]
  h.reads[0].resolve(snapshot(1, { devices }))
  await settle()
  assert.match(h.updated.textContent, /^Last checked: /)
  assert.match(h.system.textContent, /^0%Low battery · Not charging · Plugged in$/)
  assert.equal(h.system.firstElementChild.dataset.level, 'low')
  assert.equal(nodeWithClass(h.system, 'device-battery-track').firstElementChild.style.inlineSize, '0%')
  const [named, buds, pad] = h.list.children
  const deviceName = nodeWithClass(named, 'form-label').firstElementChild.firstElementChild
  assert.equal(deviceName.tagName, 'bdi')
  assert.equal(deviceName.textContent, name)
  assert.deepEqual([named, buds, pad].map((row) => {
    const icon = nodeWithClass(row, 'device-battery-icon')
    assert.equal(icon.getAttribute('aria-hidden'), 'true')
    assert.equal(icon.nextElementSibling, nodeWithClass(row, 'form-label'))
    return icon.dataset.kind
  }), ['mouse', 'earbuds', 'controller'])
  assert.match(named.textContent, /Windows Bluetooth.*Last reading, may be out of date.*4%/)
  assert.doesNotMatch(named.textContent, /[Cc]harging|Low battery/)
  assert.doesNotMatch(h.view.innerHTML, /<img/)
  const parts = nodeWithClass(buds, 'device-battery-parts')
  assert.equal(parts.tagName, 'ul')
  assert.deepEqual(parts.children.map((item) => item.firstElementChild.textContent), ['Left earbud', 'Right earbud', 'Charging case'])
  assert.equal(parts.children[0].children[1].dataset.level, 'low')
  assert.equal(parts.children[1].children[1].dataset.level, 'warning')
  assert.match(parts.children[1].textContent, /20%Battery getting low · Charging/)
  assert.equal(nodeWithClass(parts.children[2], 'device-battery-track'), null)
  assert.match(parts.children[2].textContent, /Battery level not reported/)
  assert.match(pad.textContent, /88%Estimated/)
  // Reversed provider order and a lower battery level must not move rows or
  // rebuild unaffected row contents.
  const oldLabel = named.firstElementChild
  h.push(snapshot(2, { devices: [devices[2], devices[1], { ...devices[0], percent: 1 }] }))
  assert.deepEqual(h.list.children, [named, buds, pad])
  assert.equal(named.firstElementChild, oldLabel)
  assert.equal(h.feedback.textContent, '', 'routine changes are silent')
})

test('snapshot revisions order both initial and manual replies against pushes', async () => {
  const h = makeHarness()
  h.render()
  assert.deepEqual(h.calls, ['subscribe', ['get']])
  h.push(snapshot(3, { system: system({ percent: 50 }) }))
  h.reads[0].resolve(snapshot(2))
  await settle()
  assert.match(h.system.textContent, /^50%/)
  const button = h.refresh
  h.document.activeElement = button
  h.clickRefresh()
  h.clickRefresh()
  assert.equal(h.feedback.textContent, '')
  assert.deepEqual(h.calls.slice(2), [['refresh']])
  assert.equal(button.getAttribute('aria-disabled'), 'true')
  assert.equal(h.refreshLabel.textContent, 'Refreshing…')
  h.push(snapshot(4, { system: system({ percent: 60 }) }))
  h.refreshes[0].resolve(refreshResult(snapshot(3)))
  await settle()
  assert.match(h.system.textContent, /^60%/)
  assert.match(h.feedback.textContent, /^Refresh complete\./)
  assert.equal(h.refreshLabel.textContent, 'Refresh')
  assert.equal(h.document.activeElement, button)
  assert.equal(h.refresh, button)
  assert.equal(button.getAttribute('aria-disabled'), 'false')
})

test('only announces meaningful failures, recovery and explicit refresh feedback', async () => {
  const h = makeHarness()
  h.render()
  h.reads[0].reject(new Error('SECRET path'))
  await settle()
  assert.equal(h.feedback.textContent, 'Battery data could not be read. Try again in a moment.')
  h.push(snapshot(1, { status: 'unavailable', updatedAt: null, system: system({ state: 'unavailable' }) }))
  assert.equal(h.feedback.writes.length, 1, 'do not announce the same failure again')
  assert.equal(h.empty.textContent, 'External device battery levels could not be read.')
  h.push(snapshot(2, { status: 'partial', devices: [device()] }))
  assert.equal(h.list.hidden, false)
  assert.match(h.feedback.textContent, /Available readings are still shown/)
  assert.match(h.list.textContent, /Battery level not reported/)
  h.push(snapshot(3, { status: 'partial', devices: [device({ percent: 10 })] }))
  assert.equal(h.feedback.writes.length, 2)
  h.push(snapshot(4, { status: 'paused', updatedAt: null, devices: [device({ percent: 2 })] }))
  assert.match(h.updated.textContent, /paused/)
  assert.match(h.list.textContent, /Last reading, may be out of date/)
  assert.doesNotMatch(h.list.textContent, /Low battery/)
  h.push(snapshot(5, { system: system({ state: 'no-battery', percent: null, charging: null }) }))
  assert.match(h.system.textContent, /^This PC has no batteryPlugged in/)
  assert.equal(h.empty.textContent, 'No readable external devices detected.')
  assert.equal(h.feedback.textContent, 'Battery readings are available again.')
  h.push(snapshot(6))
  assert.equal(h.feedback.writes.length, 3, 'regular updates do not mutate the live text')
  h.clickRefresh()
  h.refreshes[0].reject(new Error('SECRET path'))
  await settle()
  assert.equal(h.feedback.textContent, 'Could not request a refresh. Try again in a moment.')
  assert.match(h.system.textContent, /^0%/, 'failed refresh keeps existing readings')
})

test('manual partial results update the existing list and a timeout preserves the last reading', async () => {
  const h = makeHarness()
  h.render()
  h.reads[0].resolve(snapshot(1, { devices: [device({ percent: 40 })] }))
  await settle()
  h.clickRefresh()
  const row = h.list.firstElementChild
  assert.match(row.textContent, /40%/)
  const result = snapshot(2, { devices: [device({ percent: 38 })] })
  h.refreshes[0].resolve(refreshResult(result, 'partial'))
  await settle()
  assert.equal(h.list.firstElementChild, row)
  assert.match(row.textContent, /38%/)
  assert.match(h.feedback.textContent, /^Some readings could not be retrieved/)
  h.clickRefresh()
  h.refreshes[1].resolve(refreshResult(result, 'timeout'))
  await settle()
  assert.match(row.textContent, /38%/)
  assert.match(h.feedback.textContent, /^Refresh timed out/)
  assert.equal(h.refresh.getAttribute('aria-disabled'), 'false')
})

test('initially hidden, hidden during a read, re-shown and leaving the route invalidate old work', async () => {
  const h = makeHarness({ hidden: true })
  h.render()
  assert.deepEqual(h.calls, [])
  h.setHidden(false)
  const firstPush = [...h.watchers][0]
  h.setHidden(true)
  assert.deepEqual(h.calls, ['subscribe', ['get'], 'unsubscribe'])
  h.setHidden(false)
  h.setHidden(false)
  assert.equal(h.watchers.size, 1)
  assert.equal(h.reads.length, 2, 'show requests exactly once')
  h.reads[0].resolve(snapshot(100, { devices: [device()] }))
  firstPush(snapshot(100, { devices: [device()] }))
  h.reads[1].resolve(snapshot(2))
  await settle()
  assert.equal(h.list.children.length, 0)
  assert.equal(h.empty.textContent, 'No readable external devices detected.')

  h.clickRefresh()
  h.setHidden(true)
  h.refreshes[0].resolve(refreshResult(snapshot(101, { devices: [device()] })))
  await settle()
  assert.equal(h.list.children.length, 0)
  assert.equal(h.feedback.textContent, '')
  h.setHidden(false)
  h.clickRefresh()
  const lastPush = [...h.watchers][0]
  const detachedList = h.list
  const detachedFeedback = h.feedback
  const detachedRefresh = h.refresh
  h.leave()
  assert.equal(h.view.innerHTML, '')
  h.reads[2].resolve(snapshot(102, { devices: [device()] }))
  h.refreshes[1].resolve(refreshResult(snapshot(103, { devices: [device()] })))
  lastPush(snapshot(104, { devices: [device()] }))
  await settle()
  h.setHidden(true)
  h.setHidden(false)
  detachedRefresh.dispatchEvent(new Event('click'))
  assert.equal(h.watchers.size, 0)
  assert.equal(h.visibilityListeners, 0)
  assert.equal(h.reads.length, 3)
  assert.equal(h.refreshes.length, 2)
  assert.equal(detachedList.children.length, 0)
  assert.equal(detachedFeedback.textContent, '')
})

test('shows localized missing-bridge feedback instead of a fake empty result', () => {
  const names = { 'zh-CN': '设备电量', 'en-US': 'Device Battery', 'zh-TW': '裝置電量' }
  for (const [language, name] of Object.entries(names)) {
    const h = makeHarness({ bridge: false })
    h.render(language)
    assert.ok(h.view.innerHTML.includes(`<h1>${name}</h1>`))
    assert.ok(!h.view.innerHTML.includes('config.device-battery.'))
    assert.equal(h.refresh.getAttribute('aria-disabled'), 'true')
    assert.ok(h.feedback.textContent.includes(name) || language === 'en-US' && /this build/.test(h.feedback.textContent))
    assert.ok(!h.empty.textContent.includes('config.device-battery.'))
    assert.deepEqual(h.calls, [])
  }
})
