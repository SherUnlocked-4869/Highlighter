'use strict'

// U02 / DEV-02 (docs/plans/2026-11-28-review-optimization-follow-up-tasks.md):
// offscreen "export the current view" for a pinned image.
//
// The old path injected a hide-the-chrome style sheet into the live pin window and then
// asked the main process to capturePage() it. That round trip is the source of two
// observable defects: transient controls could be painted into the shot when the
// prepare step failed, and the style/restore pair could make the on-screen pin flicker.
//
// The replacement is a pure plan + a small painter:
//   * the RENDERER measures the live view and draws the same picture into an offscreen
//     2D canvas (this file), never touching the visible page;
//   * the MAIN process receives the bounded PNG, previews it, and saves exactly those
//     bytes (see main/domains/pin/index.js::exportPinView).
//
// Coordinate model
// ----------------
//   * `viewport`  - the window content box in CSS px (`innerWidth/innerHeight`) plus
//                   `devicePixelRatio`. The export is that box at physical pixels, which
//                   is what capturePage used to return.
//   * the picture - pin.css lays the image out at `width:100%; height:auto` inside
//                   #rotor. #rotor is the whole window for 0/180 degrees; for 90/270 it
//                   is the centred, axis-swapped frame described by ROTATED_ROTOR.
//   * rotation    - a CSS transform about #rotor's centre (which is the window centre).
//                   The plan keeps the pre-transform rectangle and the angle instead of
//                   re-deriving corners, so the painter and the tests matrix-transform
//                   the same numbers the browser does.
//   * long capture- body.long-capture scrolls; the visible strip is the scroll offset,
//                   so the picture is drawn at -scrollTop and the canvas clips it.
//   * OCR overlay - #pinOcrOverlay is `position:absolute; inset:0` inside #rotor and its
//                   blocks are laid out in the surface's display pixels. The plan
//                   reproduces the block rectangles (geometry parity with the live DOM)
//                   and the painter draws rounded-ish text chips. Text ANTIALIASING and
//                   per-glyph hinting differ from DOM text rendering by nature; that
//                   difference is documented and excluded from "pixel parity".
//
// Everything here is UMD: the pin window loads it as a classic script, node:test can
// require() it, and the main process never needs it (it only validates the PNG).
// No DOM/Electron globals are touched at require time.

;(function exposePinViewExport(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else if (root) root.pinViewExport = api
})(typeof globalThis === 'object' ? globalThis : typeof window === 'object' ? window : this, () => {
  // Bounded output. MAX_EXPORT_PIXELS is deliberately a little below 32 Mpx: a canvas
  // costs 4 bytes per pixel and 32 Mpx would already be a 128 MiB backing store. 24 Mpx
  // still covers a 4K pin at 200% on a 55%-of-work-area window.
  const MAX_EXPORT_DIMENSION = 16384
  const MAX_EXPORT_PIXELS = 24000000
  const MAX_EXPORT_PNG_BYTES = 32 * 1024 * 1024
  const MAX_OCR_BLOCKS = 200
  const MAX_OCR_TEXT_LENGTH = 512
  // P2-04: the measured overlay layout is a bounded copy of the rendered DOM. The glyph
  // budget is the hard cap on how many per-glyph boxes an export may carry, lines per
  // block and blocks are capped by the same limits as the live overlay.
  const MAX_OCR_GLYPHS = 4096
  const MAX_OCR_LINES = 512
  const DEFAULT_OCR_FONT = 'system-ui, sans-serif'
  // What the composition must never contain. The first two are absent by construction
  // (we draw the pinned picture, not the screen); the rest are the transient window
  // chrome that the old capturePage path had to hide with a style sheet.
  const VIEW_EXPORT_EXCLUSIONS = Object.freeze([
    'desktop',
    'other-windows',
    'badges',
    'recognition-status',
    'controls',
    'window-border'
  ])
  const VALID_ROTATIONS = Object.freeze([0, 90, 180, 270])

  function finiteOr(value, fallback) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return fallback
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  function positiveOr(value, fallback) {
    const parsed = finiteOr(value, Number.NaN)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  }

  function normalizeRotation(value) {
    const raw = finiteOr(value, 0)
    const snapped = ((Math.round(raw / 90) * 90) % 360 + 360) % 360
    return VALID_ROTATIONS.includes(snapped) ? snapped : 0
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value))
  }

  function normalizeViewport(value) {
    const source = value && typeof value === 'object' ? value : {}
    return {
      width: Math.max(1, Math.round(positiveOr(source.width, 0))),
      height: Math.max(1, Math.round(positiveOr(source.height, 0))),
      // A sane DPR guard: a bogus 0 would produce a 1 px export, a bogus 16 a 16x one.
      devicePixelRatio: clamp(positiveOr(source.devicePixelRatio, 1), 0.5, 4)
    }
  }

  // P2-02: the picture's ACTUALLY visible rectangle in window CSS px, as measured from the
  // live surface (getBoundingClientRect). For a long capture its negative top is the real
  // scroll offset: pin.css scrolls BODY, so document.scrollingElement (the HTML element)
  // never moves and must not be consulted.
  function normalizeVisibleRect(value) {
    if (!value || typeof value !== 'object') return null
    const rect = {
      x: finiteOr(value.x, Number.NaN),
      y: finiteOr(value.y, Number.NaN),
      width: finiteOr(value.width, Number.NaN),
      height: finiteOr(value.height, Number.NaN)
    }
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null
    if (!(rect.width > 0) || !(rect.height > 0)) return null
    return rect
  }

  // The pinned picture's intrinsic size. The painter receives the live element; only its
  // natural width/height matter to the plan.
  function normalizeSurface(value) {
    const source = value && typeof value === 'object' ? value : {}
    return {
      width: Math.max(0, Math.round(finiteOr(source.width ?? source.naturalWidth, 0))),
      height: Math.max(0, Math.round(finiteOr(source.height ?? source.naturalHeight, 0)))
    }
  }

  // Visible OCR/translation blocks, exactly the set renderRecognition() shows: the
  // translated result while translating, the source text when "show source" is on. `layout`
  // is the optional measurement of the rendered overlay (see planOcrBlocks).
  function resolveVisibleOcr(input) {
    const source = input && typeof input === 'object' ? input : {}
    const blocks = Array.isArray(source.blocks) ? source.blocks : []
    return {
      visible: source.visible === true && blocks.length > 0,
      translated: source.translated === true,
      imageWidth: positiveOr(source.imageWidth, 0),
      imageHeight: positiveOr(source.imageHeight, 0),
      blocks,
      layout: Array.isArray(source.layout) ? source.layout : []
    }
  }

  function mapOcrBlockPoints(block, scaleX, scaleY) {
    if (!Array.isArray(block?.box_points) || block.box_points.length < 4) return null
    const points = []
    for (const point of block.box_points) {
      const x = finiteOr(point?.x, Number.NaN) * scaleX
      const y = finiteOr(point?.y, Number.NaN) * scaleY
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null
      points.push({ x, y })
    }
    const edgeX = points[1].x - points[0].x
    const edgeY = points[1].y - points[0].y
    const blockWidth = Math.hypot(edgeX, edgeY)
    const blockHeight = Math.hypot(points[3].x - points[0].x, points[3].y - points[0].y)
    if (blockWidth < 2 || blockHeight < 2) return null
    return {
      centerX: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      centerY: points.reduce((sum, point) => sum + point.y, 0) / points.length,
      width: blockWidth,
      height: blockHeight,
      angle: Math.abs(Math.atan2(edgeY, edgeX) * 180 / Math.PI) < 3 ? 0 : Math.atan2(edgeY, edgeX) * 180 / Math.PI,
      vertical: blockHeight > blockWidth * 1.5
    }
  }

  function rotatePoint(point, center, angleDegrees) {
    if (!angleDegrees) return { x: point.x, y: point.y }
    const radians = angleDegrees * Math.PI / 180
    const cos = Math.cos(radians)
    const sin = Math.sin(radians)
    const dx = point.x - center.x
    const dy = point.y - center.y
    return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos }
  }

  // Source pixels -> plan output pixels for the actual drawImage call, INCLUDING the
  // long-capture scroll offset (the picture is painted at -scrollTop and clipped).
  // P2-02: when the caller measured the surface's live rectangle, that rectangle is the
  // single source of truth for the long-capture strip (its top is the real scroll offset
  // and its width excludes the body scrollbar); scrollTop stays the deterministic fallback
  // for plan-only callers (tests, a host without getBoundingClientRect).
  function resolvePictureRect(viewport, surface, rotation, longCapture, scrollTop, visibleRect) {
    const displayWidth = viewport.width
    if (longCapture) {
      const width = visibleRect ? visibleRect.width : displayWidth
      const displayHeight = width * surface.height / surface.width
      return {
        x: visibleRect ? visibleRect.x : 0,
        y: visibleRect ? visibleRect.y : -scrollTop,
        width,
        height: displayHeight
      }
    }
    const displayHeight = displayWidth * surface.height / surface.width
    if (rotation === 90 || rotation === 270) {
      // pin.css: body:not(.long-capture)[data-rotation="90"] #rotor is a centred frame with
      // width:100vh, height:100vw. The picture is `width:100%;height:auto` inside it, so it
      // is as wide as the frame's PRE-transform width (the window height).
      const rotorWidth = viewport.height
      const rotorHeight = viewport.width
      return {
        x: (viewport.width - rotorWidth) / 2,
        y: (viewport.height - rotorHeight) / 2,
        width: rotorWidth,
        height: rotorWidth * surface.height / surface.width
      }
    }
    // 0/180: #rotor covers the window; the picture spans the content width.
    return { x: 0, y: 0, width: displayWidth, height: displayHeight }
  }

  // P2-04: map ONE measured overlay block onto the export. The entry was measured from the
  // rendered overlay DOM (`shared/ocr-text-overlay.js::measureLayout`): chip centre/size in
  // surface-local CSS px plus per-glyph boxes relative to the chip centre. Nothing is
  // re-derived from the OCR box points here, so wrapped translations and vertical-rl
  // columns keep the browser's own wrap points and reading direction.
  function mapMeasuredOcrBlock(entry, block, pictureRect, viewport, rotation, scale, longCapture, glyphBudget, translated) {
    const width = positiveOr(entry.width, 0)
    const height = positiveOr(entry.height, 0)
    const fontSize = positiveOr(entry.fontSize, 0)
    const centerX = finiteOr(entry.centerX, Number.NaN)
    const centerY = finiteOr(entry.centerY, Number.NaN)
    if (!width || !height || !fontSize || !Number.isFinite(centerX) || !Number.isFinite(centerY)) return null
    const lines = []
    let glyphCount = 0
    for (const line of Array.isArray(entry.lines) ? entry.lines : []) {
      if (lines.length >= MAX_OCR_LINES || glyphCount >= glyphBudget) break
      if (!line || typeof line !== 'object') continue
      const glyphs = []
      for (const glyph of Array.isArray(line.glyphs) ? line.glyphs : []) {
        if (glyphCount >= glyphBudget) break
        const text = typeof glyph?.text === 'string' ? glyph.text.slice(0, 4) : ''
        const x = finiteOr(glyph?.x, Number.NaN)
        const y = finiteOr(glyph?.y, Number.NaN)
        if (!text || !Number.isFinite(x) || !Number.isFinite(y)) continue
        glyphs.push({
          text,
          x: x * scale,
          y: y * scale,
          width: positiveOr(glyph.width, 0) * scale,
          height: positiveOr(glyph.height, 0) * scale
        })
        glyphCount += 1
      }
      const lineText = typeof line.text === 'string'
        ? line.text.slice(0, MAX_OCR_TEXT_LENGTH)
        : glyphs.map((glyph) => glyph.text).join('')
      if (!lineText && glyphs.length === 0) continue
      lines.push({
        text: lineText,
        x: finiteOr(line.x, 0) * scale,
        y: finiteOr(line.y, 0) * scale,
        width: positiveOr(line.width, 0) * scale,
        height: positiveOr(line.height, 0) * scale,
        glyphs
      })
    }
    // A structurally valid measurement with no visible glyphs is still authoritative: the
    // live chip's overflow clipped every glyph away, so the export must paint the chip and
    // no text (the legacy centred-line fallback would invent pixels the user cannot see).
    // Only malformed measurements fall back to the box-point geometry.
    // Pre-transform chip centre in the picture's pre-transform frame, then the same rotation
    // the whole picture gets; chip-local glyph boxes stay in the chip frame.
    const pre = { x: pictureRect.x + centerX, y: pictureRect.y + centerY }
    const placed = rotatePoint(pre, { x: viewport.width / 2, y: viewport.height / 2 }, rotation)
    const outCenter = { x: placed.x * scale, y: placed.y * scale }
    const outWidth = width * scale
    const outHeight = height * scale
    if (longCapture && (outCenter.y + outHeight / 2 < 0 || outCenter.y - outHeight / 2 > viewport.height * scale)) return null
    return {
      block: {
        text: typeof block?.text === 'string' ? block.text.slice(0, MAX_OCR_TEXT_LENGTH) : '',
        centerX: outCenter.x,
        centerY: outCenter.y,
        width: outWidth,
        height: outHeight,
        angle: finiteOr(entry.angle, 0) + rotation,
        rotated: rotation !== 0,
        vertical: entry.vertical === true,
        translated: translated === true,
        fontSize: fontSize * scale,
        fontFamily: typeof entry.fontFamily === 'string' && entry.fontFamily
          ? entry.fontFamily.slice(0, 128)
          : DEFAULT_OCR_FONT,
        measured: true,
        lines
      },
      glyphCount
    }
  }

  function planOcrBlocks(ocr, surface, pictureRect, viewport, rotation, scale, longCapture) {
    const blocks = []
    if (!ocr.visible) return blocks
    const imageWidth = positiveOr(ocr.imageWidth, surface.width)
    const imageHeight = positiveOr(ocr.imageHeight, surface.height)
    if (!imageWidth || !imageHeight) return blocks
    // renderBlocks() maps OCR image pixels onto the surface's DISPLAY size.
    const scaleX = pictureRect.width / imageWidth
    const scaleY = pictureRect.height / imageHeight
    const center = { x: viewport.width / 2, y: viewport.height / 2 }
    // P2-04: the renderer hands over the layout measured from the rendered overlay. The
    // block indexes are positions in the same `textBlocks` array the plan iterates, so a
    // filtered/hidden block simply falls back to the deterministic box-point geometry.
    const measuredByIndex = new Map()
    for (const entry of Array.isArray(ocr.layout) ? ocr.layout : []) {
      const index = Number(entry?.blockIndex)
      if (!Number.isInteger(index) || index < 0 || measuredByIndex.has(index)) continue
      measuredByIndex.set(index, entry)
    }
    let glyphBudget = MAX_OCR_GLYPHS
    for (let blockIndex = 0; blockIndex < ocr.blocks.length; blockIndex += 1) {
      if (blocks.length >= MAX_OCR_BLOCKS) break
      const block = ocr.blocks[blockIndex]
      if (typeof block?.text !== 'string' || !block.text) continue
      if (Number(block.text_score) < 0) continue
      if (glyphBudget > 0) {
        const measured = measuredByIndex.get(blockIndex)
        const mapped = measured
          ? mapMeasuredOcrBlock(measured, block, pictureRect, viewport, rotation, scale, longCapture, glyphBudget, ocr.translated === true)
          : null
        if (mapped) {
          glyphBudget -= mapped.glyphCount
          blocks.push(mapped.block)
          continue
        }
      }
      const geometry = mapOcrBlockPoints(block, scaleX, scaleY)
      if (!geometry) continue
      // Pre-transform position inside #rotor, which starts at the picture's pre-transform
      // origin (pictureRect is that origin for every rotation case).
      const pre = {
        x: pictureRect.x + geometry.centerX,
        y: pictureRect.y + geometry.centerY
      }
      const placed = rotatePoint(pre, center, rotation)
      // `pre` is already a viewport coordinate: for a long capture pictureRect.y carries the
      // negative scroll offset, so no second subtraction happens here.
      const outCenter = { x: placed.x * scale, y: placed.y * scale }
      const width = geometry.width * scale
      const height = geometry.height * scale
      // Long captures scroll: a block entirely outside the visible strip is not exported.
      if (longCapture && (outCenter.y + height / 2 < 0 || outCenter.y - height / 2 > viewport.height * scale)) continue
      const fontSize = Math.max(9, Math.min(36, (geometry.vertical ? geometry.width : geometry.height) * 0.72)) * scale
      blocks.push({
        text: block.text.slice(0, MAX_OCR_TEXT_LENGTH),
        centerX: outCenter.x,
        centerY: outCenter.y,
        width,
        height,
        angle: geometry.angle + rotation,
        rotated: rotation !== 0,
        vertical: geometry.vertical,
        translated: ocr.translated === true,
        fontSize
      })
    }
    return blocks
  }

  // The one function the renderer calls to decide what to paint. Returns a serialisable
  // plan (also used verbatim by the tests) or a bounded failure code:
  //   empty-image    - the pin has no decoded pixels yet
  //   too-large      - the physical view exceeds MAX_EXPORT_PIXELS / MAX_EXPORT_DIMENSION
  function planViewExport(input = {}) {
    const source = input && typeof input === 'object' ? input : {}
    const viewport = normalizeViewport(source.viewport)
    const surface = normalizeSurface(source.surface)
    const rotation = normalizeRotation(source.rotation)
    const longCapture = source.longCapture === true
    const ocr = resolveVisibleOcr(source.ocr)
    if (!surface.width || !surface.height) return { ok: false, code: 'empty-image' }
    const scale = viewport.devicePixelRatio
    const width = Math.max(1, Math.round(viewport.width * scale))
    const height = Math.max(1, Math.round(viewport.height * scale))
    if (width > MAX_EXPORT_DIMENSION || height > MAX_EXPORT_DIMENSION) {
      return { ok: false, code: 'too-large', width, height }
    }
    if (width * height > MAX_EXPORT_PIXELS) return { ok: false, code: 'too-large', width, height }
    // P2-02: a measured visible rectangle wins for a long capture; the explicit offset is
    // the deterministic fallback for plan-only callers. Rotation/zoom semantics are
    // untouched: the CSS-managed frame still supplies the non-scrolling geometry.
    const visibleRect = normalizeVisibleRect(source.visibleRect)
    const effectiveRect = longCapture ? visibleRect : null
    const scrollTop = longCapture
      ? (effectiveRect ? Math.max(0, -effectiveRect.y) : Math.max(0, finiteOr(source.scrollTop, 0)))
      : 0
    const pictureRect = resolvePictureRect(viewport, surface, rotation, longCapture, scrollTop, effectiveRect)
    const center = { x: viewport.width / 2, y: viewport.height / 2 }
    const picture = {
      // Whole intrinsic picture: the rotation transform below supplies orientation.
      source: { x: 0, y: 0, width: surface.width, height: surface.height },
      dest: {
        x: pictureRect.x * scale,
        y: pictureRect.y * scale,
        width: pictureRect.width * scale,
        height: pictureRect.height * scale
      },
      rotation,
      center: { x: center.x * scale, y: center.y * scale }
    }
    const ocrBlocks = planOcrBlocks(ocr, surface, pictureRect, viewport, rotation, scale, longCapture)
    return {
      ok: true,
      width,
      height,
      scale,
      rotation,
      quarterTurn: rotation === 90 || rotation === 270,
      longCapture,
      scrollTop,
      visibleRect,
      picture,
      ocrBlocks,
      ocrOverlay: ocrBlocks.length > 0,
      exclusions: [...VIEW_EXPORT_EXCLUSIONS]
    }
  }

  // Paints a plan into an offscreen 2D context. `sources.picture` is the live
  // Image/Canvas element (or any CanvasImageSource). Only the plan decides geometry.
  function drawViewExport(context, plan, sources = {}) {
    if (!context || !plan || plan.ok !== true) return false
    const picture = sources.picture
    if (!picture) return false
    context.save()
    if (plan.picture.rotation) {
      const center = plan.picture.center
      context.translate(center.x, center.y)
      context.rotate(plan.picture.rotation * Math.PI / 180)
      context.translate(-center.x, -center.y)
    }
    context.imageSmoothingEnabled = true
    const source = plan.picture.source
    const dest = plan.picture.dest
    context.drawImage(picture, source.x, source.y, source.width, source.height,
      dest.x, dest.y, dest.width, dest.height)
    context.restore()
    for (const block of plan.ocrBlocks) drawOcrBlock(context, block)
    return true
  }

  function drawOcrBlock(context, block) {
    const radians = (block.angle || 0) * Math.PI / 180
    context.save()
    context.translate(block.centerX, block.centerY)
    context.rotate(radians)
    const left = -block.width / 2
    const top = -block.height / 2
    // Chip colours mirror pin.css (#e9f3ff/#143658 and the translated rgba white/#101a25).
    context.fillStyle = block.translated ? 'rgba(255,255,255,0.94)' : '#e9f3ff'
    context.fillRect(left, top, block.width, block.height)
    context.beginPath()
    context.rect(left, top, block.width, block.height)
    context.clip()
    context.fillStyle = block.translated ? '#101a25' : '#143658'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    // P2-04: a measured block is painted exactly where the rendered overlay put every
    // glyph (wrapped lines, vertical-rl columns right-to-left, one font size for the whole
    // block). Nothing is re-wrapped, re-centred or shrunk here. An authoritative
    // measurement with no visible glyphs paints the chip background only.
    if (block.measured === true) {
      const measuredFont = Math.max(1, block.fontSize)
      context.font = `${measuredFont}px ${block.fontFamily || DEFAULT_OCR_FONT}`
      for (const line of Array.isArray(block.lines) ? block.lines : []) {
        if (Array.isArray(line.glyphs) && line.glyphs.length > 0) {
          for (const glyph of line.glyphs) context.fillText(glyph.text, glyph.x, glyph.y)
        } else if (line.text) {
          context.fillText(line.text, line.x, line.y)
        }
      }
      context.restore()
      return
    }
    // Legacy path for callers without a measured layout: one bounded centred fillText,
    // shrunk to the chip width (deterministic, never larger than the plan).
    let fontSize = Math.max(1, block.fontSize)
    context.font = `${fontSize}px ${DEFAULT_OCR_FONT}`
    const measured = typeof context.measureText === 'function' ? context.measureText(block.text) : null
    const available = Math.max(1, block.width - 4)
    if (measured && measured.width > available && measured.width > 0) {
      fontSize = Math.max(1, Math.floor(fontSize * available / measured.width))
      context.font = `${fontSize}px ${DEFAULT_OCR_FONT}`
    }
    context.fillText(block.text, 0, 0)
    context.restore()
  }

  return {
    MAX_EXPORT_DIMENSION,
    MAX_EXPORT_PIXELS,
    MAX_EXPORT_PNG_BYTES,
    MAX_OCR_BLOCKS,
    MAX_OCR_TEXT_LENGTH,
    MAX_OCR_GLYPHS,
    MAX_OCR_LINES,
    DEFAULT_OCR_FONT,
    VIEW_EXPORT_EXCLUSIONS,
    VALID_ROTATIONS,
    normalizeRotation,
    normalizeViewport,
    normalizeSurface,
    normalizeVisibleRect,
    resolveVisibleOcr,
    resolvePictureRect,
    planViewExport,
    drawViewExport
  }
})
