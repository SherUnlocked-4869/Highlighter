'use strict'
// C03 (docs/reviews/2026-11-24-windows-product-architecture-review.md):
// clipboard status polling backs off with panel visibility.
//
// Mock-only: a fake clock and a fake sidecar. No native process, no window and no
// clipboard IO, so the whole 30-minute budget can be walked in microseconds and
// every request is counted by method. The service treats timers and the wall
// clock as injected seams (now / setTimeoutFn / clearTimeoutFn), which is what
// lets these cases assert on virtual time instead of sleeping.
const test = require('node:test')
const assert = require('node:assert/strict')
const { ClipboardService } = require('../main/services/clipboard-service')
const {
  POLL_VISIBLE_MS,
  POLL_DEGRADED_MS,
  POLL_HIDDEN_STABLE_MS,
  POLL_IMMEDIATE_MS,
  POLL_REVISION_FRESH_MS,
  HEALTH_EVENTS,
  isHealthEvent,
  pollIsStable,
  nextPollDelay
} = require('../main/services/clipboard-poll-policy')

const MINUTE = 60000
const STATUS = 'status'
const MAINTENANCE = 'maintenance'

// Virtual clock. advance() fires every timer due inside the window in order and
// awaits each callback, so a poll can arm its successor before the loop looks
// for the next due timer. Without that ordering a 30-minute jump would only run
// the first tick.
function createClock(start = 0) {
  let now = start
  let sequence = 0
  const timers = new Map()
  return {
    now: () => now,
    setTimeout: (fn, ms = 0) => {
      const id = ++sequence
      const delay = Math.max(0, Number(ms) || 0)
      timers.set(id, { id, delay, at: now + delay, fn })
      return { id, unref() {} }
    },
    clearTimeout: (handle) => {
      if (handle === null || handle === undefined) return
      timers.delete(typeof handle === 'object' ? handle.id : handle)
    },
    pending: () => [...timers.values()]
      .map(({ id, delay, at }) => ({ id, delay, at }))
      .sort((left, right) => left.at - right.at || left.id - right.id),
    async advance(ms) {
      const target = now + ms
      for (;;) {
        const due = [...timers.values()]
          .filter((timer) => timer.at <= target)
          .sort((left, right) => left.at - right.at || left.id - right.id)[0]
        if (!due) break
        timers.delete(due.id)
        now = due.at
        const result = due.fn()
        if (result && typeof result.then === 'function') await result
        await Promise.resolve()
      }
      now = target
      await Promise.resolve()
    }
  }
}

// Fake sidecar: the service keeps its real refresh/publish/schedule paths, only
// the transport is replaced. That matters - the assertions are about requests
// the service actually issues, not about a reimplementation of them.
function createSidecar() {
  const clock = createClock()
  const service = new ClipboardService({
    executable: 'unused',
    directory: 'unused',
    getHook: () => null,
    now: clock.now,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout
  })
  service.settings = { enabled: true, paused: false }
  service.child = { stdin: { writableLength: 0, write() {} }, kill() {} }
  service.startedAt = clock.now()
  service.exited = Promise.resolve()
  const statuses = []
  const requests = []
  const state = { revision: 'rev-7', pendingGcBytes: 0, maintenancePending: false, failWith: null }
  service.on('status', (value) => statuses.push(value))
  service.request = async (method) => {
    requests.push({ method, at: clock.now() })
    if (method === STATUS) {
      if (state.failWith) throw Object.assign(new Error(state.failWith), { code: state.failWith })
      return {
        datasetId: 'dataset-a',
        revision: state.revision,
        itemCount: 3,
        pinnedCount: 0,
        payloadBytes: 0,
        actualDiskBytes: 0,
        pendingGcBytes: state.pendingGcBytes,
        maintenancePending: state.maintenancePending,
        messageKey: null
      }
    }
    return { done: true }
  }
  // The state run() publishes once the sidecar is configured and capturing.
  service.publish({ phase: 'running', available: true })
  const times = (method) => requests.filter((entry) => entry.method === method).map((entry) => entry.at)
  return {
    clock,
    service,
    statuses,
    requests,
    state,
    count: (method = STATUS) => times(method).length,
    intervals() {
      const values = times(STATUS)
      return values.slice(1).map((at, index) => at - values[index])
    }
  }
}

test('the poll policy pins the cadences the review asks for', () => {
  // Visible keeps the shipped 2 s refresh; hidden and quiescent is 30 s; anything
  // unhealthy or in flight is a 5 s health check; out-of-band events are immediate.
  assert.equal(POLL_VISIBLE_MS, 2000)
  assert.equal(POLL_HIDDEN_STABLE_MS, 30000)
  assert.equal(POLL_DEGRADED_MS, 5000)
  assert.equal(POLL_IMMEDIATE_MS, 0)
  assert.ok(POLL_REVISION_FRESH_MS <= 300, 'the open-path budget is 300 ms')

  assert.equal(nextPollDelay({ visible: true }), POLL_VISIBLE_MS)
  // The foreground cadence wins over a degraded backend: a visible panel must
  // never refresh more slowly than it does when everything is fine.
  assert.equal(nextPollDelay({ visible: true, stable: false, healthy: false }), POLL_VISIBLE_MS)
  assert.equal(nextPollDelay({ visible: false, stable: true }), POLL_HIDDEN_STABLE_MS)
  assert.equal(nextPollDelay({}), POLL_HIDDEN_STABLE_MS, 'the default state is the quiet one')
  assert.equal(nextPollDelay({ stable: false }), POLL_DEGRADED_MS)
  assert.equal(nextPollDelay({ healthy: false }), POLL_DEGRADED_MS)

  for (const event of HEALTH_EVENTS) {
    assert.equal(isHealthEvent(event), true)
    assert.equal(nextPollDelay({ visible: false, stable: true, event }), POLL_IMMEDIATE_MS, event + ' is checked immediately')
  }
  assert.equal(isHealthEvent('unknown'), false)
  assert.equal(nextPollDelay({ event: 'unknown' }), POLL_HIDDEN_STABLE_MS, 'an unknown event must not drive polling')

  assert.equal(pollIsStable(), true)
  assert.equal(pollIsStable({ maintenancePending: true }), false)
  assert.equal(pollIsStable({ gcBacklog: true }), false)
})

test('a visible panel keeps the 2 s refresh cadence', async () => {
  const sidecar = createSidecar()
  await sidecar.service.setPanelVisible(true)
  await sidecar.clock.advance(10000)
  assert.equal(sidecar.count(), 6, 'one immediate refresh plus five 2 s ticks')
  assert.deepEqual(sidecar.intervals(), [2000, 2000, 2000, 2000, 2000])
})

test('a hidden, quiescent panel backs off to 30 s', async () => {
  const sidecar = createSidecar()
  sidecar.service.schedulePoll()
  assert.equal(sidecar.clock.pending()[0].delay, POLL_HIDDEN_STABLE_MS)
  await sidecar.clock.advance(2 * MINUTE)
  assert.equal(sidecar.count(), 4, 'two minutes of hiding is one request per 30 s')
  assert.deepEqual(sidecar.intervals(), [POLL_HIDDEN_STABLE_MS, POLL_HIDDEN_STABLE_MS, POLL_HIDDEN_STABLE_MS])
})

test('hiding re-arms the backoff without spending a request', async () => {
  const sidecar = createSidecar()
  await sidecar.service.setPanelVisible(true)
  await sidecar.clock.advance(4000)
  const before = sidecar.count()
  await sidecar.service.setPanelVisible(false)
  assert.equal(sidecar.count(), before, 'the way out costs no status request')
  assert.equal(sidecar.clock.pending()[0].delay, POLL_HIDDEN_STABLE_MS)
  await sidecar.clock.advance(POLL_HIDDEN_STABLE_MS - 1)
  assert.equal(sidecar.count(), before)
  await sidecar.clock.advance(1)
  assert.equal(sidecar.count(), before + 1)
})

test('30 hidden, stable minutes stay inside the 65-request budget', async () => {
  const sidecar = createSidecar()
  sidecar.service.schedulePoll()
  await sidecar.clock.advance(30 * MINUTE)
  const count = sidecar.count()
  // 1800 s / 30 s = 60, plus whatever margin the acceptance criterion allows.
  assert.equal(count, 60, 'exactly one ordinary status request per 30 s')
  assert.ok(count <= 65, 'the acceptance ceiling is 65 ordinary status requests in 30 minutes')
  assert.equal(sidecar.clock.pending().length, 1, 'exactly one timer is armed at any time')
})

test('opening the panel refreshes immediately and surfaces the current revision inside 300 ms', async () => {
  const sidecar = createSidecar()
  sidecar.service.schedulePoll()
  await sidecar.clock.advance(2 * MINUTE)
  const before = sidecar.count()

  // A copy landed while the panel was hidden: the open path must not paint the
  // revision the last hidden tick happened to see.
  sidecar.state.revision = 'rev-99'
  sidecar.statuses.length = 0
  const openedAt = sidecar.clock.now()
  await sidecar.service.setPanelVisible(true)

  assert.equal(sidecar.count(), before + 1, 'opening issues exactly one status request')
  const request = sidecar.requests.filter((entry) => entry.method === STATUS).at(-1)
  assert.ok(request.at - openedAt <= POLL_REVISION_FRESH_MS, 'the revision request starts inside the 300 ms budget')
  assert.equal(sidecar.service.snapshot().revision, 'rev-99', 'the snapshot clipboard:init carries is current')
  assert.ok(sidecar.statuses.some((value) => value.revision === 'rev-99'), 'the revision reaches the renderer through the status broadcast')
  assert.equal(sidecar.clock.pending()[0].delay, POLL_VISIBLE_MS, 'the open path lands in the visible cadence')
})

test('a duplicate open inside the paint budget reuses the fresh revision', async () => {
  const sidecar = createSidecar()
  await sidecar.service.setPanelVisible(true)
  const first = sidecar.count()
  // present() notes visibility a second time; the snapshot is already young
  // enough, so the second note must not send a second request.
  await sidecar.clock.advance(200)
  await sidecar.service.setPanelVisible(true)
  assert.equal(sidecar.count(), first)
  assert.equal(sidecar.clock.pending()[0].delay, POLL_VISIBLE_MS)
})

test('a failed status check is reported within 5 s and keeps a bounded health cadence', async () => {
  const sidecar = createSidecar()
  sidecar.state.failWith = 'COORDINATION_ORPHANED'
  const faultAt = sidecar.clock.now()
  const snapshot = await sidecar.service.notifyHealth('coordination')

  const reported = sidecar.statuses.find((value) => value.phase === 'error')
  assert.ok(reported, 'a failed check is published as a status change, not swallowed by the backoff')
  assert.equal(reported.messageKey, 'COORDINATION_ORPHANED')
  assert.equal(reported.available, false)
  assert.ok(sidecar.clock.now() - faultAt <= POLL_DEGRADED_MS, 'the fault is reported within the 5 s budget')
  assert.equal(snapshot.phase, 'error')
  assert.equal(sidecar.service.pollFailed, true)
  const delays = sidecar.clock.pending().map((timer) => timer.delay)
  assert.ok(delays.some((delay) => delay <= POLL_DEGRADED_MS), 'the next check is bounded by the health cadence, saw ' + delays.join(', '))
  assert.ok(delays.includes(POLL_DEGRADED_MS), 'the failed state cannot fall back to the 30 s hidden cadence')
})

test('a sidecar exit while hidden is reported immediately', async () => {
  const sidecar = createSidecar()
  sidecar.service.schedulePoll()
  await sidecar.clock.advance(5)
  const exitedAt = sidecar.clock.now()
  const child = sidecar.service.child
  sidecar.service.failChild(child, 'BACKEND_EXITED')
  const reported = sidecar.statuses.find((value) => value.phase === 'error')
  assert.ok(reported, 'the exit notification publishes the fault')
  assert.equal(reported.messageKey, 'BACKEND_EXITED')
  assert.equal(sidecar.clock.now() - exitedAt, 0, 'the exit path does not wait for a poll')
  assert.equal(sidecar.service.child, null)
})

test('migration health events trigger one immediate check and then resume the backoff', async () => {
  const sidecar = createSidecar()
  sidecar.service.schedulePoll()
  await sidecar.clock.advance(MINUTE)
  const before = sidecar.count()

  const at = sidecar.clock.now()
  await sidecar.service.notifyHealth('migration')
  assert.equal(sidecar.count(), before + 1, 'the migration event is checked at once')
  assert.equal(sidecar.requests.filter((entry) => entry.method === STATUS).at(-1).at, at)
  assert.equal(sidecar.service.lastHealthEvent, 'migration')
  assert.equal(sidecar.clock.pending()[0].delay, POLL_HIDDEN_STABLE_MS, 'one-shot: the next delay is the idle backoff again')

  const ignored = sidecar.count()
  await sidecar.service.notifyHealth('not-an-event')
  assert.equal(sidecar.count(), ignored, 'unknown reasons cannot drive requests')
  assert.equal(sidecar.service.lastHealthEvent, 'migration')
})

test('a GC backlog asks for one immediate maintenance pass, then a bounded cadence', async () => {
  const sidecar = createSidecar()
  sidecar.service.schedulePoll()
  await sidecar.clock.advance(30000)
  assert.equal(sidecar.count(), 1)
  assert.equal(sidecar.count(MAINTENANCE), 0)

  sidecar.state.pendingGcBytes = 4096
  await sidecar.clock.advance(30000)
  const statusTimes = sidecar.requests.filter((entry) => entry.method === STATUS).map((entry) => entry.at)
  assert.deepEqual(statusTimes, [30000, 60000, 60000], 'the backlog edge adds exactly one immediate follow-up')
  assert.equal(sidecar.count(MAINTENANCE), 1, 'the backlog is drained instead of waiting for the 10-minute pass')
  assert.equal(sidecar.clock.pending()[0].delay, POLL_DEGRADED_MS, 'a lingering backlog degrades to the health cadence')
})

test('dispose clears the poll timer and no callback runs afterwards', async () => {
  const sidecar = createSidecar()
  sidecar.service.schedulePoll()
  await sidecar.clock.advance(1000)
  assert.equal(sidecar.clock.pending().length, 1)

  // Only the timer seam is under test here; the stop handshake needs a real
  // sidecar and is covered by the protocol tests.
  sidecar.service.child = null
  await sidecar.service.dispose()
  assert.equal(sidecar.clock.pending().length, 0, 'dispose leaves no armed timer')

  const before = sidecar.count()
  await sidecar.clock.advance(30 * MINUTE)
  assert.equal(sidecar.count(), before, 'a disposed service never polls again')

  await sidecar.service.setPanelVisible(true)
  assert.equal(sidecar.count(), before)
  assert.equal(sidecar.clock.pending().length, 0)
})
