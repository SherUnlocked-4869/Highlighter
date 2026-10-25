// 批次 0 契约用例：shared/capture-document.js
//
// 钉的是 docs/plans/2026-10-25-history-reedit-redesign.md 里已经冻结的设计选择：
//   §6.2.1 坐标与像素契约（源像素 = 文档单位；crop/标注/样式长度同单位；导出只减一次）
//   §6.5.1 身份与版本（documentId 稳定 / revisionId 不可变）
//   §6.5.3 文档格式与载入校验（字节上限、schemaVersion、白名单字段、点数预算、内容指纹）
//   §6.7   存量记录与格式兼容（旧扁平 PNG 惰性升级）
//
// 这些是纯函数用例，不依赖 Electron，也不验证任何真机行为。
const test = require('node:test')
const assert = require('node:assert/strict')

const doc = require('../shared/capture-document')

const BASE = { assetId: 'base-a', width: 3840, height: 2160 }

function makeDocument(overrides = {}) {
  return doc.createInitialDocument({
    assetId: BASE.assetId,
    width: BASE.width,
    height: BASE.height,
    sourceScaleFactor: 2,
    ...overrides
  })
}

// ---------- §6.2.1 坐标与像素契约 ----------

test('§6.2.1 the document unit is the base image source pixel, and crop defaults to the whole image', () => {
  const document = makeDocument()
  assert.equal(document.coordinateSpace, 'source-pixel')
  assert.deepEqual(document.crop, { x: 0, y: 0, w: 3840, h: 2160 })
  assert.deepEqual(document.baseImage, { assetId: 'base-a', width: 3840, height: 2160 })
  // 捕获 DPI 是单独保存的元数据，缺失的旧图默认 1（视口 zoom 不得覆写它）。
  assert.equal(document.captureMetadata.sourceScaleFactor, 2)
  assert.equal(doc.normalizeDocument({}).captureMetadata.sourceScaleFactor, 1)
})

test('§6.2.1 crop is integer pixels clamped inside the base image, and object coordinates keep precision', () => {
  const base = { width: 800, height: 600 }
  // 越界 + 小数：裁剪边界四舍五入取整并钳制（对象坐标才保留精度）。
  // 400.8 -> 401 高，于是 y 的上限是 600-401 = 199。
  assert.deepEqual(doc.normalizeCrop({ x: 700.4, y: 550.6, w: 400.2, h: 400.8 }, base), { x: 400, y: 199, w: 400, h: 401 })
  assert.deepEqual(doc.normalizeCrop({ x: -20, y: -20, w: 100, h: 100 }, base), { x: 0, y: 0, w: 100, h: 100 })
  // 缺省 = 整张底图，且宽高至少 1。
  assert.deepEqual(doc.normalizeCrop(null, base), { x: 0, y: 0, w: 800, h: 600 })
  // 退化的 0 宽高当作"未设置"，回落整图 —— 不产出非法矩形，也不把图裁成 1×1。
  assert.deepEqual(doc.normalizeCrop({ x: 0, y: 0, w: 0, h: 0 }, base), { x: 0, y: 0, w: 800, h: 600 })
  // 非对象输入同样回落整图。
  assert.deepEqual(doc.normalizeCrop('not-a-crop', base), { x: 0, y: 0, w: 800, h: 600 })
  // 标注坐标不做取整：保留精度。
  const annotation = doc.normalizeAnnotation({ type: 'arrow', x: 10.25, y: 20.75, x2: 30.5, y2: 40.125, width: 4 })
  assert.equal(annotation.x, 10.25)
  assert.equal(annotation.y2, 40.125)
})

test('§6.2.1 the viewport transform and its inverse are exact round trips and never touch crop', () => {
  const viewport = doc.resolveViewport({
    baseSize: { width: 3840, height: 2160 },
    crop: { x: 120, y: 80, w: 2400, h: 1600 },
    zoom: 0.375,
    offsetX: 40,
    offsetY: 12
  })
  // 公式原样：cssX = offsetX + (sourceX - crop.x) * zoom
  assert.deepEqual(doc.sourceToViewport({ x: 120, y: 80 }, viewport), { x: 40, y: 12 })
  assert.deepEqual(doc.sourceToViewport({ x: 1320, y: 880 }, viewport), { x: 490, y: 312 })
  // 逆变换必须严格互逆（输入与命中用同一条）。
  for (const source of [{ x: 0, y: 0 }, { x: 3839.5, y: 2159.25 }, { x: 120, y: 80 }, { x: 2520, y: 1680 }]) {
    const roundTrip = doc.viewportToSource(doc.sourceToViewport(source, viewport), viewport)
    assert.ok(Math.abs(roundTrip.x - source.x) < 1e-9, `x round trip ${source.x} -> ${roundTrip.x}`)
    assert.ok(Math.abs(roundTrip.y - source.y) < 1e-9, `y round trip ${source.y} -> ${roundTrip.y}`)
  }
  // 非有限输入不得产出 NaN 之外的破坏性结果（调用方据此丢弃手势）。
  assert.ok(Number.isNaN(doc.sourceToViewport({ x: 'a', y: 1 }, viewport).x))
  assert.ok(Number.isNaN(doc.viewportToSource({ x: 1, y: null }, viewport).y))
})

test('§6.2.1 fit keeps the crop centred, never upscales by default, and is pure projection', () => {
  const crop = { x: 100, y: 50, w: 400, h: 300 }
  const baseSize = { width: 800, height: 600 }
  // 不放大：4K 图缩进小窗口时 zoom<1；小图不铺满（allowUpscale 才放大）。
  const small = doc.fitViewport({ baseSize, crop, bounds: { width: 100, height: 100 } })
  assert.equal(small.zoom, 0.25)
  assert.equal(small.offsetX, 0)
  assert.equal(small.offsetY, 12.5)
  const notUpscaled = doc.fitViewport({ baseSize, crop, bounds: { width: 800, height: 600 } })
  assert.equal(notUpscaled.zoom, 1)
  const upscaled = doc.fitViewport({ baseSize, crop, bounds: { width: 800, height: 600 }, allowUpscale: true })
  assert.equal(upscaled.zoom, 2)
  // fit 只更新投影：crop 原样带出，没有被平移或扩张。
  assert.deepEqual(small.crop, crop)
})

test('§6.2.1 export subtracts the crop origin exactly once and never rescales', () => {
  const transform = doc.resolveExportTransform({ x: 120, y: 80, w: 2400, h: 1600 })
  assert.deepEqual(transform, { offsetX: -120, offsetY: -80, scaleX: 1, scaleY: 1, width: 2400, height: 1600 })
  // 同一个源矩形在两种窗口大小下导出结果相同（导出不看窗口、不看 DPI、不看 view.zoom）。
  const rect = { x: 200, y: 160, w: 300, h: 200 }
  assert.deepEqual(doc.sourceRectToExport(rect, { x: 120, y: 80 }), { x: 80, y: 80, w: 300, h: 200 })
})

test('§6.2.1 every length-meaning field survives the source<->viewport round trip, not just the endpoints', () => {
  const viewport = doc.resolveViewport({
    baseSize: { width: 3840, height: 2160 },
    crop: { x: 0, y: 0, w: 3840, h: 2160 },
    zoom: 0.25,
    offsetX: 10,
    offsetY: 20
  })
  const annotations = [
    { type: 'arrow', x: 300, y: 240, x2: 900, y2: 480, width: 8, color: '#ff0000', id: 'arrow-a' },
    { type: 'pen', x: 40, y: 60, width: 4, color: '#00ff00', points: [{ x: 40, y: 60 }, { x: 80, y: 100 }] },
    { type: 'text', x: 100, y: 100, width: 4, fontSize: 12, text: 'hi', color: '#111111' },
    { type: 'serial', x: 500, y: 500, width: 8, radius: 24, number: 3, color: '#111111' },
    { type: 'watermark', x: 10, y: 10, w: 400, h: 100, text: 'wm', color: '#ffffff' },
    { type: 'rect', x: 1, y: 2, x2: 30, y2: 40, width: 4, color: '#1687ff', radius: 8 }
  ]
  const inViewport = doc.annotationsToViewport(annotations, viewport)
  // 笔宽、字号、半径、马赛克单元这类长度字段必须随 zoom 缩放，不能只转端点。
  assert.equal(inViewport[0].width, 2)
  assert.equal(inViewport[2].fontSize, 3)
  assert.equal(inViewport[3].radius, 6)
  assert.equal(inViewport[5].radius, 2)
  assert.equal(inViewport[4].w, 100)
  const back = doc.annotationsFromViewport(inViewport, viewport)
  assert.equal(back.length, annotations.length)
  for (let index = 0; index < annotations.length; index += 1) {
    for (const field of ['x', 'y', 'x2', 'y2', 'w', 'h', 'width', 'radius', 'fontSize']) {
      if (annotations[index][field] === undefined) continue
      assert.ok(
        Math.abs(back[index][field] - annotations[index][field]) < 1e-9,
        `${annotations[index].type}.${field}: ${annotations[index][field]} -> ${back[index][field]}`
      )
    }
    if (annotations[index].points) {
      assert.deepEqual(back[index].points, annotations[index].points)
    }
  }
})

// ---------- §6.5.1 身份与版本 ----------

test('§6.5.1 documentId and revisionId are separate identities and never collide in the schema', () => {
  const document = doc.normalizeDocument({
    documentId: 'document-a',
    revisionId: 'revision-2',
    parentRevisionId: 'revision-1',
    baseImage: BASE,
    crop: { x: 0, y: 0, w: 100, h: 100 }
  })
  assert.equal(document.documentId, 'document-a')
  assert.equal(document.revisionId, 'revision-2')
  assert.equal(document.parentRevisionId, 'revision-1')
  // 首版 parentRevisionId 是 null，而且不参与文档分组。
  assert.equal(makeDocument().parentRevisionId, null)
  // 非法资源 id 归零（服务层不接受渲染层指定任意路径）。
  assert.equal(doc.normalizeDocument({ documentId: '../../etc/passwd' }).documentId, '')
  assert.equal(doc.normalizeDocument({ documentId: 'a/b' }).documentId, '')
  assert.equal(doc.normalizeDocument({ documentId: 'ok-1_2' }).documentId, 'ok-1_2')
})

// ---------- §6.5.3 文档格式与载入校验 ----------

test('§6.5.3 the documented example document validates and round trips through bytes', () => {
  const example = {
    schemaVersion: 1,
    coordinateSpace: 'source-pixel',
    documentId: 'document-a',
    revisionId: 'revision-2',
    parentRevisionId: 'revision-1',
    baseImage: { assetId: 'base-a', width: 3840, height: 2160 },
    crop: { x: 120, y: 80, w: 2400, h: 1600 },
    annotations: [
      { id: 'arrow-a', type: 'arrow', x: 300, y: 240, x2: 900, y2: 480, width: 8, color: '#ff0000' }
    ],
    captureAttachments: { cursor: null },
    captureMetadata: { sourceScaleFactor: 2 },
    view: { zoomMultiplier: 1, centerX: 1320, centerY: 880 },
    source: 'region',
    createdAt: 1792886400000
  }
  const validation = doc.validateDocument(example)
  assert.deepEqual(validation, { ok: true, errors: [] })
  const bytes = doc.serializeDocument(example)
  const parsed = doc.parseDocument(bytes)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.document.documentId, 'document-a')
  assert.equal(parsed.document.annotations[0].type, 'arrow')
  assert.deepEqual(parsed.document.crop, { x: 120, y: 80, w: 2400, h: 1600 })
})

test('§6.5.3 load rejects oversized payloads before parsing, unknown schemas, and bad JSON', () => {
  // 字节硬上限 16 MiB，且在 JSON.parse 之前判定（不解析恶意大文件）。
  assert.equal(doc.MAX_DOCUMENT_BYTES, 16 * 1024 * 1024)
  const huge = Buffer.alloc(doc.MAX_DOCUMENT_BYTES + 1, 0x20)
  assert.equal(doc.parseDocument(huge).code, 'document-too-large')
  assert.equal(doc.parseDocument(new Uint8Array(0)).code, 'empty-document')
  assert.equal(doc.parseDocument('{not json').code, 'invalid-json')
  // 未知"未来版本"不得猜字段补齐 —— 显式不支持的 schema。
  const future = doc.parseDocument(JSON.stringify({ schemaVersion: 99, baseImage: BASE }))
  assert.equal(future.ok, false)
  assert.equal(future.code, 'unsupported-schema')
  // 发送端预检守卫：超限抛带 code 的错误，恰好等于上限时放行。
  assert.throws(() => doc.assertWithinDocumentBudget(huge), (error) => error.code === 'document-too-large')
  assert.equal(doc.assertWithinDocumentBudget(Buffer.alloc(doc.MAX_DOCUMENT_BYTES, 0x20)), doc.MAX_DOCUMENT_BYTES)
  // 序列化走同一个守卫：一个合法但体积超限的文档（大量长文字标注）必须显式失败，
  // 不能悄悄降级成不可编辑记录。
  const bulky = makeDocument({
    annotations: Array.from({ length: 3000 }, (_, index) => ({
      type: 'text',
      x: index,
      y: index,
      width: 4,
      color: '#ff0000',
      text: '字'.repeat(2000)
    }))
  })
  assert.throws(() => doc.serializeDocument(bulky), (error) => error.code === 'document-too-large')
})

test('§6.5.3 validation rejects unknown fields, unknown annotation types, and out-of-bounds crops', () => {
  const unknownField = doc.validateDocument(Object.assign(makeDocument(), { evil: 'payload' }))
  assert.equal(unknownField.ok, false)
  assert.ok(unknownField.errors.some((error) => error.code === 'unknown-field'))

  const unknownType = doc.validateDocument(Object.assign(makeDocument(), {
    annotations: [{ type: 'future-tool', x: 1, y: 1, width: 4, color: '#ff0000' }]
  }))
  assert.equal(unknownType.ok, false)
  assert.ok(unknownType.errors.some((error) => error.code === 'unknown-annotation-type'))

  const badCrop = doc.validateDocument(Object.assign(makeDocument(), { crop: { x: 3000, y: 0, w: 2000, h: 100 } }))
  assert.equal(badCrop.ok, false)
  assert.ok(badCrop.errors.some((error) => error.code === 'crop-out-of-bounds'))

  const fractional = doc.validateDocument(Object.assign(makeDocument(), { crop: { x: 10.5, y: 0, w: 100, h: 100 } }))
  assert.ok(fractional.errors.some((error) => error.code === 'fractional-crop'))

  const badLength = doc.validateDocument(Object.assign(makeDocument(), {
    annotations: [{ type: 'arrow', x: 1, y: 1, x2: 'nope', width: 4, color: '#ff0000' }]
  }))
  assert.ok(badLength.errors.some((error) => error.code === 'bad-length'))
})

test('§6.5.3 point budgets are enforced per annotation and in total', () => {
  assert.equal(doc.MAX_POINTS_PER_ANNOTATION, 10000)
  assert.equal(doc.MAX_TOTAL_POINTS, 200000)
  const tooMany = {
    type: 'pen',
    x: 0,
    y: 0,
    width: 4,
    color: '#ff0000',
    points: Array.from({ length: 10001 }, (_, index) => ({ x: index, y: index }))
  }
  const single = doc.validateDocument(Object.assign(makeDocument(), { annotations: [tooMany] }))
  assert.ok(single.errors.some((error) => error.code === 'too-many-points'))
  // 归一化时点集被截断到上限（不把超限点集写盘）。
  assert.equal(doc.normalizeAnnotation(tooMany).points.length, 10000)
  // 非法点被丢弃，整条全是非法点时 points 不落地。
  assert.equal(doc.normalizeAnnotation({ type: 'pen', x: 0, y: 0, points: [{ x: 'a', y: 1 }] }).points, undefined)
})

// ---------- 内容指纹 ----------

test('§6.5.3 the content fingerprint covers content only, never identity/timestamps/view/selection', () => {
  const base = makeDocument({
    annotations: [{ type: 'arrow', x: 10, y: 10, x2: 20, y2: 20, width: 4, color: '#ff0000', id: 'one' }]
  })
  const fingerprint = doc.documentFingerprint(base)

  // 相同内容 + 不同身份/时间/view/来源 ⇒ 指纹相同（无变化保存不增版）。
  const sameContent = Object.assign({}, base, {
    documentId: 'other-document',
    revisionId: 'revision-9',
    parentRevisionId: 'revision-8',
    createdAt: 123456,
    source: 'history',
    // 会话内身份重排不算内容变化：重开一次文档会重新编号。
    annotations: [{ type: 'arrow', x: 10, y: 10, x2: 20, y2: 20, width: 4, color: '#ff0000', id: 'renumbered' }],
    view: { zoomMultiplier: 2, centerX: 10, centerY: 10 }
  })
  assert.equal(doc.documentFingerprint(sameContent), fingerprint)

  // 内容变化必须改变指纹。
  const changedGeometry = Object.assign({}, base, { annotations: [{ type: 'arrow', x: 11, y: 10, x2: 20, y2: 20, width: 4, color: '#ff0000' }] })
  const changedStyle = Object.assign({}, base, { annotations: [{ type: 'arrow', x: 10, y: 10, x2: 20, y2: 20, width: 8, color: '#ff0000' }] })
  const changedColor = Object.assign({}, base, { annotations: [{ type: 'arrow', x: 10, y: 10, x2: 20, y2: 20, width: 4, color: '#00ff00' }] })
  const changedCrop = Object.assign({}, base, { crop: { x: 1, y: 0, w: 3839, h: 2160 } })
  const changedOrder = Object.assign({}, base, {
    annotations: [
      { type: 'arrow', x: 10, y: 10, x2: 20, y2: 20, width: 4, color: '#ff0000' },
      { type: 'rect', x: 1, y: 1, x2: 9, y2: 9, width: 4, color: '#ff0000' }
    ]
  })
  const changedBase = Object.assign({}, base, { baseImage: { assetId: 'base-b', width: 3840, height: 2160 } })
  const changedPoints = Object.assign({}, base, {
    annotations: [{ type: 'pen', x: 0, y: 0, width: 4, color: '#ff0000', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }]
  })
  const changedPointsMore = Object.assign({}, base, {
    annotations: [{ type: 'pen', x: 0, y: 0, width: 4, color: '#ff0000', points: [{ x: 1, y: 1 }, { x: 2, y: 3 }] }]
  })
  const fingerprints = [changedGeometry, changedStyle, changedColor, changedCrop, changedOrder, changedBase, changedPoints, changedPointsMore]
    .map((variant) => doc.documentFingerprint(variant))
  for (const value of fingerprints) assert.notEqual(value, fingerprint)
  // z 序是内容：数组顺序变化必须换指纹（它不是 selectedIds 那种会话状态）。
  assert.notEqual(doc.documentFingerprint(Object.assign({}, base, {
    annotations: [
      { type: 'rect', x: 1, y: 1, x2: 9, y2: 9, width: 4, color: '#ff0000' },
      { type: 'arrow', x: 10, y: 10, x2: 20, y2: 20, width: 4, color: '#ff0000' }
    ]
  })), doc.documentFingerprint(changedOrder))
})

test('§6.5.6 dirty compares against the last committed fingerprint, not the undo-stack index', () => {
  const committed = makeDocument()
  const fingerprint = doc.documentFingerprint(committed)
  assert.equal(doc.isDocumentDirty(committed, fingerprint), false)
  // 没有基线（会话还没提交过）一律 dirty。
  assert.equal(doc.isDocumentDirty(committed, ''), true)
  // 撤销回基线 ⇒ clean；撤销到旧内容 ⇒ dirty。
  const edited = Object.assign({}, committed, {
    annotations: [{ type: 'arrow', x: 1, y: 1, x2: 2, y2: 2, width: 4, color: '#ff0000' }]
  })
  assert.equal(doc.isDocumentDirty(edited, fingerprint), true)
  assert.equal(doc.isDocumentDirty(Object.assign({}, committed), fingerprint), false)
})

// ---------- §6.7 存量兼容 ----------

test('§6.7 a legacy flat PNG is upgraded lazily to a full-crop editable document with no vector objects', () => {
  const upgraded = doc.createLegacyDocument({ assetId: 'base-old', width: 1200, height: 800 })
  assert.equal(upgraded.storageFormat, 'editable-v1')
  assert.equal(upgraded.upgradedFrom, 'legacy-bitmap')
  assert.deepEqual(upgraded.document.crop, { x: 0, y: 0, w: 1200, h: 800 })
  assert.deepEqual(upgraded.document.annotations, [])
  assert.equal(upgraded.document.captureMetadata.sourceScaleFactor, 1)
  // 升级出的文档必须是合法文档（可直接提交）。
  assert.deepEqual(doc.validateDocument(upgraded.document), { ok: true, errors: [] })
})

test('§6.7 the loader never invents fields for an unknown future schema', () => {
  // 未知版本只给显式降级信号，不返回"猜出来的"文档。
  const result = doc.parseDocument(JSON.stringify({ schemaVersion: 2, baseImage: BASE, annotations: [] }))
  assert.equal(result.ok, false)
  assert.equal(result.code, 'unsupported-schema')
  assert.equal(result.document, undefined)
  assert.equal(doc.migrateDocument({ schemaVersion: 2 }), null)
})
