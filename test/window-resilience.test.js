// D05 (docs/reviews/2026-11-24-windows-product-architecture-review.md): the
// abnormal-renderer retention policy is exercised with injected time and timers,
// so TTL, the attempt cap and the shared 20 pin / 32 MiB budgets are deterministic.
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  DEFAULT_POLICY,
  RESULT_CODES,
  createWindowResilience
} = require('../main/services/window-resilience')

// A tiny deterministic clock: the policy takes its timers and its `now` as
// dependencies, so the whole TTL/attempt lifecycle is exercised without sleeping.
function createFakeClock(start = 1_000) {
  let current = start
  let sequence = 0
  const timers = new Map()
  return {
    now: () => current,
    setTimer: (fn, ms) => {
      const id = ++sequence
      timers.set(id, { fn, at: current + Math.max(0, Number(ms) || 0) })
      return id
    },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      current += ms
      let guard = 0
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= current)
          .sort((left, right) => left[1].at - right[1].at)[0]
        if (!due) return
        timers.delete(due[0])
        due[1].fn()
        if (++guard > 1000) throw new Error('timer loop')
      }
    },
    pending: () => timers.size
  }
}

function createHarness(overrides = {}) {
  const clock = createFakeClock()
  const retains = []
  const releases = []
  const service = createWindowResilience({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...overrides,
    retainResource: (info) => {
      retains.push({ ...info })
      return typeof overrides.retainResource === 'function' ? overrides.retainResource(info) : true
    },
    releaseResource: (entry, info) => {
      releases.push({ id: entry.id, imageId: entry.imageId, code: info.code })
    }
  })
  return { service, clock, retains, releases }
}

test('the default policy mirrors the existing pin count and image-store budget', () => {
  assert.equal(DEFAULT_POLICY.maxRetained, 20)
  assert.equal(DEFAULT_POLICY.maxRetainedBytes, 32 * 1024 * 1024)
  assert.equal(DEFAULT_POLICY.maxAttempts, 3)
})

test('TTL expiry releases the retained image even when nobody calls release', () => {
  const { service, clock, releases } = createHarness({ policy: { ttlMs: 1000 } })
  const retained = service.retain({ key: 'pin-window-1', imageId: 7, bytes: 10 })
  assert.equal(retained.ok, true)
  assert.equal(service.list().length, 1)
  assert.equal(releases.length, 0)

  clock.advance(999)
  assert.equal(releases.length, 0, 'the image must survive until the TTL elapses')
  clock.advance(1)
  assert.deepEqual(releases, [{ id: retained.entry.id, imageId: 7, code: 'TTL_EXPIRED' }])
  assert.equal(service.list().length, 0)
  assert.equal(clock.pending(), 0, 'the expiry timer is cleared with the entry')
})

test('a normal close releases immediately and leaves no recoverable entry', () => {
  const { service, releases } = createHarness()
  const retained = service.retain({ key: 'pin-window-1', imageId: 3, bytes: 12 })
  const result = service.release(retained.entry.id, { code: 'CLOSED', reason: 'normal-close' })
  assert.equal(result.ok, true)
  assert.deepEqual(releases, [{ id: retained.entry.id, imageId: 3, code: 'CLOSED' }])
  assert.equal(service.list().length, 0)
  assert.equal(service.stats().retained, 0)
})

test('releasing an unknown or already released ticket is a no-op result, not a leak', () => {
  const { service, releases } = createHarness()
  assert.deepEqual(service.release('missing'), { ok: false, code: RESULT_CODES.NOT_FOUND })
  const retained = service.retain({ imageId: 1 })
  assert.equal(service.release(retained.entry.id).ok, true)
  assert.equal(service.release(retained.entry.id).ok, false)
  assert.equal(releases.length, 1)
})

test('one window can retain at most once, so a crash loop cannot stack tickets', () => {
  const { service } = createHarness()
  assert.equal(service.retain({ key: 'pin-window-1', imageId: 1 }).ok, true)
  const duplicate = service.retain({ key: 'pin-window-1', imageId: 2 })
  assert.deepEqual(duplicate, { ok: false, code: RESULT_CODES.DUPLICATE })
  assert.equal(service.list().length, 1)
})

test('the 20 pin budget is shared with live windows and refuses retention when full', () => {
  const { service, releases } = createHarness({ policy: { maxRetained: 20 } })
  // 19 live pins + this retention = 20, the same envelope MAX_PINNED uses.
  assert.equal(service.retain({ imageId: 1, livePins: 19 }).ok, true)
  const refused = service.retain({ imageId: 2, livePins: 19 })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, RESULT_CODES.BUDGET_EXCEEDED)
  assert.equal(refused.detail.limit, 'pins')
  assert.equal(service.list().length, 1)
  // The refusal must not have taken a store reference.
  assert.equal(releases.length, 0)
})

test('the retained byte budget refuses a retention that would exceed 32 MiB', () => {
  const { service } = createHarness({ policy: { maxRetainedBytes: 100 } })
  assert.equal(service.retain({ imageId: 1, bytes: 60 }).ok, true)
  const refused = service.retain({ imageId: 2, bytes: 50 })
  assert.equal(refused.ok, false)
  assert.deepEqual(refused.detail, { limit: 'bytes', max: 100, used: 60, requested: 50 })
  assert.equal(service.retain({ imageId: 3, bytes: 40 }).ok, true)
})

test('a store that cannot retain the asset yields RESOURCE_GONE and no entry', () => {
  const { service } = createHarness({ retainResource: () => false })
  const refused = service.retain({ imageId: 1, bytes: 1 })
  assert.deepEqual(refused, { ok: false, code: RESULT_CODES.RESOURCE_GONE })
  assert.equal(service.list().length, 0)
})

test('three consecutive recovery failures stop the automatic path but keep the image', () => {
  const { service, releases } = createHarness({ policy: { maxAttempts: 3, ttlMs: 60_000 } })
  const retained = service.retain({ key: 'pin-window-1', imageId: 9 })
  const id = retained.entry.id

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assert.equal(service.claim(id).ok, true)
    const failed = service.fail(id, { code: 'RECOVERY_FAILED' })
    assert.equal(failed.ok, true)
    assert.equal(failed.attempts, attempt)
    assert.equal(failed.exhausted, attempt === 3)
  }

  const blocked = service.claim(id)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, RESULT_CODES.ATTEMPTS_EXHAUSTED)
  // Still retained: "save or discard" remains available until the TTL.
  assert.equal(service.list().length, 1)
  assert.equal(service.list()[0].exhausted, true)
  assert.equal(releases.length, 0)

  // Manual discard still works and releases the reference.
  assert.equal(service.release(id, { code: 'DISCARDED' }).ok, true)
  assert.equal(releases.length, 1)
  assert.equal(service.list().length, 0)
})

test('a successful recovery releases the retained reference exactly once', () => {
  const { service, releases } = createHarness()
  const retained = service.retain({ key: 'pin-window-1', imageId: 5 })
  const claimed = service.claim(retained.entry.id)
  assert.equal(claimed.entry.state, 'recovering')
  // A double click on the tray entry cannot build two windows.
  assert.deepEqual(service.claim(retained.entry.id), { ok: false, code: RESULT_CODES.BUSY })

  assert.equal(service.succeed(retained.entry.id).ok, true)
  assert.deepEqual(releases, [{ id: retained.entry.id, imageId: 5, code: 'RECOVERED' }])
  assert.equal(service.has(retained.entry.id), false)
})

test('a delayed timer is caught by the lazy prune when the clock jumped', () => {
  // A suspended machine resumes with every interval overdue; a fake clock that
  // never delivers the callback proves the read path does not depend on it.
  const clock = createFakeClock()
  const releases = []
  const service = createWindowResilience({
    now: clock.now,
    setTimer: () => 0,
    clearTimer: () => {},
    policy: { ttlMs: 1000 },
    releaseResource: (entry, info) => releases.push({ id: entry.id, code: info.code })
  })
  const retained = service.retain({ imageId: 1 })
  clock.advance(5000)
  assert.equal(service.list().length, 0)
  assert.deepEqual(releases, [{ id: retained.entry.id, code: 'TTL_EXPIRED' }])
})

test('dispose releases every retained reference and refuses further retention', () => {
  const { service, releases } = createHarness()
  service.retain({ imageId: 1 })
  service.retain({ imageId: 2 })
  assert.equal(service.dispose().released, 2)
  assert.equal(releases.length, 2)
  assert.equal(service.list().length, 0)
  assert.deepEqual(service.retain({ imageId: 3 }), { ok: false, code: RESULT_CODES.DISPOSED })
  assert.equal(service.dispose().released, 0)
})

test('stats report the retained count, bytes and exhausted tickets', () => {
  const { service } = createHarness({ policy: { maxAttempts: 2 } })
  const first = service.retain({ imageId: 1, bytes: 100 })
  service.retain({ imageId: 2, bytes: 50 })
  service.claim(first.entry.id)
  service.fail(first.entry.id)
  service.claim(first.entry.id)
  service.fail(first.entry.id)
  const stats = service.stats()
  assert.equal(stats.retained, 2)
  assert.equal(stats.bytes, 150)
  assert.equal(stats.exhausted, 1)
  assert.equal(stats.attemptsMax, 2)
  assert.equal(stats.disposed, false)
})
