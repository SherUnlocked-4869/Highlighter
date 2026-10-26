// Output compositor - feature C (docs/plans/2026-10-25-snow-apps-feature-development-plan.md §6.1).
//
// Why this has to be a real compositor instead of CSS: §6.1 explicitly forbids using a CSS-only
// shadow as the basis for an export - what the preview shows and what gets exported must be the
// same pixels. So the editor's preview AND every export exit (copy/save/pin/PDF/history result
// image) call this function; the only difference is which content canvas they hand in.
//
// Composition order (§6.1 "fixed composition order", not reorderable):
//   1. content layer: the caller has already drawn it (cropped base image -> annotations/capture
//      attachments); this function only receives the content canvas at crop size;
//   2. round the content corners;
//   3. card background + shadow + border (all beneath/around the content layer);
//   4. padding layout: the content lands at plan.contentOffset.
// Feature D's occlusion-safe sampling happens INSIDE the content layer (step 1) and does not
// change the outer layout.
//
// Dependency injection: node has no canvas implementation, so the canvas factory is a PARAMETER
// rather than a module-level `document.createElement`. Browser callers pass a document-based
// factory; unit tests pass a stub and assert the call sequence without doing any real rendering.
// The default kicks in when a DOM is detected, so browser callers may omit it.
;(function exposeOutputCompositor(root, factory) {
  // The style module sits one directory up (shared/), because the MAIN process needs it too
  // (document validation) and must not require anything out of the renderer tree. The two
  // resolution paths therefore differ in their specifier, not their identity.
  const styleApi = (typeof module === 'object' && module.exports)
    ? require('../shared/capture-output-style.js')
    : (root ? root.captureOutputStyle : null)
  const api = factory(styleApi || null)
  if (typeof module === 'object' && module.exports) module.exports = api
  else if (root) root.captureOutputCompositor = api
})(typeof globalThis === 'object' ? globalThis : typeof window === 'object' ? window : this, (styleApi) => {
  'use strict'

  if (!styleApi) throw new Error('output-compositor requires shared/capture-output-style.js')

  // Browser default canvas factory. `document` is only probed when the function actually runs;
  // loading this module makes no DOM assumptions.
  function defaultCreateCanvas(width, height) {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      throw new Error('output-compositor needs an injected createCanvas (no DOM in this environment)')
    }
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width))
    canvas.height = Math.max(1, Math.round(height))
    return canvas
  }

  function getContext(canvas) {
    const context = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null
    if (!context) throw new Error('output-compositor needs a 2D canvas context')
    return context
  }

  // Rounded-rectangle path. canvas.roundRect does not exist in every Electron version, so a
  // hand-written arcTo version is used as the fallback - otherwise a preview could round its
  // corners while the export did not.
  function roundedRectPath(context, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(Number(radius) || 0, Math.min(width, height) / 2))
    if (r <= 0) {
      if (typeof context.rect === 'function') context.rect(x, y, width, height)
      else context.strokeRect(x, y, width, height)
      return
    }
    const right = x + width
    const bottom = y + height
    if (typeof context.roundRect === 'function') {
      context.roundRect(x, y, width, height, r)
      return
    }
    context.moveTo(x + r, y)
    context.lineTo(right - r, y)
    context.arcTo(right, y, right, y + r, r)
    context.lineTo(right, bottom - r)
    context.arcTo(right, bottom, right - r, bottom, r)
    context.lineTo(x + r, bottom)
    context.arcTo(x, bottom, x, bottom - r, r)
    context.lineTo(x, y + r)
    context.arcTo(x, y, x + r, y, r)
    context.closePath()
  }

  function setFill(context, value) {
    context.fillStyle = value
  }

  function setStroke(context, value) {
    context.strokeStyle = value
  }

  // Draw the content at (x, y) clipped to its corner radius. clip() is used rather than an alpha
  // mask: the resulting canvas is PNG-encoded immediately afterwards and the encoder only keeps
  // alpha, while clip's edges are anti-aliased on an offscreen canvas exactly like a mask would
  // be - at one fewer full-image readback.
  function drawClippedContent(context, contentCanvas, plan) {
    const { content } = plan
    context.save()
    context.beginPath()
    roundedRectPath(context, content.x, content.y, content.width, content.height, content.radius)
    context.clip()
    context.imageSmoothingEnabled = true
    context.drawImage(
      contentCanvas,
      content.x,
      content.y,
      content.width,
      content.height
    )
    context.restore()
  }

  /**
   * Compose the output canvas.
   *
   * @param {object} options
   * @param {object} options.contentCanvas  finished content-layer canvas, crop-sized in source pixels
   * @param {object} options.outputStyle    complete or partial outputStyle (normalized internally)
   * @param {function} [options.createCanvas] (width, height) => canvas; defaults to `document`
   * @param {object} [options.plan]         pre-computed plan (preview/export sharing one geometry)
   * @param {number} [options.scale]        content-layer pixel scale (pass the viewport zoom for a
   *                                        preview; 1 means contentCanvas is already source-pixel
   *                                        sized). Geometry is still computed in source pixels and
   *                                        only the final canvas and offsets are multiplied - so
   *                                        the preview and the export are the SAME function with
   *                                        the same parameters, at different resolutions.
   * @returns {object|null} null for the original style (enabled=false); the caller keeps its old path.
   */
  function composeOutputCanvas(options = {}) {
    const source = options && typeof options === 'object' ? options : {}
    const contentCanvas = source.contentCanvas
    if (!contentCanvas) throw new Error('output-compositor needs a contentCanvas')
    const style = styleApi.normalizeOutputStyle(source.outputStyle)
    // Original mode: allocate nothing, change no size; the caller keeps using the content canvas
    // itself (§6.2: original geometry is identical to v1).
    if (!styleApi.isOutputStyleEnabled(style)) return null

    const plan = source.plan && typeof source.plan === 'object'
      ? source.plan
      : styleApi.planOutputComposite({
          contentWidth: Number(contentCanvas.width) || 1,
          contentHeight: Number(contentCanvas.height) || 1,
          outputStyle: style
        })
    const scale = Math.max(1e-6, Number(source.scale) > 0 ? Number(source.scale) : 1)
    const width = Math.max(1, Math.round(plan.width * scale))
    const height = Math.max(1, Math.round(plan.height * scale))
    const budget = styleApi.assertOutputBudget({ width, height })
    if (!budget.ok) {
      // Over budget is NOT silently scaled down: throw and let the caller decide to fall back to
      // the original image and tell the user (§3.3 requires the boundary to be visible).
      const error = new Error(`Composited size exceeds the limit: ${width}x${height}`)
      error.code = budget.code
      error.width = width
      error.height = height
      throw error
    }
    const createCanvas = typeof source.createCanvas === 'function' ? source.createCanvas : defaultCreateCanvas
    const canvas = createCanvas(width, height)
    const context = getContext(canvas)
    context.imageSmoothingEnabled = true

    const s = (value) => value * scale
    const card = {
      x: s(plan.card.x),
      y: s(plan.card.y),
      width: s(plan.card.width),
      height: s(plan.card.height),
      radius: s(plan.card.radius)
    }

    // ---- 1. shadow (drawn beneath the card) ---------------------------------
    if (plan.shadow) {
      context.save()
      context.beginPath()
      roundedRectPath(context, card.x, card.y, card.width, card.height, card.radius)
      context.shadowColor = styleApi.rgba(plan.shadow.color, plan.shadow.alpha)
      context.shadowBlur = s(plan.shadow.blurPx)
      context.shadowOffsetX = s(plan.shadow.offsetXPx)
      context.shadowOffsetY = s(plan.shadow.offsetYPx)
      // Fill an opaque rectangle in the background colour: the shadow properties produce the
      // halo, and the fill itself is covered by the card drawn next, so no "shadow body" shows.
      // Painting it in the background colour (rather than black) keeps a translucent background
      // (alpha < 1) from showing a dark rim.
      setFill(context, styleApi.rgba(plan.background.color, 1))
      context.fill()
      context.restore()
    }

    // ---- 2. card background ------------------------------------------------
    context.save()
    context.beginPath()
    roundedRectPath(context, card.x, card.y, card.width, card.height, card.radius)
    setFill(context, styleApi.rgba(plan.background.color, plan.background.alpha))
    context.fill()
    context.restore()

    // ---- 3. content (rounded clip) -----------------------------------------
    drawClippedContent(context, contentCanvas, {
      content: {
        x: s(plan.content.x),
        y: s(plan.content.y),
        width: s(plan.content.width),
        height: s(plan.content.height),
        radius: s(plan.content.radius)
      }
    })

    // ---- 4. border (topmost, over the content edge, so the outline stays crisp) ----
    if (plan.border) {
      const inset = Math.min(s(plan.border.widthPx) / 2, Math.min(card.width, card.height) / 2)
      context.save()
      context.beginPath()
      roundedRectPath(
        context,
        card.x + inset,
        card.y + inset,
        Math.max(0, card.width - inset * 2),
        Math.max(0, card.height - inset * 2),
        Math.max(0, card.radius - inset)
      )
      setStroke(context, styleApi.rgba(plan.border.color, 1))
      context.lineWidth = s(plan.border.widthPx)
      context.stroke()
      context.restore()
    }

    return canvas
  }

  /**
   * Geometry only, no canvas allocation. The renderer's layout preview uses this before it gets
   * to the drawing step, and it goes through the same plan as composeOutputCanvas, so the two
   * cannot report different sizes.
   */
  function composeOutputGeometry(options = {}) {
    const source = options && typeof options === 'object' ? options : {}
    const style = styleApi.normalizeOutputStyle(source.outputStyle)
    if (!styleApi.isOutputStyleEnabled(style)) {
      const contentWidth = Math.max(1, Math.round(Number(source.contentWidth) || 1))
      const contentHeight = Math.max(1, Math.round(Number(source.contentHeight) || 1))
      return { enabled: false, width: contentWidth, height: contentHeight, contentOffsetX: 0, contentOffsetY: 0 }
    }
    const plan = styleApi.planOutputComposite({
      contentWidth: source.contentWidth,
      contentHeight: source.contentHeight,
      outputStyle: style
    })
    const scale = Math.max(1e-6, Number(source.scale) > 0 ? Number(source.scale) : 1)
    return {
      enabled: true,
      width: Math.max(1, Math.round(plan.width * scale)),
      height: Math.max(1, Math.round(plan.height * scale)),
      contentOffsetX: plan.contentOffsetX * scale,
      contentOffsetY: plan.contentOffsetY * scale,
      plan
    }
  }

  return {
    composeOutputCanvas,
    composeOutputGeometry,
    roundedRectPath
  }
})
