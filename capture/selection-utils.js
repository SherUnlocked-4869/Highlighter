(function exposeSelectionUtils(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.selectionUtils = api
})(typeof globalThis === 'object' ? globalThis : window, () => {
  const HANDLE_CURSORS = Object.freeze({
    n: 'ns-resize',
    s: 'ns-resize',
    e: 'ew-resize',
    w: 'ew-resize',
    ne: 'nesw-resize',
    sw: 'nesw-resize',
    nw: 'nwse-resize',
    se: 'nwse-resize'
  })

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value))
  }

  function finiteOr(value, fallback) {
    const number = Number(value)
    return Number.isFinite(number) ? number : fallback
  }

  // Floating surfaces (the tool strip; the element bar asks for the same placement so
  // it can avoid it) must stay COMPLETELY inside the viewport. The region capture
  // shows the strip below the region; the pin re-annotate editor is only as big as the
  // pinned image, and there the old "clamp into the viewport" fallback dropped the
  // strip at the top INSIDE the image and clipped it on the right.
  //
  // Preference order (one rule for every flow, which is what keeps the interaction
  // consistent between a fresh capture and a re-annotation):
  //   1. below the anchor, right-aligned with it (the shipped placement);
  //   2. above the anchor when below does not fit and above does;
  //   3. docked inside, hugging the anchor's bottom edge (never the viewport top).
  // Always returns integer CSS pixels; `above` tells the caller to reverse the row
  // order so the options row stays closest to the anchor.
  function resolveFloatingPlacement(options = {}) {
    const anchor = options.anchor || {}
    const size = options.size || {}
    const viewport = options.viewport || {}
    const gap = Math.max(0, finiteOr(options.gap, 10))
    const padding = Math.max(0, finiteOr(options.padding, 6))
    const anchorX = finiteOr(anchor.x, 0)
    const anchorY = finiteOr(anchor.y, 0)
    const anchorW = Math.max(0, finiteOr(anchor.w, 0))
    const anchorH = Math.max(0, finiteOr(anchor.h, 0))
    const width = Math.max(0, finiteOr(size.width, 0))
    const height = Math.max(0, finiteOr(size.height, 0))
    const viewportWidth = Math.max(0, finiteOr(viewport.width, 0))
    const viewportHeight = Math.max(0, finiteOr(viewport.height, 0))
    // A surface wider/taller than the viewport keeps its origin at the padding: it is
    // then flush with the visible area instead of being pushed off it.
    const maximumLeft = Math.max(padding, viewportWidth - width - padding)
    const maximumTop = Math.max(padding, viewportHeight - height - padding)
    const left = clamp(anchorX + anchorW - width, padding, maximumLeft)
    const bottom = anchorY + anchorH
    let above = false
    let top = bottom + gap
    if (top + height > viewportHeight - padding) {
      const aboveTop = anchorY - gap - height
      if (aboveTop >= padding) {
        top = aboveTop
        above = true
      } else {
        // No room on either side: dock inside, still anchored to the region's bottom.
        top = bottom - gap - height
      }
    }
    return {
      left: Math.round(left),
      top: Math.round(clamp(top, padding, maximumTop)),
      above
    }
  }

  function getResizeHandle(selection, point, hitSize = 8) {
    if (!selection || !point || selection.w <= 0 || selection.h <= 0) return ''
    const left = selection.x
    const top = selection.y
    const right = selection.x + selection.w
    const bottom = selection.y + selection.h
    const withinHorizontal = point.x >= left - hitSize && point.x <= right + hitSize
    const withinVertical = point.y >= top - hitSize && point.y <= bottom + hitSize
    if (!withinHorizontal || !withinVertical) return ''
    const nearLeft = Math.abs(point.x - left) <= hitSize
    const nearRight = Math.abs(point.x - right) <= hitSize
    const nearTop = Math.abs(point.y - top) <= hitSize
    const nearBottom = Math.abs(point.y - bottom) <= hitSize
    if (nearLeft && nearTop) return 'nw'
    if (nearRight && nearTop) return 'ne'
    if (nearLeft && nearBottom) return 'sw'
    if (nearRight && nearBottom) return 'se'
    if (nearTop) return 'n'
    if (nearBottom) return 's'
    if (nearLeft) return 'w'
    if (nearRight) return 'e'
    return ''
  }

  function resizeSelection(initial, handle, point, bounds, minimumSize = 3) {
    const width = Math.max(minimumSize, Number(bounds?.width) || 0)
    const height = Math.max(minimumSize, Number(bounds?.height) || 0)
    const leftEdge = clamp(Number(initial.x) || 0, 0, width)
    const topEdge = clamp(Number(initial.y) || 0, 0, height)
    let left = leftEdge
    let top = topEdge
    let right = clamp(leftEdge + (Number(initial.w) || 0), left, width)
    let bottom = clamp(topEdge + (Number(initial.h) || 0), top, height)
    const minWidth = Math.min(minimumSize, right)
    const minHeight = Math.min(minimumSize, bottom)

    if (handle.includes('w')) left = clamp(Number(point.x) || 0, 0, right - minWidth)
    if (handle.includes('e')) right = clamp(Number(point.x) || 0, left + Math.min(minimumSize, width - left), width)
    if (handle.includes('n')) top = clamp(Number(point.y) || 0, 0, bottom - minHeight)
    if (handle.includes('s')) bottom = clamp(Number(point.y) || 0, top + Math.min(minimumSize, height - top), height)

    return {
      x: left,
      y: top,
      w: Math.max(0, right - left),
      h: Math.max(0, bottom - top)
    }
  }

  function selectionCursor(handle, inside) {
    return HANDLE_CURSORS[handle] || (inside ? 'move' : 'crosshair')
  }

  function getSourcePixelRect(selection, displayBounds, imageSize) {
    const imageWidth = Math.max(1, Math.round(Number(imageSize?.width) || 1))
    const imageHeight = Math.max(1, Math.round(Number(imageSize?.height) || 1))
    const displayWidth = Math.max(1, Number(displayBounds?.w ?? displayBounds?.width) || 1)
    const displayHeight = Math.max(1, Number(displayBounds?.h ?? displayBounds?.height) || 1)
    const displayX = Number(displayBounds?.x) || 0
    const displayY = Number(displayBounds?.y) || 0
    const scaleX = imageWidth / displayWidth
    const scaleY = imageHeight / displayHeight
    const left = clamp(Math.round(((Number(selection?.x) || 0) - displayX) * scaleX), 0, imageWidth - 1)
    const top = clamp(Math.round(((Number(selection?.y) || 0) - displayY) * scaleY), 0, imageHeight - 1)
    const right = clamp(Math.round(((Number(selection?.x) || 0) + (Number(selection?.w) || 0) - displayX) * scaleX), left + 1, imageWidth)
    const bottom = clamp(Math.round(((Number(selection?.y) || 0) + (Number(selection?.h) || 0) - displayY) * scaleY), top + 1, imageHeight)
    return { x: left, y: top, width: right - left, height: bottom - top }
  }

  return {
    getResizeHandle,
    getSourcePixelRect,
    resizeSelection,
    selectionCursor,
    resolveFloatingPlacement
  }
})
