(function exposeAnnotationStyle(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.annotationStyleUtils = api
})(typeof globalThis === 'object' ? globalThis : window, () => {
  // Screenshot annotations offer three thickness levels. The region recorder has
  // its own whitelist (2/4/7 in record/annotation-utils.js) — do not mix the two:
  // this one also drives the text font size and the serial badge radius, and the
  // three kept levels must stay pixel-identical to the values that shipped before
  // the fourth level (特粗 14) was removed.
  const WIDTH_PRESETS = Object.freeze([
    Object.freeze({ id: 'thin', label: '细', width: 2 }),
    Object.freeze({ id: 'medium', label: '中', width: 4 }),
    Object.freeze({ id: 'thick', label: '粗', width: 8 })
  ])
  const WIDTHS = Object.freeze(WIDTH_PRESETS.map((preset) => preset.width))
  const DEFAULT_WIDTH = 4

  // Drawings are scaled on export, so the width reaching these helpers may be a
  // scaled float (e.g. 4 * 1.5). Only the unscaled base width is matched against
  // the whitelist; the scale is applied afterwards.
  function resolveWidth(value) {
    const width = Number(value)
    return WIDTHS.includes(width) ? width : DEFAULT_WIDTH
  }

  function scaleFactor(value) {
    const scale = Number(value)
    return Number.isFinite(scale) && scale > 0 ? scale : 1
  }

  function textFontSize(width, scale) {
    return Math.max(14, resolveWidth(width) * scaleFactor(scale) * 5)
  }

  function serialRadius(width, scale) {
    return Math.max(12, resolveWidth(width) * scaleFactor(scale) * 3)
  }

  function highlightWidth(width, scale) {
    return Math.max(14, resolveWidth(width) * scaleFactor(scale) * 4)
  }

  return {
    WIDTH_PRESETS,
    WIDTHS,
    DEFAULT_WIDTH,
    resolveWidth,
    scaleFactor,
    textFontSize,
    serialRadius,
    highlightWidth
  }
})
