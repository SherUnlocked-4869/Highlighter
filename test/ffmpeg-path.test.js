const test = require('node:test')
const assert = require('node:assert/strict')

const { createFfmpegPathResolver } = require('../main/services/ffmpeg-path')

const BINARY = 'C:/app/resources/app.asar/node_modules/ffmpeg-static/ffmpeg.exe'
const UNPACKED = 'C:/app/resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe'

test('the FFmpeg resolver requires a loader, a logger, and a packaging probe', () => {
  assert.throws(() => createFfmpegPathResolver({ loadCandidate: null }), /candidate loader/)
  assert.throws(() => createFfmpegPathResolver({ log: null }), /logger/)
  assert.throws(() => createFfmpegPathResolver({ isPackaged: null }), /isPackaged probe/)
})

test('a development build uses the ffmpeg-static path unchanged', () => {
  const resolve = createFfmpegPathResolver({ loadCandidate: () => BINARY, isPackaged: () => false })
  assert.equal(resolve(), BINARY)
})

test('a packaged build rewrites app.asar to app.asar.unpacked', () => {
  const resolve = createFfmpegPathResolver({ loadCandidate: () => BINARY, isPackaged: () => true })
  assert.equal(resolve(), UNPACKED)
})

test('a packaged binary outside an asar archive is left alone', () => {
  const plain = 'C:/tools/ffmpeg.exe'
  const resolve = createFfmpegPathResolver({ loadCandidate: () => plain, isPackaged: () => true })
  assert.equal(resolve(), plain)
})

test('the candidate loader stays lazy until the first resolution', () => {
  let calls = 0
  const resolve = createFfmpegPathResolver({ loadCandidate: () => { calls += 1; return BINARY } })
  assert.equal(calls, 0)
  resolve()
  resolve()
  assert.equal(calls, 2)
})

test('a failing loader is logged and reported as a missing encoder', () => {
  const logged = []
  const resolve = createFfmpegPathResolver({
    loadCandidate: () => { throw new Error('module not found') },
    log: (...args) => logged.push(args)
  })
  assert.throws(() => resolve(), /未找到 MP4 编码组件/)
  assert.equal(logged.length, 1)
  assert.equal(logged[0][0], 'Unable to resolve FFmpeg:')
  assert.match(logged[0][1].message, /module not found/)
})

test('a non-string candidate is rejected even when the loader succeeds', () => {
  assert.throws(() => createFfmpegPathResolver({ loadCandidate: () => '' })(), /未找到 MP4 编码组件/)
  assert.throws(() => createFfmpegPathResolver({ loadCandidate: () => undefined })(), /未找到 MP4 编码组件/)
  assert.throws(() => createFfmpegPathResolver({ loadCandidate: () => 42 })(), /未找到 MP4 编码组件/)
})
