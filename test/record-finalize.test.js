'use strict'

// C01 (plan items 01 and 02): stopping and abandoning a take must always end inside a
// deadline, seal only what was confirmed, and never let a late acknowledgement from a
// sealed take leak into the next one.
//
// This runs the REAL control bar (record/record.js) in a fake window: the start path,
// the chunk queue, the ACK watchdog, the finish/abandon entry points and the IPC calls
// the preload bridge exposes are the production ones. Only the devices and the main
// process are fakes.

const test = require('node:test')
const assert = require('node:assert/strict')

const { createRecordWindowHarness } = require('./helpers/record-window-harness')

const MiB = 1024 * 1024
const ACK_TIMEOUT_MS = 40

function withFastAckTimeout(harness) {
  // The production policy is 30 s; the deadline itself is what is under test, so the
  // fake window runs it in milliseconds. Everything else stays the shipped default.
  harness.run(`chunkPolicy.config.ackTimeoutMs = ${ACK_TIMEOUT_MS}`)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function raceWithDeadline(promise, ms, label) {
  const outcome = await Promise.race([
    promise.then((value) => ({ value })),
    delay(ms).then(() => ({ timedOut: true }))
  ])
  assert.equal(outcome.timedOut, undefined, label + ' must settle within ' + ms + ' ms')
  return outcome.value
}

// A take that has already ACKed chunk 1 and then wedges: chunk 2 never settles.
async function wedgedTake(harness) {
  withFastAckTimeout(harness)
  await harness.startTake()
  harness.emitChunk(128)
  await harness.settle()
  let release = null
  harness.ipc.append = () => new Promise((resolve) => { release = resolve })
  harness.emitChunk(256)
  await harness.settle(4)
  return { release: () => release({ committedBytes: 128, sequence: 2, lastChunkSequence: 2 }) }
}

test('C01 (01): an unacknowledged fragment trips the watchdog and the first stop reports the risk without blocking', async () => {
  const harness = createRecordWindowHarness()
  await wedgedTake(harness)
  // The ACK watchdog fires while the user is still recording.
  harness.runTimers({ count: 1, advanceMs: ACK_TIMEOUT_MS + 1 })
  await harness.settle(4)
  const afterWatchdog = harness.snapshot()
  assert.equal(afterWatchdog.appendErrorCode, 'ack-timeout')
  assert.equal(afterWatchdog.state, 'paused')

  // The first stop only surfaces the risk (contract §12) - but it must do so promptly,
  // not after waiting on the wedged queue.
  const first = await raceWithDeadline(harness.finish(), 1000, 'the first finish')
  assert.equal(first.ok, false)
  assert.equal(first.code, 'chunk-failed')
  assert.equal(harness.snapshot().busy, false, 'the bar must not stay busy')
  assert.equal(harness.ipc.finishCalls, 0, 'the first press only asks for acknowledgement')
})

test('C01 (01): the acknowledged stop seals the confirmed part and reports the interruption', async () => {
  const harness = createRecordWindowHarness({
    finishSession: async () => ({
      ok: true,
      projectId: 'project-1',
      interrupted: true,
      code: 'ack-timeout',
      committedBytes: 128,
      lastChunkSequence: 1,
      missingSequenceFrom: 2,
      missingSequenceTo: 2
    })
  })
  const take = await wedgedTake(harness)
  harness.runTimers({ count: 1, advanceMs: ACK_TIMEOUT_MS + 1 })
  await harness.settle(4)
  await raceWithDeadline(harness.finish(), 1000, 'the first finish')

  const second = await raceWithDeadline(harness.waitWithTimers(harness.finish()), 4000, 'the acknowledged stop')
  assert.equal(second.ok, true)
  assert.equal(harness.ipc.finishCalls, 1, 'the acknowledged stop asks main exactly once')
  const snapshot = harness.snapshot()
  assert.equal(snapshot.state, 'finished')
  assert.equal(snapshot.busy, false)
  assert.equal(snapshot.projectId, 'project-1')
  // The status line says the take was interrupted and its material is being recovered.
  const notice = harness.run('failureNotice && failureNotice.key')
  assert.equal(notice, 'record.notice.capture-interrupted')
  const params = harness.run('failureNotice && failureNotice.params')
  assert.equal(params.from, 2)
  assert.equal(params.to, 2)

  // The late ACK must not resurrect the sealed take: it is allowed to resolve, but the
  // sealed session keeps its confirmed sequence and does not report a state change.
  const before = harness.snapshot()
  take.release()
  await harness.settle(6)
  const after = harness.snapshot()
  assert.equal(after.state, 'finished')
  assert.equal(after.lastAckedSequence, before.lastAckedSequence)
  assert.equal(after.committedBytes, before.committedBytes)
  assert.equal(after.appendErrorCode, 'ack-timeout')
})

test('C01 (01): abandon with a wedged write cannot hang the bar and cleans the session once', async () => {
  const harness = createRecordWindowHarness()
  await wedgedTake(harness)
  harness.runTimers({ count: 1, advanceMs: ACK_TIMEOUT_MS + 1 })
  await harness.settle(4)

  const result = await raceWithDeadline(harness.waitWithTimers(harness.discard()), 4000, 'abandon')
  assert.equal(harness.ipc.cancelCalls, 1, 'abandon cancels exactly once')
  assert.equal(harness.snapshot().busy, false)
  const state = harness.snapshot().state
  assert.ok(['idle', 'finished'].includes(state), 'the bar left the busy discard state: ' + state)
  assert.ok(result === undefined || result === null || typeof result === 'object')
})

test('C01 (01): tray and button stopping at the same time finalize once', async () => {
  const harness = createRecordWindowHarness()
  await harness.startTake()
  harness.emitChunk(64)
  await harness.settle()
  const [a, b] = await Promise.all([harness.finish(), harness.finish()])
  assert.equal(harness.ipc.finishCalls, 1, 'only one finalize may reach main')
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(harness.snapshot().state, 'finished')
})

test('C01 (01): a late ACK from the previous take never lands in the next one', async () => {
  const harness = createRecordWindowHarness()
  await harness.startTake()
  harness.emitChunk(64)
  await harness.settle()
  // Wedge the second fragment of take 1 and finish (the queue times out).
  let release = null
  harness.ipc.append = () => new Promise((resolve) => { release = resolve })
  harness.emitChunk(64)
  await harness.settle(4)
  withFastAckTimeout(harness)
  harness.runTimers({ count: 1, advanceMs: ACK_TIMEOUT_MS + 1 })
  await harness.settle(4)
  await raceWithDeadline(harness.finish(), 1000, 'first finish for acknowledgement')
  await raceWithDeadline(harness.waitWithTimers(harness.finish()), 4000, 'sealing take 1')

  // Take 2 starts; its counters are fresh.
  harness.ipc.append = null
  await harness.startTake()
  const started = harness.snapshot()
  assert.equal(started.sessionId, 'session-2')
  assert.equal(started.lastAckedSequence, 0)
  assert.equal(started.committedBytes, 0)

  // The old take's ACK arrives now: it must be ignored, not credited to take 2.
  release({ committedBytes: 999_999, sequence: 9, lastChunkSequence: 9 })
  await harness.settle(6)
  const after = harness.snapshot()
  assert.equal(after.lastAckedSequence, 0, 'a stale ACK must not advance the new take')
  assert.equal(after.committedBytes, 0)
  assert.equal(after.state, 'recording')
})

test('C01 (02): no confirmed media is reported as its own result, not a generic failure', async () => {
  const harness = createRecordWindowHarness({
    finishSession: async () => ({ ok: false, code: 'no-confirmed-media', committedBytes: 0 })
  })
  await harness.startTake()
  // Nothing was ACKed before main reports that the first chunk never reached disk.
  const result = await harness.finish()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'no-confirmed-media')
  const snapshot = harness.snapshot()
  assert.equal(snapshot.busy, false)
  assert.equal(snapshot.state, 'stopped', 'a retryable stop state, not a silent success')
  assert.equal(harness.run("failureNotice && failureNotice.key"), 'record.notice.no-confirmed-media')
})

test('C01 (01): the renderer drops new fragments once the buffer ceiling is crossed', async () => {
  const harness = createRecordWindowHarness()
  await harness.startTake()
  // Every append is wedged, so nothing drains.
  harness.ipc.append = () => new Promise(() => {})
  const sizes = [16 * MiB, 16 * MiB, 16 * MiB, 16 * MiB]
  for (const size of sizes) {
    harness.emitChunk(size)
    await harness.settle(2)
    if (harness.snapshot().appendErrorCode) break
  }
  await harness.settle(4)
  const snapshot = harness.snapshot()
  assert.equal(snapshot.appendErrorCode, 'chunk-overflow', 'the ceiling fails the take instead of buffering forever')
  const held = harness.run('chunkPolicy.snapshot().pendingBytes')
  assert.ok(held <= 48 * MiB, 'held payload must stay under the renderer ceiling: ' + held)
  // Renderer ceiling + one main-process fragment = the plan's 64 MiB held-data budget.
  // Renderer ceiling + the largest normal fragment main may hold = the 64 MiB budget.
  const maxChunkBytes = harness.run('chunkPolicy.config.maxChunkBytes')
  assert.ok(48 * MiB + maxChunkBytes <= 64 * MiB)
})
