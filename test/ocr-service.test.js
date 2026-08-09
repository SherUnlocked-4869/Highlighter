const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

const crypto = require('node:crypto')
const { OcrService, MODEL_FILES } = require('../main/services/ocr-service')

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

test('validates the OCR runtime, model manifest, sizes, and hashes', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'highlighter-ocr-files-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const sidecarPath = path.join(root, 'HighlighterOcrSidecar.exe')
  const runtimePath = path.join(root, 'onnxruntime.dll')
  const modelDir = path.join(root, 'models')
  await fsp.mkdir(modelDir)
  await fsp.writeFile(sidecarPath, 'sidecar')
  await fsp.writeFile(runtimePath, 'runtime')
  const files = {}
  for (const [index, name] of MODEL_FILES.entries()) {
    const content = Buffer.from(`model-${index}`)
    await fsp.writeFile(path.join(modelDir, name), content)
    files[name] = {
      name,
      size: content.length,
      sha256: crypto.createHash('sha256').update(content).digest('hex')
    }
  }
  await fsp.writeFile(path.join(modelDir, 'model.json'), JSON.stringify({ files }))
  const service = new OcrService({ sidecarPath, modelDir, tempDir: path.join(root, 'temp') })

  assert.deepEqual(service.getStatus().missingFiles, [])
  assert.equal(service.getStatus().available, true)
  assert.doesNotThrow(() => service.validateFiles())

  await fsp.writeFile(path.join(modelDir, MODEL_FILES[0]), 'tampered')
  assert.throws(() => service.validateFiles(), /大小异常|校验失败/)
  await fsp.rm(runtimePath)
  assert.ok(service.getStatus().missingFiles.includes('onnxruntime.dll'))
})

test('reports missing and malformed OCR model components', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'highlighter-ocr-invalid-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const service = new OcrService({
    sidecarPath: path.join(root, 'sidecar.exe'),
    modelDir: path.join(root, 'models'),
    tempDir: path.join(root, 'temp')
  })
  assert.throws(() => service.validateFiles(), /OCR 组件不存在/)
  await fsp.writeFile(service.sidecarPath, 'sidecar')
  await fsp.mkdir(service.modelDir)
  assert.throws(() => service.validateFiles(), /OCR 模型不完整/)
  for (const name of MODEL_FILES) await fsp.writeFile(path.join(service.modelDir, name), name)
  await fsp.writeFile(path.join(root, 'onnxruntime.dll'), 'runtime')
  assert.throws(() => service.validateFiles(), /模型清单不存在/)
  await fsp.writeFile(path.join(service.modelDir, 'model.json'), '{invalid')
  assert.throws(() => service.validateFiles(), /模型清单无效/)
})

test('parses split sidecar messages and settles pending requests', async () => {
  const service = createService(0)
  const logs = []
  service.log = (...args) => logs.push(args.join(' '))
  const resolved = deferred()
  let rejected
  const rejectedPromise = new Promise((resolve) => { rejected = resolve })
  const timer = setTimeout(() => {}, 1000)
  const rejectTimer = setTimeout(() => {}, 1000)
  service.pending.set('ok', { timer, resolve: resolved.resolve, reject: assert.fail })
  service.pending.set('bad', { timer: rejectTimer, resolve: assert.fail, reject: rejected })
  const messages = []

  service.handleStdout(Buffer.from('{"type":"fatal","error":"broken"}\nnot-json\n{"id":"ok","ok":true,"result":{"text":"yes"}}'), (message) => messages.push(message))
  assert.equal(service.pending.has('ok'), true, 'partial lines stay buffered')
  service.handleStdout(Buffer.from('\n{"id":"bad","ok":false,"error":"no text"}\n'), (message) => messages.push(message))

  assert.deepEqual(await resolved.promise, { text: 'yes' })
  assert.equal((await rejectedPromise).message, 'no text')
  assert.equal(service.pending.size, 0)
  assert.ok(logs.some((entry) => entry.includes('OCR fatal')))
  assert.ok(logs.some((entry) => entry.includes('Invalid OCR response')))
  assert.equal(messages.length, 3)
})

test('writes bounded requests and handles responses, write failures, and timeouts', async () => {
  const service = createService(0)
  await assert.rejects(service.request({ action: 'recognize' }), /尚未就绪/)
  const writes = []
  service.ready = true
  service.process = {
    killed: false,
    stdin: {
      write(line, callback) {
        writes.push(line)
        callback()
      }
    }
  }
  const request = service.request({ action: 'recognize' }, 1000)
  const id = JSON.parse(writes[0]).id
  service.handleStdout(Buffer.from(`${JSON.stringify({ id, ok: true, result: { text: 'done' } })}\n`), () => {})
  assert.deepEqual(await request, { text: 'done' })

  service.process.stdin.write = (_line, callback) => callback(new Error('pipe closed'))
  await assert.rejects(service.request({ action: 'recognize' }, 1000), /pipe closed/)
  service.process.stdin.write = () => {}
  await assert.rejects(service.request({ action: 'recognize' }, 5), /识别超时/)
  assert.equal(service.pending.size, 0)
})

test('coalesces recognition, returns cached copies, and evicts old results', async () => {
  const service = createService(0)
  const first = deferred()
  let calls = 0
  service.recognizeUncached = async () => {
    calls++
    return first.promise
  }
  const image = Buffer.from('same-image')
  const recognition = service.recognize(image, { minConfidence: 0.4 })
  const duplicate = service.recognize(image, { minConfidence: 0.4 })
  assert.equal(calls, 1)
  first.resolve({ text: 'cached value', durationMs: 9 })
  assert.deepEqual(await recognition, { text: 'cached value', durationMs: 9 })
  assert.deepEqual(await duplicate, { text: 'cached value', durationMs: 9 })
  assert.deepEqual(await service.recognize(image, { minConfidence: 0.4 }), { text: 'cached value', durationMs: 0, cached: true })

  service.cacheLimit = 1
  service.recognizeUncached = async () => ({ text: 'second' })
  await service.recognize(Buffer.from('other-image'))
  assert.equal(service.resultCache.size, 1)
})

test('shares startup work and shuts down an active sidecar', async () => {
  const service = createService(0)
  const startup = deferred()
  let starts = 0
  service.start = () => { starts++; return startup.promise }
  const first = service.ensureStarted()
  const second = service.ensureStarted()
  assert.equal(starts, 1)
  startup.resolve()
  await Promise.all([first, second])
  assert.equal(service.startPromise, null)

  const writes = []
  const child = {
    killed: false,
    stdin: { write: (line) => { writes.push(line); child.killed = true } },
    kill: () => { child.killed = true }
  }
  service.process = child
  service.ready = true
  service.stop()
  assert.match(writes[0], /"action":"shutdown"/)
  assert.equal(service.process, null)
  assert.equal(service.ready, false)
})
