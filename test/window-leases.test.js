const test = require('node:test')
const assert = require('node:assert/strict')

const { createLeaseTracker } = require('../main/services/window-leases')

test('a lease keeps the tracker busy until it is released', () => {
  const events = []
  const tracker = createLeaseTracker({ log: (event, details) => events.push({ event, details }) })

  assert.equal(tracker.isIdle(), true)
  const release = tracker.acquire('stream')

  assert.equal(tracker.isIdle(), false)
  assert.deepEqual(tracker.heldReasons(), ['stream'])
  assert.equal(tracker.size(), 1)

  assert.equal(release(), true)
  assert.equal(tracker.isIdle(), true)
  assert.deepEqual(tracker.heldReasons(), [])
  assert.ok(events.some((entry) => entry.event === 'lease-acquired' && entry.details.reason === 'stream'))
  assert.ok(events.some((entry) => entry.event === 'lease-released'))
})

test('releasing twice reports the second release as a no-op', () => {
  const tracker = createLeaseTracker()
  const release = tracker.acquire('draft')

  assert.equal(release(), true)
  assert.equal(release(), false)
  assert.equal(tracker.isIdle(), true)
})

test('multiple leases are reported independently', () => {
  const tracker = createLeaseTracker()
  const first = tracker.acquire('draft')
  const second = tracker.acquire('export')

  assert.deepEqual(tracker.heldReasons().sort(), ['draft', 'export'])
  first()
  assert.deepEqual(tracker.heldReasons(), ['export'])
  assert.equal(tracker.isIdle(), false)
  second()
  assert.equal(tracker.isIdle(), true)
})

test('a lease acquired before dispose cannot resurrect the tracker', () => {
  const tracker = createLeaseTracker()
  const release = tracker.acquire('stream')

  tracker.dispose()
  assert.equal(tracker.isIdle(), true)
  assert.equal(release(), false, 'dispose already dropped the lease')
  const late = tracker.acquire('late')
  assert.equal(late(), false)
  assert.equal(tracker.isIdle(), true)
})
