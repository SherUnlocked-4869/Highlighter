const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { SelectionHookService } = require('../main/services/selection-hook-service')

class FakeHook extends EventEmitter {
  constructor({ startResult = true, startError = null } = {}) {
    super()
    this.startResult = startResult
    this.startError = startError
    this.running = false
    this.startCalls = []
    this.cleanupCalls = 0
  }

  start(options) {
    this.startCalls.push(options)
    if (this.startError) throw this.startError
    this.running = this.startResult
    return this.startResult
  }

  isRunning() {
    return this.running
  }

  cleanup() {
    this.cleanupCalls += 1
    this.running = false
    this.removeAllListeners()
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
    get size() {
      return scheduled.size
    },
    get delays() {
      return [...scheduled.values()].map((timer) => timer.delay)
    }
  }
}

test('starts one selection hook and forwards configured events', () => {
  const hook = new FakeHook()
  const events = []
  const service = new SelectionHookService({
    createHook: () => hook,
    handlers: {
      textSelection: (data) => events.push(['selection', data]),
      mouseDown: (data) => events.push(['mouse', data])
    }
  })

  assert.equal(service.start(), true)
  assert.equal(service.start(), true)
  assert.equal(hook.startCalls.length, 1)
  assert.deepEqual(hook.startCalls[0], { debug: false, enableClipboard: true })

  hook.emit('text-selection', { text: 'selected' })
  hook.emit('mouse-down', { x: 4, y: 8 })
  assert.deepEqual(events, [
    ['selection', { text: 'selected' }],
    ['mouse', { x: 4, y: 8 }]
  ])
})

test('resume restart discards a falsely running hook and coalesces duplicate events', () => {
  const scheduler = createScheduler()
  const hooks = []
  const service = new SelectionHookService({
    createHook: () => {
      const hook = new FakeHook()
      hooks.push(hook)
      return hook
    },
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    restartDelayMs: 1200
  })

  service.start()
  assert.equal(hooks[0].running, true)

  service.scheduleRestart('resume')
  service.scheduleRestart('unlock-screen')
  assert.equal(hooks[0].cleanupCalls, 1)
  assert.equal(scheduler.size, 1)
  assert.deepEqual(scheduler.delays, [1200])

  scheduler.runNext()
  assert.equal(hooks.length, 2)
  assert.equal(hooks[1].running, true)
})

test('a failed hook start is cleaned up and retried a bounded number of times', () => {
  const scheduler = createScheduler()
  const hooks = []
  const service = new SelectionHookService({
    createHook: () => {
      const hook = new FakeHook({ startResult: hooks.length >= 1 })
      hooks.push(hook)
      return hook
    },
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    retryDelayMs: 2500,
    maxStartRetries: 2
  })

  assert.equal(service.start('startup'), false)
  assert.equal(hooks[0].cleanupCalls, 1)
  assert.deepEqual(scheduler.delays, [2500])

  scheduler.runNext()
  assert.equal(hooks.length, 2)
  assert.equal(service.isRunning(), true)
  assert.equal(scheduler.size, 0)
})

test('suspend and dispose prevent stale scheduled restarts', () => {
  const scheduler = createScheduler()
  const hooks = []
  const service = new SelectionHookService({
    createHook: () => {
      const hook = new FakeHook()
      hooks.push(hook)
      return hook
    },
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer
  })

  service.start()
  service.scheduleRestart('resume')
  assert.equal(scheduler.size, 1)
  service.suspend('lock-screen')
  assert.equal(scheduler.size, 0)
  service.scheduleRestart('unlock-screen')
  service.dispose()
  assert.equal(scheduler.size, 0)
  assert.equal(scheduler.runNext(), false)
  assert.equal(service.start(), false)
  assert.equal(hooks.length, 1)
})
