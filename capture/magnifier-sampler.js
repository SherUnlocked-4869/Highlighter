// Magnifier sampler - feature D2 (docs/plans/2026-10-25-snow-apps-feature-development-plan.md §7.2).
//
// The magnifier is the one annotation that reads pixels from somewhere else in the image, which
// makes it the one feature that can leak what a blur was covering. §7.2 therefore defines a
// dedicated SAMPLE BASE rather than letting the lens read the composed canvas:
//
//   sample base = original base image + opaque mask over every blur still present in the document
//                 (no magnifiers, no ordinary annotations, no output-style frame)
//
// "opaque mask" is what `shared/occlusion-mask.js` describes in source pixels. This module owns
// the two things that module cannot: the CACHE (its budget, its invalidation and its teardown)
// and the browser-side draw call that turns the plan into pixels.
//
// Why the ordering matters (§7.2 "mask before scaling"): the mask is applied at source resolution, and
// only then is the sampled region scaled up by the factor. Masking after scaling would leave the
// interpolation halo of the un-masked pixels OUTSIDE the blur rect - the exact leak the mask
// exists to prevent. `composeSampleBase` takes a source-resolution canvas for that reason.
//
// The cache is byte-budgeted (32 MiB, §3.3) rather than entry-counted, because a 4x lens over a
// 4K region and a 2x lens over a thumbnail differ by three orders of magnitude and an entry count
// cannot see the difference.
;(function exposeMagnifierSampler(root, factory) {
  const magnifierApi = (typeof module === 'object' && module.exports)
    ? require('../shared/magnifier-geometry.js')
    : (root ? root.magnifierGeometry : null)
  const occlusionApi = (typeof module === 'object' && module.exports)
    ? require('../shared/occlusion-mask.js')
    : (root ? root.occlusionMask : null)
  const api = factory(magnifierApi || null, occlusionApi || null)
  if (typeof module === 'object' && module.exports) module.exports = api
  else if (root) root.magnifierSampler = api
})(typeof globalThis === 'object' ? globalThis : typeof window === 'object' ? window : this, (magnifierApi, occlusionApi) => {
  'use strict'

  if (!magnifierApi) throw new Error('magnifier-sampler requires shared/magnifier-geometry.js')
  if (!occlusionApi) throw new Error('magnifier-sampler requires shared/occlusion-mask.js')

  // §3.3: the sample cache is capped at 32 MiB in total. Bytes, not entries - see the header.
  const CACHE_BUDGET_BYTES = 32 * 1024 * 1024
  // 4 bytes per pixel is what a canvas backing store costs on every platform this ships on
  // (RGBA8), so it is the honest accounting unit rather than a guess.
  const BYTES_PER_PIXEL = 4

  function canvasBytes(canvas) {
    const width = Math.max(0, Math.round(Number(canvas?.width) || 0))
    const height = Math.max(0, Math.round(Number(canvas?.height) || 0))
    return width * height * BYTES_PER_PIXEL
  }

  function defaultCreateCanvas(width, height) {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      throw new Error('magnifier-sampler needs an injected createCanvas (no DOM in this environment)')
    }
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width))
    canvas.height = Math.max(1, Math.round(height))
    return canvas
  }

  function getContext(canvas) {
    const context = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null
    if (!context) throw new Error('magnifier-sampler needs a 2D canvas context')
    return context
  }

  /**
   * Compose the sample base: base image cropped to `crop`, then every blur mask painted opaque,
   * all at SOURCE resolution (no scaling - see the header).
   *
   * @param {object} options
   * @param {object} options.baseImage      canvas/image holding the whole base image
   * @param {object} options.crop           {x,y,w,h} in base-image source pixels
   * @param {object[]} [options.occluders]  `shared/occlusion-mask.buildOccluders()` output
   * @param {object} [options.plan]         `shared/occlusion-mask.planOcclusion()` output; computed
   *                                        from occluders when omitted
   * @param {function} [options.createCanvas]
   * @returns {object} canvas sized to the crop
   */
  function composeSampleBase(options = {}) {
    const source = options && typeof options === 'object' ? options : {}
    const baseImage = source.baseImage
    if (!baseImage) throw new Error('magnifier-sampler needs a baseImage')
    const crop = source.crop || {}
    const width = Math.max(1, Math.round(Number(crop.w) || Number(baseImage.width) || 1))
    const height = Math.max(1, Math.round(Number(crop.h) || Number(baseImage.height) || 1))
    const createCanvas = typeof source.createCanvas === 'function' ? source.createCanvas : defaultCreateCanvas
    const canvas = createCanvas(width, height)
    const context = getContext(canvas)
    context.imageSmoothingEnabled = false
    // 1. The crop region of the base image, 1:1 (no resampling: the mask's byte accounting and the
    //    lens's factor both assume source pixels).
    context.drawImage(
      baseImage,
      Math.round(Number(crop.x) || 0),
      Math.round(Number(crop.y) || 0),
      width,
      height,
      0,
      0,
      width,
      height
    )
    // 2. The masks, still at source resolution. Painted AFTER the image and BEFORE any scaling.
    const plan = source.plan && typeof source.plan === 'object'
      ? source.plan
      : occlusionApi.planOcclusion({ crop: { x: crop.x, y: crop.y, w: width, h: height }, occluders: source.occluders })
    paintOcclusion(context, plan)
    return { canvas, plan, width, height }
  }

  /**
   * Paint an occlusion plan onto a context. Split out so a test can assert the exact pixels a
   * mask covers (the plan is in source pixels; this is the only place they become opaque black).
   */
  function paintOcclusion(context, plan) {
    const ops = Array.isArray(plan?.ops) ? plan.ops : []
    if (!ops.length) return 0
    context.save()
    context.fillStyle = occlusionApi.MASK_COLOR
    context.strokeStyle = occlusionApi.MASK_COLOR
    context.globalAlpha = occlusionApi.MASK_ALPHA
    context.lineCap = 'round'
    context.lineJoin = 'round'
    let painted = 0
    for (const op of ops) {
      if (op.kind === 'rect') {
        // Fill the whole clipped rectangle, no anti-aliased edge: a half-covered pixel at the
        // boundary must still be unreadable, so the rect is drawn on integer coordinates.
        context.fillRect(op.x, op.y, op.w, op.h)
        painted += 1
        continue
      }
      if (op.kind === 'polyline' && Array.isArray(op.points) && op.points.length) {
        // A polyline mask is the brush stroke itself, stroked at full width: that covers the
        // half-width on both sides and the round end caps (§8: half stroke width and end caps included).
        context.lineWidth = Math.max(1, Number(op.width) || 1)
        context.beginPath()
        context.moveTo(op.points[0].x, op.points[0].y)
        if (op.points.length === 1) {
          // A single sample still paints a dot (the cap), otherwise a one-click mosaic on a
          // secret would mask nothing.
          context.lineTo(op.points[0].x + 0.01, op.points[0].y)
        } else {
          for (const point of op.points.slice(1)) context.lineTo(point.x, point.y)
        }
        context.stroke()
        painted += 1
      }
    }
    context.restore()
    return painted
  }

  /**
   * Sample one magnifier from the sample base: crop the source rect, scale it by the factor.
   *
   * The source rect is in BASE-image source pixels while the sample base is crop-relative, so the
   * origin is subtracted here (§7.1: `sourceRect` is in base-image coordinates; the lens renders
   * in crop coordinates just like every other annotation's export transform).
   */
  function sampleMagnifier({ sampleBase, crop, magnifier, createCanvas }) {
    const base = sampleBase
    if (!base) throw new Error('magnifier-sampler needs a sampleBase')
    const value = magnifierApi.normalizeMagnifier(magnifier)
    const cropX = Math.round(Number(crop?.x) || 0)
    const cropY = Math.round(Number(crop?.y) || 0)
    const rect = value.sourceRect
    const width = Math.max(1, Math.round(rect.w * value.factor))
    const height = Math.max(1, Math.round(rect.h * value.factor))
    const factory = typeof createCanvas === 'function' ? createCanvas : defaultCreateCanvas
    const canvas = factory(width, height)
    const context = getContext(canvas)
    // Smoothing ON for the upscale: the lens is a zoom, and nearest-neighbour would alias text in
    // an obviously-broken way. (The MASK is not affected - it was painted before this step.)
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(
      base,
      rect.x - cropX,
      rect.y - cropY,
      rect.w,
      rect.h,
      0,
      0,
      width,
      height
    )
    return canvas
  }

  /**
   * Byte-budgeted LRU cache for sampled lens canvases (§7.2 / §3.3).
   *
   * Keys come from `magnifierApi.sampleCacheKey()`, which deliberately excludes the lens position:
   * moving the lens must not re-sample the base image (§7.2).
   *
   * Eviction is by least-recently-used until under budget. An entry larger than the whole budget
   * is returned to the caller but NOT cached - it can never be worth evicting everything else.
   */
  function createSampleCache({ budgetBytes = CACHE_BUDGET_BYTES, now = () => Date.now() } = {}) {
    const entries = new Map()
    let bytes = 0
    let hits = 0
    let misses = 0
    let evictions = 0

    function touch(key, entry) {
      entries.delete(key)
      entries.set(key, entry)
    }

    function evictUntilWithinBudget(reserve = 0) {
      while (bytes + reserve > budgetBytes && entries.size) {
        const oldestKey = entries.keys().next().value
        const oldest = entries.get(oldestKey)
        entries.delete(oldestKey)
        bytes -= oldest.bytes
        evictions += 1
      }
    }

    return {
      budgetBytes,
      get(key) {
        const entry = entries.get(String(key))
        if (!entry) {
          misses += 1
          return null
        }
        hits += 1
        touch(String(key), entry)
        return entry.canvas
      },
      has(key) {
        return entries.has(String(key))
      },
      set(key, canvas) {
        const size = canvasBytes(canvas)
        if (!size) return null
        const id = String(key)
        if (entries.has(id)) {
          bytes -= entries.get(id).bytes
          entries.delete(id)
        }
        // An entry that alone exceeds the budget is not cached (it would evict everything and
        // still not fit). The caller still gets its canvas from `sampleMagnifier`.
        if (size > budgetBytes) return null
        evictUntilWithinBudget(size)
        entries.set(id, { canvas, bytes: size, at: now() })
        bytes += size
        return canvas
      },
      stats() {
        return { entries: entries.size, bytes, budgetBytes, hits, misses, evictions }
      },
      // Editor close releases the cache (§7.2: released when the editor closes). Explicit so the tests can assert
      // a real teardown rather than relying on GC.
      clear() {
        entries.clear()
        bytes = 0
      }
    }
  }

  /**
   * The orchestrator the renderer actually calls. It owns the invalidation rules from §7.2 in one
   * place so no call site has to remember them:
   *
   *   cache key = base image id + crop + mask fingerprint + source rect + factor
   *
   * Moving the lens changes nothing in that key (the lens origin is not part of it), so dragging a
   * lens is free. Changing the source rect, the blur set, the crop or the base image invalidates.
   */
  function createLensSampler({ createCanvas, cache = createSampleCache() } = {}) {
    let baseKey = ''
    let sampleBase = null

    return {
      cache,
      // Rebuild the sample base. Called when the base image / crop / blur set changes; the
      // orchestrator then adopts its fingerprint as part of the cache identity.
      reset() {
        baseKey = ''
        sampleBase = null
        cache.clear()
      },
      adoptSampleBase({ canvas, fingerprint }) {
        sampleBase = canvas
        baseKey = String(fingerprint || '')
      },
      sample({ baseImageId, crop, maskFingerprint, magnifier }) {
        const value = magnifierApi.normalizeMagnifier(magnifier)
        const key = magnifierApi.sampleCacheKey({
          baseImageId,
          crop,
          maskFingerprint: `${baseKey}:${maskFingerprint || ''}`,
          sourceRect: value.sourceRect,
          factor: value.factor
        })
        const cached = cache.get(key)
        if (cached) return cached
        const canvas = sampleMagnifier({ sampleBase, crop, magnifier: value, createCanvas })
        cache.set(key, canvas)
        return canvas
      }
    }
  }

  return {
    CACHE_BUDGET_BYTES,
    BYTES_PER_PIXEL,
    canvasBytes,
    composeSampleBase,
    paintOcclusion,
    sampleMagnifier,
    createSampleCache,
    createLensSampler
  }
})
