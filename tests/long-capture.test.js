const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('node:vm')
const sharp = require('sharp')
const { findBestShift, scoreShift } = require('../long-capture/matcher')
const { LongCaptureSession } = require('../main/services/long-capture-session')

function makeFrame(width, height, valueAt) {
  const frame = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) frame[y * width + x] = valueAt(x, y)
  }
  return frame
}

function referenceScoreShift(previous, current, width, height, axis, shift) {
  const amount = Math.abs(shift)
  const horizontal = axis === 'horizontal'
  const axisLength = horizontal ? width : height
  const crossStart = Math.floor((horizontal ? height : width) * 0.06)
  const crossEnd = (horizontal ? height : width) - crossStart
  const alongLength = axisLength - amount
  const alongStep = Math.max(1, Math.floor(alongLength / 180))
  const crossStep = Math.max(1, Math.floor((crossEnd - crossStart) / 48))
  let difference = 0
  let samples = 0

  for (let along = 0; along < alongLength; along += alongStep) {
    const previousAlong = shift > 0 ? along + amount : along
    const currentAlong = shift > 0 ? along : along + amount
    for (let cross = crossStart; cross < crossEnd; cross += crossStep) {
      const previousIndex = horizontal
        ? cross * width + previousAlong
        : previousAlong * width + cross
      const currentIndex = horizontal
        ? cross * width + currentAlong
        : currentAlong * width + cross
      difference += Math.abs(previous[previousIndex] - current[currentIndex])
      samples++
    }
  }
  return samples ? difference / samples : Number.POSITIVE_INFINITY
}

async function png(width, height, color) {
  return sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer()
}

async function testWorkerStitching(axis) {
  let response
  let id = 0
  const worker = { postMessage: (message) => { response = message } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../long-capture/matcher-worker.js'), 'utf8'), {
    importScripts() {},
    LongCaptureMatcher: require('../long-capture/matcher'),
    Uint8ClampedArray,
    self: worker
  })
  const send = (data) => worker.onmessage({ data })
  const width = 72
  const height = 58
  const vertical = axis === 'vertical'
  const valueAt = (x, y) => ((x + 88) * 17 + (y + 88) * 29 + (x + 88) * (y + 88) * 3) % 251
  const frame = (offset, frameWidth = width) => {
    const rgba = Buffer.alloc(frameWidth * height * 4)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < frameWidth; x++) {
        const index = (y * frameWidth + x) * 4
        rgba.fill(valueAt(x + (vertical ? 0 : offset), y + (vertical ? offset : 0)), index, index + 3)
        rgba[index + 3] = 255
      }
    }
    send({ type: 'frame', id: ++id, rgba: rgba.buffer, width: frameWidth, height, axis })
    assert.equal(response.id, id)
    return { ...response, rgba }
  }
  const commit = (result) => send({ type: 'commit', id: result.id })
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-long-worker-test-'))
  const session = new LongCaptureSession({ axis, tempRoot })
  async function store(result, extension) {
    const initial = result.status === 'initialized'
    const w = vertical || initial ? width : Math.abs(extension)
    const h = !vertical || initial ? height : Math.abs(extension)
    const x = !vertical && extension > 0 ? width - w : 0
    const y = vertical && extension > 0 ? height - h : 0
    const strip = await sharp(result.rgba, { raw: { width, height, channels: 4 } })
      .extract({ left: x, top: y, width: w, height: h }).png().toBuffer()
    session.addStrip(strip, { width: w, height: h, position: extension < 0 ? 'prepend' : 'append' })
    commit(result)
  }
  try {
    // Failed initial upload must not seed the matching reference.
    assert.equal(frame(0).status, 'initialized')
    const initial = frame(0)
    assert.equal(initial.status, 'initialized')
    await store(initial, 0)
    assert.equal(frame(0, width + 1).status, 'size-changed')
    assert.equal(frame(0).status, 'still')

    for (const [offset, shift, extension] of [[20, 20, 20], [8, -12, 0], [26, 18, 6], [2, -24, 0], [-7, -9, -7], [0, 7, 0], [-11, -11, -4]]) {
      const result = frame(offset)
      assert.equal(result.status, 'matched')
      assert.equal(result.shift, shift)
      assert.equal(result.extension, extension)
      if (extension) await store(result, extension)
      else commit(result)
    }

    // Failed append upload must not move the viewport or grow the extent.
    const failed = frame(32)
    assert.equal(failed.extension, 6)
    const retry = frame(32)
    assert.equal(retry.extension, 6)
    await store(retry, 6)
    assert.equal(session.getSize().strips, 6)
    const output = await session.render()
    const { data, info } = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    assert.equal(info.width, width + (vertical ? 0 : 43))
    assert.equal(info.height, height + (vertical ? 43 : 0))
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        assert.equal(data[(y * info.width + x) * 4], valueAt(x - (vertical ? 0 : 11), y - (vertical ? 11 : 0)))
      }
    }
  } finally {
    session.cleanup()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function run() {
  await testWorkerStitching('vertical')
  await testWorkerStitching('horizontal')
  const width = 72
  const height = 58
  const base = makeFrame(width, height, (x, y) => (x * 17 + y * 29 + x * y * 3) % 251)
  const comparison = makeFrame(width, height, (x, y) => (x * 11 + y * 7 + x * y * 5) % 253)
  for (const [axis, shifts] of [['vertical', [11, -7]], ['horizontal', [9, -5]]]) {
    for (const shift of shifts) {
      assert.equal(
        scoreShift(base, comparison, width, height, axis, shift),
        referenceScoreShift(base, comparison, width, height, axis, shift)
      )
    }
  }
  const verticalShift = 11
  const vertical = makeFrame(width, height, (x, y) => (
    y < height - verticalShift ? base[(y + verticalShift) * width + x] : (x * 13 + y * 7) % 255
  ))
  const verticalResult = findBestShift(base, vertical, width, height, 'vertical')
  assert.equal(verticalResult.status, 'matched')
  assert.equal(verticalResult.shift, verticalShift)

  const horizontalShift = 9
  const horizontal = makeFrame(width, height, (x, y) => (
    x < width - horizontalShift ? base[y * width + x + horizontalShift] : (x * 11 + y * 19) % 255
  ))
  const horizontalResult = findBestShift(base, horizontal, width, height, 'horizontal')
  assert.equal(horizontalResult.status, 'matched')
  assert.equal(horizontalResult.shift, horizontalShift)
  assert.equal(findBestShift(base, base.slice(), width, height, 'vertical').status, 'still')

  const reverseShift = 7
  const reverse = makeFrame(width, height, (x, y) => (
    y >= reverseShift ? base[(y - reverseShift) * width + x] : (x * 23 + y * 31) % 255
  ))
  const reverseResult = findBestShift(base, reverse, width, height, 'vertical')
  assert.equal(reverseResult.status, 'matched')
  assert.equal(reverseResult.shift, -reverseShift)

  const repeatedBase = makeFrame(width, height, (_x, y) => (y % 8) * 24)
  const repeatedShifted = makeFrame(width, height, (_x, y) => ((y + 3) % 8) * 24)
  assert.equal(findBestShift(repeatedBase, repeatedShifted, width, height, 'vertical').status, 'failed')

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-long-test-'))
  const session = new LongCaptureSession({ axis: 'vertical', tempRoot })
  try {
    session.addStrip(await png(4, 2, { r: 255, g: 0, b: 0, alpha: 1 }), { width: 4, height: 2 })
    session.addStrip(await png(4, 3, { r: 0, g: 0, b: 255, alpha: 1 }), { width: 4, height: 3 })
    assert.deepEqual(session.getSize(), { width: 4, height: 5, strips: 2, trimStart: 0, trimEnd: 0 })
    assert.deepEqual(session.setTrim(1, 1), { width: 4, height: 3, strips: 2, trimStart: 1, trimEnd: 1 })
    const output = await session.render()
    assert.ok(fs.existsSync(output))
    const metadata = await sharp(output).metadata()
    assert.equal(metadata.width, 4)
    assert.equal(metadata.height, 3)
  } finally {
    session.cleanup()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }

  console.log('long capture tests passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
