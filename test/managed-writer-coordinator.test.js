const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const helperPath = path.join(__dirname, '..', 'main', 'services', 'managed-writer-coordinator.js')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve))
}

test('quiescence waits for recording, OCR, and long-capture work before migration', async () => {
  assert.equal(fs.existsSync(helperPath), true, 'managed writer coordinator is required')
  const { ManagedWriterCoordinator, quiesceAndMigrate } = require(helperPath)
  const coordinator = new ManagedWriterCoordinator()
  const recording = deferred()
  const ocr = deferred()
  const longCapture = deferred()
  const events = []

  coordinator.track(recording.promise)
  const migration = quiesceAndMigrate({
    coordinator,
    stopWriters: async () => {
      events.push('stop')
      await Promise.allSettled([ocr.promise, longCapture.promise])
    },
    migrate: async () => { events.push('migrate') },
    relaunch: () => { events.push('relaunch') }
  })

  await nextTurn()
  assert.deepEqual(events, ['stop'])
  recording.resolve()
  await nextTurn()
  assert.deepEqual(events, ['stop'])
  ocr.resolve()
  await nextTurn()
  assert.deepEqual(events, ['stop'])
  longCapture.resolve()
  await migration
  assert.deepEqual(events, ['stop', 'migrate', 'relaunch'])
})

test('migration failure resumes the gate and never relaunches', async () => {
  assert.equal(fs.existsSync(helperPath), true, 'managed writer coordinator is required')
  const { ManagedWriterCoordinator, quiesceAndMigrate } = require(helperPath)
  const coordinator = new ManagedWriterCoordinator()
  let relaunched = false

  await assert.rejects(quiesceAndMigrate({
    coordinator,
    stopWriters: async () => {},
    migrate: async () => { throw new Error('copy failed') },
    relaunch: () => { relaunched = true }
  }), /copy failed/)

  assert.equal(relaunched, false)
  assert.doesNotThrow(() => coordinator.assertOpen())
})
