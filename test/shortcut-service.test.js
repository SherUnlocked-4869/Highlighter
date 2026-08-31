const test = require('node:test')
const assert = require('node:assert/strict')
const { ShortcutService, normalizeAccelerator } = require('../main/services/shortcut-service')

function createGlobalShortcut({ unavailable = [], invalid = [] } = {}) {
  const callbacks = new Map()
  let unregisterCount = 0
  return {
    callbacks,
    get unregisterCount() { return unregisterCount },
    register(accelerator, callback) {
      if (invalid.includes(accelerator)) throw new Error('invalid accelerator')
      if (unavailable.includes(accelerator)) return false
      callbacks.set(accelerator, callback)
      return true
    },
    unregisterAll() {
      unregisterCount++
      callbacks.clear()
    }
  }
}

test('normalizes accelerators for duplicate detection', () => {
  assert.equal(normalizeAccelerator(' Ctrl+Shift+A '), 'ctrl+shift+a')
})

test('registers unique shortcuts and tracks disabled entries', () => {
  const globalShortcut = createGlobalShortcut()
  const executed = []
  const service = new ShortcutService({
    globalShortcut,
    executeFunction: (name) => executed.push(name)
  })

  const statuses = service.registerAll({
    screenshot: 'F1',
    screenshotDelay: ''
  })

  assert.deepEqual(statuses, {
    screenshot: { accelerator: 'F1', registered: true, reason: 'registered' },
    screenshotDelay: { accelerator: '', registered: false, reason: 'disabled' }
  })
  globalShortcut.callbacks.get('F1')()
  return new Promise((resolve) => setImmediate(() => {
    assert.deepEqual(executed, ['screenshot'])
    resolve()
  }))
})

test('rejects every application shortcut in a duplicate accelerator group', () => {
  const globalShortcut = createGlobalShortcut()
  const service = new ShortcutService({
    globalShortcut,
    executeFunction() {}
  })

  const statuses = service.registerAll({
    screenshot: 'Ctrl+Shift+A',
    screenshotDelay: 'ctrl+shift+a',
    screenshotOcr: 'F2'
  })

  assert.equal(statuses.screenshot.registered, false)
  assert.equal(statuses.screenshot.reason, 'duplicate')
  assert.deepEqual(statuses.screenshot.conflictWith, ['screenshotDelay'])
  assert.equal(statuses.screenshotDelay.reason, 'duplicate')
  assert.deepEqual([...globalShortcut.callbacks.keys()], ['F2'])
})

test('reports shortcuts occupied by the system or another application', () => {
  const globalShortcut = createGlobalShortcut({ unavailable: ['F1'] })
  const service = new ShortcutService({
    globalShortcut,
    executeFunction() {}
  })

  assert.deepEqual(service.registerAll({ screenshot: 'F1' }).screenshot, {
    accelerator: 'F1',
    registered: false,
    reason: 'unavailable'
  })
})

test('reports invalid accelerators without preventing later registrations', () => {
  const globalShortcut = createGlobalShortcut({ invalid: ['Bad+Key'] })
  const service = new ShortcutService({
    globalShortcut,
    executeFunction() {}
  })

  const statuses = service.registerAll({
    screenshot: 'Bad+Key',
    screenshotOcr: 'F2'
  })

  assert.equal(statuses.screenshot.reason, 'invalid')
  assert.match(statuses.screenshot.message, /invalid accelerator/)
  assert.equal(statuses.screenshotOcr.registered, true)
})

test('status snapshots cannot mutate service state', () => {
  const service = new ShortcutService({
    globalShortcut: createGlobalShortcut(),
    executeFunction() {}
  })
  const statuses = service.registerAll({
    screenshot: 'F1',
    screenshotDelay: 'f1'
  })

  statuses.screenshot.reason = 'changed'
  statuses.screenshot.conflictWith.push('other')
  assert.equal(service.getStatuses().screenshot.reason, 'duplicate')
  assert.deepEqual(service.getStatuses().screenshot.conflictWith, ['screenshotDelay'])
})

test('suspends registered shortcuts for game mode and restores them later', () => {
  const globalShortcut = createGlobalShortcut()
  const service = new ShortcutService({
    globalShortcut,
    executeFunction() {}
  })
  const shortcuts = { screenshot: 'F1', screenshotDelay: '' }
  service.registerAll(shortcuts)

  assert.deepEqual(service.suspendAll(shortcuts, 'game-mode'), {
    screenshot: { accelerator: 'F1', registered: false, reason: 'game-mode' },
    screenshotDelay: { accelerator: '', registered: false, reason: 'disabled' }
  })
  assert.deepEqual([...globalShortcut.callbacks.keys()], [])

  service.registerAll(shortcuts)
  assert.deepEqual([...globalShortcut.callbacks.keys()], ['F1'])
})

test('dispose unregisters shortcuts and clears status', () => {
  const globalShortcut = createGlobalShortcut()
  const service = new ShortcutService({
    globalShortcut,
    executeFunction() {}
  })
  service.registerAll({ screenshot: 'F1' })
  service.dispose()

  assert.equal(globalShortcut.unregisterCount, 2)
  assert.deepEqual(service.getStatuses(), {})
})
