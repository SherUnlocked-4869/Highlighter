// 可编辑截图文档（editable capture document）的共享契约层。
//
// 设计基线：docs/plans/2026-10-25-history-reedit-redesign.md §6.2.1（坐标与像素契约）、
// §6.5.1（身份与版本）、§6.5.3（文档格式与载入校验）、§6.5.5（多文件发布）。
//
// 为什么是 shared/：主进程（历史服务、提交校验）与渲染层（捕获编辑器）必须对同一份
// 文档给出**同一个**解释 —— 归一化、校验、内容指纹、视口正逆变换都只在这里定义一次。
// 与 shared/cursor-geometry.js 同款 UMD 双端暴露，但没有构建步骤：渲染层靠
// `<script src="../shared/capture-document.js">` 拿到 `window.captureDocument`。
//
// ---------------------------------------------------------------------------
// 坐标系（本方案最容易出错的地方，改之前先读完）
// ---------------------------------------------------------------------------
//   源像素（source pixel）= 底图物理像素。这是**文档坐标单位**，也是唯一写进 JSON 的单位。
//     crop、所有标注的 x/y/x2/y2/points、笔宽、字号、圆角、序号半径、马赛克单元尺寸等
//     **一切有长度含义的字段**都用它。颜色/透明度等无量纲属性不缩放。
//
//   视口 CSS（viewport css）= 编辑器窗口内的 CSS 像素，只用于显示与命中，
//     **绝不落盘**。映射（§6.2.1 原式）：
//       cssX = offsetX + (sourceX - crop.x) * zoom
//       cssY = offsetY + (sourceY - crop.y) * zoom
//     zoom 是"源像素 → CSS 像素"的比例（含 fit 与用户缩放），offset 含居中与平移。
//     输入与命中用同一个变换的逆；DPR 只影响 canvas backing store，不乘进文档数据。
//
//   导出像素（export pixel）= 结果图坐标，只换算一次：
//       outX = sourceX - crop.x
//       outY = sourceY - crop.y
//     导出尺寸等于 crop 的整数像素宽高，不因窗口缩小、DPI 或 view.zoom 重采样。
//
//   禁止：先减 crop 再在导出时减第二次；把窗口 CSS 坐标原样写盘（annotation-geometry.js
//   里的数是屏幕 CSS 坐标，不能直接落盘）；resize/DPI/view 变化时重置 crop 或重写对象坐标。
//
// ---------------------------------------------------------------------------
// 内容指纹（决定 dirty 与"无变化保存不增版"）
// ---------------------------------------------------------------------------
//   只覆盖**影响产物**的内容：底图引用与内容哈希、crop、标注（按 z 序）、捕获附件、
//   捕获元数据。刻意排除：documentId / revisionId / parentRevisionId / createdAt /
//   view / source —— 它们改不了像素。标注的 `id` 也排除：它是会话内身份，重开一次文档
//   会重新编号，若把它算进指纹，每次重开都会假 dirty。
//   实现是纯 JS 的 FNV-1a 双累加器（64 位十六进制），两端可算且不依赖 node:crypto。
;(function exposeCaptureDocument(root, factory) {
  // Feature C (§6.2): schema v2 adds `outputStyle`, whose geometry lives in its own shared
  // module. Both ends load/render the same way, so the dependency resolves the same way in
  // both: CommonJS require under node, the `<script>`-installed global in a window. Loading it
  // is not optional - v2 cannot validate or fingerprint a document without it - but a missing
  // module must fail loudly at load time rather than silently validating every style as empty.
  const outputStyleApi = (typeof module === 'object' && module.exports)
    ? require('./capture-output-style.js')
    : (root ? root.captureOutputStyle : null)
  // Feature D (§7.1/§7.3): the magnifier annotation is a nested object model (source rect +
  // lens origin + derived size). Its geometry lives in the same shared layer for the same
  // reason as the output style: the main process must validate and fingerprint it without
  // loading renderer code.
  const magnifierApi = (typeof module === 'object' && module.exports)
    ? require('./magnifier-geometry.js')
    : (root ? root.magnifierGeometry : null)
  // Feature D (§7.2): the safe-sampling plan is expressed in source pixels by this module, so
  // the renderer's sample compositor and any main-process consumer agree on what gets masked.
  const occlusionApi = (typeof module === 'object' && module.exports)
    ? require('./occlusion-mask.js')
    : (root ? root.occlusionMask : null)
  const api = factory(outputStyleApi, magnifierApi, occlusionApi)
  if (typeof module === 'object' && module.exports) module.exports = api
  else if (root) root.captureDocument = api
})(typeof globalThis === 'object' ? globalThis : typeof window === 'object' ? window : this, (outputStyleApi, magnifierApi, occlusionApi) => {
  'use strict'

  if (!outputStyleApi) throw new Error('capture-document requires shared/capture-output-style.js')
  if (!magnifierApi) throw new Error('capture-document requires shared/magnifier-geometry.js')
  if (!occlusionApi) throw new Error('capture-document requires shared/occlusion-mask.js')

  // Schema history:
  //   v1 - the first editable format (batch 1).
  //   v2 - feature C §6.2: content carries `outputStyle`.
  //   v3 - feature D §7.3: the annotation whitelist gains `magnifier` (a nested object).
  // Each step has a registered migration; a v1 document is upgraded by chaining 1 -> 2 -> 3,
  // and `normalizeDocument` is the single shape every version lands on.
  const SCHEMA_VERSION = 3
  const COORDINATE_SPACE = 'source-pixel'
  // §6.5.3：doc UTF-8 硬上限 16 MiB，且在 JSON.parse **之前**按字节限制。
  const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024
  // 载荷预算：单条与总点数。上限与 capture/annotation-geometry.js 的 MAX_PEN_POINTS 同源
  // （10000/条），总量给 20 万点（设计文档 §6.3 U2 的初值）。
  const MAX_POINTS_PER_ANNOTATION = 10000
  const MAX_TOTAL_POINTS = 200000
  const MAX_ANNOTATIONS = 5000
  // 资源 id 的形状：主进程用 createId() 生成（时间戳-随机），渲染层不得指定路径。
  const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

  // 标注类型的白名单（与 capture/capture.html 的工具同源）。未知类型必须被拒绝，
  // 否则"未来版本写的对象"会被当成已知对象画错而不是显式报损坏。
  // v3 (feature D §7.3): `magnifier` joins the whitelist. It is the first type whose geometry
  // is NESTED (sourceRect + lensOrigin), which is why the flat LENGTH_FIELDS walk below does not
  // apply to it - see normalizeAnnotation/validateDocument.
  const ANNOTATION_TYPES = Object.freeze([
    'rect', 'ellipse', 'arrow', 'line', 'pen', 'highlight', 'blur', 'text', 'serial', 'watermark',
    'magnifier'
  ])
  // 有长度含义、必须按源像素理解的字段（§6.2.1：不能只转换端点而漏掉样式几何）。
  const LENGTH_FIELDS = Object.freeze(['x', 'y', 'x2', 'y2', 'w', 'h', 'width', 'radius', 'fontSize'])
  const OPTIONAL_NUMBER_FIELDS = Object.freeze(['x2', 'y2', 'w', 'h', 'radius', 'fontSize', 'number'])
  // Feature D (§3.3): a document may hold at most this many magnifiers. Enforced by validation
  // and by the renderer's tool, so neither end can exceed it by accident.
  const MAX_MAGNIFIERS = magnifierApi.MAX_PER_DOCUMENT
  const ENUM_FIELDS = Object.freeze({
    fill: Object.freeze(['none', 'translucent', 'solid']),
    dash: Object.freeze(['solid', 'dashed', 'dotted']),
    alpha: Object.freeze(['light', 'medium', 'strong']),
    blurGeometry: Object.freeze(['rect', 'stroke'])
  })
  const HEX_COLOR = /^#[0-9a-fA-F]{6}$/
  // 文档顶层白名单。任何未列出的键在归一化时被丢弃（而不是透传），避免渲染层
  // 用未知字段做侧信道。
  const DOCUMENT_FIELDS = Object.freeze([
    'schemaVersion', 'coordinateSpace', 'documentId', 'revisionId', 'parentRevisionId',
    'baseImage', 'crop', 'annotations', 'captureAttachments', 'captureMetadata',
    'view', 'source', 'createdAt', 'derivedFrom',
    // v2 (feature C §6.2): the output style is CONTENT - it changes the produced pixels.
    'outputStyle'
  ])
  // 内容指纹覆盖的字段（顺序即序列化顺序，改顺序等于改指纹 → 全量历史假 dirty）。
  // `outputStyle` 是 v2 的**内容**字段：参数变化必须产生新版本（§6.3 "参数变化纳入内容指纹"），
  // 位置追加在末尾而不是插到中间 —— 追加只让 v2 文档的指纹与 v1 不同，v1 文档经迁移后
  // 也算出了一模一样的 v2 指纹，所以"打开 v1 不 dirty"仍然成立（迁移链的唯一输出形态是 v2）。
  const CONTENT_FIELDS = Object.freeze([
    'schemaVersion', 'coordinateSpace', 'baseImage', 'crop', 'annotations',
    'captureAttachments', 'captureMetadata', 'outputStyle'
  ])

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value)
  }

  // 严格数值解析：`Number(null) === 0` 会让"缺失坐标"静默变成原点，把一个标注悄悄搬到
  // 左上角。所以 null/undefined/''/布尔一律走 fallback，而不是被当成 0。
  function finiteOr(value, fallback) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return fallback
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value))
  }

  function positiveInteger(value, fallback) {
    const parsed = Math.round(Number(value))
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  }

  function normalizeColor(value) {
    const text = typeof value === 'string' ? value.trim() : ''
    return HEX_COLOR.test(text) ? text.toLowerCase() : '#ff3b30'
  }

  function normalizeEnum(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback
  }

  // ---------- 尺寸与 crop ----------

  // 底图尺寸：源像素整数。缺失/非法时按 1×1，调用方会把它当"损坏"处理。
  function normalizeBaseSize(value) {
    const source = isPlainObject(value) ? value : {}
    return {
      width: positiveInteger(source.width, 1),
      height: positiveInteger(source.height, 1)
    }
  }

  // crop 是**底图源像素坐标里的整数矩形**，且必须完整落在底图内（§6.2.1：
  // "crop 确认时统一取整并钳制在底图范围内；对象坐标保留精度，仅裁剪边界取整"）。
  // 缺省 crop = 整张底图。返回的永远是合法矩形：宽高 ≥1、不越界。
  function normalizeCrop(value, baseSize) {
    const base = normalizeBaseSize(baseSize)
    const source = isPlainObject(value) ? value : {}
    const width = clamp(positiveInteger(source.w ?? source.width, base.width), 1, base.width)
    const height = clamp(positiveInteger(source.h ?? source.height, base.height), 1, base.height)
    const left = clamp(Math.round(finiteOr(source.x, 0)), 0, base.width - width)
    const top = clamp(Math.round(finiteOr(source.y, 0)), 0, base.height - height)
    return { x: left, y: top, w: width, h: height }
  }

  // ---------- 视口正逆变换（§6.2.1） ----------

  // 把 {crop, zoom, offsetX, offsetY} 收成一个视口对象，变换与逆变换都只认它。
  function resolveViewport(input) {
    const source = isPlainObject(input) ? input : {}
    const baseSize = normalizeBaseSize(source.baseSize || source.baseImage)
    return {
      crop: normalizeCrop(source.crop, baseSize),
      baseSize,
      zoom: Math.max(1e-6, finiteOr(source.zoom, 1)),
      offsetX: finiteOr(source.offsetX, 0),
      offsetY: finiteOr(source.offsetY, 0)
    }
  }

  // fit 视口：把 crop 最大比例装进 bounds 并居中。zoom 是"源像素 → CSS 像素"的比例，
  // 所以不放大（zoom ≤ 1）时图片按原始像素显示，这是编辑器首帧的预期。
  // allowUpscale 给"小图也想铺满"的调用方留口，默认关。
  function fitViewport(options) {
    const source = isPlainObject(options) ? options : {}
    const baseSize = normalizeBaseSize(source.baseSize || source.baseImage)
    const crop = normalizeCrop(source.crop, baseSize)
    const bounds = isPlainObject(source.bounds) ? source.bounds : {}
    const width = Math.max(1, finiteOr(bounds.width ?? bounds.w, crop.w))
    const height = Math.max(1, finiteOr(bounds.height ?? bounds.h, crop.h))
    const allowUpscale = source.allowUpscale === true
    const fit = Math.min(width / crop.w, height / crop.h)
    const zoom = allowUpscale ? fit : Math.min(1, fit)
    return resolveViewport({
      baseSize,
      crop,
      zoom,
      offsetX: (width - crop.w * zoom) / 2,
      offsetY: (height - crop.h * zoom) / 2
    })
  }

  // 源像素 → 视口 CSS 像素。
  function sourceToViewport(point, viewport) {
    const view = resolveViewport(viewport)
    const x = finiteOr(point?.x, Number.NaN)
    const y = finiteOr(point?.y, Number.NaN)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: Number.NaN, y: Number.NaN }
    return {
      x: view.offsetX + (x - view.crop.x) * view.zoom,
      y: view.offsetY + (y - view.crop.y) * view.zoom
    }
  }

  // 视口 CSS 像素 → 源像素（输入与命中用的逆变换，与 sourceToViewport 严格互逆）。
  function viewportToSource(point, viewport) {
    const view = resolveViewport(viewport)
    const x = finiteOr(point?.x, Number.NaN)
    const y = finiteOr(point?.y, Number.NaN)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: Number.NaN, y: Number.NaN }
    return {
      x: view.crop.x + (x - view.offsetX) / view.zoom,
      y: view.crop.y + (y - view.offsetY) / view.zoom
    }
  }

  // 源像素矩形 → 导出像素矩形（只减一次 crop 原点，不缩放、不重采样）。
  function sourceRectToExport(rect, crop) {
    const source = isPlainObject(rect) ? rect : {}
    const region = isPlainObject(crop) ? crop : {}
    const x = finiteOr(region.x, 0)
    const y = finiteOr(region.y, 0)
    return {
      x: finiteOr(source.x, 0) - x,
      y: finiteOr(source.y, 0) - y,
      w: Math.max(0, finiteOr(source.w ?? source.width, 0)),
      h: Math.max(0, finiteOr(source.h ?? source.height, 0))
    }
  }

  // 导出用的一次性矩阵：把源像素映射到结果图坐标，同时给出标量缩放。
  // scaleX/scaleY 供画标注时复用（与 exportSelectionCanvas 的 scaleX/scaleY 同义，
  // 但那里是从窗口 CSS 到导出像素；这里是源像素到导出像素，恒为 1）。
  // 保留这个函数是为了让"导出只换算一次"有一个可断言的出口。
  function resolveExportTransform(crop) {
    const region = isPlainObject(crop) ? crop : {}
    return {
      offsetX: -finiteOr(region.x, 0),
      offsetY: -finiteOr(region.y, 0),
      scaleX: 1,
      scaleY: 1,
      width: Math.max(1, Math.round(finiteOr(region.w, 1))),
      height: Math.max(1, Math.round(finiteOr(region.h, 1)))
    }
  }

  // ---------- 标注归一化与校验 ----------

  function normalizePoints(value, limit) {
    if (!Array.isArray(value)) return null
    const cap = Math.max(1, Math.min(MAX_POINTS_PER_ANNOTATION, positiveInteger(limit, MAX_POINTS_PER_ANNOTATION)))
    const points = []
    for (const entry of value.slice(0, cap)) {
      const x = finiteOr(entry?.x, Number.NaN)
      const y = finiteOr(entry?.y, Number.NaN)
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      points.push({ x, y })
    }
    return points
  }

  // 单个标注：白名单字段 + 类型化数值。所有长度字段保持源像素（§6.2.1），
  // 不做任何缩放；未知字段丢弃。返回 null 表示"这条根本无法解释"。
  function normalizeAnnotation(value, options) {
    if (!isPlainObject(value)) return null
    const type = value.type
    if (!ANNOTATION_TYPES.includes(type)) return null
    // Feature D (§7.1): a magnifier's geometry is nested and its lens size is DERIVED from
    // sourceRect x factor, so the flat walk below would (a) invent x/y from x2/y2 defaults and
    // (b) create exactly the "contradictory persisted lens size" the plan forbids. It therefore
    // normalizes through its own module and keeps only the session-scoped `id` alongside.
    if (type === 'magnifier') {
      const magnifier = magnifierApi.normalizeMagnifier(value)
      return value.id !== undefined && value.id !== null && value.id !== ''
        ? Object.assign({}, magnifier, { id: String(value.id).slice(0, 128) })
        : magnifier
    }
    const settings = isPlainObject(options) ? options : {}
    const annotation = { type }
    // id 是会话内身份（不进内容指纹），但持久化时留一个稳定字符串便于排查。
    if (value.id !== undefined && value.id !== null && value.id !== '') {
      annotation.id = String(value.id).slice(0, 128)
    }
    annotation.color = normalizeColor(value.color)
    annotation.width = Math.max(1, finiteOr(value.width, 4))
    for (const field of OPTIONAL_NUMBER_FIELDS) {
      if (value[field] === undefined || value[field] === null) continue
      const parsed = Number(value[field])
      if (Number.isFinite(parsed)) annotation[field] = parsed
    }
    // 几何主字段：所有类型都有 x/y（watermark 还带 w/h）。
    annotation.x = finiteOr(value.x, 0)
    annotation.y = finiteOr(value.y, 0)
    if (value.text !== undefined) annotation.text = String(value.text).slice(0, 2000)
    if (value.bold === true) annotation.bold = true
    if (value.startHead === true) annotation.startHead = true
    if (value.endHead === false) annotation.endHead = false
    for (const field of Object.keys(ENUM_FIELDS)) {
      if (value[field] === undefined) continue
      annotation[field] = normalizeEnum(value[field], ENUM_FIELDS[field], field === 'fill' ? 'none' : field === 'dash' ? 'solid' : field === 'alpha' ? 'medium' : 'rect')
    }
    // 点集：只有真正带点集的对象才有（blur 的矩形/笔刷两种几何靠它显式区分，§6.1 A6）。
    if (Array.isArray(value.points)) {
      const points = normalizePoints(value.points, settings.maxPointsPerAnnotation)
      // 点集被整体拒绝（全是非法点）时宁可丢弃对象也不留一个坏对象。
      if (points && points.length) annotation.points = points
    }
    const maxPoints = positiveInteger(settings.maxPointsPerAnnotation, MAX_POINTS_PER_ANNOTATION)
    if (annotation.points && annotation.points.length > maxPoints) annotation.points.length = maxPoints
    return annotation
  }

  // ---------- 文档归一化 / 校验 ----------

  // 归一化：宽容地接收渲染层/磁盘来的对象，产出**唯一一种**可写盘的形状。
  // 与校验不同，归一化会尽力修复（缺 crop → 全图、缺 baseImage → 1×1），
  // 因为它的用途是"把内存态转成待提交的文档"。
  function normalizeDocument(value) {
    const source = isPlainObject(value) ? value : {}
    const baseImage = normalizeBaseImage(source.baseImage)
    const baseSize = { width: baseImage.width, height: baseImage.height }
    const rawAnnotations = Array.isArray(source.annotations) ? source.annotations : []
    const annotations = []
    let totalPoints = 0
    for (const entry of rawAnnotations.slice(0, MAX_ANNOTATIONS)) {
      const annotation = normalizeAnnotation(entry)
      if (!annotation) continue
      if (annotation.points) {
        totalPoints += annotation.points.length
        if (totalPoints > MAX_TOTAL_POINTS) break
      }
      annotations.push(annotation)
    }
    const view = isPlainObject(source.view) ? source.view : null
    return {
      schemaVersion: SCHEMA_VERSION,
      coordinateSpace: COORDINATE_SPACE,
      documentId: normalizeResourceId(source.documentId, ''),
      revisionId: normalizeResourceId(source.revisionId, ''),
      parentRevisionId: source.parentRevisionId ? normalizeResourceId(source.parentRevisionId, '') || null : null,
      baseImage,
      crop: normalizeCrop(source.crop, baseSize),
      annotations,
      captureAttachments: normalizeAttachments(source.captureAttachments),
      captureMetadata: normalizeCaptureMetadata(source.captureMetadata),
      // v2 (feature C §6.2): always present, always the full normalized shape. A v1 document
      // arrives here with no style and gets the disabled default, which is exactly what the
      // migration would have added - one normalization, two entry points (§6.3 "服务端和渲染器
      // 必须用同一归一化版本计算 clean 指纹").
      outputStyle: outputStyleApi.normalizeOutputStyle(source.outputStyle),
      // view 只表达"基于 fit 的缩放偏好与源像素中心"，不参与内容指纹（§6.5.3）。
      view: view
        ? {
            zoomMultiplier: Math.max(0.01, finiteOr(view.zoomMultiplier, 1)),
            centerX: finiteOr(view.centerX, baseSize.width / 2),
            centerY: finiteOr(view.centerY, baseSize.height / 2)
          }
        : { zoomMultiplier: 1, centerX: baseSize.width / 2, centerY: baseSize.height / 2 },
      source: String(source.source || 'region').slice(0, 64),
      createdAt: Math.max(0, Math.round(finiteOr(source.createdAt, 0))),
      // 另存来源（§6.5.1）：只在"另存为新记录"的首版存在，只记录来源、不参与分组。
      // 它不影响产物，所以**不**在 CONTENT_FIELDS 里（不参与内容指纹）。
      ...(isPlainObject(source.derivedFrom) && RESOURCE_ID_PATTERN.test(String(source.derivedFrom.documentId || ''))
        ? {
            derivedFrom: {
              documentId: String(source.derivedFrom.documentId),
              revisionId: normalizeResourceId(source.derivedFrom.revisionId, '')
            }
          }
        : {})
    }
  }

  function normalizeResourceId(value, fallback) {
    const text = typeof value === 'string' ? value.trim() : ''
    return RESOURCE_ID_PATTERN.test(text) ? text : fallback
  }

  function normalizeBaseImage(value) {
    const source = isPlainObject(value) ? value : {}
    const size = normalizeBaseSize(source)
    const baseImage = {
      assetId: normalizeResourceId(source.assetId, ''),
      width: size.width,
      height: size.height
    }
    // 内容哈希由主进程在写入底图时算好并随文档带上（§6.5.3 内容指纹要求）。
    if (typeof source.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(source.sha256)) {
      baseImage.sha256 = source.sha256.toLowerCase()
    }
    return baseImage
  }

  function normalizeAttachments(value) {
    const source = isPlainObject(value) ? value : {}
    const attachments = {}
    // cursor 是唯一已定义的附件：位图资源 id + 源像素位置/热点/尺寸（§6.2.1）。
    if (isPlainObject(source.cursor)) {
      const cursor = source.cursor
      const hotspot = isPlainObject(cursor.hotspot) ? cursor.hotspot : {}
      attachments.cursor = {
        assetId: normalizeResourceId(cursor.assetId, ''),
        x: finiteOr(cursor.x, 0),
        y: finiteOr(cursor.y, 0),
        width: Math.max(1, finiteOr(cursor.width, 1)),
        height: Math.max(1, finiteOr(cursor.height, 1)),
        hotspot: { x: finiteOr(hotspot.x, 0), y: finiteOr(hotspot.y, 0) }
      }
    } else {
      attachments.cursor = null
    }
    return attachments
  }

  function normalizeCaptureMetadata(value) {
    const source = isPlainObject(value) ? value : {}
    // 捕获 DPI 单独保存（§6.2.1）：缺失的旧图默认 1，视口 fit/zoom 不得覆写它。
    return {
      sourceScaleFactor: Math.max(0.01, finiteOr(source.sourceScaleFactor, 1)),
      longCapture: source.longCapture === true
    }
  }

  // 完整 schema 校验：**只读**，不修复。任何不合法都进 errors，由调用方决定
  // 返回错误码还是走损坏降级（§6.5.7）。
  function validateDocument(value, options) {
    const settings = isPlainObject(options) ? options : {}
    const errors = []
    const push = (code, path, message) => errors.push({ code, path, message })
    if (!isPlainObject(value)) {
      push('not-an-object', '', '文档必须是对象')
      return { ok: false, errors }
    }
    if (value.schemaVersion !== SCHEMA_VERSION) {
      push('unsupported-schema', 'schemaVersion', `不支持的文档版本：${String(value.schemaVersion)}`)
      return { ok: false, errors }
    }
    if (value.coordinateSpace !== COORDINATE_SPACE) {
      push('bad-coordinate-space', 'coordinateSpace', `坐标空间必须是 ${COORDINATE_SPACE}`)
    }
    for (const field of Object.keys(value)) {
      if (!DOCUMENT_FIELDS.includes(field)) push('unknown-field', field, `未知字段：${field}`)
    }
    const baseImage = value.baseImage
    if (!isPlainObject(baseImage)) {
      push('missing-base-image', 'baseImage', '缺少 baseImage')
    } else {
      if (!RESOURCE_ID_PATTERN.test(String(baseImage.assetId || ''))) push('bad-asset-id', 'baseImage.assetId', '底图资源 id 非法')
      const width = Number(baseImage.width)
      const height = Number(baseImage.height)
      if (!Number.isInteger(width) || width <= 0) push('bad-base-size', 'baseImage.width', '底图宽度必须是正整数')
      if (!Number.isInteger(height) || height <= 0) push('bad-base-size', 'baseImage.height', '底图高度必须是正整数')
      if (settings.expectedBaseWidth && width !== Number(settings.expectedBaseWidth)) {
        push('base-size-mismatch', 'baseImage.width', '底图宽度与实际图片不一致')
      }
      if (settings.expectedBaseHeight && height !== Number(settings.expectedBaseHeight)) {
        push('base-size-mismatch', 'baseImage.height', '底图高度与实际图片不一致')
      }
    }
    const crop = value.crop
    if (!isPlainObject(crop)) {
      push('missing-crop', 'crop', '缺少 crop')
    } else {
      const numbers = ['x', 'y', 'w', 'h'].map((key) => Number(crop[key]))
      if (!numbers.every(Number.isFinite)) push('bad-crop', 'crop', 'crop 必须是有限数值')
      else if (!numbers.every(Number.isInteger)) push('fractional-crop', 'crop', 'crop 必须是整数像素')
      else {
        const [x, y, w, h] = numbers
        if (w < 1 || h < 1) push('bad-crop', 'crop', 'crop 宽高必须 ≥1')
        const base = isPlainObject(baseImage) ? baseImage : {}
        if (Number.isFinite(Number(base.width)) && (x < 0 || x + w > Number(base.width))) push('crop-out-of-bounds', 'crop', 'crop 超出底图宽度')
        if (Number.isFinite(Number(base.height)) && (y < 0 || y + h > Number(base.height))) push('crop-out-of-bounds', 'crop', 'crop 超出底图高度')
      }
    }
    if (!Array.isArray(value.annotations)) {
      push('missing-annotations', 'annotations', 'annotations 必须是数组')
    } else {
      if (value.annotations.length > MAX_ANNOTATIONS) push('too-many-annotations', 'annotations', `标注数量超过 ${MAX_ANNOTATIONS}`)
      let totalPoints = 0
      let magnifierCount = 0
      value.annotations.forEach((entry, index) => {
        if (!isPlainObject(entry)) {
          push('bad-annotation', `annotations[${index}]`, '标注必须是对象')
          return
        }
        if (!ANNOTATION_TYPES.includes(entry.type)) {
          push('unknown-annotation-type', `annotations[${index}].type`, `未知标注类型：${String(entry.type)}`)
        }
        // Feature D (§7.3): the magnifier has its own validator (nested geometry, discrete
        // factors, source-rect edges) and its own per-document budget. It is validated BEFORE
        // the flat checks and returns, because those checks assume the flat x/y shape.
        if (entry.type === 'magnifier') {
          magnifierCount += 1
          const report = magnifierApi.validateMagnifier(entry)
          for (const issue of report.errors) {
            push(issue.code, `annotations[${index}].${issue.path.replace(/^magnifier\./, '')}`, issue.message)
          }
          // §7.1: the source rect must lie inside the CURRENT crop. Checked here rather than in
          // the magnifier module because only the document knows the crop.
          if (isPlainObject(entry.sourceRect) && isPlainObject(crop) && Number(crop.w) > 0) {
            const source = entry.sourceRect
            const outside = Number(source.x) < Number(crop.x) ||
              Number(source.y) < Number(crop.y) ||
              Number(source.x) + Number(source.w) > Number(crop.x) + Number(crop.w) ||
              Number(source.y) + Number(source.h) > Number(crop.y) + Number(crop.h)
            if (outside && [source.x, source.y, source.w, source.h].every((v) => Number.isFinite(Number(v)))) {
              push('source-outside-crop', `annotations[${index}].sourceRect`, '源区必须落在当前裁剪区域内')
            }
          }
          return
        }
        for (const field of LENGTH_FIELDS) {
          if (entry[field] === undefined) continue
          if (!Number.isFinite(Number(entry[field]))) push('bad-length', `annotations[${index}].${field}`, `${field} 必须是有限数值`)
        }
        if (!Number.isFinite(Number(entry.x)) || !Number.isFinite(Number(entry.y))) {
          push('bad-position', `annotations[${index}]`, '标注必须带有限的 x/y')
        }
        if (entry.points !== undefined) {
          if (!Array.isArray(entry.points)) {
            push('bad-points', `annotations[${index}].points`, 'points 必须是数组')
            return
          }
          if (entry.points.length > MAX_POINTS_PER_ANNOTATION) {
            push('too-many-points', `annotations[${index}].points`, `单条标注点数超过 ${MAX_POINTS_PER_ANNOTATION}`)
          }
          totalPoints += entry.points.length
          for (const point of entry.points) {
            if (!Number.isFinite(Number(point?.x)) || !Number.isFinite(Number(point?.y))) {
              push('bad-point', `annotations[${index}].points`, '点坐标必须是有限数值')
              break
            }
          }
        }
      })
      if (totalPoints > MAX_TOTAL_POINTS) push('too-many-points-total', 'annotations', `总点数超过 ${MAX_TOTAL_POINTS}`)
      if (magnifierCount > MAX_MAGNIFIERS) {
        push('too-many-magnifiers', 'annotations', `放大镜数量超过 ${MAX_MAGNIFIERS}`)
      }
    }
    if (value.captureAttachments !== undefined && !isPlainObject(value.captureAttachments)) {
      push('bad-attachments', 'captureAttachments', 'captureAttachments 必须是对象')
    }
    if (value.captureMetadata !== undefined && !isPlainObject(value.captureMetadata)) {
      push('bad-capture-metadata', 'captureMetadata', 'captureMetadata 必须是对象')
    }
    // v2 (feature C §6.2): the style is validated by its own module (one owner for the ranges),
    // but the errors are merged into THIS error list so a caller only ever inspects one report.
    // A v2 document without a style is rejected: the field is content, and "absent" would make
    // the fingerprint of two different documents collide.
    if (value.outputStyle === undefined) {
      push('missing-output-style', 'outputStyle', '缺少 outputStyle')
    } else {
      const style = outputStyleApi.validateOutputStyle(value.outputStyle)
      for (const issue of style.errors) {
        push(issue.code, issue.path ? `outputStyle.${issue.path.replace(/^outputStyle\./, '')}` : 'outputStyle', issue.message)
      }
    }
    return { ok: errors.length === 0, errors }
  }

  // ---------- 序列化 / 反序列化 ----------

  function utf8Bytes(text) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text)
    return Uint8Array.from(Buffer.from(text, 'utf8'))
  }

  function utf8Text(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || [])
    if (typeof TextDecoder === 'function') return new TextDecoder('utf-8', { fatal: false }).decode(view)
    return Buffer.from(view).toString('utf8')
  }

  function byteLength(value) {
    if (value == null) return 0
    if (typeof value === 'string') return utf8Bytes(value).length
    if (value instanceof Uint8Array) return value.byteLength
    if (Buffer.isBuffer?.(value)) return value.length
    if (ArrayBuffer.isView(value)) return value.byteLength
    if (value instanceof ArrayBuffer) return value.byteLength
    return 0
  }

  // 字节预算守卫：发送端与主进程两侧都调它（§6.5.3 "发送端/preload 先限制载荷字节数，
  // 主进程接收后再次校验"）。单独导出是为了让"预检"这条路径可被直接断言，而不是只能
  // 靠构造一个 16 MiB 的合法文档去触发。
  function assertWithinDocumentBudget(bytes) {
    const size = byteLength(bytes)
    if (size > MAX_DOCUMENT_BYTES) {
      const error = new Error(`文档超过 ${Math.round(MAX_DOCUMENT_BYTES / (1024 * 1024))} MiB 上限`)
      error.code = 'document-too-large'
      error.size = size
      throw error
    }
    return size
  }

  // 序列化成 UTF-8 字节。超出硬上限直接抛错 —— §6.5.3 要求"不能悄悄把一次文档保存
  // 降级成不可编辑记录"，宁可显式失败让用户选择仅导出位图。
  function serializeDocument(document) {
    const bytes = utf8Bytes(JSON.stringify(normalizeDocument(document)))
    assertWithinDocumentBudget(bytes)
    return bytes
  }

  // 反序列化：**先按字节限流，再 parse**，随后校验 schemaVersion 并做迁移。
  // 未知的"未来版本"不得猜字段补齐（§6.5.3）—— 返回 unsupported-schema 由调用方
  // 走"仅位图恢复"降级。
  function parseDocument(payload, options) {
    const settings = isPlainObject(options) ? options : {}
    const size = byteLength(payload)
    if (!size) return { ok: false, code: 'empty-document', errors: [{ code: 'empty-document', path: '', message: '文档为空' }] }
    if (size > MAX_DOCUMENT_BYTES) {
      return {
        ok: false,
        code: 'document-too-large',
        errors: [{ code: 'document-too-large', path: '', message: `文档超过 ${MAX_DOCUMENT_BYTES} 字节` }]
      }
    }
    let raw
    try {
      raw = JSON.parse(typeof payload === 'string' ? payload : utf8Text(payload))
    } catch (error) {
      return { ok: false, code: 'invalid-json', errors: [{ code: 'invalid-json', path: '', message: error.message }] }
    }
    if (Number(raw?.schemaVersion) === SCHEMA_VERSION) {
      const validation = validateDocument(raw, settings)
      return validation.ok
        ? { ok: true, document: normalizeDocument(raw), migratedFrom: SCHEMA_VERSION }
        : { ok: false, code: 'invalid-document', errors: validation.errors }
    }
    const migrated = migrateDocument(raw)
    if (!migrated) {
      return {
        ok: false,
        code: 'unsupported-schema',
        errors: [{ code: 'unsupported-schema', path: 'schemaVersion', message: `不支持的文档版本：${String(raw?.schemaVersion)}` }]
      }
    }
    // A document whose version is known but whose CONTENT is invalid after migration is not an
    // "unsupported schema" - reporting that would send the caller down the "future version, fall
    // back to bitmap only" path for what is really a corrupt crop or a bad annotation. The
    // distinction matters because §6.5.7's degradation is user-visible.
    if (migrated.invalid) {
      return { ok: false, code: 'invalid-document', errors: migrated.errors }
    }
    return { ok: true, document: migrated.document, migratedFrom: migrated.migratedFrom }
  }

  // 版本迁移函数表。只有明确写好的迁移才能升级；未知版本返回 null（不猜）。
  // 迁移"只写新 revision，保留旧文件"是服务层的事，这里只负责形状转换。
  const MIGRATIONS = Object.freeze({
    // v1 -> v2 (feature C §6.3): add a DISABLED output style. Disabled means "geometry identical
    // to v1" (§6.2), so the migrated document produces the same pixels, the same result size and
    // - because normalizeDocument() is the only thing that builds the fingerprint - the same clean
    // baseline the renderer computes after loading. That is what "opening a v1 record does not
    // dirty it" means concretely.
    //
    // Deliberately NOT a place to invent anything else: no annotation rewrites, no crop change,
    // no new revision. The service keeps the v1 bytes on disk untouched and only writes the
    // upgraded shape when the user actually changes content (§6.3 second paragraph).
    1: (raw) => Object.assign({}, raw, {
      schemaVersion: 2,
      outputStyle: outputStyleApi.normalizeOutputStyle(raw?.outputStyle)
    }),
    // v2 -> v3 (feature D §7.3): the only schema change is the annotation-type whitelist, which
    // is not data - a v2 document with no magnifiers is already a valid v3 document. The bump
    // exists so an OLD client meeting a v3 document falls back to "bitmap only" instead of
    // silently dropping the magnifiers and saving over them (§7.3 last sentence).
    //
    // Nothing is rewritten: no coordinates, no crop, no style. A v2 document therefore keeps its
    // exact content fingerprint across the migration, which is what "opening does not dirty it"
    // requires.
    2: (raw) => Object.assign({}, raw, { schemaVersion: 3 })
  })

  function migrateDocument(raw) {
    if (!isPlainObject(raw)) return null
    let current = raw
    let guard = 0
    while (Number(current?.schemaVersion) !== SCHEMA_VERSION) {
      const from = Number(current?.schemaVersion)
      const migrate = MIGRATIONS[from]
      if (typeof migrate !== 'function' || guard++ > 8) return null
      current = migrate(current)
      if (!isPlainObject(current)) return null
    }
    const validation = validateDocument(current)
    if (!validation.ok) {
      // Known version, invalid content. `parseDocument` turns this into `invalid-document`;
      // `migrateDocument`'s null means "no migration path", which is a different thing.
      return { invalid: true, errors: validation.errors }
    }
    return { document: normalizeDocument(current), migratedFrom: Number(raw?.schemaVersion) }
  }

  // ---------- 内容指纹 ----------

  // 稳定序列化：键序固定（CONTENT_FIELDS 的顺序 + 标注内部固定键序），数组保持顺序
  // （数组顺序即 z 序，是内容的一部分）。
  function canonicalAnnotation(annotation) {
    const ordered = {}
    const keys = Object.keys(annotation).filter((key) => key !== 'id').sort()
    for (const key of keys) {
      const value = annotation[key]
      if (value === undefined) continue
      if (key === 'points' && Array.isArray(value)) {
        // 点集用紧凑数组表达，避免 20 万点时把键名重复 40 万次。
        ordered.points = value.map((point) => [point.x, point.y])
        continue
      }
      ordered[key] = value
    }
    return ordered
  }

  function canonicalContent(document) {
    const doc = normalizeDocument(document)
    const content = {}
    for (const field of CONTENT_FIELDS) {
      if (field === 'annotations') {
        content.annotations = doc.annotations.map(canonicalAnnotation)
      } else {
        content[field] = doc[field]
      }
    }
    return JSON.stringify(content)
  }

  // FNV-1a 双累加器 → 64 位十六进制。纯 JS、两端可算、无需 node:crypto。
  // 只用于 dirty 判定与日志，不作为安全哈希（底图内容哈希由主进程用 sha256 算）。
  function fnv1a64(text) {
    const PRIME = 0x01000193
    let high = 0x811c9dc5
    let low = 0x811c9dc5
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index)
      high ^= code
      high = Math.imul(high, PRIME) >>> 0
      low ^= (code + index) & 0xffff
      low = Math.imul(low, PRIME) >>> 0
    }
    return `${high.toString(16).padStart(8, '0')}${low.toString(16).padStart(8, '0')}`
  }

  function documentFingerprint(document) {
    return fnv1a64(canonicalContent(document))
  }

  // dirty 判定：与"最近一次成功提交的指纹"比较。撤销回基线 → clean；
  // 撤销到旧内容 → dirty。刻意不看撤销栈下标（§6.5.3 末条）。
  function isDocumentDirty(document, cleanFingerprint) {
    const baseline = typeof cleanFingerprint === 'string' ? cleanFingerprint : ''
    if (!baseline) return true
    return documentFingerprint(document) !== baseline
  }

  // ---------- 渲染层恢复辅助 ----------

  // Feature D (§7.1/§7.3): the magnifier is the first NESTED annotation, so the flat mapping
  // below would silently corrupt it - it has no x/y/x2/y2 at all, and its two rectangles live in
  // the SAME source-pixel space. A generic walk would either drop the object (no x/y) or invent
  // one. These two helpers translate the nested rectangles explicitly, and both directions are
  // built from the same pair of primitives so they stay exact inverses.
  function magnifierToViewport(annotation, view) {
    const magnifier = magnifierApi.normalizeMagnifier(annotation)
    const sourceTopLeft = sourceToViewport({ x: magnifier.sourceRect.x, y: magnifier.sourceRect.y }, view)
    const lensTopLeft = sourceToViewport(magnifier.lensOrigin, view)
    const mapped = Object.assign({}, magnifier, {
      sourceRect: {
        x: sourceTopLeft.x,
        y: sourceTopLeft.y,
        // Sizes scale by zoom; they are never re-derived from the lens, because the lens size is
        // a derived value and re-deriving it here would compound rounding on every reload.
        w: magnifier.sourceRect.w * view.zoom,
        h: magnifier.sourceRect.h * view.zoom
      },
      lensOrigin: { x: lensTopLeft.x, y: lensTopLeft.y },
      // The stroke width is a length too (§6.2.1 "不能只转换端点而漏掉样式几何").
      stroke: Object.assign({}, magnifier.stroke, { widthPx: magnifier.stroke.widthPx * view.zoom })
    })
    return annotation.id !== undefined ? Object.assign({}, mapped, { id: annotation.id }) : mapped
  }

  function magnifierFromViewport(annotation, view) {
    const magnifier = magnifierApi.normalizeMagnifier(annotation)
    const sourceTopLeft = viewportToSource({ x: magnifier.sourceRect.x, y: magnifier.sourceRect.y }, view)
    const lensTopLeft = viewportToSource(magnifier.lensOrigin, view)
    const mapped = Object.assign({}, magnifier, {
      sourceRect: {
        x: sourceTopLeft.x,
        y: sourceTopLeft.y,
        w: magnifier.sourceRect.w / view.zoom,
        h: magnifier.sourceRect.h / view.zoom
      },
      lensOrigin: { x: lensTopLeft.x, y: lensTopLeft.y },
      stroke: Object.assign({}, magnifier.stroke, { widthPx: magnifier.stroke.widthPx / view.zoom })
    })
    return annotation.id !== undefined ? Object.assign({}, mapped, { id: annotation.id }) : mapped
  }

  // 把文档里的标注映射到视口 CSS 坐标，供恢复时直接放进渲染层的 annotations。
  // 只对**不带点集**的对象做整体平移缩放；带点集的对象逐点映射（§6.2.1：
  // 不能只转换端点而漏掉点集）。
  function annotationsToViewport(annotations, viewport) {
    const view = resolveViewport(viewport)
    const list = Array.isArray(annotations) ? annotations : []
    const zoom = view.zoom
    const mapped = []
    for (const entry of list) {
      const annotation = normalizeAnnotation(entry)
      if (!annotation) continue
      // Feature D: nested geometry own branch (see the helper above).
      if (annotation.type === 'magnifier') {
        mapped.push(magnifierToViewport(entry, view))
        continue
      }
      const origin = sourceToViewport({ x: annotation.x, y: annotation.y }, view)
      const result = Object.assign({}, annotation, { x: origin.x, y: origin.y })
      if (annotation.x2 !== undefined) result.x2 = sourceToViewport({ x: annotation.x2, y: annotation.y }, view).x
      if (annotation.y2 !== undefined) result.y2 = sourceToViewport({ x: annotation.x, y: annotation.y2 }, view).y
      if (Array.isArray(annotation.points)) {
        result.points = annotation.points.map((point) => sourceToViewport(point, view))
      }
      if (annotation.w !== undefined) result.w = annotation.w * zoom
      if (annotation.h !== undefined) result.h = annotation.h * zoom
      if (annotation.width !== undefined) result.width = annotation.width * zoom
      if (annotation.radius !== undefined) result.radius = annotation.radius * zoom
      if (annotation.fontSize !== undefined) result.fontSize = annotation.fontSize * zoom
      mapped.push(result)
    }
    return mapped
  }

  // 视口 CSS 坐标的标注 → 源像素（提交前用；annotationsToViewport 的严格逆）。
  function annotationsFromViewport(annotations, viewport) {
    const view = resolveViewport(viewport)
    const list = Array.isArray(annotations) ? annotations : []
    const zoom = view.zoom
    const mapped = []
    for (const entry of list) {
      const annotation = normalizeAnnotation(entry)
      if (!annotation) continue
      // Feature D: strict inverse of magnifierToViewport.
      if (annotation.type === 'magnifier') {
        mapped.push(magnifierFromViewport(entry, view))
        continue
      }
      const origin = viewportToSource({ x: annotation.x, y: annotation.y }, view)
      const result = Object.assign({}, annotation, { x: origin.x, y: origin.y })
      if (annotation.x2 !== undefined) result.x2 = viewportToSource({ x: annotation.x2, y: annotation.y }, view).x
      if (annotation.y2 !== undefined) result.y2 = viewportToSource({ x: annotation.x, y: annotation.y2 }, view).y
      if (Array.isArray(annotation.points)) {
        result.points = annotation.points.map((point) => viewportToSource(point, view))
      }
      if (annotation.w !== undefined) result.w = annotation.w / zoom
      if (annotation.h !== undefined) result.h = annotation.h / zoom
      if (annotation.width !== undefined) result.width = annotation.width / zoom
      if (annotation.radius !== undefined) result.radius = annotation.radius / zoom
      if (annotation.fontSize !== undefined) result.fontSize = annotation.fontSize / zoom
      mapped.push(result)
    }
    return mapped
  }

  // ---------- 新图建档 / 旧图惰性升级 ----------

  // 首次建档：把一次区域截图的**实际像素边界**作为初始底图与完整 crop（§6.2.1：
  // "首次选区取 getSourcePixelRect 的实际整数像素边界作为初始底图，再统一减去该边界原点"）。
  function createInitialDocument(options) {
    const settings = isPlainObject(options) ? options : {}
    const width = positiveInteger(settings.width, 1)
    const height = positiveInteger(settings.height, 1)
    const document = normalizeDocument({
      baseImage: { assetId: settings.assetId || '', width, height },
      crop: { x: 0, y: 0, w: width, h: height },
      annotations: settings.annotations || [],
      captureAttachments: settings.captureAttachments || { cursor: null },
      captureMetadata: {
        sourceScaleFactor: settings.sourceScaleFactor,
        longCapture: settings.longCapture === true
      },
      // v2 (feature C): a brand-new document starts in "original" (disabled effects), so a
      // first save of an untouched screenshot is byte-identical to what v1 would have written
      // apart from the schema number and the disabled style block.
      outputStyle: settings.outputStyle,
      view: settings.view,
      source: settings.source || 'region',
      createdAt: settings.createdAt
    })
    return document
  }

  // 旧扁平 PNG 的惰性升级（§6.7）：完整图 crop + 空矢量列表，已有像素留在底图里。
  // 返回带 storageFormat 标记的条目字段供服务层写索引。
  function createLegacyDocument(options) {
    const settings = isPlainObject(options) ? options : {}
    const document = createInitialDocument({
      assetId: settings.assetId || '',
      width: settings.width,
      height: settings.height,
      sourceScaleFactor: settings.sourceScaleFactor,
      source: settings.source || 'legacy',
      annotations: [],
      // A lazily upgraded legacy bitmap carries pixels that already include whatever was
      // baked in; adding a card frame here would DOUBLE the decoration on the next save
      // (§6.3 "贴图再编辑均不能累计叠加外框"). Upgrade always lands in disabled/original.
      outputStyle: null,
      createdAt: settings.createdAt
    })
    return { document, storageFormat: 'editable-v1', upgradedFrom: 'legacy-bitmap' }
  }

  // ---------- 成品几何（feature C §6.2） ----------

  // The ONE place the export size of a document is decided. `capture-document-service` validates
  // a submitted result PNG against this for v2 documents, and the renderer uses the same call to
  // size its export canvas, so the two ends cannot disagree about "how big is the result".
  function resolveOutputGeometry(document) {
    const doc = normalizeDocument(document)
    return outputStyleApi.resolveOutputGeometry({
      contentWidth: doc.crop.w,
      contentHeight: doc.crop.h,
      outputStyle: doc.outputStyle
    })
  }

  // The full composite plan (card/content rectangles, shadow bleed). Exposed so the renderer's
  // preview and its export path build the canvas from the same numbers (§6.2).
  function resolveOutputPlan(document) {
    const doc = normalizeDocument(document)
    return outputStyleApi.planOutputComposite({
      contentWidth: doc.crop.w,
      contentHeight: doc.crop.h,
      outputStyle: doc.outputStyle
    })
  }

  // ---------- 遮挡合成 / 放大镜采样（feature D §7.2 + R0.4） ----------

  // The safe-sampling plan for a document: base image + opaque masking of every blur still in
  // the document, expressed in SOURCE PIXELS and applied before any scaling. Both the
  // recognition entry points (R0.4) and the magnifier's sample base (D2) consume this - they are
  // the same composition, which is why it is exposed once here instead of twice in the renderer.
  //
  // Deliberately ignores `highlight`: §8 says it is not a secrecy tool. Also ignores the
  // display-only transparency/eraser preview: protection ends only when the object is deleted.
  function resolveOcclusionPlan(document) {
    const doc = normalizeDocument(document)
    return occlusionApi.buildOcclusionPlan({ crop: doc.crop, annotations: doc.annotations })
  }

  // Magnifier helpers that need the document (the crop) rather than just the object. The
  // renderer's crop gesture calls this so "the source rect no longer intersects the crop"
  // removes the object within the SAME undo frame that changed the crop (§7.1).
  function resolveMagnifiers(document) {
    const doc = normalizeDocument(document)
    return doc.annotations.filter((annotation) => annotation.type === 'magnifier')
  }

  function clipMagnifiersToCrop(document) {
    const doc = normalizeDocument(document)
    const magnifiers = doc.annotations.filter((annotation) => annotation.type === 'magnifier')
    const result = magnifierApi.clipAllToCrop(magnifiers, doc.crop)
    return {
      kept: result.kept,
      removed: result.removed,
      adjusted: result.adjusted,
      // Ids are session-scoped; returning them lets the caller build one undo frame that both
      // trims the crop and drops the affected magnifiers.
      removedIds: result.removed
        .map((entry) => (entry && entry.id !== undefined ? String(entry.id) : ''))
        .filter(Boolean)
    }
  }

  return {
    // 常量
    SCHEMA_VERSION,
    COORDINATE_SPACE,
    MAX_DOCUMENT_BYTES,
    MAX_POINTS_PER_ANNOTATION,
    MAX_TOTAL_POINTS,
    MAX_ANNOTATIONS,
    ANNOTATION_TYPES,
    LENGTH_FIELDS,
    DOCUMENT_FIELDS,
    CONTENT_FIELDS,
    RESOURCE_ID_PATTERN,
    MIGRATIONS,
    // 兼容性别名：v2 起文档格式已是 editable-v2，但索引里的 storageFormat 值仍沿用
    // `editable-v1` 这一"可编辑"标记（它描述的是"能否重开编辑"，不是 schema 号），
    // 改动它会让 v1 记录在迁移中被误判成另一种格式。
    STORAGE_FORMAT_EDITABLE: 'editable-v1',
    // 尺寸与坐标
    normalizeBaseSize,
    normalizeCrop,
    resolveViewport,
    fitViewport,
    sourceToViewport,
    viewportToSource,
    sourceRectToExport,
    resolveExportTransform,
    // 文档
    normalizeAnnotation,
    normalizeDocument,
    validateDocument,
    assertWithinDocumentBudget,
    serializeDocument,
    parseDocument,
    migrateDocument,
    // 指纹
    canonicalContent,
    documentFingerprint,
    isDocumentDirty,
    fnv1a64,
    // 渲染层恢复
    annotationsToViewport,
    annotationsFromViewport,
    // 成品几何（feature C）
    resolveOutputGeometry,
    resolveOutputPlan,
    // 遮挡合成与放大镜（feature D §7.2 / R0.4）
    MAX_MAGNIFIERS,
    resolveOcclusionPlan,
    resolveMagnifiers,
    clipMagnifiersToCrop,
    // 建档
    createInitialDocument,
    createLegacyDocument
  }
})
