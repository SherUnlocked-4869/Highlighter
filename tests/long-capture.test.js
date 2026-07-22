const assert = require('assert')
const fs = require('fs')
const sharp = require('sharp')
const { findBestShift } = require('../long-capture/matcher')
const { LongCaptureSession } = require('../main/services/long-capture-session')

function makeFrame(width, height, valueAt) {
  const frame = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) frame[y * width + x] = valueAt(x, y)
  }
  return frame
}

async function png(width, height, color) {
  return sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer()
}

async function run() {
  const width = 72
  const height = 58
  const base = makeFrame(width, height, (x, y) => (x * 17 + y * 29 + x * y * 3) % 251)
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

  const session = new LongCaptureSession({ axis: 'vertical' })
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
  }

  console.log('long capture tests passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
