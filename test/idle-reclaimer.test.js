const test = require('node:test')
const assert = require('node:assert/strict')

const { createIdleReclaimer } = require('../main/services/idle-reclaimer')

function createFakeClock() {
  let nowMs = 0
  const timers = []
  return {
    now: () => nowMs,
    setTimer: (fn, ms) => {
      const timer = { fn, ms: nowMs + ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => { if (timer) timer.cleared = true },
    advance: (ms) => {
      nowMs += ms
      for (const timer of timers) {
        if (timer.cleared || timer.fired) continue
        if (timer.ms <= nowMs) {
          timer.fired = true
          timer.fn()
        }
      }
    },
    pending: () => timers.filter((timer) => !timer.cleared && !timer.fired).length
  }
}

function createReclaimer(overrides = {}) {
  const clock = createFakeClock()
  const events = []
  const reclaimer = createIdleReclaimer({
    name: 'search-window',
    timeoutMs: 1000,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
    log: (event, details) => events.push({ event, details }),
    ...overrides
  })
  return { reclaimer, clock, events }
}

test('reclaims once the timeout elapses and reports the idle duration', () => {
  const calls = []
  const { reclaimer, clock, events } = createReclaimer({ onReclaim: (details) => calls.push(details) })

  assert.equal(reclaimer.arm(), true)
  assert.equal(reclaimer.isArmed(), true)
  clock.advance(999)
  assert.equal(calls.length, 0, 'the timer has not elapsed yet')

  clock.advance(2)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].idleForMs, 1001)
  assert.equal(reclaimer.isArmed(), false)
  assert.equal(reclaimer.getLastOutcome(), 'fired')
  assert.ok(events.some((entry) => entry.event === 'reclaim-fired'))
})

test('re-checking the predicate can veto a reclaim', () => {
  let busy = true
  const calls = []
  const { reclaimer, clock, events } = createReclaimer({
    shouldReclaim: () => !busy,
    onReclaim: () => calls.push('reclaimed')
  })

  reclaimer.arm()
  clock.advance(1001)
  assert.equal(calls.length, 0)
  assert.equal(reclaimer.getLastOutcome(), 'skipped')
  assert.ok(events.some((entry) => entry.event === 'reclaim-skipped'))

  busy = false
  reclaimer.arm()
  clock.advance(1001)
  assert.deepEqual(calls, ['reclaimed'])
})

test('arming twice replaces the previous timer', () => {
  const calls = []
  const { reclaimer, clock, events } = createReclaimer({ onReclaim: () => calls.push('reclaimed') })

  reclaimer.arm()
  clock.advance(600)
  reclaimer.arm()
  clock.advance(600)
  assert.equal(calls.length, 0, 'the first timer must have been replaced')

  clock.advance(401)
  assert.deepEqual(calls, ['reclaimed'])
  assert.equal(events.filter((entry) => entry.event === 'reclaim-fired').length, 1)
})

test('disarm cancels an armed timer and a stale callback cannot fire', () => {
  const calls = []
  const { reclaimer, clock, events } = createReclaimer({ onReclaim: () => calls.push('reclaimed') })

  reclaimer.arm()
  assert.equal(reclaimer.disarm('reopened'), true)
  assert.equal(reclaimer.isArmed(), false)
  assert.equal(reclaimer.disarm('again'), false)

  clock.advance(5000)
  assert.equal(calls.length, 0)
  assert.ok(events.some((entry) => entry.event === 'reclaim-disarmed' && entry.details.reason === 'reopened'))
})

test('timeoutMs <= 0 disables reclaiming', () => {
  const calls = []
  const { reclaimer, clock } = createReclaimer({ timeoutMs: 0, onReclaim: () => calls.push('reclaimed') })

  assert.equal(reclaimer.arm(), false)
  clock.advance(10000)
  assert.equal(calls.length, 0)
})

test('defensive predicate and handler failures are logged and do not escape', () => {
  let mode = 'throw'
  const { reclaimer, clock, events } = createReclaimer({
    shouldReclaim: () => { if (mode === 'throw') throw new Error('boom'); return true },
    onReclaim: () => { if (mode === 'handler') throw new Error('handler boom') }
  })

  reclaimer.arm()
  assert.doesNotThrow(() => clock.advance(1001))
  assert.equal(reclaimer.getLastOutcome(), 'skipped')
  assert.ok(events.some((entry) => entry.event === 'reclaim-predicate-failed'))

  mode = 'handler'
  reclaimer.arm()
  assert.doesNotThrow(() => clock.advance(2002))
  assert.ok(events.some((entry) => entry.event === 'reclaim-handler-failed'))
})

test('dispose is idempotent and prevents further arming', () => {
  const calls = []
  const { reclaimer, clock } = createReclaimer({ onReclaim: () => calls.push('reclaimed') })

  reclaimer.arm()
  reclaimer.dispose()
  reclaimer.dispose()
  assert.equal(reclaimer.isArmed(), false)
  assert.equal(reclaimer.isDisposed(), true)
  assert.equal(reclaimer.arm(), false)
  clock.advance(5000)
  assert.equal(calls.length, 0)
})
