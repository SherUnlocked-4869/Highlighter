const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')

const crypto = require('node:crypto')
const { OcrService, MODEL_FILES, encodeImageFrame, IMAGE_FRAME } = require('../main/services/ocr-service')

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

// "The timer fired" is the behaviour under test; "it fired inside a fixed sleep"
// is not. A 10 ms idle timer needs a 40 ms budget at rest, but a loaded full-suite
// run (and the 2-core CI runner) can starve that process past the budget while the
// timer is still pending, which turned this into a load-dependent failure. Poll
// with a generous deadline instead, then assert the exact count so the assertion
// itself has not been loosened.
async function waitFor(predicate, timeoutMs = 2000, stepMs = 5) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await delay(stepMs)
  }
  return predicate()
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

test('a hot start that never recognizes still arms the idle stop', async () => {
  const service = createService(10)
  let stopCount = 0
  service.stop = () => { stopCount += 1 }
  service.start = async () => {
    service.process = { killed: false }
    service.ready = true
  }

  await service.ensureStarted()
  assert.equal(stopCount, 0, 'the service is warm until the idle timeout elapses')
  assert.ok(await waitFor(() => stopCount > 0), 'hot-start-only path is now reclaimed')
  await delay(5)
  assert.equal(stopCount, 1, 'the reclaimed sidecar is stopped exactly once')
})

test('a busy idle timer re-arms instead of losing the sidecar', async () => {
  const service = createService(10)
  let stopCount = 0
  service.stop = () => { stopCount += 1 }
  service.inFlight.set('active', Promise.resolve())

  service.scheduleIdleStop()
  await delay(35)
  assert.equal(stopCount, 0)
  assert.notEqual(service.idleTimer, null, 'the timer keeps re-arming while busy')

  service.inFlight.clear()
  await delay(25)
  assert.equal(stopCount, 1, 'the next quiet window reclaims the sidecar')
})

test('stop rejects pending requests immediately with OCR_STOPPED', async () => {
  const service = createService(0)
  const writes = []
  service.process = {
    killed: false,
    stdin: { write: (line, callback) => { writes.push(line); if (callback) callback() } },
    kill: () => {}
  }
  service.ready = true

  const request = service.request({ action: 'recognize' }, 120000)
  assert.equal(service.pending.size, 1)

  service.stop()

  await assert.rejects(request, (error) => error.code === 'OCR_STOPPED' && /已停止/.test(error.message))
  assert.equal(service.pending.size, 0)
  assert.equal(service.idleTimer, null)
  assert.equal(service.ready, false)
  assert.ok(writes.some((line) => /"action":"shutdown"/.test(line)))
})

test('setIdleTimeoutMs reschedules an armed timer and ignores invalid values', async () => {
  const service = createService(1000)
  let stopCount = 0
  service.stop = () => { stopCount += 1 }

  service.scheduleIdleStop()
  assert.equal(service.setIdleTimeoutMs(10), 10)
  await delay(30)
  assert.equal(stopCount, 1)

  assert.equal(service.setIdleTimeoutMs(-1), 10)
  assert.equal(service.setIdleTimeoutMs('nope'), 10)
})

test('stopIfIdle leaves an active recognition running', () => {
  const service = createService(0)
  let stopCount = 0
  service.stop = () => { stopCount += 1 }
  service.pending.set('active', { timer: null, resolve() {}, reject() {} })

  assert.equal(service.stopIfIdle(), false)
  assert.equal(stopCount, 0)

  service.pending.clear()
  assert.equal(service.stopIfIdle(), true)
  assert.equal(stopCount, 1)
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

test('caches model digests by file identity so restarts skip re-hashing', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'highlighter-ocr-cache-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const sidecarPath = path.join(root, 'HighlighterOcrSidecar.exe')
  const modelDir = path.join(root, 'models')
  await fsp.mkdir(modelDir)
  await fsp.writeFile(sidecarPath, 'sidecar')
  await fsp.writeFile(path.join(root, 'onnxruntime.dll'), 'runtime')
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

  const hashCalls = []
  const realCreateHash = crypto.createHash
  crypto.createHash = (algorithm) => {
    hashCalls.push(algorithm)
    return realCreateHash(algorithm)
  }
  t.after(() => { crypto.createHash = realCreateHash })
  try {
    service.validateFiles()
    const firstPass = hashCalls.length
    assert.equal(firstPass, MODEL_FILES.length, 'first validation hashes every model')

    service.validateFiles()
    assert.equal(hashCalls.length, firstPass, 'second validation reuses cached digests')
  } finally {
    crypto.createHash = realCreateHash
  }

  // A same-size rewrite changes identity, so the digest must be recomputed and
  // the tampered file must still be rejected.
  await fsp.writeFile(path.join(modelDir, MODEL_FILES[0]), Buffer.from('model-X'))
  assert.throws(() => service.validateFiles(), /校验失败/)
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

// ===================== DEV-06: stdin binary image frames =====================

// A protocol-faithful fake sidecar over real pipes: it parses the same frame
// layout as native/ocr/src/main.rs, verifies the exact body bytes, and can crash
// mid-request to exercise the fresh-handshake recovery path.
const FAKE_SIDECAR_SOURCE = String.raw`
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const modelIndex = process.argv.indexOf('--model-dir')
const root = modelIndex >= 0 ? process.argv[modelIndex + 1] : ''
let config = {}
try { config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')) } catch {}
fs.appendFileSync(path.join(root, 'starts.log'), 'start\n')
const starts = fs.readFileSync(path.join(root, 'starts.log'), 'utf8').trim().split('\n').length
const expected = config.expectedImageHex ? Buffer.from(config.expectedImageHex, 'hex') : null
let framesSeen = 0
function reply(value) { process.stdout.write(JSON.stringify(value) + '\n') }
function fakeResult(text) {
  return { text: text, imageWidth: 3, imageHeight: 2, durationMs: 1, textBlocks: [{ text: 'fake', boxPoints: [{ x: 4, y: 5 }] }] }
}
function handleLine(line) {
  const request = JSON.parse(line)
  if (request.action === 'shutdown') {
    reply({ id: request.id, ok: true })
    setTimeout(function () { process.exit(0) }, 5)
    return
  }
  if (!request.imagePath || !fs.existsSync(request.imagePath)) {
    reply({ id: request.id, ok: false, error: 'missing-image-path' })
    return
  }
  const body = fs.readFileSync(request.imagePath)
  if (expected && !body.equals(expected)) {
    reply({ id: request.id, ok: false, error: 'legacy-body-mismatch' })
    return
  }
  reply({ id: request.id, ok: true, result: fakeResult('fake-legacy:' + body.length) })
}
function frameLoop(buffer) {
  for (;;) {
    if (buffer.length === 0) return buffer
    if (buffer[0] === 0x7b) {
      const newline = buffer.indexOf(10)
      if (newline < 0) return buffer
      const line = buffer.subarray(0, newline).toString('utf8')
      buffer = buffer.subarray(newline + 1)
      handleLine(line)
      if (line.indexOf('shutdown') >= 0) return buffer
      continue
    }
    if (buffer.length < 16) return buffer
    if (buffer.subarray(0, 4).toString('ascii') !== 'HLOC') {
      reply({ ok: false, error: 'bad-magic' })
      process.exit(4)
    }
    const headerLength = buffer.readUInt32LE(8)
    const bodyLength = buffer.readUInt32LE(12)
    if (buffer.length < 16 + headerLength + bodyLength) return buffer
    const header = JSON.parse(buffer.subarray(16, 16 + headerLength).toString('utf8'))
    const body = buffer.subarray(16 + headerLength, 16 + headerLength + bodyLength)
    buffer = buffer.subarray(16 + headerLength + bodyLength)
    framesSeen += 1
    if (config.crashOnFirstFrame && starts === 1 && framesSeen === 1) process.exit(7)
    if (expected && framesSeen === 1 && !body.equals(expected)) {
      reply({ id: header.id, ok: false, error: 'body-mismatch' })
      continue
    }
    if (header.action !== 'recognize') {
      reply({ id: header.id, ok: false, error: 'bad-action' })
      continue
    }
    reply({ id: header.id, ok: true, result: fakeResult('fake-frame:' + bodyLength) })
  }
}
if (config.mode === 'legacy') {
  reply({ type: 'ready', engine: 'paddleocr', model: 'fake-legacy', initDurationMs: 1 })
  let buffered = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', function (chunk) {
    buffered += chunk
    for (;;) {
      const newline = buffered.indexOf('\n')
      if (newline < 0) return
      const line = buffered.slice(0, newline).trim()
      buffered = buffered.slice(newline + 1)
      if (line) handleLine(line)
    }
  })
} else {
  reply({ type: 'ready', engine: 'paddleocr', model: 'fake', initDurationMs: 1, protocol: { imageTransfer: 'stdin-frame-v1', maxFrameBodyBytes: 67108864 } })
  let buffered = Buffer.alloc(0)
  process.stdin.on('data', function (chunk) {
    buffered = Buffer.concat([buffered, chunk])
    buffered = frameLoop(buffered)
  })
}
`

async function createFakeSidecarHarness(t, config) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'highlighter-ocr-frames-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const scriptPath = path.join(root, 'fake-sidecar.js')
  await fsp.writeFile(scriptPath, FAKE_SIDECAR_SOURCE)
  await fsp.writeFile(path.join(root, 'config.json'), JSON.stringify(config))
  const service = new OcrService({
    sidecarPath: path.join(root, 'missing-sidecar.exe'),
    modelDir: root,
    tempDir: path.join(root, 'temp'),
    idleTimeoutMs: 0,
    log: () => {}
  })
  service.validateFiles = () => {}
  service.spawnSidecar = () => spawn(process.execPath, [scriptPath, '--model-dir', root], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  t.after(() => service.stop())
  return { service, root }
}

test('DEV-06 image frames are self-describing and carry the exact PNG bytes', () => {
  const image = Buffer.from('89504e470d0a1a0a-not-really-a-png-body')
  const frame = encodeImageFrame({ id: 'req-1', action: 'recognize', scaleFactor: 1.25, minConfidence: 0.4 }, image)
  assert.equal(frame.subarray(0, 4).toString('ascii'), IMAGE_FRAME.magic)
  assert.equal(frame.readUInt8(4), IMAGE_FRAME.version)
  assert.equal(frame.readUInt8(5), IMAGE_FRAME.kind)
  assert.equal(frame.readUInt16LE(6), 0)
  const headerLength = frame.readUInt32LE(8)
  const bodyLength = frame.readUInt32LE(12)
  const header = JSON.parse(frame.subarray(IMAGE_FRAME.fixedBytes, IMAGE_FRAME.fixedBytes + headerLength).toString('utf8'))
  assert.deepEqual(header, { id: 'req-1', action: 'recognize', scaleFactor: 1.25, minConfidence: 0.4 })
  assert.equal(bodyLength, image.length)
  assert.equal(frame.length, IMAGE_FRAME.fixedBytes + headerLength + bodyLength)
  assert.deepEqual(frame.subarray(IMAGE_FRAME.fixedBytes + headerLength), image)
  assert.throws(() => encodeImageFrame({ id: 'x' }, Buffer.alloc(0)), /empty/)
  assert.throws(() => encodeImageFrame({ id: 'x'.repeat(IMAGE_FRAME.headerLimit) }, image), /header exceeds/)
  assert.throws(() => encodeImageFrame({ id: 'x' }, 'not-a-buffer'), /Buffer/)
})

test('DEV-06 negotiates the binary frame protocol from the ready announcement', () => {
  const service = createService(0)
  assert.equal(service.imageTransfer, null)
  service.handleReadyMessage({ type: 'ready', engine: 'paddleocr', model: 'legacy', initDurationMs: 1 })
  assert.equal(service.imageTransfer, null, 'an old sidecar without a protocol member keeps the legacy path')
  service.handleReadyMessage({ type: 'ready', protocol: { imageTransfer: 'stdin-frame-v1', maxFrameBodyBytes: 4096 } })
  assert.equal(service.imageTransfer, IMAGE_FRAME.imageTransfer)
  assert.equal(service.frameBodyLimit, 4096)
  service.handleReadyMessage({ type: 'ready', protocol: { imageTransfer: 'stdin-frame-v2' } })
  assert.equal(service.imageTransfer, null, 'an unknown protocol token falls back to the legacy path')
  service.handleReadyMessage({
    type: 'ready',
    protocol: { imageTransfer: IMAGE_FRAME.imageTransfer, maxFrameBodyBytes: 2 ** 40 }
  })
  assert.equal(service.frameBodyLimit, IMAGE_FRAME.bodyLimit, 'the advertised body limit is clamped locally')
})

test('DEV-06 the binary path writes zero temporary PNGs and never creates the temp directory', async () => {
  const service = createService(0)
  service.ensureStarted = async () => {}
  service.ready = true
  service.process = { killed: false }
  service.imageTransfer = IMAGE_FRAME.imageTransfer
  const writes = []
  const unlinks = []
  const mkdirs = []
  const realWriteFile = fs.promises.writeFile
  const realUnlink = fs.promises.unlink
  const realMkdir = fs.promises.mkdir
  fs.promises.writeFile = async (...args) => { writes.push(args[0]); return realWriteFile(...args) }
  fs.promises.unlink = async (...args) => { unlinks.push(args[0]); return realUnlink(...args) }
  fs.promises.mkdir = async (...args) => { mkdirs.push(args[0]); return realMkdir(...args) }
  try {
    const framed = []
    service.requestFrame = async (payload, imageBuffer) => {
      framed.push({ payload, imageBuffer })
      return { text: 'binary' }
    }
    const image = Buffer.from('png-binary')
    const result = await service.recognizeUncached(image, { scaleFactor: 1.5, detectAngle: true, maxSide: 2048, minConfidence: 0.3 })
    assert.deepEqual(result, { text: 'binary' })
    assert.equal(framed.length, 1)
    assert.deepEqual(framed[0].payload, {
      action: 'recognize',
      scaleFactor: 1.5,
      detectAngle: true,
      maxSide: 2048,
      minConfidence: 0.3
    })
    assert.equal(framed[0].imageBuffer, image, 'the buffer is forwarded without a temp-file round trip')
  } finally {
    fs.promises.writeFile = realWriteFile
    fs.promises.unlink = realUnlink
    fs.promises.mkdir = realMkdir
  }
  assert.deepEqual(writes, [], 'no temp PNG write on the binary path')
  assert.deepEqual(unlinks, [])
  assert.deepEqual(mkdirs, [], 'the temp directory is not even created')
})

test('DEV-06 the legacy imagePath path writes exactly one temp PNG and cleans up on success and failure', async (t) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'highlighter-ocr-legacy-temp-'))
  t.after(() => fsp.rm(tempDir, { recursive: true, force: true }))
  const service = new OcrService({ sidecarPath: 'sidecar.exe', modelDir: 'models', tempDir })
  service.ensureStarted = async () => {}
  service.ready = true
  service.process = { killed: false }
  const writes = []
  const unlinks = []
  const realWriteFile = fs.promises.writeFile
  const realUnlink = fs.promises.unlink
  fs.promises.writeFile = async (file, data) => { writes.push({ file, data: Buffer.from(data) }); return realWriteFile(file, data) }
  fs.promises.unlink = async (file) => { unlinks.push(file); return realUnlink(file) }
  const image = Buffer.from('legacy-png-bytes')
  try {
    service.request = async (payload) => {
      assert.equal(payload.action, 'recognize')
      assert.match(payload.imagePath, /\.png$/)
      assert.ok(fs.existsSync(payload.imagePath), 'the temp PNG exists while the legacy request is in flight')
      return { text: 'legacy-success' }
    }
    assert.deepEqual(await service.recognizeUncached(image, { scaleFactor: 2 }), { text: 'legacy-success' })
    assert.equal(writes.length, 1)
    assert.deepEqual(writes[0].data, image)
    assert.equal(unlinks.length, 1)
    assert.deepEqual(writes[0].file, unlinks[0])
    assert.deepEqual(fs.readdirSync(tempDir), [], 'the success path removes the temp PNG')

    service.request = async () => { throw new Error('legacy failure') }
    await assert.rejects(service.recognizeUncached(image, { scaleFactor: 2 }), /legacy failure/)
    assert.equal(writes.length, 2)
    assert.equal(unlinks.length, 2)
    assert.deepEqual(fs.readdirSync(tempDir), [], 'the failure path removes the temp PNG')
  } finally {
    fs.promises.writeFile = realWriteFile
    fs.promises.unlink = realUnlink
  }
})

test('DEV-06 a failed frame write drops the sidecar and rejects its pending requests', async () => {
  const service = createService(0)
  let killed = false
  const child = {
    killed: false,
    kill: () => { killed = true },
    stdin: { on() {}, removeListener() {}, write: (_frame, callback) => callback(new Error('EPIPE')) }
  }
  service.process = child
  service.ready = true
  service.imageTransfer = IMAGE_FRAME.imageTransfer
  await assert.rejects(service.requestFrame({ action: 'recognize' }, Buffer.from('img')), /EPIPE/)
  assert.equal(killed, true, 'a half-written frame drops the sidecar process')
  assert.equal(service.process, null)
  assert.equal(service.ready, false)
  assert.equal(service.imageTransfer, null)
  assert.equal(service.pending.size, 0)
})

test('DEV-06 frames are queued so a slow pipe cannot interleave headers and bodies', async () => {
  const service = createService(0)
  const writes = []
  let releaseFirst
  const child = {
    killed: false,
    kill() {},
    stdin: {
      on() {},
      removeListener() {},
      write(frame, callback) {
        writes.push(frame)
        if (writes.length === 1) {
          releaseFirst = callback
          return false
        }
        callback()
        return true
      }
    }
  }
  service.process = child
  service.ready = true
  service.imageTransfer = IMAGE_FRAME.imageTransfer
  const first = service.requestFrame({ action: 'recognize' }, Buffer.from('first'))
  const second = service.requestFrame({ action: 'recognize' }, Buffer.from('second'))
  await delay(10)
  assert.equal(writes.length, 1, 'the second frame waits for the first write to flush')
  assert.equal(typeof releaseFirst, 'function')
  releaseFirst()
  await delay(10)
  assert.equal(writes.length, 2)
  const ids = writes.map((frame) => {
    const headerLength = frame.readUInt32LE(8)
    const bodyLength = frame.readUInt32LE(12)
    assert.equal(frame.length, IMAGE_FRAME.fixedBytes + headerLength + bodyLength)
    return JSON.parse(frame.subarray(IMAGE_FRAME.fixedBytes, IMAGE_FRAME.fixedBytes + headerLength).toString('utf8')).id
  })
  for (const id of ids) {
    service.handleStdout(Buffer.from(`${JSON.stringify({ id, ok: true, result: { text: id } })}\n`), () => {})
  }
  assert.deepEqual(await first, { text: ids[0] })
  assert.deepEqual(await second, { text: ids[1] })
})

test('DEV-06 a real pipe sidecar receives exact binary frames and JSON responses still parse', async (t) => {
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5])
  const { service, root } = await createFakeSidecarHarness(t, {
    mode: 'frames',
    expectedImageHex: image.toString('hex')
  })
  const first = await service.recognize(image, { scaleFactor: 1 })
  assert.equal(first.text, `fake-frame:${image.length}`)
  assert.deepEqual(first.textBlocks, [{ text: 'fake', boxPoints: [{ x: 4, y: 5 }] }], 'textBlocks coordinates are unchanged')
  assert.equal(service.imageTransfer, IMAGE_FRAME.imageTransfer)

  const secondImage = Buffer.from('second-image')
  const second = await service.recognize(secondImage)
  assert.equal(second.text, `fake-frame:${secondImage.length}`)
  assert.equal(service.resultCache.size, 2)

  const starts = fs.readFileSync(path.join(root, 'starts.log'), 'utf8').trim().split('\n')
  assert.equal(starts.length, 1, 'binary frames reuse the same sidecar process')
  assert.equal(fs.existsSync(path.join(root, 'temp')), false, 'the binary path creates no temp directory')
})

test('DEV-06 a crashed sidecar rejects pending work and recovers through a fresh handshake', async (t) => {
  const { service, root } = await createFakeSidecarHarness(t, { mode: 'frames', crashOnFirstFrame: true })
  await assert.rejects(service.recognize(Buffer.from('crash-image')))
  assert.equal(service.process, null)
  assert.equal(service.pending.size, 0)
  assert.equal(service.imageTransfer, null, 'the negotiated capability is dropped with the process')

  const secondImage = Buffer.from('second-attempt')
  const recovered = await service.recognize(secondImage)
  assert.equal(recovered.text, `fake-frame:${secondImage.length}`)
  const starts = fs.readFileSync(path.join(root, 'starts.log'), 'utf8').trim().split('\n')
  assert.equal(starts.length, 2, 'recovery spawns one fresh sidecar handshake')
})

test('DEV-06 a new main falls back to the legacy imagePath protocol against an old sidecar', async (t) => {
  const image = Buffer.from('legacy-pipe-image')
  const { service, root } = await createFakeSidecarHarness(t, {
    mode: 'legacy',
    expectedImageHex: image.toString('hex')
  })
  const result = await service.recognize(image)
  assert.equal(result.text, `fake-legacy:${image.length}`)
  assert.equal(service.imageTransfer, null, 'an old sidecar advertises no capability')
  const tempDir = path.join(root, 'temp')
  assert.ok(fs.existsSync(tempDir), 'the legacy path uses the temp directory')
  assert.deepEqual(fs.readdirSync(tempDir), [], 'the temp PNG is removed after a successful legacy call')
})
