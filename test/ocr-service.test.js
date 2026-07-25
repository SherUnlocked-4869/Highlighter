const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

const { OcrService } = require('../main/services/ocr-service')

function deferred() {
  let resolve
  const promise = new Promise((onResolve) => { resolve = onResolve })
  return { promise, resolve }
}

test('OCR recognition waits for delayed temporary-file cleanup', async (t) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'highlighter-ocr-test-'))
  t.after(() => fsp.rm(tempDir, { recursive: true, force: true }))

  const service = new OcrService({ sidecarPath: 'sidecar', modelDir: 'models', tempDir })
  service.ensureStarted = async () => {}
  service.request = async () => ({ text: 'ok' })

  const originalUnlink = fs.promises.unlink
  const unlinkStarted = deferred()
  const unlinkGate = deferred()
  fs.promises.unlink = async (...args) => {
    unlinkStarted.resolve()
    await unlinkGate.promise
    return originalUnlink(...args)
  }

  try {
    const recognition = service.recognize(Buffer.from('image'))
    await unlinkStarted.promise

    let settled = false
    recognition.then(() => { settled = true })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(settled, false)
    assert.equal(service.inFlight.size, 1)

    unlinkGate.resolve()
    await recognition
    assert.equal(service.inFlight.size, 0)
  } finally {
    fs.promises.unlink = originalUnlink
  }
})

function createService(idleTimeoutMs = 10) {
  return new OcrService({
    sidecarPath: 'sidecar.exe',
    modelDir: 'models',
    tempDir: path.join(os.tmpdir(), 'highlighter-ocr-idle-tests'),
    idleTimeoutMs
  })
}

test('stops the OCR sidecar after the idle timeout', async () => {
  const service = createService()
  let stopCount = 0
  service.stop = () => { stopCount += 1 }

  service.scheduleIdleStop()
  await delay(30)

  assert.equal(stopCount, 1)
})

test('rescheduling idle cleanup replaces the previous timer', async () => {
  const service = createService(100)
  let stopCount = 0
  service.stop = () => { stopCount += 1 }

  service.scheduleIdleStop()
  service.scheduleIdleStop()
  await delay(50)
  assert.equal(stopCount, 0)
  await delay(75)
  assert.equal(stopCount, 1)
})

test('does not stop while an OCR request is active', async () => {
  const service = createService()
  let stopCount = 0
  service.stop = () => { stopCount += 1 }
  service.inFlight.set('active', Promise.resolve())

  service.scheduleIdleStop()
  await delay(30)

  assert.equal(stopCount, 0)
})

test('an old sidecar exit cannot clear a replacement process', () => {
  const service = createService()
  const oldProcess = {}
  const replacementProcess = {}
  service.process = replacementProcess
  service.ready = true

  service.handleExit(oldProcess, new Error('old process exited'))

  assert.equal(service.process, replacementProcess)
  assert.equal(service.ready, true)
})
