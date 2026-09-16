const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { SelectionHookService } = require('../main/services/selection-hook-service')

class FakeHost extends EventEmitter {
  constructor() {
    super()
    this.messages = []
    this.killed = false
    this.unsubMessage = null
    this.unsubExit = null
  }

  postMessage(message) {
    if (this.killed) throw new Error('host killed')
    this.messages.push(message)
  }

  onMessage(listener) {
    this.messageListener = listener
    this.unsubMessage = () => { this.messageListener = null }
    return this.unsubMessage
  }

  onExit(listener) {
    this.exitListener = listener
    this.unsubExit = () => { this.exitListener = null }
    return this.unsubExit
  }

  kill() {
    this.killed = true
  }

  emitMessage(message) {
    this.messageListener?.(message)
  }

  emitExit(info = { code: 0 }) {
    this.exitListener?.(info)
  }

  lastMessage(type) {
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      if (this.messages[i].type === type) return this.messages[i]
    }
    return null
  }
}

function createScheduler() {
  let nextId = 1
  const scheduled = new Map()
  return {
    setTimer(callback, delay) {
      const timer = { id: nextId++, callback, delay, unref() {} }
      scheduled.set(timer.id, timer)
      return timer
    },
    clearTimer(timer) {
      scheduled.delete(timer.id)
    },
    runNext() {
      const timer = scheduled.values().next().value
      if (!timer) return false
      scheduled.delete(timer.id)
      timer.callback()
      return true
    },
    runAll(limit = 20) {
      let ran = 0
      while (ran < limit && this.runNext()) ran += 1
      return ran
    },
    get size() {
      return scheduled.size
    },
    get delays() {
      return [...scheduled.values()].map((timer) => timer.delay)
    }
  }
}

function createService({ scheduler = createScheduler(), handlers = {}, hosts = [], ...rest } = {}) {
  const service = new SelectionHookService({
    createHost: () => {
      const host = new FakeHost()
      hosts.push(host)
      return host
    },
    handlers,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    restartDelayMs: 1200,
    retryDelayMs: 2500,
    heartbeatIntervalMs: 30000,
    heartbeatTimeoutMs: 8000,
    powerDebounceMs: 1500,
    unexpectedStopRestartDelayMs: 400,
    ...rest
  })
  return { service, scheduler, hosts }
}

function startAndReady(service, hosts) {
  assert.equal(service.start('startup'), true)
  const host = hosts.at(-1)
  host.emitMessage({ type: 'ready' })
  host.emitMessage({ type: 'status', status: 'started', hookRunning: true })
  return host
}

test('starts a host process and forwards configured events', () => {
  const events = []
  const { service, hosts } = createService({
    handlers: {
      textSelection: (data) => events.push(['selection', data]),
      mouseDown: (data) => events.push(['mouse', data])
    }
  })

  const host = startAndReady(service, hosts)
  assert.equal(service.isRunning(), true)
  assert.equal(host.lastMessage('start').options.enableClipboard, false)

  host.emitMessage({ type: 'event', event: 'text-selection', data: { text: 'selected' } })
  host.emitMessage({ type: 'event', event: 'mouse-down', data: { x: 4, y: 8 } })
  assert.deepEqual(events, [
    ['selection', { text: 'selected' }],
    ['mouse', { x: 4, y: 8 }]
  ])
})

test('updating clipboard fallback posts update-options to the host', () => {
  const { service, hosts } = createService()
  const host = startAndReady(service, hosts)

  assert.equal(service.updateStartOptions({ enableClipboard: false }), false)
  assert.equal(service.updateStartOptions({ enableClipboard: true }), true)
  assert.equal(host.lastMessage('update-options').options.enableClipboard, true)
})

test('resume restart discards the host and coalesces duplicate power events', () => {
  const { service, scheduler, hosts } = createService()
  const host = startAndReady(service, hosts)

  service.notePowerEvent('wake', 'system-resume')
  service.notePowerEvent('wake', 'unlock-screen')
  assert.equal(scheduler.delays.filter((delay) => delay === 1500).length, 1)
  assert.equal(host.killed, false)

  while (scheduler.runNext()) {
    if (hosts.length >= 2) break
  }
  assert.equal(hosts.length, 2)
  assert.equal(host.killed, true)
  const next = hosts.at(-1)
  next.emitMessage({ type: 'ready' })
  next.emitMessage({ type: 'status', status: 'started', hookRunning: true })
  assert.equal(service.isRunning(), true)
  assert.equal(scheduler.size >= 1, true)
})

test('a failed host start is cleaned up and retried a bounded number of times', () => {
  const hosts = []
  let failNext = 1
  const scheduler = createScheduler()
  const service = new SelectionHookService({
    createHost: () => {
      const host = new FakeHost()
      hosts.push(host)
      return host
    },
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    retryDelayMs: 2500,
    maxStartRetries: 2,
    restartDelayMs: 1200,
    heartbeatIntervalMs: 30000,
    heartbeatTimeoutMs: 8000
  })

  assert.equal(service.start('startup'), true)
  hosts.at(-1).emitMessage({ type: 'status', status: 'start-failed', hookRunning: false })
  assert.equal(scheduler.delays.includes(2500), true)

  scheduler.runNext()
  assert.equal(hosts.length, 2)
  hosts.at(-1).emitMessage({ type: 'ready' })
  hosts.at(-1).emitMessage({ type: 'status', status: 'started', hookRunning: true })
  assert.equal(service.isRunning(), true)
})

test('suspend and dispose prevent stale scheduled restarts', () => {
  const { service, scheduler, hosts } = createService()
  const host = startAndReady(service, hosts)

  service.scheduleRestart('resume')
  assert.equal(scheduler.size, 1)
  service.suspend('lock-screen')
  assert.equal(scheduler.size, 0)
  service.scheduleRestart('unlock-screen')
  service.dispose()
  assert.equal(scheduler.size, 0)
  assert.equal(scheduler.runNext(), false)
  assert.equal(service.start(), false)
  assert.equal(hosts.length, 1)
})

test('unexpected host stop schedules recovery when still desired', () => {
  const { service, scheduler, hosts } = createService()
  const host = startAndReady(service, hosts)

  host.emitMessage({ type: 'status', status: 'stopped', hookRunning: false })
  assert.equal(scheduler.delays.includes(400), true)
  while (scheduler.runNext()) {
    if (hosts.length >= 2) break
  }
  assert.equal(hosts.length, 2)
})

test('intentional suspend does not recover from stopped', () => {
  const { service, scheduler, hosts } = createService()
  const host = startAndReady(service, hosts)

  service.suspend('game-mode')
  host.emitMessage({ type: 'status', status: 'stopped', hookRunning: false })
  assert.equal(scheduler.size, 0)
})

test('host exit while desired running forces recreate', () => {
  const { service, scheduler, hosts } = createService()
  const host = startAndReady(service, hosts)

  host.emitExit({ code: 1 })
  assert.equal(scheduler.delays.includes(400), true)
  while (scheduler.runNext()) {
    if (hosts.length >= 2) break
  }
  assert.equal(hosts.length, 2)
})

test('heartbeat timeout recreates the host after repeated failures', () => {
  const { service, scheduler, hosts } = createService({
    heartbeatIntervalMs: 1000,
    heartbeatTimeoutMs: 100,
    maxHeartbeatFailures: 2
  })
  const host = startAndReady(service, hosts)

  // first heartbeat interval
  assert.equal(scheduler.runNext(), true)
  assert.equal(host.lastMessage('ping')?.type, 'ping')
  // timeout #1
  assert.equal(scheduler.runNext(), true)
  // re-arm interval
  assert.equal(scheduler.runNext(), true)
  // timeout #2 -> recreate
  assert.equal(scheduler.runNext(), true)
  assert.equal(host.killed, true)
  scheduler.runNext()
  assert.equal(hosts.length, 2)
})

test('heartbeat pong keeps the same host', () => {
  const { service, scheduler, hosts } = createService({
    heartbeatIntervalMs: 1000,
    heartbeatTimeoutMs: 100,
    maxHeartbeatFailures: 2
  })
  const host = startAndReady(service, hosts)

  assert.equal(scheduler.runNext(), true)
  host.emitMessage({ type: 'pong', hookRunning: true, lastInputAt: Date.now() })
  assert.equal(host.killed, false)
  assert.equal(service.isRunning(), true)
})

test('utility process host factory forks the host script', () => {
  const calls = []
  const fakeUtilityProcess = {
    fork(modulePath, args, options) {
      calls.push({ modulePath, args, options })
      return {
        postMessage() {},
        on() {},
        removeListener() {},
        kill() {}
      }
    }
  }
  const createHost = SelectionHookService.createUtilityProcessHostFactory({
    utilityProcess: fakeUtilityProcess,
    hostPath: 'C:/app/main/services/selection-hook-host.js'
  })
  createHost()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].modulePath, 'C:/app/main/services/selection-hook-host.js')
  assert.equal(calls[0].options.serviceName, 'highlighter-selection-hook')
})
