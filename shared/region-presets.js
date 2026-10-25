// 区域复用与尺寸预设（feature B，方案 §5：docs/plans/2026-10-25-snow-apps-feature-development-plan.md）。
//
// 两件**不同类型**的东西同住 `screenshot.regionPreferences`，永远不要混用：
//   * `presets` 是**输出像素宽高**（例如 1920 x 1080）。它命名一个尺寸，不命名一个位置；
//   * `lastByMode[mode]` 是一个 LastRegion：**某个显示器上的位置 + 尺寸**，只在那个屏幕
//     仍以相同 key 或相同 DIP 边界存在时有效。
// 计划 §5.1 刻意把它们分开：预设跨显示器可复用，上次区域不能。
//
// 为什么是 shared/：主进程的 region-preferences 服务、设置归一化、以及（后续）截图/录屏
// 渲染层都要对同一份数据给出同一个解释。UMD 包装与 shared/capture-document.js 同款：
// 主进程 `require('../../shared/region-presets')`，渲染层 `<script>` 后取
// `window.regionPresets`。本文件**纯函数**：不 require Electron，不 require node:fs，
// 不读写文件，不查询屏幕。
//
// ---------------------------------------------------------------------------
// 坐标系（改之前先读完；这是本模块最容易出错的部分）
// ---------------------------------------------------------------------------
// `rectDisplayPx` 是**屏幕绝对坐标，单位是显示器的物理像素**：即抓屏位图使用的那个空间。
// 例：1920x1080 DIP、scaleFactor 2 的主屏，像素边界是 x=[0, 3840]；屏幕正中 960x540
// 的 DIP 区域对应像素矩形 {x:960, y:540, width:1920, height:1080}。
// 主屏**左侧**的第二块屏（Electron 里 bounds.x 为负）因此也是**负的像素 x** —— 这就是
// validateLastRegion 允许 rectDisplayPx.x/y 为任意负整数的原因，不是漏校验。
//
// LastRegion 同时保存 `displayBoundsDip` 与 `displayPixelSize`，所以读回时可以把存储的
// 像素矩形换回 DIP（用**存储时**的比例），与**当前**屏幕的 DIP 边界比较/裁剪，再用当前
// 比例换回像素。这样 DPI 从 200% 改成 100% 时区域不会平白缩水一半。
//
// 主进程 capture/record 域手里的 `selectionBounds` 是 DIP（Electron 窗口边界口径），
// 跨到本模块时用下面两个函数换算，不要手写除法：
//     rectDisplayPxToDip({ rect, display })    // px -> DIP
//     rectDipToDisplayPx({ rect, display })    // DIP -> px
// 两个方向都按 X / Y 分别从 displayPixelSize 与 boundsDip 求比例（计划 §5.1 要求
// "分别计算 X/Y 像素到 DIP 的映射"），所以 90° 旋转后的抓屏（像素宽高与 DIP 宽高互换）
// 不会把两个轴搞反。
//
// 已知边界（v1）：区域复用限定单显示器；不提供跨屏统一画布，也不做历史区域浏览。
//
// 错误语义（方案 §5.2）：
//   * normalizeRegionPreferences —— 读旧配置：**绝不抛错**，丢掉非法项并给诊断；
//   * assertRegionPreferencesPatch —— 设置写入路径的严格入口：非法输入**明确拒绝**，
//     **绝不悄悄改成别的尺寸**；
//   * resolve* —— 屏幕几何变化时返回 `adjusted` 原因，绝不在没做到时声称保持了原区域。

(function exposeRegionPresets(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.regionPresets = api
})(typeof globalThis === 'object' ? globalThis : window, () => {
  'use strict'

  // 方案 §3.3 的初始资源护栏："自定义尺寸预设最多 20 项，名称最多 40 字符"。
  // 像素预算沿用主进程既有的 80 MP 量级上限；集中在这里，避免三处各写一份。
  const LIMITS = Object.freeze({
    MAX_PRESETS: 20,
    MAX_NAME_LENGTH: 40,
    MIN_EDGE_PX: 16,
    MAX_EDGE_PX: 10000,
    MAX_TOTAL_PIXELS: 80000000,
    SCHEMA_VERSION: 1
  })

  const MAX_PRESET_ID_LENGTH = 64
  const MAX_DISPLAY_KEY_LENGTH = 128
  const MIN_SCALE_FACTOR = 0.5
  const MAX_SCALE_FACTOR = 8

  const REGION_MODES = Object.freeze(['capture', 'record'])
  const REGION_PREFERENCES_PATH = 'screenshot.regionPreferences'
  const PRESET_FIELDS = Object.freeze(['id', 'name', 'widthPx', 'heightPx'])
  const PREFERENCES_FIELDS = Object.freeze(['schemaVersion', 'lastByMode', 'presets'])
  const DISPLAY_FIELDS = Object.freeze(['key', 'boundsDip', 'pixelSize', 'scaleFactor'])
  const LAST_REGION_FIELDS = Object.freeze([
    'displayKey',
    'displayBoundsDip',
    'displayPixelSize',
    'rectDisplayPx',
    'capturedScaleFactor'
  ])

  // 缺省配置的**唯一**定义。设置默认值（main/services/settings-defaults.js）必须与它
  // 逐字段相同（test/settings-region-preferences.test.js 会盯住这点）；归一化返回值是
  // 每次新建的可变副本，调用方可以放心改。
  const DEFAULT_REGION_PREFERENCES = Object.freeze({
    schemaVersion: LIMITS.SCHEMA_VERSION,
    lastByMode: Object.freeze({ capture: null, record: null }),
    presets: Object.freeze([])
  })

  function createDefaultRegionPreferences() {
    return { schemaVersion: LIMITS.SCHEMA_VERSION, lastByMode: { capture: null, record: null }, presets: [] }
  }

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  }

  function unknownFields(value, allowed) {
    return Object.keys(value).filter((key) => !allowed.includes(key))
  }

  // 数字字段一律要求**真正的 number**：`Number('1920')` 会把字符串悄悄转成 1920，而方案
  // §5.2 明确要求"新 IPC 输入错误应明确拒绝，不能悄悄改成别的尺寸"。读路径同样受益：
  // 手改 store 里的 "1920" 属于非法数据，应该被丢弃并诊断，而不是被当成 1920 使用。
  function finiteNumber(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    return value
  }

  function positiveInteger(value) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null
    return value
  }

  // {x,y,width,height} -> 全部有限数字，否则 null。
  function readRect(value) {
    if (!isPlainObject(value)) return null
    const x = finiteNumber(value.x)
    const y = finiteNumber(value.y)
    const width = finiteNumber(value.width)
    const height = finiteNumber(value.height)
    if (x === null || y === null || width === null || height === null) return null
    return { x, y, width, height }
  }

  // 像素矩形必须能整数化且尺寸 >= 1：浮点矩形无法作为一个选区被复用。
  function readPixelRect(value) {
    const rect = readRect(value)
    if (!rect) return null
    if (!Number.isInteger(rect.x) || !Number.isInteger(rect.y)) return null
    if (!Number.isInteger(rect.width) || !Number.isInteger(rect.height)) return null
    if (rect.width < 1 || rect.height < 1) return null
    return rect
  }

  // 显示像素尺寸：正整数。
  function readPixelSize(value) {
    if (!isPlainObject(value)) return null
    const width = positiveInteger(value.width)
    const height = positiveInteger(value.height)
    if (width === null || height === null) return null
    return { width, height }
  }

  function readEdge(value) {
    if (typeof value !== 'number' || !Number.isInteger(value)) return null
    if (value < LIMITS.MIN_EDGE_PX || value > LIMITS.MAX_EDGE_PX) return null
    return value
  }

  function diagnostic(code, path, message) {
    return { code, path, message }
  }

  // -------------------------------------------------------------------------
  // LastRegion
  // -------------------------------------------------------------------------
  function normalizeDisplayKey(value) {
    // Electron 的 display.id 是**数字**，而计划要求 displayKey 是字符串。这里接受有限
    // 数字并转成字符串，避免接线方到处写 String(...)。
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    return value
  }

  // pure: { ok:true, value } | { ok:false, code }
  function validateLastRegion(value) {
    if (!isPlainObject(value)) return { ok: false, code: 'not-an-object' }
    const displayKey = normalizeDisplayKey(value.displayKey)
    if (typeof displayKey !== 'string' || !displayKey.trim() || displayKey.length > MAX_DISPLAY_KEY_LENGTH) {
      return { ok: false, code: 'display-key-invalid' }
    }
    const displayBoundsDip = readRect(value.displayBoundsDip)
    if (!displayBoundsDip) return { ok: false, code: 'display-bounds-invalid' }
    const displayPixelSize = readPixelSize(value.displayPixelSize)
    if (!displayPixelSize) return { ok: false, code: 'display-pixel-size-invalid' }
    const rectDisplayPx = readPixelRect(value.rectDisplayPx)
    if (!rectDisplayPx) return { ok: false, code: 'rect-invalid' }
    const capturedScaleFactor = finiteNumber(value.capturedScaleFactor)
    if (capturedScaleFactor === null || capturedScaleFactor < MIN_SCALE_FACTOR || capturedScaleFactor > MAX_SCALE_FACTOR) {
      return { ok: false, code: 'scale-factor-invalid' }
    }
    // 只回传已知字段：手改过的 store 里任何额外键都不该流到上层。
    return {
      ok: true,
      value: {
        displayKey,
        displayBoundsDip,
        displayPixelSize,
        rectDisplayPx,
        capturedScaleFactor
      }
    }
  }

  // -------------------------------------------------------------------------
  // Preset
  // -------------------------------------------------------------------------
  // strict=true 时额外拒绝未知字段（新 IPC 入口）；normalize 只是**丢弃**未知字段。
  function readPreset(value, strict = false) {
    if (!isPlainObject(value)) return { ok: false, code: 'not-an-object' }
    if (strict) {
      const unknown = unknownFields(value, PRESET_FIELDS)
      if (unknown.length) return { ok: false, code: 'unknown-field', field: unknown[0] }
    }
    const rawId = typeof value.id === 'string' ? value.id.trim() : ''
    if (!rawId || rawId.length > MAX_PRESET_ID_LENGTH) return { ok: false, code: 'id-invalid' }
    const name = typeof value.name === 'string' ? value.name.trim() : ''
    if (!name || name.length > LIMITS.MAX_NAME_LENGTH) return { ok: false, code: 'name-invalid' }
    const widthPx = readEdge(value.widthPx)
    if (widthPx === null) return { ok: false, code: 'width-invalid' }
    const heightPx = readEdge(value.heightPx)
    if (heightPx === null) return { ok: false, code: 'height-invalid' }
    if (widthPx * heightPx > LIMITS.MAX_TOTAL_PIXELS) return { ok: false, code: 'pixel-budget-exceeded' }
    return { ok: true, preset: { id: rawId, name, widthPx, heightPx } }
  }

  // -------------------------------------------------------------------------
  // 读路径归一化（绝不抛错）
  // -------------------------------------------------------------------------
  function normalizeRegionPreferences(value) {
    const diagnostics = []
    const preferences = createDefaultRegionPreferences()

    // 迁移主场景：旧 store 没有这个键（undefined）或显式 null，都是**合法缺省**。
    if (value === undefined || value === null) return { preferences, diagnostics }
    if (!isPlainObject(value)) {
      diagnostics.push(diagnostic('invalid-preferences', '', 'regionPreferences must be an object'))
      return { preferences, diagnostics }
    }

    if (Object.hasOwn(value, 'schemaVersion') && value.schemaVersion !== LIMITS.SCHEMA_VERSION) {
      // 未来版本降级读：尽量按 v1 解释已识别的字段，而不是清空用户数据；诊断让上层知道
      // 这份配置不是本版本写的。
      diagnostics.push(diagnostic(
        'unsupported-schema-version',
        'schemaVersion',
        `unsupported schemaVersion ${JSON.stringify(value.schemaVersion)}; falling back to ${LIMITS.SCHEMA_VERSION}`
      ))
    }

    const lastByMode = value.lastByMode
    if (lastByMode !== undefined && lastByMode !== null) {
      if (!isPlainObject(lastByMode)) {
        diagnostics.push(diagnostic('invalid-last-by-mode', 'lastByMode', 'lastByMode must be an object'))
      } else {
        for (const mode of REGION_MODES) {
          const raw = lastByMode[mode]
          if (raw === undefined || raw === null) continue
          const result = validateLastRegion(raw)
          if (result.ok) preferences.lastByMode[mode] = result.value
          else diagnostics.push(diagnostic('invalid-last-region', `lastByMode.${mode}`, `dropped last ${mode} region (${result.code})`))
        }
      }
    }

    if (Object.hasOwn(value, 'presets') && value.presets !== undefined && value.presets !== null) {
      if (!Array.isArray(value.presets)) {
        diagnostics.push(diagnostic('invalid-presets', 'presets', 'presets must be an array'))
      } else {
        const seenIds = new Set()
        let kept = 0
        for (let index = 0; index < value.presets.length; index += 1) {
          const path = `presets[${index}]`
          const result = readPreset(value.presets[index])
          if (!result.ok) {
            diagnostics.push(diagnostic('invalid-preset', path, `dropped preset (${result.code})`))
            continue
          }
          // 上限按**保留数量**算：前面被丢掉的非法项不会占名额。
          if (kept >= LIMITS.MAX_PRESETS) {
            diagnostics.push(diagnostic(
              'preset-limit-exceeded',
              path,
              `dropped preset: at most ${LIMITS.MAX_PRESETS} presets are stored`
            ))
            continue
          }
          if (seenIds.has(result.preset.id)) {
            diagnostics.push(diagnostic('duplicate-preset-id', path, `dropped preset with duplicate id "${result.preset.id}"`))
            continue
          }
          seenIds.add(result.preset.id)
          preferences.presets.push(result.preset)
          kept += 1
        }
      }
    }

    return { preferences, diagnostics }
  }

  // -------------------------------------------------------------------------
  // 写路径严格校验（方案 §5.2：明确拒绝，不悄悄改写）
  // -------------------------------------------------------------------------
  function assertRegionPreferencesPatch(value) {
    if (!isPlainObject(value)) {
      throw new TypeError(`${REGION_PREFERENCES_PATH} must be an object`)
    }
    const unknown = unknownFields(value, PREFERENCES_FIELDS)
    if (unknown.length) {
      throw new TypeError(`${REGION_PREFERENCES_PATH}.${unknown[0]} is not a supported field`)
    }
    if (Object.hasOwn(value, 'schemaVersion') && value.schemaVersion !== LIMITS.SCHEMA_VERSION) {
      throw new RangeError(`${REGION_PREFERENCES_PATH}.schemaVersion must be ${LIMITS.SCHEMA_VERSION}`)
    }
    if (Object.hasOwn(value, 'lastByMode')) {
      const lastByMode = value.lastByMode
      if (!isPlainObject(lastByMode)) {
        throw new TypeError(`${REGION_PREFERENCES_PATH}.lastByMode must be an object`)
      }
      for (const key of Object.keys(lastByMode)) {
        if (!REGION_MODES.includes(key)) {
          throw new TypeError(`${REGION_PREFERENCES_PATH}.lastByMode.${key} is not a supported mode`)
        }
        if (lastByMode[key] === null) continue
        const path = `${REGION_PREFERENCES_PATH}.lastByMode.${key}`
        const result = validateLastRegion(lastByMode[key])
        if (!result.ok) throw new TypeError(`${path} is invalid (${result.code})`)
        const extra = unknownFields(lastByMode[key], LAST_REGION_FIELDS)
        if (extra.length) throw new TypeError(`${path}.${extra[0]} is not a supported field`)
      }
    }
    if (Object.hasOwn(value, 'presets')) {
      const presets = value.presets
      if (!Array.isArray(presets)) {
        throw new TypeError(`${REGION_PREFERENCES_PATH}.presets must be an array`)
      }
      if (presets.length > LIMITS.MAX_PRESETS) {
        throw new RangeError(`${REGION_PREFERENCES_PATH}.presets must contain at most ${LIMITS.MAX_PRESETS} items`)
      }
      const ids = new Set()
      for (let index = 0; index < presets.length; index += 1) {
        const path = `${REGION_PREFERENCES_PATH}.presets[${index}]`
        const result = readPreset(presets[index], true)
        if (!result.ok) {
          const suffix = result.field ? `: ${result.field}` : ''
          throw new TypeError(`${path} is invalid (${result.code}${suffix})`)
        }
        if (ids.has(result.preset.id)) {
          throw new TypeError(`${path}.id duplicates "${result.preset.id}"`)
        }
        ids.add(result.preset.id)
      }
    }
    // 返回原值：调用方（settings-service）把 patch 原样深合并，本函数只负责拒绝。
    return value
  }

  // -------------------------------------------------------------------------
  // 屏幕几何换算
  // -------------------------------------------------------------------------
  // display 可以是 { key, boundsDip, pixelSize, scaleFactor } 描述符，也可以是 LastRegion
  // 本身（displayBoundsDip / displayPixelSize）；两种形状都认，调用方不必手工转换。
  function displayScale(display) {
    const source = isPlainObject(display) ? display : {}
    const boundsDip = readRect(source.boundsDip !== undefined ? source.boundsDip : source.displayBoundsDip)
    const pixelSize = readPixelSize(source.pixelSize !== undefined ? source.pixelSize : source.displayPixelSize)
    if (!boundsDip || !pixelSize) return null
    if (!(boundsDip.width > 0) || !(boundsDip.height > 0)) return null
    return {
      boundsDip,
      pixelSize,
      scaleX: pixelSize.width / boundsDip.width,
      scaleY: pixelSize.height / boundsDip.height
    }
  }

  function displayPixelBounds(display) {
    const scale = displayScale(display)
    if (!scale) return null
    return {
      x: Math.round(scale.boundsDip.x * scale.scaleX),
      y: Math.round(scale.boundsDip.y * scale.scaleY),
      width: scale.pixelSize.width,
      height: scale.pixelSize.height
    }
  }

  function rectDisplayPxToDip({ rect, display } = {}) {
    const scale = displayScale(display)
    const source = readRect(rect)
    if (!scale || !source) return null
    return {
      x: Math.round(source.x / scale.scaleX),
      y: Math.round(source.y / scale.scaleY),
      width: Math.max(1, Math.round(source.width / scale.scaleX)),
      height: Math.max(1, Math.round(source.height / scale.scaleY))
    }
  }

  function rectDipToDisplayPx({ rect, display } = {}) {
    const scale = displayScale(display)
    const source = readRect(rect)
    if (!scale || !source) return null
    // A degenerate rect must be REFUSED, not rounded up to 1x1. `Math.max(1, ...)` used to turn a
    // 0-size selection into a valid-looking one-pixel region, so an aborted drag could be remembered
    // as a real region (plan §5.1: a cancelled selection must not overwrite the record). Returning
    // null makes createLastRegionFromSelection refuse it, surfacing as 'selection-unusable'.
    if (!(source.width > 0) || !(source.height > 0)) return null
    const width = Math.round(source.width * scale.scaleX)
    const height = Math.round(source.height * scale.scaleY)
    if (!(width >= 1) || !(height >= 1)) return null
    return {
      x: Math.round(source.x * scale.scaleX),
      y: Math.round(source.y * scale.scaleY),
      width,
      height
    }
  }

  // 与屏幕边界的交集；完全落在外面时返回 null（调用方据此判定 display-changed）。
  function intersectRect(rect, bounds) {
    const x1 = Math.max(rect.x, bounds.x)
    const y1 = Math.max(rect.y, bounds.y)
    const x2 = Math.min(rect.x + rect.width, bounds.x + bounds.width)
    const y2 = Math.min(rect.y + rect.height, bounds.y + bounds.height)
    if (!(x2 - x1 >= 1) || !(y2 - y1 >= 1)) return null
    return { x: Math.round(x1), y: Math.round(y1), width: Math.round(x2 - x1), height: Math.round(y2 - y1) }
  }

  function sameRect(left, right) {
    return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
  }

  function sameBounds(left, right) {
    return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
  }

  function readDisplayDescriptor(value) {
    if (!isPlainObject(value)) return null
    const scale = displayScale(value)
    if (!scale) return null
    return {
      key: normalizeDisplayKey(value.key),
      boundsDip: scale.boundsDip,
      pixelSize: scale.pixelSize,
      scaleFactor: finiteNumber(value.scaleFactor) || scale.scaleX
    }
  }

  // -------------------------------------------------------------------------
  // 预设 -> 屏幕矩形
  // -------------------------------------------------------------------------
  // 预设是输出像素宽高；返回 rectDisplayPx 是它在**当前显示器**上的像素矩形，居中放置。
  // 超过屏幕时夹到屏幕尺寸并报 'clamped-to-screen'（附请求值与实际值），绝不假装保持了预设。
  function resolvePresetRect({ preset, displayPixelSize, displayBoundsDip } = {}) {
    const empty = { ok: false, rectDisplayPx: null, rectDip: null, appliedPixelSize: null, adjusted: [] }
    const checked = isPlainObject(preset) ? readPreset(preset) : { ok: false, code: 'invalid-preset' }
    if (!checked.ok) return { ...empty, code: checked.code || 'invalid-preset' }
    const pixelSize = readPixelSize(displayPixelSize)
    const boundsDip = readRect(displayBoundsDip)
    if (!pixelSize || !boundsDip || !(boundsDip.width > 0) || !(boundsDip.height > 0)) {
      return { ...empty, code: 'invalid-display' }
    }
    const appliedWidthPx = Math.max(1, Math.min(checked.preset.widthPx, pixelSize.width))
    const appliedHeightPx = Math.max(1, Math.min(checked.preset.heightPx, pixelSize.height))
    const adjusted = []
    if (appliedWidthPx !== checked.preset.widthPx || appliedHeightPx !== checked.preset.heightPx) {
      adjusted.push({
        code: 'clamped-to-screen',
        requestedPixelSize: { width: checked.preset.widthPx, height: checked.preset.heightPx },
        appliedPixelSize: { width: appliedWidthPx, height: appliedHeightPx }
      })
    }

    // 先在 DIP 空间算（居中语义在 DIP 里对用户可见），再按比例换回像素。
    // 两个方向的换算**只走** rectDisplayPxToDip / rectDipToDisplayPx（与
    // resolveLastRegion、createLastRegionFromSelection 同一份逐轴映射），这里不重写
    // 一遍乘除法 —— 两处公式迟早漂移，而漂移的表现是"预设正确、上次区域偏几个像素"。
    const descriptor = { boundsDip, pixelSize }
    const dipSize = rectDisplayPxToDip({
      rect: { x: 0, y: 0, width: appliedWidthPx, height: appliedHeightPx },
      display: descriptor
    })
    const rectDip = {
      x: Math.round(boundsDip.x + (boundsDip.width - dipSize.width) / 2),
      y: Math.round(boundsDip.y + (boundsDip.height - dipSize.height) / 2),
      width: dipSize.width,
      height: dipSize.height
    }
    const rectDisplayPx = rectDipToDisplayPx({ rect: rectDip, display: descriptor })
    return { ok: true, rectDisplayPx, rectDip, appliedPixelSize: { width: appliedWidthPx, height: appliedHeightPx }, adjusted }
  }

  // -------------------------------------------------------------------------
  // 上次区域 -> 当前屏幕矩形
  // -------------------------------------------------------------------------
  // 先按 displayKey 匹配，再按完全相同的 boundsDip 匹配（计划：displayKey 只是线索，
  // 不假定系统显示器 ID 跨重启稳定）。匹配不到返回 ok:false + 'display-changed'，
  // 让调用方把区域居中放到当前屏幕，而不是猜一个可能完全错误的位置。
  function resolveLastRegion({ lastRegion, displays } = {}) {
    const empty = { ok: false, rectDisplayPx: null, rectDip: null, displayKey: null, adjusted: [] }
    const checked = validateLastRegion(lastRegion)
    if (!checked.ok) return { ...empty, code: 'invalid-last-region' }
    const stored = checked.value
    const candidates = (Array.isArray(displays) ? displays : [])
      .map(readDisplayDescriptor)
      .filter(Boolean)
    let display = candidates.find((candidate) => candidate.key === stored.displayKey)
    if (!display) display = candidates.find((candidate) => sameBounds(candidate.boundsDip, stored.displayBoundsDip))
    if (!display) return { ...empty, code: 'display-changed' }

    const adjusted = []
    if (
      display.pixelSize.width !== stored.displayPixelSize.width ||
      display.pixelSize.height !== stored.displayPixelSize.height
    ) {
      adjusted.push({
        code: 'display-pixel-size-changed',
        from: { width: stored.displayPixelSize.width, height: stored.displayPixelSize.height },
        to: { width: display.pixelSize.width, height: display.pixelSize.height }
      })
    }

    // 存储的像素矩形用**存储时**的比例换回 DIP，再与**当前** DIP 边界裁剪：这样 DPI
    // 改变（200% -> 100%）不会让同一块物理区域平白缩水。
    const storedDip = rectDisplayPxToDip({ rect: stored.rectDisplayPx, display: stored })
    if (!storedDip) return { ...empty, code: 'display-changed' }
    const clippedDip = intersectRect(storedDip, display.boundsDip)
    if (!clippedDip) return { ...empty, code: 'display-changed' }
    if (!sameRect(clippedDip, storedDip)) {
      adjusted.push({
        code: 'rect-outside-display',
        storedRectDisplayPx: stored.rectDisplayPx,
        clippedRectDisplayPx: rectDipToDisplayPx({ rect: clippedDip, display })
      })
    }
    const rectDip = clippedDip
    const rectDisplayPx = rectDipToDisplayPx({ rect: rectDip, display })
    return { ok: true, rectDisplayPx, rectDip, displayKey: display.key, adjusted }
  }

  // -------------------------------------------------------------------------
  // 选区 -> LastRegion（由主进程根据**已确认**区域构建；渲染层不得提交）
  // -------------------------------------------------------------------------
  // selection 默认按像素矩形解释（space:'displayPx'）。主进程 capture/record 手里的
  // selectionBounds 是 DIP —— 那种调用方必须传 space:'dip'，本函数会换算。
  // 返回 null 表示这份数据不足以记成"上次区域"（非有限、尺寸 < 1 px 等），调用方应静默
  // 跳过记录，而不是存一条坏数据。
  function createLastRegionFromSelection({ selection, display, space = 'displayPx' } = {}) {
    if (!isPlainObject(selection) || !isPlainObject(display)) return null
    const scale = displayScale(display)
    if (!scale) return null
    const source = readRect(selection)
    if (!source) return null
    let rect
    if (space === 'dip') {
      // **只走** rectDipToDisplayPx：与 resolvePresetRect / resolveLastRegion 同一份逐轴
      // 映射。这里再手写一遍乘法，就会多出第三个"公式"，DPI 一变就与另两处漂移。
      rect = rectDipToDisplayPx({ rect: source, display: { boundsDip: scale.boundsDip, pixelSize: scale.pixelSize } })
      if (!rect) return null
    } else if (space === 'displayPx') {
      rect = {
        x: Math.round(source.x),
        y: Math.round(source.y),
        width: Math.round(source.width),
        height: Math.round(source.height)
      }
    } else {
      return null
    }
    if (!Number.isInteger(rect.x) || !Number.isInteger(rect.y)) return null
    if (!(rect.width >= 1) || !(rect.height >= 1)) return null
    const candidate = {
      displayKey: normalizeDisplayKey(display.key),
      displayBoundsDip: scale.boundsDip,
      displayPixelSize: scale.pixelSize,
      rectDisplayPx: rect,
      capturedScaleFactor: finiteNumber(display.scaleFactor) || scale.scaleX
    }
    const checked = validateLastRegion(candidate)
    return checked.ok ? checked.value : null
  }

  return {
    LIMITS,
    REGION_MODES,
    REGION_PREFERENCES_PATH,
    DEFAULT_REGION_PREFERENCES,
    createDefaultRegionPreferences,
    normalizeRegionPreferences,
    validateLastRegion,
    assertRegionPreferencesPatch,
    displayPixelBounds,
    rectDisplayPxToDip,
    rectDipToDisplayPx,
    resolvePresetRect,
    resolveLastRegion,
    createLastRegionFromSelection
  }
})
