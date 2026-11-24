const test = require('node:test')
const assert = require('node:assert/strict')
const { ShortcutService, normalizeAccelerator } = require('../main/services/shortcut-service')

function createGlobalShortcut({ unavailable = [], invalid = [] } = {}) {
  const callbacks = new Map()
  const unregistered = []
  let unregisterCount = 0
  return {
    callbacks,
    unregistered,
    get unregisterCount() { return unregisterCount },
    register(accelerator, callback) {
      if (invalid.includes(accelerator)) throw new Error('invalid accelerator')
      // Electron refuses a combination another process already owns - and also one this
      // process already registered, which is what makes a swap a real transaction.
      if (unavailable.includes(accelerator) || callbacks.has(accelerator)) return false
      callbacks.set(accelerator, callback)
      return true
    },
    unregister(accelerator) {
      unregistered.push(accelerator)
      callbacks.delete(accelerator)
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

// A03 (docs/reviews/2026-11-24-windows-product-architecture-review.md): rebinding must not
// trade a working key for a rejected one. sync is the transaction the settings write is
// gated on; registerAll is only the cold-start path.
test('A03: a successful rebind registers the new key before releasing the old one', () => {
  const globalShortcut = createGlobalShortcut()
  const service = new ShortcutService({ globalShortcut, executeFunction() {} })
  service.registerAll({ screenshot: 'F1', screenshotDelay: '' })

  const outcome = service.sync({ screenshot: 'F2', screenshotDelay: '' })
  assert.equal(outcome.ok, true)
  assert.deepEqual([...globalShortcut.callbacks.keys()], ['F2'])
  assert.deepEqual(globalShortcut.unregistered, ['F1'])
  assert.deepEqual(outcome.statuses.screenshot, { accelerator: 'F2', registered: true, reason: 'registered' })
  // Unrelated names are never touched: no unregisterAll, one targeted release.
  assert.equal(globalShortcut.unregisterCount, 1)
})

test('A03: a rejected combination leaves the working key registered and settings untouched', () => {
  const globalShortcut = createGlobalShortcut({ unavailable: ['F2'] })
  const service = new ShortcutService({ globalShortcut, executeFunction() {} })
  service.registerAll({ screenshot: 'F1' })

  const outcome = service.sync({ screenshot: 'F2' })
  assert.equal(outcome.ok, false)
  assert.deepEqual(outcome.failed, { name: 'screenshot', accelerator: 'F2', reason: 'unavailable' })
  // The old key is still ours and still dispatches.
  assert.deepEqual([...globalShortcut.callbacks.keys()], ['F1'])
  assert.equal(service.getStatuses().screenshot.registered, true)
  assert.equal(service.getStatuses().screenshot.accelerator, 'F1')
})

test('A03: swapping two accelerators is one transaction', () => {
  const globalShortcut = createGlobalShortcut()
  const executed = []
  const service = new ShortcutService({ globalShortcut, executeFunction: (name) => executed.push(name) })
  service.registerAll({ a: 'F1', b: 'F2' })

  const outcome = service.sync({ a: 'F2', b: 'F1' })
  assert.equal(outcome.ok, true)
  assert.deepEqual([...globalShortcut.callbacks.keys()].sort(), ['F1', 'F2'])
  globalShortcut.callbacks.get('F2')()
  return new Promise((resolve) => setImmediate(() => {
    assert.deepEqual(executed, ['a'])
    resolve()
  }))
})

test('A03: a failed swap rolls both bindings back to what was working', () => {
  const globalShortcut = createGlobalShortcut({ unavailable: ['F3'] })
  const service = new ShortcutService({ globalShortcut, executeFunction() {} })
  service.registerAll({ a: 'F1', b: 'F2' })

  // a takes F2 (held by b), b takes F3 (refused by the system).
  const outcome = service.sync({ a: 'F2', b: 'F3' })
  assert.equal(outcome.ok, false)
  assert.deepEqual(outcome.failed, { name: 'b', accelerator: 'F3', reason: 'unavailable' })
  assert.deepEqual(outcome.blockedRestore, [])
  assert.deepEqual([...globalShortcut.callbacks.keys()].sort(), ['F1', 'F2'])
  assert.deepEqual(outcome.statuses.a, { accelerator: 'F1', registered: true, reason: 'registered' })
  assert.deepEqual(outcome.statuses.b, { accelerator: 'F2', registered: true, reason: 'registered' })
})

test('A03: clearing a shortcut only releases that one binding', () => {
  const globalShortcut = createGlobalShortcut()
  const service = new ShortcutService({ globalShortcut, executeFunction() {} })
  service.registerAll({ screenshot: 'F1', screenshotOcr: 'F2' })

  assert.equal(service.sync({ screenshot: '', screenshotOcr: 'F2' }).ok, true)
  assert.deepEqual([...globalShortcut.callbacks.keys()], ['F2'])
  assert.deepEqual(service.getStatuses().screenshot, { accelerator: '', registered: false, reason: 'disabled' })
})

test('A03: a draft that turns a key into a duplicate releases the old binding', () => {
  const globalShortcut = createGlobalShortcut()
  const service = new ShortcutService({ globalShortcut, executeFunction() {} })
  service.registerAll({ a: 'F1', b: 'F2' })

  const outcome = service.sync({ a: 'F2', b: 'F2' })
  assert.equal(outcome.ok, true)
  // Neither name may hold F2: the pair is a duplicate, so the system key is freed.
  assert.deepEqual([...globalShortcut.callbacks.keys()], [])
  assert.equal(outcome.statuses.a.reason, 'duplicate')
  assert.deepEqual(outcome.statuses.a.conflictWith, ['b'])
})

test('A03: sync with no changes never touches the registry', () => {
  const globalShortcut = createGlobalShortcut()
  const service = new ShortcutService({ globalShortcut, executeFunction() {} })
  service.registerAll({ screenshot: 'F1' })
  const before = globalShortcut.unregistered.length
  const outcome = service.sync({ screenshot: 'F1' })
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.changed, [])
  assert.equal(globalShortcut.unregistered.length, before)
  assert.equal(globalShortcut.unregisterCount, 1)
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

test('a syntactically invalid accelerator never reaches the global shortcut registry', () => {
  const globalShortcut = createGlobalShortcut()
  const service = new ShortcutService({
    globalShortcut,
    executeFunction() {}
  })

  const statuses = service.registerAll({ chatSelectText: 'Process', screenshot: 'Ctrl+1' })

  assert.equal(statuses.chatSelectText.reason, 'invalid')
  assert.equal(statuses.chatSelectText.registered, false)
  assert.equal(globalShortcut.callbacks.has('Process'), false)
  assert.equal(statuses.screenshot.registered, true)
  assert.equal(globalShortcut.callbacks.has('Ctrl+1'), true)
})
