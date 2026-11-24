// B06 (docs/reviews/2026-11-24-windows-product-architecture-review.md): the copy/pin limits
// are a property of the composited result, not of the capture loop. The controller window and
// the main process must agree on them BEFORE anything is composed, so the thresholds live in
// one shared module and both sides call capabilities({ width, height }).
//
// save is always possible while there is at least one pixel; copy/pin are the actions that a
// renderer/OS image path cannot carry past the edge or pixel ceiling.
(function exposeLongCaptureLimits(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else if (root) root.longCaptureLimits = api
})(typeof globalThis === 'object' ? globalThis : (typeof window !== 'undefined' ? window : null), () => {
  const MAX_EDGE = 65535
  const MAX_PIXELS = 80000000

  function capabilities(size = {}) {
    const width = Math.max(0, Math.round(Number(size.width) || 0))
    const height = Math.max(0, Math.round(Number(size.height) || 0))
    const hasSize = width > 0 && height > 0
    const edge = Math.max(width, height)
    const pixels = width * height
    const tooLong = edge > MAX_EDGE
    const tooMany = pixels > MAX_PIXELS
    const copyable = hasSize && !tooLong && !tooMany
    return {
      width,
      height,
      edge,
      pixels,
      copy: copyable,
      pin: copyable,
      save: hasSize,
      reason: !hasSize ? 'empty' : tooLong ? 'edge' : tooMany ? 'pixels' : '',
      limits: { maxEdge: MAX_EDGE, maxPixels: MAX_PIXELS }
    }
  }

  return { MAX_EDGE, MAX_PIXELS, capabilities }
})
