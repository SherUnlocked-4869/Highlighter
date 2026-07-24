const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

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
