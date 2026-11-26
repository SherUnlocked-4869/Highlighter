'use strict'

// H04 §二.4 (P0): the OCR and Everything sidecars speak newline-delimited JSON
// over stdout. `child.stdout` delivers raw Buffer chunks, so a 3-byte UTF-8
// Chinese character can straddle a chunk boundary. The original code decoded
// every chunk on its own (`stdoutBuffer += chunk.toString('utf8')`), which turns
// both halves into U+FFFD while still producing valid JSON — a silent text
// corruption (OCR results, 600 Chinese paths).
//
// These tests drive the real `start()` -> stdout `data` handler -> `handleStdout`
// path with a fake child process. The fake models a pipe *before* any encoding is
// applied (it emits raw Buffers, like a real child_process pipe does), and the
// fixture is validated to be genuinely adversarial: decoding the two chunks
// independently produces U+FFFD.

const test = require('node:test')
const assert = require('node:assert/strict')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')

// OcrService destructures `spawn` from child_process at module load and has no
// injection point; load it behind a spawn shim so `start()` can be driven by the
// fake sidecar. EverythingService accepts `spawn` as an option, but shares the
// same shim path harmlessly.
const childProcess = require('node:child_process')
const realSpawn = childProcess.spawn
let mockedChild = null
childProcess.spawn = (...args) => (mockedChild ? mockedChild : realSpawn(...args))
const { OcrService, MODEL_FILES } = require('../main/services/ocr-service')
const { EverythingService } = require('../main/services/everything-service')

test.after(() => {
  childProcess.spawn = realSpawn
})

function createFakeSidecar() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stderr.setEncoding = () => {}
  child.pid = 4242
  child.killed = false
  child.kill = () => { child.killed = true }
  child.unref = () => {}
  child.requests = []
  child.stdin = {
    write: (line, callback) => {
      child.requests.push(JSON.parse(line))
      if (typeof callback === 'function') callback()
    }
  }
  // Raw pipe chunk, exactly what a `stdout.on('data')` handler receives before
  // any encoding is applied.
  child.pushStdout = (buffer) => child.stdout.emit('data', buffer)
  return child
}

async function waitFor(check, message, attempts = 400) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (check()) return
    await delay(5)
  }
  throw new Error(message)
}

// Split a UTF-8 buffer in the middle of the first Chinese character so the
// fixture genuinely exercises the cross-chunk decoder. Asserts the split really
// is mid-character and that naive per-chunk decoding would corrupt it.
function splitInsideChinese(text) {
  const buffer = Buffer.from(text, 'utf8')
  const marker = Buffer.from('中文报告', 'utf8')
  const markerIndex = buffer.indexOf(marker)
  assert.notEqual(markerIndex, -1, 'fixture must contain the Chinese marker')
  const splitAt = markerIndex + 1
  assert.equal(buffer[splitAt] & 0xc0, 0x80, 'split must land on a UTF-8 continuation byte')
  const chunks = [buffer.subarray(0, splitAt), buffer.subarray(splitAt)]
  assert.match(
    chunks.map((chunk) => chunk.toString('utf8')).join(''),
    /\uFFFD/,
    'fixture must corrupt under per-chunk toString decoding'
  )
  return chunks
}

function countReplacementChars(value) {
  return (String(value).match(/\uFFFD/g) || []).length
}

async function makeOcrFixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'highlighter-h04-ocr-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const modelDir = path.join(root, 'models')
  await fsp.mkdir(modelDir)
  const sidecarPath = path.join(root, 'HighlighterOcrSidecar.exe')
  await fsp.writeFile(sidecarPath, 'sidecar')
  await fsp.writeFile(path.join(root, 'onnxruntime.dll'), 'runtime')
  for (const name of MODEL_FILES) await fsp.writeFile(path.join(modelDir, name), name)
  await fsp.writeFile(path.join(modelDir, 'model.json'), JSON.stringify({ files: {} }))
  return { sidecarPath, modelDir, tempDir: path.join(root, 'temp') }
}

test('H04 ocr-service keeps a Chinese stdout reply intact when a chunk boundary splits a UTF-8 character', async (t) => {
  const { sidecarPath, modelDir, tempDir } = await makeOcrFixture(t)
  const child = createFakeSidecar()
  mockedChild = child
  t.after(() => { mockedChild = null })

  const service = new OcrService({ sidecarPath, modelDir, tempDir, idleTimeoutMs: 0, log: () => {} })
  const started = service.start()
  child.pushStdout(Buffer.from('{"type":"ready"}\n'))
  await started
  assert.equal(service.ready, true, 'the ready handshake still works after the decoder change')

  const recognition = service.recognize(Buffer.from('fake-image-bytes'))
  await waitFor(
    () => child.requests.some((request) => request.action === 'recognize'),
    'OCR recognize request was never written to stdin'
  )
  const request = child.requests.find((item) => item.action === 'recognize')
  const payload = `${JSON.stringify({
    id: request.id,
    ok: true,
    result: { text: '中文报告', blocks: [{ text: '中文报告', box: [0, 0, 10, 10] }] }
  })}\n`
  const [first, second] = splitInsideChinese(payload)

  child.pushStdout(first)
  assert.equal(countReplacementChars(service.stdoutBuffer), 0, 'the partially decoded line must not contain U+FFFD')
  child.pushStdout(second)

  const result = await recognition
  assert.deepEqual(result, { text: '中文报告', blocks: [{ text: '中文报告', box: [0, 0, 10, 10] }] })
  assert.equal(countReplacementChars(JSON.stringify(result)), 0, 'Chinese text is fully preserved')
  assert.equal(service.stdoutBuffer, '', 'the complete JSON line was consumed and the buffer drained')
  assert.equal(service.pending.size, 0)
})

test('H04 everything-service keeps a Chinese stdout reply intact when a chunk boundary splits a UTF-8 character', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'highlighter-h04-everything-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const sidecarPath = path.join(root, 'HighlighterEverything.exe')
  await fsp.writeFile(sidecarPath, 'sidecar')

  const child = createFakeSidecar()
  child.stdin.write = (line, callback) => {
    const request = JSON.parse(line)
    child.requests.push(request)
    if (typeof callback === 'function') callback()
    // EverythingService.query() first runs the readiness chain; answer those
    // requests so the test reaches the real query round-trip.
    if (request.action === 'status') {
      child.pushStdout(Buffer.from(`${JSON.stringify({
        id: request.id,
        ok: true,
        result: { running: true, dbLoaded: true, version: '1.4.1.1032' }
      })}\n`))
    }
  }

  const service = new EverythingService({
    sidecarPath,
    idleTimeoutMs: 0,
    log: () => {},
    spawn: () => child
  })
  const started = service.start()
  child.pushStdout(Buffer.from('{"type":"ready"}\n'))
  await started
  assert.equal(service.ready, true, 'the ready handshake still works after the decoder change')

  const query = service.query({ search: '中文报告', maxResults: 600 })
  await waitFor(
    () => child.requests.some((request) => request.action === 'query'),
    'Everything query request was never written to stdin'
  )
  const request = child.requests.find((item) => item.action === 'query')
  const payload = `${JSON.stringify({
    id: request.id,
    ok: true,
    result: {
      total: 1,
      items: [{
        name: '中文报告.txt',
        path: 'C:\\用户\\文档\\',
        fullPath: 'C:\\用户\\文档\\中文报告.txt',
        highlightedName: '中文*报告*.txt'
      }]
    }
  })}\n`
  const [first, second] = splitInsideChinese(payload)

  child.pushStdout(first)
  assert.equal(countReplacementChars(service.stdoutBuffer), 0, 'the partially decoded line must not contain U+FFFD')
  child.pushStdout(second)

  const result = await query
  assert.equal(result.total, 1)
  assert.equal(result.items[0].name, '中文报告.txt')
  assert.equal(result.items[0].path, 'C:\\用户\\文档\\')
  assert.equal(result.items[0].fullPath, 'C:\\用户\\文档\\中文报告.txt')
  assert.equal(countReplacementChars(JSON.stringify(result)), 0, 'Chinese text is fully preserved')
  assert.equal(service.stdoutBuffer, '', 'the complete JSON line was consumed and the buffer drained')
  assert.equal(service.pending.size, 0)
})
