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
  // A1 (D2): a press on an element only turns into a move once the pointer has
  // travelled further than this. Below it the gesture is a plain click, which
  // selects without producing a (no-op) undo frame or a visible jitter.
  const MOVE_THRESHOLD = 3
  // text 没有 x2，纯函数层也拿不到 canvas 度量：用 0.6em/字符 估计盒宽（见 annotationBounds）。
  const TEXT_WIDTH_RATIO = 0.6
  // PR3 缩放下限：任何一维小于 3px 时按 3px 处理（方案 §8.4 PR3 验收「镜像不崩、最小 3px」）。
  // 与 selection-utils.js 的 resizeSelection(minimumSize=3) 同值 —— 手柄层与纯函数层给出
  // 同一个下限，镜像/退化输入都不会产出负尺寸。
  const MIN_RESIZE_SIZE = 3
  // text/serial 的宽度字段是**预设**而不是自由数值（annotation-style.js 的 resolveWidth 会把
  // 非预设值打回 4），所以「仅字号 / 仅半径」只能把缩放比换算成最接近的预设。
  const WIDTH_PRESETS = Array.isArray(style.WIDTHS) && style.WIDTHS.length ? style.WIDTHS : null
  const resolveWidth = typeof style.resolveWidth === 'function' ? style.resolveWidth : (value) => value

  // 字号/半径必须与 drawAnnotation() 同源，否则选中虚线框和图形对不上。
  const fontSize = typeof style.textFontSize === 'function' ? style.textFontSize : () => 20
  const serialRadius = typeof style.serialRadius === 'function' ? style.serialRadius : () => 12
  const markerWidth = typeof style.highlightWidth === 'function' ? style.highlightWidth : () => 16
  // B2 (D9): a filled rect/ellipse is clickable through its interior, so the hit test
  // needs the same fill resolution the renderer uses.
  const resolveFill = typeof style.resolveFill === 'function' ? style.resolveFill : () => 'none'

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

  // A1 (D2): did the pointer travel past the click/drag threshold? Non-finite
  // input is "not moved" so a broken event can never start an element move.
  function movedBeyondThreshold(start, point, threshold) {
    if (!start || !point) return false
    const x1 = numberOr(start.x, Number.NaN)
    const y1 = numberOr(start.y, Number.NaN)
    const x2 = numberOr(point.x, Number.NaN)
    const y2 = numberOr(point.y, Number.NaN)
    if (![x1, y1, x2, y2].every(Number.isFinite)) return false
    const limit = Number(threshold)
    return Math.hypot(x2 - x1, y2 - y1) > (Number.isFinite(limit) ? Math.max(0, limit) : 0)
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

  // B2 (D9): the ellipse interior (a filled ellipse must be draggable from inside).
  // Degenerate axes are "not inside" - nearEllipseRing already handles those.
  function insideEllipse(px, py, box) {
    const rx = box.w / 2
    const ry = box.h / 2
    if (rx <= 0 || ry <= 0) return false
    const cx = box.x + rx
    const cy = box.y + ry
    return ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1
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
    // B2 (D9): an outline-only shape keeps the ring test (its interior stays free for
    // dragging the region); a filled one upgrades to ring ∪ interior, exactly like
    // text/serial/watermark already behave.
    if (item.type === 'rect') {
      return nearBoxRing(px, py, box, limit) || (resolveFill(item.fill) !== 'none' && insideBox(px, py, box, 0))
    }
    if (item.type === 'ellipse') {
      return nearEllipseRing(px, py, box, limit) || (resolveFill(item.fill) !== 'none' && insideEllipse(px, py, box))
    }
    // highlight 也是"粗线段"（markerWidth 决定粗细）：若落进 insideBox，斜向高亮的整个 bbox
    // 都会可点 —— 既吞掉其下元素的选中，又因 pointerdown 的"元素命中 > 拖选区"挡住拖选区，
    // 正是 rect/ellipse 用环带命中刻意规避的失效模式。
    if (item.type === 'line' || item.type === 'arrow' || item.type === 'highlight') {
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

  // PR3 缩放的入参归一化：接受 {x,y,w,h}（也接受 {width,height} 别名），一律取绝对值并
  // 抬到 MIN_RESIZE_SIZE —— 镜像（负宽/负高）与退化（0 宽/0 高）都不得产出非法尺寸。
  function targetBox(box) {
    if (!box || typeof box !== 'object') return null
    return {
      x: numberOr(box.x, 0),
      y: numberOr(box.y, 0),
      w: Math.max(MIN_RESIZE_SIZE, Math.abs(numberOr(box.w ?? box.width, 0))),
      h: Math.max(MIN_RESIZE_SIZE, Math.abs(numberOr(box.h ?? box.height, 0)))
    }
  }

  // 把点按"它在 oldBox 里的相对位置"映射到 newBox：line/arrow 靠它保端点方向，pen 靠它
  // 等比映射点集。oldBox 某一维退化为 0 时取中点（0.5），既避免除零也不让整条线塌到一边。
  function mapPointToBox(px, py, oldBox, newBox) {
    const u = oldBox.w > 0 ? (px - oldBox.x) / oldBox.w : 0.5
    const v = oldBox.h > 0 ? (py - oldBox.y) / oldBox.h : 0.5
    return { x: newBox.x + u * newBox.w, y: newBox.y + v * newBox.h }
  }

  function boxScaleRatio(oldBox, newBox) {
    const ratios = []
    if (oldBox.w > 0) ratios.push(newBox.w / oldBox.w)
    if (oldBox.h > 0) ratios.push(newBox.h / oldBox.h)
    if (!ratios.length) return 1
    // 取较大的那一维：拖左右边时高度不变（该维比值恒为 1），取 max 才能让字号/半径真的动。
    return Math.max(...ratios)
  }

  // text/serial 的「仅字号 / 仅半径」：把缩放比换算成**派生尺寸最接近的 width 预设**。
  // 比值恰好为 1（没缩放）或没有预设表时返回 null，调用方保持原宽度（= 不制造无效编辑）。
  function presetWidthForScale(baseWidth, oldBox, newBox) {
    if (!WIDTH_PRESETS) return null
    const ratio = boxScaleRatio(oldBox, newBox)
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio === 1) return null
    const current = Math.max(1, numberOr(resolveWidth(baseWidth), 4))
    const desired = current * ratio
    let best = WIDTH_PRESETS[0]
    for (const preset of WIDTH_PRESETS) {
      // <= 让"同样接近"时取更大的预设：放大手势必须能看出字号/半径的变化。
      if (Math.abs(preset - desired) <= Math.abs(best - desired)) best = preset
    }
    return best === numberOr(baseWidth, Number.NaN) ? null : best
  }

  // PR3：把标注按新 box 缩放。契约与 translateAnnotation 一致 —— **永远返回新对象**
  // （pen 点集也换新数组），绝不就地修改入参。box 一律是屏幕 CSS 坐标（方案 §8.3），
  // 导出坐标（(item.x-selection.x)*scaleX）只在 exportSelectionCanvas() 内部存在。
  //
  // 逐类型语义（方案 §8.4 PR3）：
  //   rect / ellipse / blur / watermark（以及未知类型）：直接采用新 box（watermark 改 x/y/w/h）；
  //   line / arrow（含同族的 highlight）：两端各按相对位置映射，**保持端点方向**——
  //     反向拖拽（镜像）不会把箭头掉头，因为旧端点相对旧 bbox 的 u/v 不变；
  //   pen：按新旧 box 的逐轴比例等比映射每个点，点集换新数组；
  //   text：**仅移动原点 + 字号**，不写 x2/y2（字形绝不拉伸，宽度仍由字号推出）；
  //   serial：**仅半径**（序号是 2×radius 的圆心方框：圆心跟到新 box 中心），number 不变。
  // 已知边界（方案 §8 风险③）：字号/半径只能落在 annotation-style 的 width 预设上，所以
  // text/serial 缩放后实际 bbox 可能与虚线框不完全吻合 —— 这是既有绘制模型的上限，
  // 不是坐标换算错误（导出仍走同一套 item 字段）。
  function resizeAnnotationToBox(item, box) {
    if (!item || typeof item !== 'object') return null
    const target = targetBox(box)
    if (!target) return null
    const source = annotationBounds(item)
    if (!source) return null
    const type = item.type

    if (type === 'watermark') {
      return Object.assign({}, item, { x: target.x, y: target.y, w: target.w, h: target.h })
    }

    if (type === 'text') {
      const resized = Object.assign({}, item, { x: target.x, y: target.y })
      const width = presetWidthForScale(item.width, source, target)
      if (width !== null) resized.width = width
      return resized
    }

    if (type === 'serial') {
      const resized = Object.assign({}, item, {
        x: target.x + target.w / 2,
        y: target.y + target.h / 2
      })
      const width = presetWidthForScale(item.width, source, target)
      if (width !== null) resized.width = width
      return resized
    }

    if (type === 'line' || type === 'arrow' || type === 'highlight') {
      const from = mapPointToBox(numberOr(item.x, 0), numberOr(item.y, 0), source, target)
      const to = mapPointToBox(
        hasX2(item) ? Number(item.x2) : numberOr(item.x, 0),
        hasY2(item) ? Number(item.y2) : numberOr(item.y, 0),
        source,
        target
      )
      const resized = Object.assign({}, item, { x: from.x, y: from.y })
      if (hasX2(item)) resized.x2 = to.x
      if (hasY2(item)) resized.y2 = to.y
      return resized
    }

    if (type === 'pen') {
      const resized = Object.assign({}, item)
      const from = mapPointToBox(numberOr(item.x, 0), numberOr(item.y, 0), source, target)
      const to = mapPointToBox(
        hasX2(item) ? Number(item.x2) : numberOr(item.x, 0),
        hasY2(item) ? Number(item.y2) : numberOr(item.y, 0),
        source,
        target
      )
      resized.x = from.x
      resized.y = from.y
      if (hasX2(item)) resized.x2 = to.x
      if (hasY2(item)) resized.y2 = to.y
      if (Array.isArray(item.points)) {
        resized.points = item.points.map((point) => {
          const mapped = mapPointToBox(numberOr(point?.x, 0), numberOr(point?.y, 0), source, target)
          return { x: mapped.x, y: mapped.y }
        })
      }
      return resized
    }

    // rect / ellipse / blur 以及任何带 x2/y2 的实心块：直接采用新 box。
    return Object.assign({}, item, { x: target.x, y: target.y, x2: target.x + target.w, y2: target.y + target.h })
  }

  // PR4 层级：把指定标注在数组内上移/下移**一层**。下标即 z 序（方案 §8.1）：数组末尾是最
  // 上层，而 renderOverlay() 与 exportSelectionCanvas() 都是 forEach 顺序遍历 —— 只改数组顺序
  // 就等于同时改屏幕层序与导出层序，绘制代码一行都不用动（这是 PR4 的关键简化）。
  //
  // 参数：target 接受元素引用（也接受下标数字），direction **只取符号**：
  //   direction > 0 → 上移一层（朝数组末尾、更靠前）；< 0 → 下移一层（朝数组开头、更靠后）。
  // 契约：
  //   · 永远返回**新数组**（只搬同一批元素引用，既不复制也不改写元素本身），调用方直接替换；
  //   · 边界 no-op：已在最上/最下层、下标越界、target 不在数组里、direction 为 0/非法、
  //     空数组、入参不是数组 —— 一律返回"原顺序的等价浅拷贝"，不抛错、不改动任何内容；
  //   · 只移一层：|direction| > 1 也不会跨过多个邻居（避免调用方误以为能一次置顶）。
  // 注意：不动 id、不重编号 serial.number（§8 风险⑥ 的既有口径不变）。
  function reorderAnnotation(annotations, target, direction) {
    if (!Array.isArray(annotations)) return []
    const ordered = annotations.slice()
    const step = numberOr(direction, 0)
    if (!step) return ordered
    const index = typeof target === 'number' ? Math.trunc(target) : ordered.indexOf(target)
    if (!Number.isFinite(index) || index < 0 || index >= ordered.length) return ordered
    const neighbour = index + (step > 0 ? 1 : -1)
    if (neighbour < 0 || neighbour >= ordered.length) return ordered
    const [item] = ordered.splice(index, 1)
    ordered.splice(neighbour, 0, item)
    return ordered
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
    MIN_RESIZE_SIZE,
    MOVE_THRESHOLD,
    annotationBounds,
    hitTestAnnotation,
    findAnnotationAt,
    movedBeyondThreshold,
    translateAnnotation,
    resizeAnnotationToBox,
    reorderAnnotation,
    clampAnnotationToStage,
    cloneAnnotations
  }
})
