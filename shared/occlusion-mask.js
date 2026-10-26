// 识别/采样用的遮挡合成 —— R0.4 独立修复 + 功能 D 的采样底图（§7.2）。
//
// 设计基线：
//   docs/plans/2026-10-25-history-reedit-batch0-contracts.md §8（识别隐私）
//   docs/plans/2026-10-25-snow-apps-feature-development-plan.md §7.2（安全采样与缓存）
//
// 为什么是一个独立的纯函数模块：这是**隐私边界**，不是显示效果。三条硬规则必须能
// 被单独断言，而不是只能"看某次 OCR 恰好没认出文字"：
//   1. 取当前 crop 的底图；
//   2. 对仍存在的 blur 对象覆盖区域应用**不透明**遮罩（含笔刷半宽、端帽与保守扩展）；
//   3. **在任何缩放之前**施加遮罩，再预缩放。
// 所以本模块只接受"已经算好的矩形与折线"（源像素），输出"遮罩图元清单"，
// 由调用方（渲染层 canvas）把它画成不透明黑块。这样测试可以断言"哪些像素被覆盖"，
// 而不需要真的跑一次模型。
//
// 关键语义（§8 明文）：
//   - highlight **不**视为遮密工具（它不是遮罩）；
//   - 显示透明度预览（橡皮擦）**不**解除识别保护 —— 只要对象还在文档里就遮；
//   - 只有显式确认删除该 blur 对象才解除（对象不在清单里 = 不遮）。
;(function exposeOcclusionMask(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else if (root) root.occlusionMask = api
})(typeof globalThis === 'object' ? globalThis : typeof window === 'object' ? window : this, () => {
  'use strict'

  // 遮罩从 blur 覆盖区向外额外扩张的像素。§8 要求"含半线宽/端帽/边缘保守扩展"：
  // 半线宽由几何本身带上，端帽同理；这里再给一层保守余量，吃掉抗锯齿与像素取整的
  // 边缘（马赛克边缘通常有一两像素的插值过渡，那部分仍可能泄漏字形）。
  const CONSERVATIVE_MARGIN_PX = 2
  // 遮罩色：纯黑不透明。用黑色而不是"和背景同色"是因为它只需要不被读出来；
  // 黑色不会被任何 OCR 引擎当成文字笔画，也不会被误判成二维码定位图样。
  const MASK_COLOR = '#000000'
  const MASK_ALPHA = 1

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value)
  }

  function finiteOr(value, fallback) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return fallback
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  // 与 capture/annotation-style.js 的 blurBrushWidth / highlightWidth 同源公式的**镜像**。
  // 不能 require 那个文件：它在 window 上，且这是主进程也会用的路径。所以两边各自定义，
  // 并由测试钉住"两边给出同一个数"（见 test/occlusion-mask.test.js 的同源断言）。
  function brushStrokeWidth(width) {
    const presets = { 2: 2, 4: 4, 8: 8 }
    const resolved = presets[Math.round(finiteOr(width, 4))] || 4
    return Math.max(18, resolved * 6)
  }

  function pointsOf(annotation) {
    if (!Array.isArray(annotation?.points)) return null
    const points = []
    for (const point of annotation.points) {
      const x = finiteOr(point?.x, Number.NaN)
      const y = finiteOr(point?.y, Number.NaN)
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      points.push({ x, y })
    }
    return points.length ? points : null
  }

  // 一个 blur 对象 → 遮罩图元。矩形 blur 返回 {kind:'rect'}，笔刷 blur 返回
  // {kind:'polyline', points, width}。**不含**高亮、不含普通标注。
  function occluderFor(annotation) {
    if (!isPlainObject(annotation) || annotation.type !== 'blur') return null
    const points = pointsOf(annotation)
    if (points) {
      return {
        kind: 'polyline',
        points,
        // 遮罩宽度 = 笔刷全宽（不是半宽）：折线本身要从两侧各扩半宽，所以给全宽让
        // 调用方按 lineWidth 画 stroke 即得到"半宽 + 端帽"。
        width: brushStrokeWidth(annotation.width)
      }
    }
    const x = finiteOr(annotation.x, 0)
    const y = finiteOr(annotation.y, 0)
    const x2 = finiteOr(annotation.x2, x)
    const y2 = finiteOr(annotation.y2, y)
    const left = Math.min(x, x2)
    const top = Math.min(y, y2)
    return {
      kind: 'rect',
      // 矩形 blur 的显示范围就是这两个端点构成的盒子；值可能是小数（对象坐标保留精度），
      // 遮罩在取整时向外扩，保证不裁掉边缘半个像素。
      rect: {
        x: left,
        y: top,
        w: Math.abs(x2 - x),
        h: Math.abs(y2 - y)
      },
      // 矩形 blur 没有描边，但边界仍有显示时的抗锯齿过渡，按 CONSERVATIVE_MARGIN 扩。
      margin: CONSERVATIVE_MARGIN_PX
    }
  }

  /**
   * 把文档里的 blur 对象集合转成"源像素坐标下的遮罩图元清单"。
   *
   * 只输出仍然存在的对象 —— §8："只有显式确认删除该 blur 对象才解除保护"。
   * 显示层的透明度预览/橡皮擦状态**不**参与这里，因为调用方传进来的是文档快照。
   */
  function buildOccluders(annotations) {
    const list = Array.isArray(annotations) ? annotations : []
    const occluders = []
    for (const annotation of list) {
      const occluder = occluderFor(annotation)
      if (occluder) occluders.push(occluder)
    }
    return occluders
  }

  /**
   * 图元的包围盒（源像素，已含扩张），用于：
   *   - 预算与裁剪判定（在 crop 外的图元不影响采样）；
   *   - 缓存键的指纹（遮罩内容变化必须让缓存失效）。
   */
  function occluderBounds(occluder) {
    const margin = finiteOr(occluder?.margin, CONSERVATIVE_MARGIN_PX)
    if (occluder?.kind === 'rect') {
      const rect = occluder.rect || {}
      const x = finiteOr(rect.x, 0) - margin
      const y = finiteOr(rect.y, 0) - margin
      return {
        x,
        y,
        w: Math.max(0, finiteOr(rect.w, 0)) + margin * 2,
        h: Math.max(0, finiteOr(rect.h, 0)) + margin * 2
      }
    }
    if (occluder?.kind === 'polyline') {
      const points = Array.isArray(occluder.points) ? occluder.points : []
      if (!points.length) return { x: 0, y: 0, w: 0, h: 0 }
      const half = finiteOr(occluder.width, 0) / 2 + margin
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
      return {
        x: minX - half,
        y: minY - half,
        w: (maxX - minX) + half * 2,
        h: (maxY - minY) + half * 2
      }
    }
    return { x: 0, y: 0, w: 0, h: 0 }
  }

  /**
   * 遮罩内容指纹。缓存键要用它，所以它必须只取决于"哪些像素被遮"：
   * 图元顺序、类型、几何、宽度、扩张量都算进去；对象 id 与颜色**不**算
   * （改颜色不改变遮住的区域，不该让缓存失效）。
   */
  function maskFingerprint(occluders) {
    const list = Array.isArray(occluders) ? occluders : []
    const parts = list.map((occluder) => {
      if (occluder?.kind === 'rect') {
        const rect = occluder.rect || {}
        return `r:${finiteOr(rect.x, 0).toFixed(3)},${finiteOr(rect.y, 0).toFixed(3)},${finiteOr(rect.w, 0).toFixed(3)},${finiteOr(rect.h, 0).toFixed(3)},${finiteOr(occluder.margin, CONSERVATIVE_MARGIN_PX)}`
      }
      if (occluder?.kind === 'polyline') {
        const points = (Array.isArray(occluder.points) ? occluder.points : [])
          .map((point) => `${finiteOr(point.x, 0).toFixed(3)},${finiteOr(point.y, 0).toFixed(3)}`)
          .join(';')
        return `p:${finiteOr(occluder.width, 0).toFixed(3)}:${points}`
      }
      return 'x:'
    })
    // 纯 JS 的 FNV-1a（与 capture-document 同款，不需要 node:crypto，两端可算）。
    const text = parts.join('|')
    let high = 0x811c9dc5
    let low = 0x811c9dc5
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index)
      high ^= code
      high = Math.imul(high, 0x01000193) >>> 0
      low ^= (code + index) & 0xffff
      low = Math.imul(low, 0x01000193) >>> 0
    }
    return `${high.toString(16).padStart(8, '0')}${low.toString(16).padStart(8, '0')}`
  }

  /**
   * 遮罩落到 crop 坐标系下的绘制计划（§8 第 3 条：**在任何缩放之前**施加遮罩）。
   *
   * 返回值全部是源像素坐标，调用方在自己的采样画布上按 1:1 画，画完再缩放：
   *   { crop, masked: boolean, ops: [...] }
   * ops 里的 rect / polyline 坐标已经是"相对 crop 原点"的采样画布坐标。
   *
   * 三条裁剪规则：
   *   - 完全在 crop 外的图元被丢弃（它遮不住任何会被采样的像素）；
   *   - 有交集的图元被裁进 crop（**不**做边缘扩张后越界绘制，采样画布的边界就是硬边界）；
   *   - 被裁后的图元若退化（宽或高为 0）也丢弃。
   */
  function planOcclusion({ crop, occluders }) {
    const cropRect = {
      x: finiteOr(crop?.x, 0),
      y: finiteOr(crop?.y, 0),
      w: Math.max(1, Math.round(finiteOr(crop?.w, 1))),
      h: Math.max(1, Math.round(finiteOr(crop?.h, 1)))
    }
    const list = Array.isArray(occluders) ? occluders : []
    const ops = []
    for (const occluder of list) {
      if (occluder?.kind === 'rect') {
        const bounds = occluderBounds(occluder)
        const clipped = intersect(bounds, cropRect)
        if (!clipped) continue
        ops.push({
          kind: 'rect',
          // 相对 crop 原点 + 取整（向外对齐，保证不裁掉半像素）。
          x: Math.floor(clipped.x - cropRect.x),
          y: Math.floor(clipped.y - cropRect.y),
          w: Math.ceil(clipped.w),
          h: Math.ceil(clipped.h)
        })
        continue
      }
      if (occluder?.kind === 'polyline') {
        const bounds = occluderBounds(occluder)
        if (!intersect(bounds, cropRect)) continue
        const points = (Array.isArray(occluder.points) ? occluder.points : [])
          .map((point) => ({ x: point.x - cropRect.x, y: point.y - cropRect.y }))
        if (!points.length) continue
        ops.push({ kind: 'polyline', points, width: finiteOr(occluder.width, 0) })
      }
    }
    return { crop: cropRect, masked: ops.length > 0, ops }
  }

  function intersect(left, right) {
    const x = Math.max(left.x, right.x)
    const y = Math.max(left.y, right.y)
    const right1 = Math.min(left.x + left.w, right.x + right.w)
    const bottom = Math.min(left.y + left.h, right.y + right.h)
    if (!(right1 > x) || !(bottom > y)) return null
    return { x, y, w: right1 - x, h: bottom - y }
  }

  /**
   * 一次性便捷入口：标注 → 绘制计划。渲染层的识别入口与放大镜采样底图都调它。
   *
   * 注意 `includeAnnotations: false` 的识别路径与放大镜采样底图的差别：
   *   - 识别输入：底图 + 遮罩，**不含**普通标注（箭头/文字/高亮）；
   *   - 放大镜采样底图：底图 + 遮罩，同样不含放大镜自身与普通标注（§7.2）。
   * 两者其实是同一个合成，所以共用一个函数是对的。
   */
  function buildOcclusionPlan({ crop, annotations }) {
    const occluders = buildOccluders(annotations)
    const plan = planOcclusion({ crop, occluders })
    return Object.assign({}, plan, {
      occluders,
      fingerprint: maskFingerprint(occluders)
    })
  }

  return {
    CONSERVATIVE_MARGIN_PX,
    MASK_COLOR,
    MASK_ALPHA,
    brushStrokeWidth,
    occluderFor,
    buildOccluders,
    occluderBounds,
    maskFingerprint,
    planOcclusion,
    buildOcclusionPlan
  }
})
