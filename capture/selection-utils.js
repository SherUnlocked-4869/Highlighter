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

  return {
    getResizeHandle,
    resizeSelection,
    selectionCursor
  }
})
