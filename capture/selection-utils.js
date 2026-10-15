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
  // Horizontally the surface right-aligns with the anchor, and when that is impossible
  // (the surface is much wider than the anchor's right offset - a 200px region under a
  // ~950px strip) it CENTRES on the anchor instead of clamping to the viewport's left
  // edge: clamping threw the strip to the far side of the screen, leaving the drawing
  // tools up to ~600px from the region the user is working on. Centring never changes
  // the right-overflow case, where it clamps to the same right edge.
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
    const rightAligned = anchorX + anchorW - width
    const left = rightAligned >= padding && rightAligned <= maximumLeft
      ? rightAligned
      : clamp(anchorX + anchorW / 2 - width / 2, padding, maximumLeft)
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

  // Plan 2 (D12): how wide the strip is allowed to be on this stage. The shipped rule is
  // "as wide as the viewport minus the 20px CSS margin", which on a 1493px display makes
  // a ~1000px bar: for a 200px region the drawing tools end up ~600px away from the
  // region. Capping the strip at the region's own width (plus `slack` for the tool group
  // and the width picker) lets the flex rows wrap into a compact block that stays under
  // the region, and it is what makes the horizontal rule in resolveFloatingPlacement able
  // to right-align or centre the strip on a small region instead of clamping it left.
  // `minimum` is a floor, not a promise: the viewport cap still wins, exactly like the
  // CSS default it replaces, so a stage narrower than the floor yields a narrower strip
  // rather than one that overflows. A non-finite viewport degrades to the region-derived
  // width instead of collapsing the strip to zero.
  function toolbarWidthLimit(options = {}) {
    const anchor = options.anchor || {}
    const viewport = options.viewport || {}
    const minimum = Math.max(0, finiteOr(options.minimum, 420))
    const slack = Math.max(0, finiteOr(options.slack, 160))
    const margin = Math.max(0, finiteOr(options.margin, 20))
    const anchorWidth = Math.max(0, finiteOr(anchor.w ?? anchor.width, 0))
    const desired = Math.max(minimum, anchorWidth + slack)
    const viewportWidth = finiteOr(viewport.w ?? viewport.width, Number.NaN)
    if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return Math.round(desired)
    return Math.round(Math.min(Math.max(0, viewportWidth - margin), desired))
  }

  // B6 (D8): keep only the selected ids that still exist in the annotation array.
  // Snapshot restore replaces object identities but keeps ids, so revalidating by id
  // is what lets a multi-selection survive undo/redo while dropping items that are
  // gone. Non-Set / non-array input degrades to the empty selection instead of
  // throwing, because the caller runs this on every undo/redo.
  function revalidateSelection(annotations, ids) {
    const source = ids instanceof Set ? ids : new Set(Array.isArray(ids) ? ids : [])
    if (!Array.isArray(annotations) || !annotations.length) return new Set()
    const alive = new Set()
    for (const item of annotations) {
      if (item && source.has(item.id)) alive.add(item.id)
    }
    return alive
  }

  // B6 (D8): the value every entry agrees on, or null when they disagree (the "mixed"
  // state the toolbar renders as an indeterminate control). Empty input is also null,
  // so an empty selection can never look like a shared value.
  function commonSelectionValue(values) {
    if (!Array.isArray(values) || !values.length) return null
    const first = values[0]
    return values.every((value) => value === first) ? first : null
  }

  // B6 wave 2 (D8): do two screen-CSS rectangles overlap? Touching an edge counts,
  // because the marquee's contract is "everything it touches gets selected". A
  // degenerate box (a horizontal line has h = 0) is a segment, not empty, so it can
  // still be caught - only non-finite input refuses to intersect.
  function rectsIntersect(a, b) {
    if (!a || !b) return false
    const ax = finiteOr(a.x, Number.NaN)
    const ay = finiteOr(a.y, Number.NaN)
    const aw = Math.max(0, finiteOr(a.w ?? a.width, Number.NaN))
    const ah = Math.max(0, finiteOr(a.h ?? a.height, Number.NaN))
    const bx = finiteOr(b.x, Number.NaN)
    const by = finiteOr(b.y, Number.NaN)
    const bw = Math.max(0, finiteOr(b.w ?? b.width, Number.NaN))
    const bh = Math.max(0, finiteOr(b.h ?? b.height, Number.NaN))
    if (![ax, ay, aw, ah, bx, by, bw, bh].every(Number.isFinite)) return false
    return ax <= bx + bw && bx <= ax + aw && ay <= by + bh && by <= ay + ah
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
    resolveFloatingPlacement,
    toolbarWidthLimit,
    revalidateSelection,
    commonSelectionValue,
    rectsIntersect
  }
})
