const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const {
  createWindowRegistry,
  listWindows,
  normalizeProcessMetric,
  registerWindow,
  reset,
  snapshotWindows
} = require('../main/services/window-registry')

class FakeWebContents extends EventEmitter {
  constructor({ id = 10, pid = 100 } = {}) {
    super()
    this.id = id
    this.pid = pid
  }

  getOSProcessId() {
    return this.pid
  }
}

class FakeWindow extends EventEmitter {
  constructor({ id = 1, webContentsId = 10, pid = 100, visible = true } = {}) {
    super()
    this.id = id
    this.webContents = new FakeWebContents({ id: webContentsId, pid })
    this.destroyed = false
    this.visible = visible
  }

  isDestroyed() {
    return this.destroyed
  }

  isVisible() {
    return this.visible
  }

  destroy() {
    this.destroyed = true
    this.emit('closed')
  }
}

function makeMetrics() {
  return [
    {
      pid: 100,
      type: 'Browser',
      name: 'Electron',
      creationTime: 1700000000,
      memory: { workingSetSize: 102400, peakWorkingSetSize: 122880, privateBytes: 81920 },
      cpu: { percentCPUUsage: 1.25 }
    },
    {
      pid: 200,
      type: 'Utility',
      serviceName: 'highlighter-usage-scan',
      creationTime: 1700000001,
      memory: { workingSetSize: 20480, privateBytes: 4096 },
      cpu: { percentCPUUsage: 0.5 }
    }
  ]
}

test('registers windows idempotently and describes live state', () => {
  const registry = createWindowRegistry({ getAppMetrics: () => [], now: () => 42 })
  const win = new FakeWindow({ id: 7, webContentsId: 70, pid: 700 })

  const first = registry.register('main', win, { feature: 'settings' })
  const second = registry.register('main', win)
  assert.equal(first.role, 'main')
  assert.equal(first.feature, 'settings')
  assert.equal(first.windowId, 7)
  assert.equal(first.webContentsId, 70)
  assert.equal(first.pid, 700)
  assert.equal(first.visible, true)
  assert.equal(first.destroyed, false)
  assert.deepEqual(second, first, 're-registering the same window must not duplicate the entry')
  assert.equal(registry.list().length, 1)
  assert.throws(() => registry.register('   ', win), /non-empty window role/)
  assert.throws(() => registry.register('main', null), /window object/)
})

test('a closed window leaves the registry and reads prune destroyed entries', () => {
  const registry = createWindowRegistry({ getAppMetrics: () => [] })
  const closedByEvent = new FakeWindow({ id: 1, webContentsId: 11, pid: 101 })
  const closedSilently = new FakeWindow({ id: 2, webContentsId: 12, pid: 102 })
  registry.register('main', closedByEvent)
  registry.register('search', closedSilently)

  closedByEvent.destroy()
  assert.deepEqual(registry.list().map((entry) => entry.role), ['search'])

  closedSilently.destroyed = true // destroyed without the 'closed' event
  assert.deepEqual(registry.list(), [])
})

test('snapshot associates each window pid with its process metric and degrades without one', () => {
  const registry = createWindowRegistry({
    getAppMetrics: makeMetrics,
    now: () => 1700000099
  })
  const browser = new FakeWindow({ id: 1, webContentsId: 11, pid: 100, visible: true })
  const knownRenderer = new FakeWindow({ id: 2, webContentsId: 12, pid: 999, visible: false })
  const noPid = new FakeWindow({ id: 3, webContentsId: 13, pid: 0 })
  registry.register('main', browser, { feature: 'main-window' })
  registry.register('selection-result:7', knownRenderer)
  registry.register('pin:3', noPid)

  const snapshot = registry.snapshot()
  assert.equal(snapshot.generatedAt, 1700000099)
  assert.equal(snapshot.windowCount, 3)
  const byRole = new Map(snapshot.windows.map((entry) => [entry.role, entry]))

  const main = byRole.get('main')
  assert.equal(main.pid, 100)
  assert.equal(main.type, 'Browser')
  assert.equal(main.workingSetMiB, 100)
  assert.equal(main.privateMiB, 80)
  assert.equal(main.cpuPercent, 1.25)
  assert.equal(main.visible, true)

  const missing = byRole.get('selection-result:7')
  assert.equal(missing.pid, 999)
  assert.equal(missing.type, null, 'a pid with no metric must degrade to null, not throw')
  assert.equal(missing.workingSetMiB, null)
  assert.equal(missing.visible, false)

  const unknownPid = byRole.get('pin:3')
  assert.equal(unknownPid.pid, null)
  assert.equal(unknownPid.workingSetMiB, null)
})

test('a failing metrics provider degrades to an empty process mapping', () => {
  const registry = createWindowRegistry({
    getAppMetrics: () => { throw new Error('no electron') }
  })
  registry.register('clipboard-panel', new FakeWindow({ pid: 100 }))
  const snapshot = registry.snapshot()
  assert.equal(snapshot.windows[0].pid, 100)
  assert.equal(snapshot.windows[0].workingSetMiB, null)
  assert.equal(snapshot.windows[0].type, null)
})

test('reset clears the shared singleton', () => {
  reset()
  const win = new FakeWindow({ id: 9, webContentsId: 90, pid: 900 })
  registerWindow('main', win, { feature: 'singleton' })
  assert.deepEqual(listWindows().map((entry) => entry.role), ['main'])
  assert.equal(snapshotWindows().windowCount, 1)
  reset()
  assert.deepEqual(listWindows(), [])
})

test('process metrics keep pid, serviceName, and creationTime', () => {
  const [browser, utility] = makeMetrics().map(normalizeProcessMetric)
  assert.deepEqual(browser, {
    pid: 100,
    type: 'Browser',
    name: 'Electron',
    serviceName: null,
    creationTime: 1700000000,
    workingSetMiB: 100,
    privateMiB: 80,
    cpuPercent: 1.25
  })
  assert.equal(utility.serviceName, 'highlighter-usage-scan')
  assert.equal(utility.workingSetMiB, 20)
})
