const test = require('node:test')
const assert = require('node:assert/strict')
const { DEFAULTS, createChunkBackpressurePolicy } = require('../record/chunk-backpressure')

const MiB = 1024 * 1024

test('C01: a normal take drains every fragment and never pauses', () => {
  // 30 minutes at one 2 MiB fragment per second, each ACKed before the next arrives.
  const policy = createChunkBackpressurePolicy()
  let now = 0
  for (let sequence = 1; sequence <= 1800; sequence++) {
    now += 1000
    const decision = policy.enqueue({ sequence, bytes: 2 * MiB, at: now })
    assert.equal(decision.action, 'accept', `fragment ${sequence}`)
    assert.equal(policy.settle({ sequence, at: now + 20 }).action, 'none')
  }
  const snapshot = policy.snapshot(now)
  assert.equal(snapshot.paused, false)
  assert.equal(snapshot.pauseCount, 0)
  assert.equal(snapshot.pendingBytes, 0)
  assert.equal(snapshot.peakPendingBytes, 2 * MiB)
})

test('C01: the 32 MiB high-water mark pauses the recorder', () => {
  const policy = createChunkBackpressurePolicy()
  let now = 0
  let decision = null
  let sequence = 0
  // 15 MiB fragments, no ACK at all: the byte bound is reached before the age bound.
  do {
    now += 500
    sequence += 1
    decision = policy.enqueue({ sequence, bytes: 15 * MiB, at: now })
  } while (decision.action === 'accept')
  assert.equal(decision.action, 'pause')
  assert.equal(decision.reason, 'bytes')
  assert.ok(decision.pendingBytes > DEFAULTS.highWaterBytes)
  assert.equal(policy.paused, true)
  // Further fragments may still arrive from the recorder's internal buffer; the policy
  // stays paused (one pause span, not one per fragment).
  const again = policy.enqueue({ sequence: sequence + 1, bytes: MiB, at: now + 100 })
  assert.equal(again.action, 'accept')
  assert.equal(policy.snapshot(now).pauseCount, 1)
})

test('C01: age alone triggers the pause when fragments sit for 5 s', () => {
  const policy = createChunkBackpressurePolicy()
  const first = policy.enqueue({ sequence: 1, bytes: 100, at: 0 })
  assert.equal(first.action, 'accept')
  // A tiny fragment that has waited 5 s is just as much a stuck write as 32 MiB.
  const second = policy.enqueue({ sequence: 2, bytes: 100, at: DEFAULTS.highWaterAgeMs + 1 })
  assert.equal(second.action, 'pause')
  assert.equal(second.reason, 'age')
})

test('C01: resume waits for both low-water bounds', () => {
  const policy = createChunkBackpressurePolicy()
  let now = 0
  for (let sequence = 1; sequence <= 17; sequence++) {
    now += 1000
    policy.enqueue({ sequence, bytes: 2 * MiB, at: now })
  }
  assert.equal(policy.paused, true)
  // Draining below 8 MiB is not enough while the oldest remaining fragment is still old:
  // settle the ACKs with a current timestamp so age drops too.
  let resumed = null
  for (let sequence = 1; sequence <= 17; sequence++) {
    const result = policy.settle({ sequence, at: now + 100 })
    if (result.action === 'resume') resumed = sequence
  }
  assert.ok(resumed !== null, 'a resume must happen once the queue drains')
  assert.equal(policy.paused, false)
  const spans = policy.getPauseSpans()
  assert.equal(spans.length, 1)
  assert.equal(spans[0].reason, 'backpressure')
  assert.ok(spans[0].endWall > spans[0].startWall)
})

test('C01: an oversized single fragment is never buffered', () => {
  const policy = createChunkBackpressurePolicy()
  const decision = policy.enqueue({ sequence: 1, bytes: DEFAULTS.maxChunkBytes + 1, at: 0 })
  assert.equal(decision.action, 'overflow')
  assert.equal(decision.reason, 'oversized-chunk')
  assert.equal(policy.snapshot(0).pendingBytes, 0, 'nothing was queued')
  assert.equal(policy.snapshot(0).overflowCount, 1)
})

test('C01: the 48 MiB renderer ceiling drops the fragment instead of holding it', () => {
  const policy = createChunkBackpressurePolicy()
  let now = 0
  let sequence = 0
  let decision = null
  do {
    now += 1000
    sequence += 1
    decision = policy.enqueue({ sequence, bytes: 4 * MiB, at: now })
  } while (decision.action !== 'overflow')
  assert.equal(decision.reason, 'hard-limit')
  // The fragment that crossed the ceiling was dropped, so the held payload stays under
  // the limit and the confirmed sequence ends at decision.sequence - 1.
  assert.ok(policy.snapshot(now).pendingBytes <= DEFAULTS.hardLimitBytes)
  assert.ok(decision.sequence > 1)
  // Renderer ceiling + one main-process fragment = the 64 MiB budget from the plan.
  assert.ok(DEFAULTS.hardLimitBytes + DEFAULTS.maxChunkBytes <= 64 * MiB)
})

test('C01: settle of an unknown sequence is harmless and reset clears everything', () => {
  const policy = createChunkBackpressurePolicy()
  policy.enqueue({ sequence: 1, bytes: 100, at: 0 })
  assert.equal(policy.settle({ sequence: 99, at: 10 }).action, 'none')
  policy.reset()
  const snapshot = policy.snapshot(10)
  assert.equal(snapshot.pendingBytes, 0)
  assert.equal(snapshot.pendingChunks, 0)
  assert.equal(snapshot.enqueuedChunks, 0)
  assert.equal(snapshot.paused, false)
  assert.deepEqual(policy.getPauseSpans(), [])
})
