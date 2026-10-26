// 截图成品样式（output style）的共享契约层 —— 功能 C。
//
// 设计基线：docs/plans/2026-10-25-snow-apps-feature-development-plan.md §6.1/§6.2。
//
// 为什么单独一个文件而不是塞进 capture-document.js：文档模型只关心"这份内容是什么"，
// 而成品的**几何**（画布多大、内容落在哪里）必须能被主进程的提交校验、渲染层的预览和
// 导出三处共用，且不需要加载整个文档模型。放在同一层、同款 UMD 双端暴露，渲染层靠
// `<script src="../shared/capture-output-style.js">` 拿到 `window.captureOutputStyle`。
//
// ---------------------------------------------------------------------------
// 坐标系（同 capture-document.js：一切长度都是**源像素**）
// ---------------------------------------------------------------------------
//   outputStyle 里所有 `*Px` 字段都是源像素，与 crop / 标注同一单位。产物（结果图）的
//   画布是"内容层 + 装饰"的并集：
//
//     contentLayer = crop 尺寸（crop.w × crop.h），标注/捕获附件画在它内部
//     card         = contentLayer + 2×paddingPx（成品背景板）
//     shadowBleed  = 阴影向外溢出的有限边界（见 shadowExtents）
//     canvas       = card ∪ (card 平移 (offsetX, offsetY) 后按 blurPx 外扩)
//
//   映射规则（§6.2，渲染层唯一允许的换算）：
//     outputX = sourceX - crop.x + contentOffsetX
//     outputY = sourceY - crop.y + contentOffsetY
//   外框留白**不**反写进 crop，底图尺寸**不**改成成品尺寸。
//
// ---------------------------------------------------------------------------
// 原图模式的硬约束（§6.2 末段 / §6.4 C1：v1 打开不变脏、原图等价）
// ---------------------------------------------------------------------------
//   enabled === false 时几何必须与 v1 逐像素相同：宽高 = crop 的整数宽高，
//   contentOffset 恒为 0。这不是"近似"，是校验路径（capture-document-service 对 v1 文档
//   继续要求结果尺寸 == crop）能继续成立的前提，因此 planOutputComposite 在这个分支里
//   **完全不看**其它参数（padding/radius/border/shadow 一律忽略）。默认值因此也是禁用态。
;(function exposeCaptureOutputStyle(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else if (root) root.captureOutputStyle = api
})(typeof globalThis === 'object' ? globalThis : typeof window === 'object' ? window : this, () => {
  'use strict'

  // 集中上限（§3.3 "保留集中常量、服务端校验与边界测试"）。这些是**工程护栏**，
  // 不是测得的最优值：任何一项都能在不改协议的前提下调大，但必须同时改测试。
  const LIMITS = Object.freeze({
    MAX_PADDING_PX: 512,
    MAX_CORNER_RADIUS_PX: 512,
    MAX_BORDER_WIDTH_PX: 64,
    MAX_SHADOW_BLUR_PX: 256,
    MAX_SHADOW_OFFSET_PX: 256,
    // 画布边长的硬上限（远低于各平台 canvas 的真实上限，留足余量）。
    MAX_OUTPUT_EDGE_PX: 16384,
    // 与 shared/region-presets.js 的像素预算同量级：超预算在分配前拒绝，不是"尽最大努力"。
    MAX_OUTPUT_PIXELS: 80000000
  })

  // 阴影外扩系数。canvas 的 shadowBlur 是高斯核，视觉可见范围约 3σ，而 σ ≈ blur/2
  // （规范把 blur 当直径附近的核尺寸），所以 1.5×blur 覆盖 3σ。取 1.5 而不是 2 是因为
  // 2 会在 4K 图上白白多留几十像素背景（§6.2 "不必要的无限外扩假设"）。
  const SHADOW_BLEED_FACTOR = 1.5

  const HEX_COLOR = /^#[0-9a-fA-F]{6}$/
  // presetId 只是 UI 偏好（§6.2："presetId 只是 UI 偏好，产物由完整解析参数决定"），
  // 所以这里只定义三个预设的**初始参数**；真正的产物永远读完整字段。
  const PRESET_IDS = Object.freeze(['original', 'card-light', 'card-dark'])

  const DEFAULT_OUTPUT_STYLE = Object.freeze({
    enabled: false,
    paddingPx: 0,
    background: Object.freeze({ color: '#ffffff', alpha: 1 }),
    cornerRadiusPx: 0,
    border: Object.freeze({ widthPx: 0, color: '#e0e0e3' }),
    shadow: Object.freeze({
      enabled: false,
      blurPx: 0,
      offsetXPx: 0,
      offsetYPx: 0,
      color: '#000000',
      alpha: 0.24
    })
  })

  // 三个预设。数值是"看起来像卡片"的起点：48px 留白在 1080p 截图上是约 4% 的边，
  // 16px 圆角与 32px 阴影是常见卡片比例；深色卡片的阴影更黑更实（浅色卡片上是灰雾）。
  const OUTPUT_STYLE_PRESETS = Object.freeze({
    original: Object.freeze({
      id: 'original',
      labelKey: 'capture.output.preset-original',
      style: DEFAULT_OUTPUT_STYLE
    }),
    'card-light': Object.freeze({
      id: 'card-light',
      labelKey: 'capture.output.preset-card-light',
      style: Object.freeze({
        enabled: true,
        paddingPx: 48,
        background: Object.freeze({ color: '#f5f5f7', alpha: 1 }),
        cornerRadiusPx: 16,
        border: Object.freeze({ widthPx: 1, color: '#d8d8dd' }),
        shadow: Object.freeze({
          enabled: true,
          blurPx: 32,
          offsetXPx: 0,
          offsetYPx: 12,
          color: '#000000',
          alpha: 0.18
        })
      })
    }),
    'card-dark': Object.freeze({
      id: 'card-dark',
      labelKey: 'capture.output.preset-card-dark',
      style: Object.freeze({
        enabled: true,
        paddingPx: 48,
        background: Object.freeze({ color: '#141416', alpha: 1 }),
        cornerRadiusPx: 16,
        border: Object.freeze({ widthPx: 1, color: '#2c2c2e' }),
        shadow: Object.freeze({
          enabled: true,
          blurPx: 32,
          offsetXPx: 0,
          offsetYPx: 12,
          color: '#000000',
          alpha: 0.5
        })
      })
    })
  })

  const STYLE_FIELDS = Object.freeze(['enabled', 'paddingPx', 'background', 'cornerRadiusPx', 'border', 'shadow'])
  const BACKGROUND_FIELDS = Object.freeze(['color', 'alpha'])
  const BORDER_FIELDS = Object.freeze(['widthPx', 'color'])
  const SHADOW_FIELDS = Object.freeze(['enabled', 'blurPx', 'offsetXPx', 'offsetYPx', 'color', 'alpha'])

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value)
  }

  // 与 capture-document.js 同款的严格数值解析：null/undefined/''/布尔一律走 fallback，
  // 避免"缺失的留白"被 Number(null)=0 静默变成另一个值（这里 0 是合法值，所以更需要区分）。
  function finiteOr(value, fallback) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return fallback
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value))
  }

  // Round to integer pixels and clamp into [minimum, maximum].
  //
  // `fallback` is a SEPARATE parameter and must never be `minimum`: for a ranged field such as the
  // shadow offset the range is [-256, 256], so using the lower bound as the "missing value" would
  // silently turn an absent offset into a hard -256px shadow shift. Everything here defaults to 0
  // because 0 is the neutral value for padding/radius/border/blur/offset alike.
  function clampRound(value, minimum, maximum, fallback = 0) {
    const parsed = finiteOr(value, fallback)
    return Math.round(clamp(parsed, minimum, maximum))
  }

  function normalizeColor(value, fallback) {
    const text = typeof value === 'string' ? value.trim() : ''
    return HEX_COLOR.test(text) ? text.toLowerCase() : fallback
  }

  function normalizeAlpha(value, fallback) {
    const parsed = finiteOr(value, fallback)
    return clamp(Math.round(parsed * 1000) / 1000, 0, 1)
  }

  function normalizeOutputStyle(value) {
    const source = isPlainObject(value) ? value : {}
    const background = isPlainObject(source.background) ? source.background : {}
    const border = isPlainObject(source.border) ? source.border : {}
    const shadow = isPlainObject(source.shadow) ? source.shadow : {}
    return {
      enabled: source.enabled === true,
      paddingPx: clampRound(source.paddingPx, 0, LIMITS.MAX_PADDING_PX),
      background: {
        color: normalizeColor(background.color, DEFAULT_OUTPUT_STYLE.background.color),
        alpha: normalizeAlpha(background.alpha, DEFAULT_OUTPUT_STYLE.background.alpha)
      },
      cornerRadiusPx: clampRound(source.cornerRadiusPx, 0, LIMITS.MAX_CORNER_RADIUS_PX),
      border: {
        widthPx: clampRound(border.widthPx, 0, LIMITS.MAX_BORDER_WIDTH_PX),
        color: normalizeColor(border.color, DEFAULT_OUTPUT_STYLE.border.color)
      },
      shadow: {
        enabled: shadow.enabled === true,
        blurPx: clampRound(shadow.blurPx, 0, LIMITS.MAX_SHADOW_BLUR_PX),
        offsetXPx: clampRound(shadow.offsetXPx, -LIMITS.MAX_SHADOW_OFFSET_PX, LIMITS.MAX_SHADOW_OFFSET_PX),
        offsetYPx: clampRound(shadow.offsetYPx, -LIMITS.MAX_SHADOW_OFFSET_PX, LIMITS.MAX_SHADOW_OFFSET_PX),
        color: normalizeColor(shadow.color, DEFAULT_OUTPUT_STYLE.shadow.color),
        alpha: normalizeAlpha(shadow.alpha, DEFAULT_OUTPUT_STYLE.shadow.alpha)
      }
    }
  }

  // 严格校验：**只读**，不修复。归一化会尽力修复（把 9999 夹成上限），校验必须报错 ——
  // 主进程提交路径用校验，渲染层载入路径用归一化，两者的区别就是"能不能悄悄改值"。
  function validateOutputStyle(value) {
    const errors = []
    const push = (code, path, message) => errors.push({ code, path, message })
    if (!isPlainObject(value)) {
      push('not-an-object', 'outputStyle', 'outputStyle 必须是对象')
      return { ok: false, errors }
    }
    for (const field of Object.keys(value)) {
      if (!STYLE_FIELDS.includes(field)) push('unknown-field', `outputStyle.${field}`, `未知字段：${field}`)
    }
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
      push('bad-enabled', 'outputStyle.enabled', 'enabled 必须是布尔值')
    }
    for (const [field, max] of [
      ['paddingPx', LIMITS.MAX_PADDING_PX],
      ['cornerRadiusPx', LIMITS.MAX_CORNER_RADIUS_PX]
    ]) {
      if (value[field] === undefined) continue
      const number = Number(value[field])
      if (!Number.isFinite(number)) push('bad-number', `outputStyle.${field}`, `${field} 必须是有限数值`)
      else if (!Number.isInteger(number)) push('bad-number', `outputStyle.${field}`, `${field} 必须是整数像素`)
      else if (number < 0 || number > max) push('out-of-range', `outputStyle.${field}`, `${field} 必须在 0..${max}`)
    }
    if (value.background !== undefined) {
      if (!isPlainObject(value.background)) push('bad-object', 'outputStyle.background', 'background 必须是对象')
      else {
        for (const field of Object.keys(value.background)) {
          if (!BACKGROUND_FIELDS.includes(field)) push('unknown-field', `outputStyle.background.${field}`, `未知字段：${field}`)
        }
        if (value.background.color !== undefined && !HEX_COLOR.test(String(value.background.color))) {
          push('bad-color', 'outputStyle.background.color', '颜色必须是 #rrggbb')
        }
        if (value.background.alpha !== undefined) {
          const alpha = Number(value.background.alpha)
          if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) push('out-of-range', 'outputStyle.background.alpha', 'alpha 必须在 0..1')
        }
      }
    }
    if (value.border !== undefined) {
      if (!isPlainObject(value.border)) push('bad-object', 'outputStyle.border', 'border 必须是对象')
      else {
        for (const field of Object.keys(value.border)) {
          if (!BORDER_FIELDS.includes(field)) push('unknown-field', `outputStyle.border.${field}`, `未知字段：${field}`)
        }
        if (value.border.widthPx !== undefined) {
          const width = Number(value.border.widthPx)
          if (!Number.isFinite(width)) push('bad-number', 'outputStyle.border.widthPx', 'widthPx 必须是有限数值')
          else if (!Number.isInteger(width)) push('bad-number', 'outputStyle.border.widthPx', 'widthPx 必须是整数像素')
          else if (width < 0 || width > LIMITS.MAX_BORDER_WIDTH_PX) {
            push('out-of-range', 'outputStyle.border.widthPx', `widthPx 必须在 0..${LIMITS.MAX_BORDER_WIDTH_PX}`)
          }
        }
        if (value.border.color !== undefined && !HEX_COLOR.test(String(value.border.color))) {
          push('bad-color', 'outputStyle.border.color', '颜色必须是 #rrggbb')
        }
      }
    }
    if (value.shadow !== undefined) {
      if (!isPlainObject(value.shadow)) push('bad-object', 'outputStyle.shadow', 'shadow 必须是对象')
      else {
        for (const field of Object.keys(value.shadow)) {
          if (!SHADOW_FIELDS.includes(field)) push('unknown-field', `outputStyle.shadow.${field}`, `未知字段：${field}`)
        }
        if (value.shadow.enabled !== undefined && typeof value.shadow.enabled !== 'boolean') {
          push('bad-enabled', 'outputStyle.shadow.enabled', 'enabled 必须是布尔值')
        }
        if (value.shadow.blurPx !== undefined) {
          const blur = Number(value.shadow.blurPx)
          if (!Number.isFinite(blur)) push('bad-number', 'outputStyle.shadow.blurPx', 'blurPx 必须是有限数值')
          else if (!Number.isInteger(blur)) push('bad-number', 'outputStyle.shadow.blurPx', 'blurPx 必须是整数像素')
          else if (blur < 0 || blur > LIMITS.MAX_SHADOW_BLUR_PX) {
            push('out-of-range', 'outputStyle.shadow.blurPx', `blurPx 必须在 0..${LIMITS.MAX_SHADOW_BLUR_PX}`)
          }
        }
        for (const field of ['offsetXPx', 'offsetYPx']) {
          if (value.shadow[field] === undefined) continue
          const offset = Number(value.shadow[field])
          if (!Number.isFinite(offset)) push('bad-number', `outputStyle.shadow.${field}`, `${field} 必须是有限数值`)
          else if (!Number.isInteger(offset)) push('bad-number', `outputStyle.shadow.${field}`, `${field} 必须是整数像素`)
          else if (Math.abs(offset) > LIMITS.MAX_SHADOW_OFFSET_PX) {
            push('out-of-range', `outputStyle.shadow.${field}`, `${field} 的绝对值不得超过 ${LIMITS.MAX_SHADOW_OFFSET_PX}`)
          }
        }
        if (value.shadow.color !== undefined && !HEX_COLOR.test(String(value.shadow.color))) {
          push('bad-color', 'outputStyle.shadow.color', '颜色必须是 #rrggbb')
        }
        if (value.shadow.alpha !== undefined) {
          const alpha = Number(value.shadow.alpha)
          if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) push('out-of-range', 'outputStyle.shadow.alpha', 'alpha 必须在 0..1')
        }
      }
    }
    return { ok: errors.length === 0, errors }
  }

  function isOutputStyleEnabled(style) {
    return isPlainObject(style) ? style.enabled === true : false
  }

  function presetStyle(presetId) {
    const preset = OUTPUT_STYLE_PRESETS[String(presetId || '')]
    return normalizeOutputStyle(preset ? preset.style : DEFAULT_OUTPUT_STYLE)
  }

  // 阴影的有限外扩边界。返回四边各自的像素数（含偏移的符号方向）：
  //   阴影形状 = card 平移 (offsetX, offsetY) 后按 blurBleed 外扩；
  //   画布必须容纳 card ∪ shadowShape，所以每边取两者的最大值。
  // blurPx 为 0 时外扩只剩下偏移本身 —— 但纯偏移的阴影如果完全被 card 覆盖就没有可见
  // 部分，所以仍按 0 处理（不额外留白）。
  function shadowExtents(shadow) {
    const normalized = isPlainObject(shadow) ? normalizeOutputStyle({ shadow }).shadow : normalizeOutputStyle({}).shadow
    if (!normalized.enabled || normalized.blurPx <= 0) {
      return { left: 0, top: 0, right: 0, bottom: 0, bleed: 0 }
    }
    const bleed = Math.ceil(normalized.blurPx * SHADOW_BLEED_FACTOR)
    return {
      left: Math.max(0, -normalized.offsetXPx) + bleed,
      top: Math.max(0, -normalized.offsetYPx) + bleed,
      right: Math.max(0, normalized.offsetXPx) + bleed,
      bottom: Math.max(0, normalized.offsetYPx) + bleed,
      bleed
    }
  }

  // 成品几何的唯一计算入口。渲染层的预览、渲染层的导出、主进程的提交校验都调它，
  // 三处不可能给出不同答案（§6.2 "统一函数 resolveOutputGeometry(doc)"）。
  //
  // 入参有三种等价写法，调用方按自己手里已有的东西传，避免为了调它先伪造一个文档：
  //   { crop: {w,h}, outputStyle }                     —— 文档快照（主进程校验走这条）
  //   { contentWidth, contentHeight, outputStyle }     —— 渲染层算好的内容层尺寸
  //   { width, height, outputStyle }                   —— 同上（画布习惯的字段名）
  // 内容层尺寸永远是 crop 的整数宽高：crop 已经是整数像素矩形（capture-document.normalizeCrop）。
  function planOutputComposite(input) {
    const source = isPlainObject(input) ? input : {}
    const crop = isPlainObject(source.crop) ? source.crop : null
    const rawWidth = crop ? (crop.w ?? crop.width) : (source.contentWidth ?? source.width ?? source.w)
    const rawHeight = crop ? (crop.h ?? crop.height) : (source.contentHeight ?? source.height ?? source.h)
    const contentWidth = Math.max(1, Math.round(finiteOr(rawWidth, 1)))
    const contentHeight = Math.max(1, Math.round(finiteOr(rawHeight, 1)))
    const style = normalizeOutputStyle(source.outputStyle)
    // 原图模式：几何与 v1 逐像素相同，其它参数一律不参与（§6.2）。
    if (!style.enabled) {
      return {
        enabled: false,
        width: contentWidth,
        height: contentHeight,
        contentWidth,
        contentHeight,
        contentOffsetX: 0,
        contentOffsetY: 0,
        card: { x: 0, y: 0, width: contentWidth, height: contentHeight, radius: 0 },
        content: { x: 0, y: 0, width: contentWidth, height: contentHeight, radius: 0 },
        shadow: null,
        background: null,
        border: null
      }
    }
    const padding = style.paddingPx
    const cardWidth = contentWidth + padding * 2
    const cardHeight = contentHeight + padding * 2
    const extents = shadowExtents(style.shadow)
    const left = extents.left
    const top = extents.top
    const cardX = left
    const cardY = top
    const contentX = left + padding
    const contentY = top + padding
    // 圆角是"同心"的：内容按 cornerRadiusPx 裁切，背景板半径 = 圆角 + 留白，这样留白
    // 环带的宽度看起来处处一致。留白为 0 时两者相等，背景板被内容完全覆盖（符合直觉）。
    const contentRadius = clamp(
      style.cornerRadiusPx,
      0,
      Math.floor(Math.min(contentWidth, contentHeight) / 2)
    )
    const cardRadius = clamp(
      style.cornerRadiusPx + padding,
      0,
      Math.floor(Math.min(cardWidth, cardHeight) / 2)
    )
    return {
      enabled: true,
      width: cardWidth + left + extents.right,
      height: cardHeight + top + extents.bottom,
      contentWidth,
      contentHeight,
      contentOffsetX: contentX,
      contentOffsetY: contentY,
      card: { x: cardX, y: cardY, width: cardWidth, height: cardHeight, radius: cardRadius },
      content: { x: contentX, y: contentY, width: contentWidth, height: contentHeight, radius: contentRadius },
      shadow: style.shadow.enabled && style.shadow.blurPx > 0
        ? {
            blurPx: style.shadow.blurPx,
            offsetXPx: style.shadow.offsetXPx,
            offsetYPx: style.shadow.offsetYPx,
            color: style.shadow.color,
            alpha: style.shadow.alpha
          }
        : null,
      background: { color: style.background.color, alpha: style.background.alpha },
      border: style.border.widthPx > 0
        ? { widthPx: style.border.widthPx, color: style.border.color }
        : null
    }
  }

  function geometryFromPlan(plan) {
    return {
      width: plan.width,
      height: plan.height,
      contentOffsetX: plan.contentOffsetX,
      contentOffsetY: plan.contentOffsetY
    }
  }

  function resolveOutputGeometry(document) {
    return geometryFromPlan(planOutputComposite(document))
  }

  // 预算校验放在**分配画布之前**（§3.3 / §6.2 "先计算预算再分配画布"）。
  // 返回 {ok} 或 {ok:false, code, ...}，不抛错：调用方决定是报错还是降级回原图。
  function assertOutputBudget(geometry, limits = LIMITS) {
    const width = Math.round(finiteOr(geometry?.width, 0))
    const height = Math.round(finiteOr(geometry?.height, 0))
    if (width < 1 || height < 1) return { ok: false, code: 'empty-output', width, height }
    if (width > limits.MAX_OUTPUT_EDGE_PX || height > limits.MAX_OUTPUT_EDGE_PX) {
      return { ok: false, code: 'output-too-large', width, height, maxEdge: limits.MAX_OUTPUT_EDGE_PX }
    }
    const pixels = width * height
    if (pixels > limits.MAX_OUTPUT_PIXELS) {
      return { ok: false, code: 'output-too-large', width, height, pixels, maxPixels: limits.MAX_OUTPUT_PIXELS }
    }
    return { ok: true, width, height, pixels }
  }

  // rgba() 字符串：canvas 的 fillStyle/strokeStyle/shadowColor 都吃它。
  function rgba(color, alpha) {
    const hex = normalizeColor(color, '#000000')
    const red = parseInt(hex.slice(1, 3), 16)
    const green = parseInt(hex.slice(3, 5), 16)
    const blue = parseInt(hex.slice(5, 7), 16)
    return `rgba(${red},${green},${blue},${normalizeAlpha(alpha, 1)})`
  }

  // 两个 outputStyle 是否等价（"仅切换预览缩放不产生新版本"的判据之一：
  // 参数没变就不该写新文档）。比较归一化后的完整结构，不比较 presetId。
  function outputStyleEquals(left, right) {
    return JSON.stringify(normalizeOutputStyle(left)) === JSON.stringify(normalizeOutputStyle(right))
  }

  return {
    LIMITS,
    SHADOW_BLEED_FACTOR,
    PRESET_IDS,
    DEFAULT_OUTPUT_STYLE,
    OUTPUT_STYLE_PRESETS,
    STYLE_FIELDS,
    BACKGROUND_FIELDS,
    BORDER_FIELDS,
    SHADOW_FIELDS,
    isPlainObject,
    clamp,
    normalizeColor,
    normalizeAlpha,
    normalizeOutputStyle,
    validateOutputStyle,
    isOutputStyleEnabled,
    presetStyle,
    shadowExtents,
    planOutputComposite,
    geometryFromPlan,
    resolveOutputGeometry,
    assertOutputBudget,
    rgba,
    outputStyleEquals
  }
})
