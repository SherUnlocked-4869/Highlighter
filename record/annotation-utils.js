(function initAnnotationUtils(globalScope) {
  const ANNOTATION_TOOLS = Object.freeze(['pointer', 'pen', 'rect', 'ellipse', 'arrow'])
  const ANNOTATION_COLORS = Object.freeze(['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#1687ff', '#111111', '#ffffff'])
  const ANNOTATION_WIDTHS = Object.freeze([2, 4, 7])
  const ANNOTATION_ACTIONS = new Set(['undo', 'clear', 'reset'])
  const MAX_ANNOTATIONS = 500
  const MAX_PEN_POINTS = 10000

  function finite(value, fallback = 0) {
    const number = Number(value)
    return Number.isFinite(number) ? number : fallback
  }

  function clampCoordinate(value, maximum = Infinity) {
    const coordinate = Math.max(0, finite(value))
    const limit = Number(maximum)
    return Number.isFinite(limit) ? Math.min(Math.max(0, limit), coordinate) : coordinate
  }

  function cleanPoint(point = {}, bounds = {}) {
    return {
      x: clampCoordinate(point.x, bounds.width),
      y: clampCoordinate(point.y, bounds.height)
    }
  }

  function cleanStyle(style = {}) {
    return {
      color: ANNOTATION_COLORS.includes(style.color) ? style.color : ANNOTATION_COLORS[0],
      width: ANNOTATION_WIDTHS.includes(Number(style.width)) ? Number(style.width) : 4
    }
  }

  function sanitizeAnnotationCommand(command = {}) {
    return {
      tool: ANNOTATION_TOOLS.includes(command.tool) ? command.tool : 'pointer',
      ...cleanStyle(command),
      action: ANNOTATION_ACTIONS.has(command.action) ? command.action : '',
      resetVersion: Math.max(0, Math.round(finite(command.resetVersion)))
    }
  }

  function createAnnotation(type, point, style, id) {
    if (!ANNOTATION_TOOLS.includes(type) || type === 'pointer') return null
    const start = cleanPoint(point)
    const item = {
      id: Math.max(1, Math.round(finite(id, 1))),
      type,
      ...cleanStyle(style),
      x: start.x,
      y: start.y,
      x2: start.x,
      y2: start.y
    }
    if (type === 'pen') item.points = [start]
    return item
  }

  function updateAnnotation(item, point) {
    if (!item) return null
    const next = cleanPoint(point)
    if (item.type !== 'pen') return { ...item, x2: next.x, y2: next.y }
    const points = Array.isArray(item.points) ? item.points.slice(0, MAX_PEN_POINTS) : []
    const last = points[points.length - 1]
    if (points.length < MAX_PEN_POINTS && (!last || Math.hypot(next.x - last.x, next.y - last.y) >= 0.5)) {
      points.push(next)
    }
    return { ...item, x2: next.x, y2: next.y, points }
  }

  function sanitizeAnnotation(item, bounds) {
    if (!item || !ANNOTATION_TOOLS.includes(item.type) || item.type === 'pointer') return null
    const start = cleanPoint(item, bounds)
    const end = cleanPoint({ x: item.x2, y: item.y2 }, bounds)
    const clean = {
      id: Math.max(1, Math.round(finite(item.id, 1))),
      type: item.type,
      ...cleanStyle(item),
      x: start.x,
      y: start.y,
      x2: end.x,
      y2: end.y
    }
    if (clean.type === 'pen') {
      const points = (Array.isArray(item.points) ? item.points : [])
        .slice(0, MAX_PEN_POINTS)
        .map((point) => cleanPoint(point, bounds))
      clean.points = points.length ? points : [start]
    }
    return clean
  }

  function sanitizeAnnotationSnapshot(snapshot = {}, bounds = {}) {
    const annotations = (Array.isArray(snapshot.annotations) ? snapshot.annotations : [])
      .slice(0, MAX_ANNOTATIONS)
      .map((item) => sanitizeAnnotation(item, bounds))
      .filter(Boolean)
    return {
      annotations,
      active: sanitizeAnnotation(snapshot.active, bounds)
    }
  }

  function undoAnnotationSnapshot(snapshot = {}) {
    return {
      annotations: (Array.isArray(snapshot.annotations) ? snapshot.annotations : []).slice(0, -1),
      active: null
    }
  }

  function clearAnnotationSnapshot() {
    return { annotations: [], active: null }
  }

  function drawArrow(context, x, y, x2, y2, width) {
    const angle = Math.atan2(y2 - y, x2 - x)
    const head = Math.max(10, width * 3)
    context.beginPath()
    context.moveTo(x, y)
    context.lineTo(x2, y2)
    context.stroke()
    context.beginPath()
    context.moveTo(x2, y2)
    context.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6))
    context.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6))
    context.closePath()
    context.fill()
  }

  function drawAnnotation(context, item, scaleX, scaleY) {
    const x = item.x * scaleX
    const y = item.y * scaleY
    const x2 = item.x2 * scaleX
    const y2 = item.y2 * scaleY
    const width = item.width * Math.sqrt(scaleX * scaleY)
    context.save()
    context.strokeStyle = item.color
    context.fillStyle = item.color
    context.lineWidth = width
    context.lineCap = 'round'
    context.lineJoin = 'round'
    if (item.type === 'pen') {
      context.beginPath()
      item.points.forEach((point, index) => {
        const pointX = point.x * scaleX
        const pointY = point.y * scaleY
        if (index) context.lineTo(pointX, pointY)
        else context.moveTo(pointX, pointY)
      })
      if (item.points.length === 1) context.lineTo(item.points[0].x * scaleX + 0.01, item.points[0].y * scaleY)
      context.stroke()
    } else if (item.type === 'rect') {
      context.strokeRect(Math.min(x, x2), Math.min(y, y2), Math.abs(x2 - x), Math.abs(y2 - y))
    } else if (item.type === 'ellipse') {
      const radiusX = Math.abs(x2 - x) / 2
      const radiusY = Math.abs(y2 - y) / 2
      if (radiusX && radiusY) {
        context.beginPath()
        context.ellipse((x + x2) / 2, (y + y2) / 2, radiusX, radiusY, 0, 0, Math.PI * 2)
        context.stroke()
      }
    } else if (item.type === 'arrow') {
      drawArrow(context, x, y, x2, y2, width)
    }
    context.restore()
  }

  function drawAnnotationSnapshot(context, snapshot = {}, sourceSize = {}) {
    if (!context?.canvas) return
    const scaleX = context.canvas.width / Math.max(1, finite(sourceSize.width, context.canvas.width))
    const scaleY = context.canvas.height / Math.max(1, finite(sourceSize.height, context.canvas.height))
    const annotations = Array.isArray(snapshot.annotations) ? snapshot.annotations : []
    annotations.forEach((item) => drawAnnotation(context, item, scaleX, scaleY))
    if (snapshot.active) drawAnnotation(context, snapshot.active, scaleX, scaleY)
  }

  const annotationUtils = {
    ANNOTATION_TOOLS,
    ANNOTATION_COLORS,
    ANNOTATION_WIDTHS,
    MAX_ANNOTATIONS,
    MAX_PEN_POINTS,
    createAnnotation,
    updateAnnotation,
    sanitizeAnnotationCommand,
    sanitizeAnnotationSnapshot,
    undoAnnotationSnapshot,
    clearAnnotationSnapshot,
    drawAnnotationSnapshot
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = annotationUtils
  if (globalScope) globalScope.annotationUtils = annotationUtils
})(typeof window !== 'undefined' ? window : null)
