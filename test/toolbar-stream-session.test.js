const test = require('node:test')
const assert = require('node:assert/strict')
const { ToolbarStreamSession } = require('../main/services/toolbar-stream-session')

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
      if (timer) scheduled.delete(timer.id)
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
    }
  }
}

function createWindow() {
  const sent = []
  const webContents = {
    send: (...args) => sent.push(args)
  }
  return {
    sent,
    webContents,
    destroyed: false,
    isDestroyed() { return this.destroyed }
  }
}

test('stream inactivity aborts the request, reports timeout, and releases state once', () => {
  const scheduler = createScheduler()
  const win = createWindow()
  const aborts = []
  const finishes = []
  const session = new ToolbarStreamSession({
    win,
    timeoutMs: 30000,
    onFinish: (value) => finishes.push(value),
    createAbortController: () => ({
      signal: { test: true },
      abort: (reason) => aborts.push(reason)
    }),
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer
  })

  session.armTimeout()
  assert.equal(scheduler.size, 1)
  scheduler.runNext()

  assert.equal(session.cancelled, true)
  assert.equal(session.finished, true)
  assert.deepEqual(aborts, ['模型长时间无输出，已取消。免费模型高峰期易排队超时，可重试或更换模型'])
  assert.deepEqual(win.sent, [
    ['stream:error', { error: '模型长时间无输出，已取消。免费模型高峰期易排队超时，可重试或更换模型' }]
  ])
  assert.deepEqual(finishes, [session])
  assert.equal(session.finish(), false)
})

test('each stream chunk can rearm one sliding timeout', () => {
  const scheduler = createScheduler()
  const session = new ToolbarStreamSession({
    win: createWindow(),
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer
  })

  session.armTimeout()
  session.armTimeout()
  session.armTimeout()
  assert.equal(scheduler.size, 1)
  session.finish()
  assert.equal(scheduler.size, 0)
})

test('only the owning result window can control an active stream', () => {
  const win = createWindow()
  const session = new ToolbarStreamSession({ win })

  assert.equal(session.matchesSender(win.webContents), true)
  assert.equal(session.matchesSender({}), false)
  session.finish()
  assert.equal(session.matchesSender(win.webContents), false)
})
