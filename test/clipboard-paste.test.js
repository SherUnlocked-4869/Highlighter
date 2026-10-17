'use strict'
// Mock-only regression cases: no native process, real windows or clipboard IO.
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const path = require('node:path')
const { createClipboardDomain } = require('../main/domains/clipboard')
const { ClipboardService } = require('../main/services/clipboard-service')
const { buildIpcPolicies } = require('../main/services/ipc-security')
const id = '11111111-1111-4111-8111-111111111111'
const operationId = '22222222-2222-4222-8222-222222222222'
const tick = () => new Promise((resolve) => setImmediate(resolve))
function harness(releaseAfterMs = 0) {
  const handlers = new Map(); const listeners = new Map(); const calls = []; let win
  const domain = createClipboardDomain({
    app: { isPackaged: false }, rootDirectory: path.resolve(__dirname, '..'), directory: 'unused',
    nativeTheme: {}, getSettings: () => ({ clipboard: { enabled: true, releaseAfterMs } }),
    getHook: () => null, isGameModeEnabled: () => false, isMigrationInProgress: () => false,
    positionAutomationWindow() {},
    screen: { getCursorScreenPoint: () => ({}), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 900 } }), getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 900 } }) },
    session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, protocol: { handle() {}, unhandle() {} } }) },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: (name, handler) => listeners.set(name, handler) },
    createLocalWindow: () => {
      win = new EventEmitter(); win.visible = false; win.focused = false; win.destroyed = false
      win.messages = []; win.bounds = { x: 100, y: 100, width: 480, height: 640 }; win.minimum = [380, 420]; win.focusable = true
      win.getBounds = () => ({ ...win.bounds }); win.setBounds = (value) => { win.bounds = value }
      win.getMinimumSize = () => win.minimum; win.setMinimumSize = (...value) => { win.minimum = value }
      win.setFocusable = (value) => { win.focusable = value }
      win.webContents = new EventEmitter(); win.webContents.id = 1; win.webContents.send = (channel, data) => win.messages.push({ channel, data }); win.webContents.isDestroyed = () => win.destroyed
      win.isDestroyed = () => win.destroyed; win.isVisible = () => win.visible; win.isFocused = () => win.focused
      win.getNativeWindowHandle = () => Buffer.from('3412000000000000', 'hex')
      win.loadFile = async () => {}
      win.show = () => { calls.push('show'); win.visible = true }
      win.showInactive = () => { calls.push('showInactive'); win.visible = true }
      win.focus = () => { win.focused = true }
      win.hide = () => { calls.push('hide'); win.visible = false; win.focused = false; win.emit('blur') }
      win.destroy = () => { calls.push('destroy'); win.destroyed = true; win.emit('closed') }
      return win
    }
  })
  let prepare = async () => ({ copied: true, ticket: 'private-ticket' })
  domain.service.allowPasteForeground = () => { assert.equal(win.visible, true); assert.equal(win.focused, true); calls.push('foreground-grant'); return true }
  let commit = async () => ({ copied: true, outcome: 'injected' })
  domain.service.command = async (method, args) => {
    calls.push(method)
    if (method === 'paste.capture') { assert.equal(win.visible, false); return { targetId: 'private-target' } }
    if (method === 'paste.prepare') { assert.equal(args.targetId, 'private-target'); return prepare() }
    if (method === 'paste.commit') { assert.equal(win.visible, false); assert.equal(win.destroyed, false); return commit() }
    if (method === 'paste.cancel') return { copied: true, outcome: 'copiedOnly', reason: 'FOCUS_CHANGED' }
    return {}
  }
  return { domain, calls, get win() { return win },
    prepare: (fn) => { prepare = fn },
    commit: (fn) => { commit = fn },
    async open() { domain.show(); listeners.get('clipboard:ready')({ sender: win.webContents }); await tick() },
    paste: (args = { id, operationId }) => handlers.get('clipboard:paste')({ sender: win.webContents }, args)
  }
}

test('clipboard change shows immediate, inactive feedback without reinitializing history', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness(); await h.open()
  h.commit(async () => ({ copied: true, outcome: 'copiedOnly', reason: 'CLIPBOARD_CHANGED' }))
  h.win.messages.length = 0
  await h.paste()
  assert.equal(h.win.visible, true); assert.equal(h.win.focusable, false); assert.equal(h.win.focused, false)
  assert.equal(h.win.bounds.height, 148)
  assert.deepEqual(h.win.messages.map((value) => value.channel), ['clipboard:hidden', 'clipboard:paste-result'])
  assert.equal(h.win.messages[1].data.pasteFeedback.reason, 'CLIPBOARD_CHANGED')
  t.mock.timers.tick(3999); assert.equal(h.win.destroyed, false)
  t.mock.timers.tick(1); assert.equal(h.win.destroyed, true)
})

test('new shortcut restores normal panel and cancels feedback expiry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness(60000); await h.open()
  h.commit(async () => { throw Object.assign(new Error('unknown'), { code: 'PASTE_OUTCOME_UNKNOWN' }) })
  assert.equal((await h.paste()).error.code, 'PASTE_OUTCOME_UNKNOWN')
  assert.equal(h.win.focusable, false)
  h.domain.show(); await tick()
  assert.equal(h.win.bounds.height, 640); assert.equal(h.win.focusable, true); assert.equal(h.win.focused, true)
  t.mock.timers.tick(4000); assert.equal(h.win.visible, true)
  assert.equal(h.win.messages.at(-1).channel, 'clipboard:init')
  assert.equal(h.win.messages.at(-1).data.pasteFeedback, undefined)
  h.domain.hide()
})

test('explicit close during commit prevents fallback resurrection', async () => {
  const h = harness(); await h.open()
  let complete; h.commit(() => new Promise((resolve) => { complete = resolve }))
  const pending = h.paste(); await tick(); h.domain.hide()
  complete({ copied: true, outcome: 'copiedOnly', reason: 'CLIPBOARD_CHANGED' }); await pending
  assert.equal(h.win.destroyed, true)
  assert.equal(h.calls.includes('showInactive'), false)
})

test('paste captures before focus, copies before hiding, and keeps an immediate-release panel alive until commit', async () => {
  const h = harness(); await h.open()
  const value = await h.paste()
  assert.deepEqual(value, { ok: true, result: { copied: true, outcome: 'injected', reason: undefined } })
  assert.deepEqual(h.calls.filter((call) => call !== 'paste.clear'), ['paste.capture', 'show', 'paste.prepare', 'foreground-grant', 'hide', 'paste.commit', 'destroy'])
})
test('losing focus while preparing cancels input and never commits', async () => {
  const h = harness(); await h.open()
  let complete; h.prepare(() => new Promise((resolve) => { complete = resolve }))
  const operation = h.paste(); h.win.focused = false; h.win.emit('blur')
  complete({ copied: true, ticket: 'private-ticket' })
  assert.equal((await operation).result.outcome, 'copiedOnly')
  assert.equal(h.calls.includes('paste.commit'), false)
  assert.equal(h.calls.includes('foreground-grant'), false)
  assert.equal(h.calls.includes('paste.cancel'), true)
})
test('extra target/key fields and concurrent clicks cannot request another paste', async () => {
  const h = harness(); await h.open()
  assert.equal((await h.paste({ id, operationId, targetId: 'attacker' })).error.code, 'INVALID_ARGUMENT')
  let complete; h.prepare(() => new Promise((resolve) => { complete = resolve }))
  const first = h.paste()
  assert.equal((await h.paste()).error.code, 'OPERATION_BUSY')
  complete({ copied: true, outcome: 'copiedOnly', reason: 'TARGET_UNAVAILABLE' }); await first
  assert.equal(h.calls.filter((method) => method === 'paste.prepare').length, 1)
  h.domain.hide()
})
test('paste timeout is unknown and never replays; only clipboard windows own the channel', async () => {
  const service = new ClipboardService({ executable: 'unused', directory: 'unused', getHook: () => null })
  service.stopping = true
  service.child = { stdin: { writableLength: 0, write() {} }, kill() {} }
  const pending = service.request('paste.commit', { ticket: 'private-ticket' })
  service.failChild(service.child, 'BACKEND_TIMEOUT')
  await assert.rejects(pending, { code: 'PASTE_OUTCOME_UNKNOWN' })
  assert.equal(service.pending.size, 0)
  const policy = buildIpcPolicies(path.resolve(__dirname, '..')).get('clipboard:paste')
  assert.deepEqual(policy.pages.map((page) => page.role), ['clipboard'])
})

test('foreground permission uses only the live backend PID and rejects invalid or stopped children', { skip: process.platform !== 'win32' }, () => {
  const SelectionHook = require('selection-hook')
  const original = SelectionHook.allowSetForegroundWindow
  const calls = []
  const service = new ClipboardService({ executable: 'unused', directory: 'unused', getHook: () => null })
  SelectionHook.allowSetForegroundWindow = (pid) => { calls.push(pid); return true }
  try {
    assert.equal(service.allowPasteForeground(), false)
    service.child = { pid: 12345 }
    assert.equal(service.allowPasteForeground(98765), true)
    assert.deepEqual(calls, [12345])
    service.stopping = true; assert.equal(service.allowPasteForeground(), false)
    service.stopping = false; service.disposed = true; assert.equal(service.allowPasteForeground(), false)
    service.disposed = false
    for (const pid of [0, -1, 0xffffffff, NaN, 1.5]) { service.child = { pid }; assert.equal(service.allowPasteForeground(), false) }
    assert.deepEqual(calls, [12345])
  } finally { SelectionHook.allowSetForegroundWindow = original }
})
