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
    screen: { getCursorScreenPoint: () => ({}), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 900 } }) },
    session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, protocol: { handle() {}, unhandle() {} } }) },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: (name, handler) => listeners.set(name, handler) },
    createLocalWindow: () => {
      win = new EventEmitter(); win.visible = false; win.focused = false; win.destroyed = false
      win.webContents = new EventEmitter(); win.webContents.id = 1; win.webContents.send = () => {}; win.webContents.isDestroyed = () => win.destroyed
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
  domain.service.command = async (method, args) => {
    calls.push(method)
    if (method === 'paste.capture') { assert.equal(win.visible, false); return { targetId: 'private-target' } }
    if (method === 'paste.prepare') { assert.equal(args.targetId, 'private-target'); return prepare() }
    if (method === 'paste.commit') { assert.equal(win.visible, false); assert.equal(win.destroyed, false); return { copied: true, outcome: 'injected' } }
    if (method === 'paste.cancel') return { copied: true, outcome: 'copiedOnly', reason: 'FOCUS_CHANGED' }
    return {}
  }
  return { domain, calls, get win() { return win },
    prepare: (fn) => { prepare = fn },
    async open() { domain.show(); listeners.get('clipboard:ready')({ sender: win.webContents }); await tick() },
    paste: (args = { id, operationId }) => handlers.get('clipboard:paste')({ sender: win.webContents }, args)
  }
}

test('paste captures before focus, copies before hiding, and keeps an immediate-release panel alive until commit', async () => {
  const h = harness(); await h.open()
  const value = await h.paste()
  assert.deepEqual(value, { ok: true, result: { copied: true, outcome: 'injected', reason: undefined } })
  assert.deepEqual(h.calls.filter((call) => call !== 'paste.clear'), ['paste.capture', 'show', 'paste.prepare', 'hide', 'paste.commit', 'destroy'])
})
test('losing focus while preparing cancels input and never commits', async () => {
  const h = harness(); await h.open()
  let complete; h.prepare(() => new Promise((resolve) => { complete = resolve }))
  const operation = h.paste(); h.win.focused = false; h.win.emit('blur')
  complete({ copied: true, ticket: 'private-ticket' })
  assert.equal((await operation).result.outcome, 'copiedOnly')
  assert.equal(h.calls.includes('paste.commit'), false)
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
