const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
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

async function run() {
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
