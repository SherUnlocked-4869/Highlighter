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

  // B2/B3/B5 (D9): per-tool style options. Every table is a preset list plus a
  // resolver whose fallback is the pre-B2 rendering, so an annotation carrying none
  // of these fields still draws exactly what it drew before.
  const FILL_PRESETS = Object.freeze(['none', 'translucent', 'solid'])
  const DASH_PRESETS = Object.freeze(['solid', 'dashed', 'dotted'])
  const RADIUS_PRESETS = Object.freeze([0, 4, 8])
  // B5: highlight opacity levels; medium (.28) is the value that shipped.
  const ALPHA_PRESETS = Object.freeze({ light: 0.18, medium: 0.28, strong: 0.45 })
  const ALPHA_IDS = Object.freeze(Object.keys(ALPHA_PRESETS))
  // A translucent fill is drawn at the same opacity the highlight already used.
  const FILL_ALPHA = 0.28
  // Brush-stroke plans (docs/plans/2026-10-19-brush-highlight-mosaic-interaction-design.md
  // §3.2.2, decision D3): the mosaic pixel block is 12 CSS px. The renderer converts it to
  // output pixels with `MOSAIC_CELL * scale`, where scale is target pixels per CSS px
  // (devicePixelRatio on screen, the export factor in exportSelectionCanvas) - so the
  // blocks stay visually the same size on a HiDPI screen and in an exported PNG.
  const MOSAIC_CELL = 12

  // Which option fields each tool owns. Reading and writing per tool is what keeps
  // unrelated fields off an item (a pen must never carry a fill, a rect no alpha).
  const TOOL_OPTION_FIELDS = Object.freeze({
    rect: Object.freeze(['fill', 'dash', 'radius']),
    ellipse: Object.freeze(['fill', 'dash']),
    line: Object.freeze(['dash']),
    arrow: Object.freeze(['dash', 'startHead', 'endHead']),
    highlight: Object.freeze(['alpha']),
    text: Object.freeze(['bold'])
  })

  // D9 defaults: outline-only shapes, solid strokes, square corners, one arrow head
  // at the tip, medium highlight, no bold text.
  const DEFAULT_TOOL_OPTIONS = Object.freeze({
    rect: Object.freeze({ fill: 'none', dash: 'solid', radius: 0 }),
    ellipse: Object.freeze({ fill: 'none', dash: 'solid' }),
    line: Object.freeze({ dash: 'solid' }),
    arrow: Object.freeze({ dash: 'solid', startHead: false, endHead: true }),
    highlight: Object.freeze({ alpha: 'medium' }),
    text: Object.freeze({ bold: false })
  })

  // B4 (D7): the tools that own a remembered style. The settings template enumerates
  // exactly these, so this list is what keeps the store and the renderer in step.
  // Brush plan (D2-B'): blur joined so the wheel's width step survives the gesture - a
  // width the renderer honours but never remembers is a fake control (plan §3.6).
  const TOOL_STYLE_TOOLS = Object.freeze(['rect', 'ellipse', 'arrow', 'line', 'pen', 'highlight', 'text', 'serial', 'blur'])
  // Highlight shipped yellow (its own default colour), every other tool red.
  const TOOL_DEFAULT_COLORS = Object.freeze({ highlight: '#ffcc00' })

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

  // B4 (D7) + A4 (D4): the field-level normaliser for one tool's remembered style.
  // `stored` may be the persisted block or a selected annotation (the echo reads a
  // selected item through the same function), and every field degrades to the shipped
  // default instead of reaching the renderer.
  function defaultColorForTool(tool) {
    return Object.hasOwn(TOOL_DEFAULT_COLORS, tool) ? TOOL_DEFAULT_COLORS[tool] : DEFAULT_COLOR
  }

  function resolveToolStyle(tool, stored) {
    const source = stored && typeof stored === 'object' ? stored : {}
    return Object.assign({
      color: normalizeAnnotationColor(source.color === undefined ? defaultColorForTool(tool) : source.color),
      width: resolveWidth(source.width === undefined ? DEFAULT_WIDTH : source.width)
    }, resolveToolOptions(tool, source))
  }

  // The full canonical map, one block per remembered tool. Persisting this whole
  // object is what makes the "always merge with the newest store" rule safe: nothing
  // is written field by field, so a stale window cannot clobber half a style.
  function resolveToolStyles(stored) {
    const source = stored && typeof stored === 'object' ? stored : {}
    const styles = {}
    for (const tool of TOOL_STYLE_TOOLS) styles[tool] = resolveToolStyle(tool, source[tool])
    return styles
  }

  function scaleFactor(value) {
    const scale = Number(value)
    return Number.isFinite(scale) && scale > 0 ? scale : 1
  }

  // ---------- B2/B3/B5: option presets ----------

  function resolveFill(value) {
    return FILL_PRESETS.includes(value) ? value : 'none'
  }

  function resolveDash(value) {
    return DASH_PRESETS.includes(value) ? value : 'solid'
  }

  function resolveRadius(value) {
    const radius = Number(value)
    return RADIUS_PRESETS.includes(radius) ? radius : 0
  }

  // Returns the numeric opacity so the renderer assigns it directly; an unknown or
  // missing level keeps the shipped .28.
  function resolveAlpha(value) {
    return Object.hasOwn(ALPHA_PRESETS, value) ? ALPHA_PRESETS[value] : ALPHA_PRESETS.medium
  }

  // The dash pattern in device pixels for one stroke of `width` (already scaled by
  // the export factor by the caller). 'solid' returns [] so the caller leaves the
  // canvas default alone and pre-B2 output stays byte-identical.
  function dashPattern(dash, width) {
    const resolved = resolveDash(dash)
    if (resolved === 'solid') return []
    const stroke = Math.max(1, Number(width) || 1)
    return resolved === 'dashed' ? [stroke * 3, stroke * 2] : [stroke, stroke * 1.5]
  }

  // Field-level normalisation of one tool's stored options. `stored` may be a stored
  // settings block or an annotation itself (A4 reads a selected item through it), and
  // anything unknown degrades to the D9 default instead of reaching the renderer.
  function resolveToolOptions(tool, stored) {
    const fields = TOOL_OPTION_FIELDS[tool]
    if (!fields) return {}
    const base = DEFAULT_TOOL_OPTIONS[tool] || {}
    const source = stored && typeof stored === 'object' ? stored : {}
    const options = {}
    for (const field of fields) {
      const value = source[field] === undefined ? base[field] : source[field]
      switch (field) {
        case 'fill': options.fill = resolveFill(value); break
        case 'dash': options.dash = resolveDash(value); break
        case 'radius': options.radius = resolveRadius(value); break
        case 'alpha': options.alpha = ALPHA_IDS.includes(value) ? value : 'medium'; break
        case 'bold': options.bold = value === true; break
        case 'startHead': options.startHead = value === true; break
        case 'endHead': options.endHead = value !== false; break
        default: break
      }
    }
    return options
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

  // Brush plan (D1): the mosaic brush is wider than the highlighter - below ~18 CSS px a
  // sub-two-cell brush no longer reads as "pixelated". Same three width presets as every
  // other tool, so the wheel and the toolbar keep working without a fourth control.
  function blurBrushWidth(width, scale) {
    return Math.max(18, resolveWidth(width) * scaleFactor(scale) * 6)
  }

  return {
    WIDTH_PRESETS,
    WIDTHS,
    DEFAULT_WIDTH,
    PRESET_COLORS,
    DEFAULT_COLOR,
    FILL_PRESETS,
    DASH_PRESETS,
    RADIUS_PRESETS,
    ALPHA_PRESETS,
    FILL_ALPHA,
    MOSAIC_CELL,
    TOOL_OPTION_FIELDS,
    DEFAULT_TOOL_OPTIONS,
    TOOL_STYLE_TOOLS,
    TOOL_DEFAULT_COLORS,
    resolveWidth,
    normalizeAnnotationColor,
    nextWidthPreset,
    resolveFill,
    resolveDash,
    resolveRadius,
    resolveAlpha,
    dashPattern,
    resolveToolOptions,
    resolveToolStyle,
    resolveToolStyles,
    scaleFactor,
    textFontSize,
    serialRadius,
    highlightWidth,
    blurBrushWidth
  }
})
