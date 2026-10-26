// 放大镜（magnifier）的共享几何与对象模型 —— 功能 D。
//
// 设计基线：docs/plans/2026-10-25-snow-apps-feature-development-plan.md §7.1/§7.3。
//
// 为什么单独一个模块：放大镜是**带嵌套矩形**的标注（源区 + 镜头），而现有标注模型
// （capture/annotation-geometry.js）只认顶层的 x/y/x2/y2。把嵌套几何集中在这里，
// 文档契约（归一化/校验/指纹）、渲染层（命中/拖动/包围盒）和采样缓存（键）都读同一份
// 推导，避免"镜头显示的位置"和"保存下来的位置"各算一套。
//
// ---------------------------------------------------------------------------
// 坐标系（同 capture-document.js：源像素是唯一落盘单位）
// ---------------------------------------------------------------------------
//   sourceRect   要放大的区域，**底图源像素**坐标，必须落在当前 crop 内（§7.1）。
//   lensOrigin   镜头矩形左上角，**同一坐标系**（底图源像素）。
//   factor       2 | 3 | 4；镜头内容尺寸 = sourceRect.w/h × factor，**禁止持久化镜头尺寸**
//                （§7.1 "禁止同时持久化互相矛盾的镜头尺寸"）。
//
//   因此 lensRect 是**推导值**，永不落盘：
//     lensRect = { x: lensOrigin.x, y: lensOrigin.y,
//                  w: sourceRect.w * factor, h: sourceRect.h * factor }
//
//   镜头不嵌套、不支持旋转（§7.1）。镜头超出 crop 的部分按普通标注裁掉，不扩展底图。
;(function exposeMagnifierGeometry(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else if (root) root.magnifierGeometry = api
})(typeof globalThis === 'object' ? globalThis : typeof window === 'object' ? window : this, () => {
  'use strict'

  const TYPE = 'magnifier'
  // §7.1：倍率只允许 2×/3×/4×。其它值必须被拒绝而不是"四舍五入到最近的合法值"，
  // 因为倍率决定镜头尺寸，悄悄改倍率会让已存的画面与用户看到的不一致。
  const FACTORS = Object.freeze([2, 3, 4])
  const CONNECTORS = Object.freeze(['none', 'line'])
  // §3.3：每文档最多 8 个。上限是工程护栏，不是性能实测最优值。
  const MAX_PER_DOCUMENT = 8
  // 镜头可用的边框宽度范围（源像素）。太细在导出图上看不见，太粗会盖住内容。
  const MIN_STROKE_PX = 1
  const MAX_STROKE_PX = 24
  // 源区的最小边长：1×1 的源区在任何倍率下都不可读，且会让 lensRect 退化。
  const MIN_SOURCE_EDGE_PX = 4
  const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value)
  }

  function finiteOr(value, fallback) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return fallback
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value))
  }

  function normalizeColor(value, fallback) {
    const text = typeof value === 'string' ? value.trim() : ''
    return HEX_COLOR.test(text) ? text.toLowerCase() : fallback
  }

  function normalizeFactor(value) {
    const parsed = Number(value)
    return FACTORS.includes(parsed) ? parsed : 2
  }

  function normalizeConnector(value) {
    return CONNECTORS.includes(value) ? value : 'none'
  }

  // 源区：源像素矩形。宽高至少 MIN_SOURCE_EDGE_PX；位置可以是任意有限值
  // （是否在 crop 内由 clipToCrop 判定，归一化阶段不做裁剪 —— 否则"归一化"会
  // 悄悄改动用户的框选，正是 §6.3 反复强调要避免的那类行为）。
  function normalizeRect(value, fallback) {
    const source = isPlainObject(value) ? value : {}
    const base = isPlainObject(fallback) ? fallback : { x: 0, y: 0, w: MIN_SOURCE_EDGE_PX, h: MIN_SOURCE_EDGE_PX }
    return {
      x: finiteOr(source.x, base.x),
      y: finiteOr(source.y, base.y),
      w: Math.max(MIN_SOURCE_EDGE_PX, finiteOr(source.w ?? source.width, base.w)),
      h: Math.max(MIN_SOURCE_EDGE_PX, finiteOr(source.h ?? source.height, base.h))
    }
  }

  function rectArea(rect) {
    return Math.max(0, Number(rect?.w) || 0) * Math.max(0, Number(rect?.h) || 0)
  }

  function rectsIntersect(left, right) {
    if (!isPlainObject(left) || !isPlainObject(right)) return false
    return left.x < right.x + right.w && right.x < left.x + left.w &&
      left.y < right.y + right.h && right.y < left.y + left.h
  }

  // 两个矩形的交集；空交集返回 null（不是 w=0/h=0 的退化矩形 —— 调用方必须显式处理
  // "源区消失了"这种情形，§7.1 要求此时移除对象并允许撤销恢复）。
  function intersectRects(left, right) {
    if (!isPlainObject(left) || !isPlainObject(right)) return null
    const x = Math.max(left.x, right.x)
    const y = Math.max(left.y, right.y)
    const right1 = Math.min(left.x + left.w, right.x + right.w)
    const bottom = Math.min(left.y + left.h, right.y + right.h)
    if (!(right1 > x) || !(bottom > y)) return null
    return { x, y, w: right1 - x, h: bottom - y }
  }

  function rectWithin(inner, outer) {
    if (!isPlainObject(inner) || !isPlainObject(outer)) return false
    return inner.x >= outer.x && inner.y >= outer.y &&
      inner.x + inner.w <= outer.x + outer.w &&
      inner.y + inner.h <= outer.y + outer.h
  }

  /**
   * 归一化一个放大镜对象。宽容（尽力修复），用于渲染层内存态与磁盘载入。
   * 未知字段丢弃（与文档契约的其它标注一致），倍率非法回落到 2×。
   */
  function normalizeMagnifier(value) {
    const source = isPlainObject(value) ? value : {}
    const stroke = isPlainObject(source.stroke) ? source.stroke : {}
    return {
      type: TYPE,
      sourceRect: normalizeRect(source.sourceRect),
      lensOrigin: {
        x: finiteOr(source.lensOrigin?.x, 0),
        y: finiteOr(source.lensOrigin?.y, 0)
      },
      factor: normalizeFactor(source.factor),
      stroke: {
        color: normalizeColor(stroke.color, '#ff3b30'),
        // Length fields keep SUB-PIXEL precision - and crucially are NOT range-clamped here.
        //
        // Two separate traps, both found by a viewport round trip (`annotationsToViewport` ->
        // `annotationsFromViewport`, the only path between "what the screen shows" and "what gets
        // written"):
        //
        //   1. Math.round() to integers turned 3 * 0.5 = 1.5 into 2, and 2 / 0.5 = 4 - a 1px drift
        //      per round trip that accumulates on every resize, reload and re-save.
        //   2. Clamping to MIN_STROKE_PX did the same damage from the other side: a 1px stroke at
        //      zoom 0.5 is 0.5 VIEWPORT px, and lifting it to 1 came back as 2 source px.
        //
        // So the clamp belongs to validateMagnifier (which judges a document) and NOT here: this
        // function sees both spaces, and only document-space values are subject to the document
        // range. What normalization does need is (a) a positive floor so drawing can never divide
        // by zero and (b) quantisation, because a round trip introduces float noise
        // (1 * 0.37 / 0.37 = 1.0000000000000002) and the content fingerprint would then report a
        // spurious edit on every reopen (§6.3 "打开不增版、不变脏").
        widthPx: quantizeLength(finiteOr(stroke.widthPx ?? stroke.width, 2))
      },
      connector: normalizeConnector(source.connector)
    }
  }

  // Keep three decimals: enough that the document range (1..24 px, and any zoom down to 1/8) is
  // represented exactly after a round trip, few enough that float noise from a scale/divide pair
  // collapses onto the same value. NOT a range clamp - see the stroke comment above.
  function quantizeLength(value) {
    const finite = Number.isFinite(value) ? value : 2
    return Math.max(MIN_STROKE_PX / 1000, Math.round(finite * 1000) / 1000)
  }

  /**
   * 严格校验：**只读**，不修复。任何不合法都进 errors（§7.3 "不合法倍率/源区拒绝"）。
   * 与 normalizeMagnifier 分开的原因同 capture-output-style：主进程提交路径用校验，
   * 载入路径用归一化，"能不能悄悄改值"是这两条路径的唯一区别。
   */
  function validateMagnifier(value) {
    const errors = []
    const push = (code, path, message) => errors.push({ code, path, message })
    if (!isPlainObject(value)) {
      push('not-an-object', 'magnifier', '放大镜必须是对象')
      return { ok: false, errors }
    }
    const allowed = ['id', 'type', 'color', 'width', 'sourceRect', 'lensOrigin', 'factor', 'stroke', 'connector']
    for (const field of Object.keys(value)) {
      if (!allowed.includes(field)) push('unknown-field', `magnifier.${field}`, `未知字段：${field}`)
    }
    if (value.type !== TYPE) push('bad-type', 'magnifier.type', `type 必须是 ${TYPE}`)
    if (!isPlainObject(value.sourceRect)) {
      push('bad-source-rect', 'magnifier.sourceRect', 'sourceRect 必须是对象')
    } else {
      const keys = ['x', 'y', 'w', 'h']
      for (const key of keys) {
        const number = Number(value.sourceRect[key])
        if (!Number.isFinite(number)) push('bad-source-rect', `magnifier.sourceRect.${key}`, `${key} 必须是有限数值`)
      }
      const width = Number(value.sourceRect.w)
      const height = Number(value.sourceRect.h)
      if (Number.isFinite(width) && width < MIN_SOURCE_EDGE_PX) {
        push('source-too-small', 'magnifier.sourceRect.w', `源区宽至少 ${MIN_SOURCE_EDGE_PX}`)
      }
      if (Number.isFinite(height) && height < MIN_SOURCE_EDGE_PX) {
        push('source-too-small', 'magnifier.sourceRect.h', `源区高至少 ${MIN_SOURCE_EDGE_PX}`)
      }
    }
    if (!isPlainObject(value.lensOrigin)) {
      push('bad-lens-origin', 'magnifier.lensOrigin', 'lensOrigin 必须是对象')
    } else {
      for (const key of ['x', 'y']) {
        if (!Number.isFinite(Number(value.lensOrigin[key]))) {
          push('bad-lens-origin', `magnifier.lensOrigin.${key}`, `${key} 必须是有限数值`)
        }
      }
    }
    // 倍率：必须是 2/3/4 之一。字符串 '3' 也拒绝 —— 它是"差不多对"的输入，
    // 而倍率决定镜头尺寸，模糊接受会让画面与数据不一致。
    // `typeof` is checked first because `Number(undefined)` is NaN but `Number(null)` is 0 and
    // `'2'` would coerce to a legal factor: only a real JSON number in FACTORS is acceptable.
    if (typeof value.factor !== 'number' || !FACTORS.includes(value.factor)) {
      push('bad-factor', 'magnifier.factor', `倍率必须是 ${FACTORS.join('/')}`)
    }
    if (value.stroke !== undefined) {
      if (!isPlainObject(value.stroke)) push('bad-stroke', 'magnifier.stroke', 'stroke 必须是对象')
      else {
        if (value.stroke.color !== undefined && !HEX_COLOR.test(String(value.stroke.color))) {
          push('bad-color', 'magnifier.stroke.color', '颜色必须是 #rrggbb')
        }
        if (value.stroke.widthPx !== undefined) {
          const width = Number(value.stroke.widthPx)
          if (!Number.isFinite(width)) push('bad-stroke', 'magnifier.stroke.widthPx', 'widthPx 必须是有限数值')
          else if (width < MIN_STROKE_PX || width > MAX_STROKE_PX) {
            push('out-of-range', 'magnifier.stroke.widthPx', `widthPx 必须在 ${MIN_STROKE_PX}..${MAX_STROKE_PX}`)
          }
        }
      }
    }
    if (value.connector !== undefined && !CONNECTORS.includes(value.connector)) {
      push('bad-connector', 'magnifier.connector', `connector 必须是 ${CONNECTORS.join('/')}`)
    }
    return { ok: errors.length === 0, errors }
  }

  /** 镜头矩形：由 sourceRect × factor 推导，永不落盘（§7.1）。 */
  function lensRect(magnifier) {
    const normalized = isPlainObject(magnifier?.sourceRect) ? magnifier : normalizeMagnifier(magnifier)
    const { sourceRect, lensOrigin, factor } = normalized
    return {
      x: lensOrigin.x,
      y: lensOrigin.y,
      w: sourceRect.w * factor,
      h: sourceRect.h * factor
    }
  }

  function lensCenter(magnifier) {
    const lens = lensRect(magnifier)
    return { x: lens.x + lens.w / 2, y: lens.y + lens.h / 2 }
  }

  function sourceCenter(magnifier) {
    const normalized = isPlainObject(magnifier?.sourceRect) ? magnifier : normalizeMagnifier(magnifier)
    return {
      x: normalized.sourceRect.x + normalized.sourceRect.w / 2,
      y: normalized.sourceRect.y + normalized.sourceRect.h / 2
    }
  }

  /**
   * 以镜头中心为锚点改倍率（§7.1 "倍率变更以镜头中心为锚点"）。
   * 只改 factor；lensOrigin 向内收缩/向外扩张以保持中心不变。
   */
  function withFactor(magnifier, factor) {
    const normalized = isPlainObject(magnifier?.sourceRect) ? magnifier : normalizeMagnifier(magnifier)
    const next = normalizeFactor(factor)
    if (next === normalized.factor) return normalized
    const center = lensCenter(normalized)
    const width = normalized.sourceRect.w * next
    const height = normalized.sourceRect.h * next
    return Object.assign({}, normalized, {
      factor: next,
      lensOrigin: { x: center.x - width / 2, y: center.y - height / 2 }
    })
  }

  /**
   * 平移镜头（只改 lensOrigin；源区不动 —— 源区和镜头可分别拖动，§7.1）。
   * 返回新对象，绝不就地改入参（与 annotation-geometry 的 translateAnnotation 同契约）。
   */
  function translateLens(magnifier, dx, dy) {
    const normalized = isPlainObject(magnifier?.sourceRect) ? magnifier : normalizeMagnifier(magnifier)
    const offsetX = finiteOr(dx, 0)
    const offsetY = finiteOr(dy, 0)
    return Object.assign({}, normalized, {
      lensOrigin: { x: normalized.lensOrigin.x + offsetX, y: normalized.lensOrigin.y + offsetY }
    })
  }

  /** 平移源区（镜头不动）。 */
  function translateSource(magnifier, dx, dy) {
    const normalized = isPlainObject(magnifier?.sourceRect) ? magnifier : normalizeMagnifier(magnifier)
    const offsetX = finiteOr(dx, 0)
    const offsetY = finiteOr(dy, 0)
    return Object.assign({}, normalized, {
      sourceRect: {
        x: normalized.sourceRect.x + offsetX,
        y: normalized.sourceRect.y + offsetY,
        w: normalized.sourceRect.w,
        h: normalized.sourceRect.h
      }
    })
  }

  function translateMagnifier(magnifier, dx, dy) {
    const normalized = isPlainObject(magnifier?.sourceRect) ? magnifier : normalizeMagnifier(magnifier)
    return translateLens(translateSource(normalized, dx, dy), dx, dy)
  }

  /**
   * 包围盒：源区 ∪ 镜头（并给引线留出空间）。渲染层的选择框、拖动 clamp、
   * 导出时的裁切判定都用这个盒子，所以它必须覆盖**所有会画出来的像素**。
   */
  function magnifierBounds(magnifier) {
    const normalized = isPlainObject(magnifier?.sourceRect) ? magnifier : normalizeMagnifier(magnifier)
    const source = normalized.sourceRect
    const lens = lensRect(normalized)
    const left = Math.min(source.x, lens.x)
    const top = Math.min(source.y, lens.y)
    const right = Math.max(source.x + source.w, lens.x + lens.w)
    const bottom = Math.max(source.y + source.h, lens.y + lens.h)
    return { x: left, y: top, w: right - left, h: bottom - top }
  }

  /**
   * 裁剪变更时把源区收进 crop 的统一规则（§7.1）：
   *   - 完全在 crop 内：原样返回，adjusted=false；
   *   - 有非空交集：取交集，adjusted=true（镜头保持中心不动，尺寸由新源区推导）；
   *   - 交集为空：ok=false + code='source-outside-crop'。调用方（裁剪手势）负责移除对象，
   *     并且**这次移除必须可撤销**（撤销即恢复对象，§7.1 "允许撤销恢复"）。
   *
   * 特别注意：**不允许**保留一个采样 crop 外内容的镜头（那就等于把用户裁掉的像素
   * 重新画回成品里）。所以空交集时是"移除"，不是"夹紧到一个边缘小矩形"。
   */
  function clipToCrop(magnifier, crop) {
    const normalized = isPlainObject(magnifier?.sourceRect) ? magnifier : normalizeMagnifier(magnifier)
    if (!isPlainObject(crop)) return { ok: true, magnifier: normalized, adjusted: false }
    const cropRect = { x: Number(crop.x) || 0, y: Number(crop.y) || 0, w: Number(crop.w) || 0, h: Number(crop.h) || 0 }
    if (!(cropRect.w > 0) || !(cropRect.h > 0)) {
      return { ok: false, code: 'source-outside-crop', magnifier: normalized, adjusted: false }
    }
    if (rectWithin(normalized.sourceRect, cropRect)) {
      return { ok: true, magnifier: normalized, adjusted: false }
    }
    const clipped = intersectRects(normalized.sourceRect, cropRect)
    if (!clipped) return { ok: false, code: 'source-outside-crop', magnifier: normalized, adjusted: false }
    // 源区被裁小后镜头尺寸变小；以镜头中心为锚点保持它不跳位（与改倍率同一条规则）。
    const center = lensCenter(normalized)
    const width = clipped.w * normalized.factor
    const height = clipped.h * normalized.factor
    return {
      ok: true,
      adjusted: true,
      code: 'source-clipped',
      magnifier: Object.assign({}, normalized, {
        sourceRect: clipped,
        lensOrigin: { x: center.x - width / 2, y: center.y - height / 2 }
      })
    }
  }

  /**
   * 把一组放大镜按裁剪规则处理。返回保留下来的对象 + 被移除的 id 列表，
   * 让调用方把它们塞进同一个撤销帧（"该裁剪变更中移除对象并允许撤销恢复"）。
   */
  function clipAllToCrop(magnifiers, crop) {
    const list = Array.isArray(magnifiers) ? magnifiers : []
    const kept = []
    const removed = []
    let adjusted = false
    for (const entry of list) {
      const result = clipToCrop(entry, crop)
      if (result.ok) {
        if (result.adjusted) adjusted = true
        kept.push(result.magnifier)
      } else {
        removed.push(entry)
      }
    }
    return { kept, removed, adjusted }
  }

  /** 预算守卫：每文档最多 MAX_PER_DOCUMENT 个（§3.3）。 */
  function withinBudget(magnifiers) {
    const list = Array.isArray(magnifiers) ? magnifiers : []
    return list.length <= MAX_PER_DOCUMENT
  }

  /**
   * 采样缓存键（§7.2）：底图内容标识 + crop + 遮罩内容指纹 + 源区与采样尺度。
   *
   * 刻意**不**包含 lensOrigin：移动镜头位置不需要重新采样底图（§7.2 明写）。
   * 改源区 / 改 blur / 换底图 / 改 crop 都必须变键。
   */
  function sampleCacheKey({ baseImageId, crop, maskFingerprint, sourceRect, factor }) {
    const rect = normalizeRect(sourceRect)
    return [
      String(baseImageId || ''),
      `${Math.round(Number(crop?.x) || 0)},${Math.round(Number(crop?.y) || 0)},${Math.round(Number(crop?.w) || 0)},${Math.round(Number(crop?.h) || 0)}`,
      String(maskFingerprint || ''),
      `${rect.x.toFixed(3)},${rect.y.toFixed(3)},${rect.w.toFixed(3)},${rect.h.toFixed(3)}`,
      String(normalizeFactor(factor))
    ].join('|')
  }

  /**
   * 命中测试：源区（含描边）、镜头（含描边）、以及引线（若开启）。
   * `tolerance` 是源像素容差（渲染层会把视口 CSS 容差除以 zoom 再传进来）。
   * 返回 'source' | 'lens' | 'connector' | null —— 调用方据此决定拖哪一半。
   */
  function hitTestMagnifier(magnifier, point, tolerance = 0) {
    const normalized = isPlainObject(magnifier?.sourceRect) ? magnifier : normalizeMagnifier(magnifier)
    const px = Number(point?.x)
    const py = Number(point?.y)
    if (!Number.isFinite(px) || !Number.isFinite(py)) return null
    const slop = Math.max(0, Number(tolerance) || 0) + normalized.stroke.widthPx / 2
    const inside = (rect) => px >= rect.x - slop && px <= rect.x + rect.w + slop &&
      py >= rect.y - slop && py <= rect.y + rect.h + slop
    // 镜头优先：它画在源区之上，点中重叠区域时用户想拖的是镜头。
    if (inside(lensRect(normalized))) return 'lens'
    if (inside(normalized.sourceRect)) return 'source'
    if (normalized.connector === 'line') {
      const from = sourceCenter(normalized)
      const lens = lensRect(normalized)
      const to = { x: lens.x + lens.w / 2, y: lens.y + lens.h / 2 }
      if (pointToSegmentDistance(px, py, from.x, from.y, to.x, to.y) <= slop) return 'connector'
    }
    return null
  }

  function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1
    const dy = y2 - y1
    const lengthSquared = dx * dx + dy * dy
    if (!lengthSquared) return Math.hypot(px - x1, py - y1)
    const raw = ((px - x1) * dx + (py - y1) * dy) / lengthSquared
    const t = clamp(raw, 0, 1)
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
  }

  /**
   * 从"用户拖出的一个矩形"创建一个放大镜：源区就是该矩形（收进 crop），
   * 镜头放在矩形的右下方（避开源区，否则会盖住要放大的内容）。
   * 镜头位置会被调用方再做一次 stage 内 clamp，这里只保证"不压住源区"。
   */
  function createFromSourceRect(sourceRect, options = {}) {
    const settings = isPlainObject(options) ? options : {}
    const factor = normalizeFactor(settings.factor)
    const crop = isPlainObject(settings.crop) ? settings.crop : null
    let rect = normalizeRect(sourceRect)
    if (crop) {
      const clipped = clipToCrop(normalizeMagnifier({ sourceRect: rect, lensOrigin: { x: 0, y: 0 }, factor }), crop)
      if (!clipped.ok) return null
      rect = clipped.magnifier.sourceRect
    }
    const width = rect.w * factor
    const height = rect.h * factor
    // 默认放在源区右下方（留 8px 呼吸位），空间不够时翻到左上。
    const gap = 8
    let x = rect.x + rect.w + gap
    let y = rect.y + rect.h + gap
    if (crop && x + width > crop.x + crop.w) x = rect.x - width - gap
    if (crop && y + height > crop.y + crop.h) y = rect.y - height - gap
    return normalizeMagnifier({
      sourceRect: rect,
      lensOrigin: { x, y },
      factor,
      stroke: settings.stroke,
      connector: settings.connector
    })
  }

  /** 包围盒 → 选择框：直接复用 annotation-geometry 的矩形契约。 */
  function outlineRect(magnifier) {
    return magnifierBounds(magnifier)
  }

  return {
    TYPE,
    FACTORS,
    CONNECTORS,
    MAX_PER_DOCUMENT,
    MIN_SOURCE_EDGE_PX,
    MIN_STROKE_PX,
    MAX_STROKE_PX,
    isPlainObject,
    normalizeRect,
    rectArea,
    rectsIntersect,
    intersectRects,
    rectWithin,
    normalizeMagnifier,
    validateMagnifier,
    lensRect,
    lensCenter,
    sourceCenter,
    withFactor,
    translateLens,
    translateSource,
    translateMagnifier,
    magnifierBounds,
    clipToCrop,
    clipAllToCrop,
    withinBudget,
    sampleCacheKey,
    hitTestMagnifier,
    createFromSourceRect,
    outlineRect
  }
})
