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

test('blocked coordinator rejects late recording starts without invoking them', async () => {
  const { ManagedWriterCoordinator } = require(helperPath)
  const coordinator = new ManagedWriterCoordinator()
  const cleanup = deferred()
  let starts = 0

  const startAfterCleanup = (async () => {
    coordinator.assertOpen()
    await coordinator.track(cleanup.promise)
    return coordinator.track(() => {
      starts += 1
      return Promise.resolve({ id: 'late' })
    })
  })()

  coordinator.block()
  cleanup.resolve()

  await assert.rejects(startAfterCleanup, /数据目录正在迁移，请稍候/)
  assert.equal(starts, 0)
  await coordinator.waitForIdle()
  coordinator.resume()
})

test('blocked coordinator tracks explicitly allowed shutdown cleanup', async () => {
  const { ManagedWriterCoordinator } = require(helperPath)
  const coordinator = new ManagedWriterCoordinator()
  const cleanup = deferred()
  let cleanupStarts = 0
  let idle = false

  coordinator.block()
  const cleanupTask = coordinator.track(() => {
    cleanupStarts += 1
    return cleanup.promise
  }, { allowBlocked: true })
  const idleTask = coordinator.waitForIdle().then(() => { idle = true })

  await nextTurn()
  assert.equal(cleanupStarts, 1)
  assert.equal(idle, false)
  cleanup.resolve()
  await cleanupTask
  await idleTask
})
