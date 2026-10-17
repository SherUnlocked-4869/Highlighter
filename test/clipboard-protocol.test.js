const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { encodeFrame, FrameDecoder, MAX_HEADER, MAX_CHUNK } = require('../scripts/lib/clipboard-protocol')

test('framing preserves arbitrary chunk boundaries, Unicode, binary and adjacent responses', () => {
  const bytes = Buffer.concat([encodeFrame({ text: '🙂\n中文' }), encodeFrame({ id: 2 }, Buffer.from([0, 10, 255]))])
  for (const size of [1, 3, 9, 4096]) {
    const decoder = new FrameDecoder()
    const frames = []
    for (let offset = 0; offset < bytes.length; offset += size) frames.push(...decoder.feed(bytes.subarray(offset, offset + size)))
    decoder.finish()
    assert.equal(frames[0].header.text, '🙂\n中文')
    assert.deepEqual(frames[1].payload, Buffer.from([0, 10, 255]))
    assert.equal(frames.length, 2)
  }
})

test('rejects oversized, truncated, scalar, invalid UTF-8 and invalid control frames', () => {
  const corrupt = encodeFrame({})
  corrupt.writeUInt32LE(MAX_HEADER + 1, 5)
  const kind = encodeFrame({})
  kind[4] = 3
  const utf8 = encodeFrame({})
  utf8[9] = 0xff
  const controlPayload = encodeFrame({}, Buffer.from([1]))
  controlPayload[4] = 1
  for (const bytes of [Buffer.from([255, 255, 255, 255]), corrupt, kind, utf8, controlPayload]) {
    const decoder = new FrameDecoder()
    assert.throws(() => decoder.feed(bytes))
    assert.throws(() => decoder.finish())
  }
  for (const bytes of [Buffer.from([1]), encodeFrame({}).subarray(0, -1)]) {
    const decoder = new FrameDecoder()
    decoder.feed(bytes)
    assert.throws(() => decoder.finish())
  }
  assert.throws(() => encodeFrame({ text: 'x'.repeat(MAX_HEADER) }))
  assert.throws(() => encodeFrame({}, Buffer.alloc(MAX_CHUNK + 1)))
  assert.throws(() => encodeFrame([]))
})

test('native G0 initializes disabled, validates session, quiesces and exits on parent EOF', { timeout: 20000 }, async (t) => {
  const executable = path.resolve(__dirname, '../native/clipboard/bin/HighlighterClipboard.exe')
  if (process.platform !== 'win32' || !fs.existsSync(executable)) {
    if (process.env.HIGHLIGHTER_REQUIRE_CLIPBOARD_NATIVE === '1') assert.fail('Build the Windows clipboard native executable first')
    t.skip('Windows clipboard native executable not built')
    return
  }
  const result = await require('../scripts/probe-clipboard-native').probe()
  assert.equal(result.defaultEnabled, false)
  assert.equal(result.exitCode, 0)
})

test('native parser exits on malformed parent input without echoing its body', { timeout: 20000 }, (t) => {
  const executable = path.resolve(__dirname, '../native/clipboard/bin/HighlighterClipboard.exe')
  if (process.platform !== 'win32' || !fs.existsSync(executable)) {
    if (process.env.HIGHLIGHTER_REQUIRE_CLIPBOARD_NATIVE === '1') assert.fail('Build the Windows clipboard native executable first')
    t.skip('Windows clipboard native executable not built')
    return
  }
  const secret = 'synthetic-payload-must-never-appear-in-errors'
  const malformed = encodeFrame({ version: 1, type: 'request', requestId: '1', method: 'initialize', unexpected: secret })
  for (const bytes of [Buffer.from([1]), Buffer.from([255, 255, 255, 255]), malformed]) {
    const result = spawnSync(executable, [], { input: bytes, timeout: 5000, windowsHide: true })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1)
    assert.equal(result.stdout.length, 0)
    assert.doesNotMatch(result.stderr.toString(), new RegExp(secret))
    assert.match(result.stderr.toString(), /no payload logged/)
  }
})
