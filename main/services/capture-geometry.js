function finiteNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function getNativeDisplayBounds(display) {
  const left = finiteNumber(display?.left)
  const top = finiteNumber(display?.top)
  const width = Math.max(0, finiteNumber(display?.width, finiteNumber(display?.right) - left))
  const height = Math.max(0, finiteNumber(display?.height, finiteNumber(display?.bottom) - top))
  return { left, top, right: left + width, bottom: top + height, width, height }
}

function findNativeDisplay(displays, expectedBounds, tolerance = 2) {
  const expected = {
    left: finiteNumber(expectedBounds?.x),
    top: finiteNumber(expectedBounds?.y),
    width: Math.max(0, finiteNumber(expectedBounds?.width)),
    height: Math.max(0, finiteNumber(expectedBounds?.height))
  }
  expected.right = expected.left + expected.width
  expected.bottom = expected.top + expected.height
  const maximumError = Math.max(0, finiteNumber(tolerance, 2))

  const matches = (Array.isArray(displays) ? displays : [])
    .map((display) => {
      const bounds = getNativeDisplayBounds(display)
      const errors = [
        Math.abs(bounds.left - expected.left),
        Math.abs(bounds.top - expected.top),
        Math.abs(bounds.right - expected.right),
        Math.abs(bounds.bottom - expected.bottom)
      ]
      return { display, errors, score: errors.reduce((sum, error) => sum + error, 0) }
    })
    .filter(({ errors }) => errors.every((error) => error <= maximumError))
    .sort((left, right) => left.score - right.score)

  return matches[0]?.display || null
}

module.exports = { findNativeDisplay, getNativeDisplayBounds }
