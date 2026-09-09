const test = require('node:test')
const assert = require('node:assert/strict')

const { findNativeDisplay, getNativeDisplayBounds, readPngSize } = require('../main/services/capture-geometry')

function pngHeader(width, height) {
  const header = Buffer.alloc(24)
  header.writeUInt32BE(0x89504e47, 0)
  header.writeUInt32BE(0x0d0a1a0a, 4)
  header.writeUInt32BE(13, 8)
  header.write('IHDR', 12, 'ascii')
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  return header
}

test('native display matching tolerates one-pixel Electron DIP conversion drift', () => {
  const display = {
    id: '\\\\.\\DISPLAY1',
    left: 0,
    top: 0,
    width: 2240,
    height: 1400
  }
  assert.equal(findNativeDisplay([display], { x: 0, y: 0, width: 2241, height: 1401 }, 2), display)
  assert.deepEqual(getNativeDisplayBounds(display), {
    left: 0,
    top: 0,
    right: 2240,
    bottom: 1400,
    width: 2240,
    height: 1400
  })
})

test('native display matching rejects a different monitor', () => {
  const display = { left: 2240, top: 0, width: 1920, height: 1080 }
  assert.equal(findNativeDisplay([display], { x: 0, y: 0, width: 2241, height: 1401 }, 2), null)
})

test('reads PNG dimensions from the IHDR chunk without decoding pixels', () => {
  assert.deepEqual(readPngSize(pngHeader(3840, 2160)), { width: 3840, height: 2160 })
  assert.deepEqual(readPngSize(pngHeader(1, 1)), { width: 1, height: 1 })
})

test('PNG header parsing rejects truncated and non-PNG buffers', () => {
  assert.equal(readPngSize(Buffer.alloc(0)), null)
  assert.equal(readPngSize(Buffer.alloc(23)), null)
  assert.equal(readPngSize(Buffer.alloc(32)), null)
  const notPng = Buffer.alloc(32)
  notPng.write('JPEG', 12, 'ascii')
  assert.equal(readPngSize(notPng), null)
  assert.equal(readPngSize('not a buffer'), null)
})
