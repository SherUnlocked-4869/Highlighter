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

  // A3 (D3): the seven colours the capture palette offers, byte-identical to the
  // region recorder's ANNOTATION_COLORS (record/annotation-utils.js). The copy is
  // deliberate - the recorder sanitises at its IPC boundary while this module runs
  // inside the capture renderer - so both lists must be changed together.
  const PRESET_COLORS = Object.freeze([
    Object.freeze({ id: 'red', color: '#ff3b30' }),
    Object.freeze({ id: 'orange', color: '#ff9500' }),
    Object.freeze({ id: 'yellow', color: '#ffcc00' }),
    Object.freeze({ id: 'green', color: '#34c759' }),
    Object.freeze({ id: 'blue', color: '#1687ff' }),
    Object.freeze({ id: 'black', color: '#111111' }),
    Object.freeze({ id: 'white', color: '#ffffff' })
  ])
  const DEFAULT_COLOR = '#ff3b30'
  const HEX_COLOR = /^#[0-9a-f]{6}$/i

  // Drawings are scaled on export, so the width reaching these helpers may be a
  // scaled float (e.g. 4 * 1.5). Only the unscaled base width is matched against
  // the whitelist; the scale is applied afterwards.
  function resolveWidth(value) {
    const width = Number(value)
    return WIDTHS.includes(width) ? width : DEFAULT_WIDTH
  }

  // A3 (D3): the capture side stores any #rrggbb colour - a custom picker value
  // must survive a round trip - so this normalises the shape only (six hex digits,
  // lower case) and falls back to the shipped default. The 7-entry palette is a
  // UI preset list, not a whitelist (unlike the recorder's cleanStyle).
  function normalizeAnnotationColor(value) {
    const text = typeof value === 'string' ? value.trim() : ''
    return HEX_COLOR.test(text) ? text.toLowerCase() : DEFAULT_COLOR
  }

  // A2: one wheel notch moves one level along WIDTHS. Both ends clamp instead of
  // wrapping, so a burst never jumps from "thick" back to "thin".
  function nextWidthPreset(current, delta) {
    const step = Number(delta)
    const index = WIDTHS.indexOf(resolveWidth(current))
    if (!Number.isFinite(step) || step === 0) return WIDTHS[index]
    const next = Math.min(WIDTHS.length - 1, Math.max(0, index + (step > 0 ? 1 : -1)))
    return WIDTHS[next]
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
    PRESET_COLORS,
    DEFAULT_COLOR,
    resolveWidth,
    normalizeAnnotationColor,
    nextWidthPreset,
    scaleFactor,
    textFontSize,
    serialRadius,
    highlightWidth
  }
})
