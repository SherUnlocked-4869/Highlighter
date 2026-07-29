const test = require('node:test')
const assert = require('node:assert/strict')

const { findNativeDisplay, getNativeDisplayBounds } = require('../main/services/capture-geometry')

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
