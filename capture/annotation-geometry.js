// P0-5 PR1 —— 标注几何与命中测试（纯函数，UMD 写法与 capture/selection-utils.js 同构）。
//
// 坐标系（方案 §8.3，最易出错）：本模块里的每一个数都是**屏幕 CSS 坐标**，与
// capture.js 在 #stage 上绘制标注用的是同一套。导出坐标（(item.x-selection.x)*scaleX）
// 只存在于 exportSelectionCanvas() 内部，两套坐标严禁混用。
//
// 除几何外本模块还承载 PR1 的深拷贝原语 cloneAnnotations()：快照栈必须把 pen 点集
// 真正拷开，否则"撤销后仍然指向同一个数组"。放在这里而不是新建
// capture/annotation-history.js，是因为 PR1 的注册写作用域只登记了本文件（方案 §8.4）。
(function exposeAnnotationGeometry(root, factory) {
  const styleApi = (typeof module === 'object' && module.exports)
    ? require('./annotation-style.js')
    : (root ? root.annotationStyleUtils : null)
  const api = factory(styleApi || {})
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.annotationGeometry = api
})(typeof globalThis === 'object' ? globalThis : window, (style) => {
  // 快照栈上限（方案 §8.2）与 pen 点集上限（与 record/annotation-utils.js 的
  // MAX_PEN_POINTS 取同值 10000，避免两个标注体系给出不同的容量口径）。
  const MAX_ANNOTATION_HISTORY = 60
  const MAX_PEN_POINTS = 10000
  // 描边命中容差：细线也要能点中，但不能大到把矩形中心当成边。
  const DEFAULT_HIT_TOLERANCE = 6
  // text 没有 x2，纯函数层也拿不到 canvas 度量：用 0.6em/字符 估计盒宽（见 annotationBounds）。
  const TEXT_WIDTH_RATIO = 0.6

  // 字号/半径必须与 drawAnnotation() 同源，否则选中虚线框和图形对不上。
  const fontSize = typeof style.textFontSize === 'function' ? style.textFontSize : () => 20
  const serialRadius = typeof style.serialRadius === 'function' ? style.serialRadius : () => 12
  const markerWidth = typeof style.highlightWidth === 'function' ? style.highlightWidth : () => 16

  function numberOr(value, fallback) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  function hasX2(item) {
    return Number.isFinite(Number(item?.x2))
  }

  function hasY2(item) {
    return Number.isFinite(Number(item?.y2))
  }

  function normalizeBox(x1, y1, x2, y2) {
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      w: Math.abs(x2 - x1),
      h: Math.abs(y2 - y1)
    }
  }

  // 反向端点（x2<x / y2<y）在这里统一规范化；缺 x2/y2 时退化为单点而不是 NaN。
  function endpointBox(item) {
    const x = numberOr(item.x, 0)
    const y = numberOr(item.y, 0)
    return normalizeBox(x, y, hasX2(item) ? Number(item.x2) : x, hasY2(item) ? Number(item.y2) : y)
  }

  function endpoints(item) {
    const x1 = numberOr(item.x, 0)
    const y1 = numberOr(item.y, 0)
    return { x1, y1, x2: hasX2(item) ? Number(item.x2) : x1, y2: hasY2(item) ? Number(item.y2) : y1 }
  }

  function penPoints(item) {
    if (!Array.isArray(item?.points)) return []
    const points = []
    for (const point of item.points) {
      const x = Number(point?.x)
      const y = Number(point?.y)
      if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y })
    }
    return points
  }

  function penBox(item) {
    const points = penPoints(item)
    if (!points.length) return { x: numberOr(item.x, 0), y: numberOr(item.y, 0), w: 0, h: 0 }
    let minX = points[0].x
    let maxX = points[0].x
    let minY = points[0].y
    let maxY = points[0].y
    for (const point of points) {
      if (point.x < minX) minX = point.x
      if (point.x > maxX) maxX = point.x
      if (point.y < minY) minY = point.y
      if (point.y > maxY) maxY = point.y
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
  }

  function annotationBounds(item) {
    if (!item || typeof item !== 'object') return null
    if (item.type === 'pen') return penBox(item)
    const x = numberOr(item.x, 0)
    const y = numberOr(item.y, 0)
    // 序号以 2×radius 为方框（drawAnnotation 画的是半径 radius 的实心圆）。
    if (item.type === 'serial') {
      const radius = serialRadius(item.width)
      return { x: x - radius, y: y - radius, w: radius * 2, h: radius * 2 }
    }
    // 文字没有 x2，且这里没有 canvas 度量：取"1em 高、0.6em/字符宽"的估计盒，
    // 只用于选中框与命中测试，不影响绘制（绘制仍走 drawAnnotation 的 fillText）。
    if (item.type === 'text') {
      const size = fontSize(item.width)
      const text = typeof item.text === 'string' ? item.text : ''
      return { x, y, w: Math.max(size, text.length * size * TEXT_WIDTH_RATIO), h: size }
    }
    if (item.type === 'watermark') {
      return { x, y, w: Math.max(0, numberOr(item.w, 0)), h: Math.max(0, numberOr(item.h, 0)) }
    }
    return endpointBox(item)
  }

  function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1
    const dy = y2 - y1
    const lengthSquared = dx * dx + dy * dy
    if (!lengthSquared) return Math.hypot(px - x1, py - y1)
    const raw = ((px - x1) * dx + (py - y1) * dy) / lengthSquared
    const t = Math.max(0, Math.min(1, raw))
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
  }

  function insideBox(px, py, box, tolerance) {
    return px >= box.x - tolerance && px <= box.x + box.w + tolerance &&
      py >= box.y - tolerance && py <= box.y + box.h + tolerance
  }

  // 矩形/椭圆这类"空心"图形只认描边环带：中心点必须落空，否则会挡住拖动选区。
  function nearBoxRing(px, py, box, tolerance) {
    if (px < box.x - tolerance || px > box.x + box.w + tolerance) return false
    if (py < box.y - tolerance || py > box.y + box.h + tolerance) return false
    const innerLeft = box.x + tolerance
    const innerRight = box.x + box.w - tolerance
    const innerTop = box.y + tolerance
    const innerBottom = box.y + box.h - tolerance
    if (innerRight < innerLeft || innerBottom < innerTop) return true
    return !(px > innerLeft && px < innerRight && py > innerTop && py < innerBottom)
  }

  // 椭圆环带：|√((dx/rx)²+(dy/ry)²) − 1| 换算回像素距离，圆时精确、椭圆时按短半轴近似。
  // 任一半轴退化为 0 时按线段/点处理，避免除零。
  function nearEllipseRing(px, py, box, tolerance) {
    const cx = box.x + box.w / 2
    const cy = box.y + box.h / 2
    const rx = box.w / 2
    const ry = box.h / 2
    if (rx <= 0 && ry <= 0) return Math.hypot(px - cx, py - cy) <= tolerance
    if (rx <= 0) return pointToSegmentDistance(px, py, cx, cy - ry, cx, cy + ry) <= tolerance
    if (ry <= 0) return pointToSegmentDistance(px, py, cx - rx, cy, cx + rx, cy) <= tolerance
    const value = ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2
    return Math.abs(Math.sqrt(value) - 1) * Math.min(rx, ry) <= tolerance
  }

  function nearPolyline(px, py, points, tolerance) {
    if (!points.length) return false
    if (points.length === 1) return Math.hypot(px - points[0].x, py - points[0].y) <= tolerance
    for (let index = 1; index < points.length; index += 1) {
      const from = points[index - 1]
      const to = points[index]
      if (pointToSegmentDistance(px, py, from.x, from.y, to.x, to.y) <= tolerance) return true
    }
    return false
  }

  function hitTolerance(item) {
    const width = Math.max(1, numberOr(item?.width, 4))
    if (item?.type === 'highlight') return Math.max(DEFAULT_HIT_TOLERANCE, markerWidth(width) / 2)
    return Math.max(DEFAULT_HIT_TOLERANCE, width / 2)
  }

  // 逐类型命中判定。tolerance 省略时按线宽推导（highlight 更宽）。
  function hitTestAnnotation(item, point, tolerance) {
    if (!item || typeof item !== 'object' || !point) return false
    const px = Number(point.x)
    const py = Number(point.y)
    if (!Number.isFinite(px) || !Number.isFinite(py)) return false
    const forced = Number(tolerance)
    const limit = Number.isFinite(forced) ? Math.max(0, forced) : hitTolerance(item)
    const box = annotationBounds(item)
    if (!box) return false
    if (item.type === 'rect') return nearBoxRing(px, py, box, limit)
    if (item.type === 'ellipse') return nearEllipseRing(px, py, box, limit)
    if (item.type === 'line' || item.type === 'arrow') {
      const segment = endpoints(item)
      return pointToSegmentDistance(px, py, segment.x1, segment.y1, segment.x2, segment.y2) <= limit
    }
    if (item.type === 'pen') {
      const points = penPoints(item)
      if (!points.length) return Math.hypot(px - numberOr(item.x, 0), py - numberOr(item.y, 0)) <= limit
      return nearPolyline(px, py, points, limit)
    }
    // text / serial / watermark / blur 以及任何带 x/y/x2/y2 的实心块：整体可点。
    return insideBox(px, py, box, limit)
  }

  // 逆序扫描 = 数组末尾是最上层（§8.1：下标即 z 序）。
  function findAnnotationAt(annotations, point, options = {}) {
    if (!Array.isArray(annotations) || !point) return null
    const forced = Number(options.tolerance)
    const limit = Number.isFinite(forced) ? Math.max(0, forced) : undefined
    for (let index = annotations.length - 1; index >= 0; index -= 1) {
      if (hitTestAnnotation(annotations[index], point, limit)) return annotations[index]
    }
    return null
  }

  // PR2 拖动用：返回新对象，绝不改原对象（pen 点集也换新数组）。
  function translateAnnotation(item, dx, dy) {
    if (!item || typeof item !== 'object') return null
    const offsetX = numberOr(dx, 0)
    const offsetY = numberOr(dy, 0)
    const moved = Object.assign({}, item, {
      x: numberOr(item.x, 0) + offsetX,
      y: numberOr(item.y, 0) + offsetY
    })
    if (hasX2(item)) moved.x2 = Number(item.x2) + offsetX
    if (hasY2(item)) moved.y2 = Number(item.y2) + offsetY
    if (Array.isArray(item.points)) {
      moved.points = item.points.map((point) => ({
        x: numberOr(point?.x, 0) + offsetX,
        y: numberOr(point?.y, 0) + offsetY
      }))
    }
    return moved
  }

  // 单个轴向上的 clamp：把 box 的起点夹进"能放下的区间"。box 比舞台还大时区间退化为
  // [limit-size, 0]（起点为负），即至少保证有一侧贴住舞台边，绝不整块飞出去。
  function clampAxis(position, size, limit) {
    const span = limit - size
    const minimum = Math.min(0, span)
    const maximum = Math.max(0, span)
    return Math.min(maximum, Math.max(minimum, position))
  }

  // PR2 拖动边界 clamp（方案 §8.4 PR2「边界 clamp」）。舞台一律是屏幕 CSS 坐标系里的
  // [0, stage.w]×[0, stage.h]；调用方传 { w: innerWidth, h: innerHeight }（也接受
  // { width, height } 别名）。口径 = **整体包含**：平移后 annotationBounds() 必须完全落在
  // 舞台内；元素本身就比舞台大时由 clampAxis 退化为"贴住一侧"。
  //
  // 永远返回新对象（含 pen 点集的新数组），调用方拿到的副本可以安全放回 annotations；
  // 没有位移时也返回新副本，保证"绝不就地改原对象"这条契约无条件成立。
  function clampAnnotationToStage(item, stage) {
    if (!item || typeof item !== 'object') return null
    const bounds = annotationBounds(item)
    if (!bounds) return null
    const stageW = Math.max(0, numberOr(stage?.w ?? stage?.width, 0))
    const stageH = Math.max(0, numberOr(stage?.h ?? stage?.height, 0))
    const targetX = clampAxis(bounds.x, bounds.w, stageW)
    const targetY = clampAxis(bounds.y, bounds.h, stageH)
    // 即使 (0,0) 也走 translateAnnotation：它保证返回新对象、pen 点集也换新数组。
    return translateAnnotation(item, targetX - bounds.x, targetY - bounds.y)
  }

  // 快照栈的深拷贝原语：pen 点集必须换新数组并封顶，其余字段是扁平的。
  function cloneAnnotations(annotations, options = {}) {
    if (!Array.isArray(annotations)) return []
    const maxPenPoints = Math.max(1, numberOr(options.maxPenPoints, MAX_PEN_POINTS))
    return annotations.map((item) => {
      if (!item || typeof item !== 'object') return item
      const copy = Object.assign({}, item)
      if (Array.isArray(item.points)) {
        copy.points = item.points.slice(0, maxPenPoints).map((point) => ({
          x: numberOr(point?.x, 0),
          y: numberOr(point?.y, 0)
        }))
      }
      return copy
    })
  }

  return {
    MAX_ANNOTATION_HISTORY,
    MAX_PEN_POINTS,
    DEFAULT_HIT_TOLERANCE,
    annotationBounds,
    hitTestAnnotation,
    findAnnotationAt,
    translateAnnotation,
    clampAnnotationToStage,
    cloneAnnotations
  }
})
