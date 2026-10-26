// 功能 D：放大镜几何（shared/magnifier-geometry.js）+ 遮挡安全采样（shared/occlusion-mask.js）
// + 文档 schema v3 的对象模型部分。
//
// 设计基线：docs/plans/2026-10-25-snow-apps-feature-development-plan.md §7.1–§7.3；遮挡规则见
// docs/plans/2026-10-25-history-reedit-batch0-contracts.md §8（R0.4 是 D 的前置条件）。
//
// 这里钉的是"纯函数可断言的部分"：倍率/源区拒绝、镜头尺寸只由推导得出、裁剪相交规则、
// 缓存键失效条件、遮罩覆盖范围（**在不缩放之前**）。
// 像素级验证（模型调用边界截获像素）在 test/capture-document-editor-runtime.test.js 的
// 遮挡探针里；本文件只断言"哪些像素会被遮"，不打开真实模型。
const test = require('node:test')
const assert = require('node:assert/strict')

const magnifier = require('../shared/magnifier-geometry')
const occlusion = require('../shared/occlusion-mask')
const geometry = require('../capture/annotation-geometry')
const doc = require('../shared/capture-document')

const CROP = { x: 100, y: 100, w: 800, h: 600 }

function makeMagnifier(overrides = {}) {
  return magnifier.normalizeMagnifier(Object.assign({
    sourceRect: { x: 200, y: 200, w: 80, h: 60 },
    lensOrigin: { x: 400, y: 400 },
    factor: 3
  }, overrides))
}

// ---------- §7.1 对象模型与倍率 ----------

test('§7.1 the factor is a discrete 2x/3x/4x choice, and an illegal value is rejected by validation', () => {
  assert.deepEqual([...magnifier.FACTORS], [2, 3, 4])
  for (const factor of [2, 3, 4]) {
    assert.equal(magnifier.validateMagnifier(makeMagnifier({ factor })).ok, true)
    // 归一化：镜头尺寸由推导得出，绝不落盘。
    const lens = magnifier.lensRect(makeMagnifier({ factor }))
    assert.equal(lens.w, 80 * factor)
    assert.equal(lens.h, 60 * factor)
  }
  // 校验必须看**原始输入**：经 normalizeMagnifier 之后非法倍率已经被修成 2，再校验就永远通过。
  for (const factor of [1, 1.5, 5, 0, -2, '3', null, undefined]) {
    const raw = { type: 'magnifier', sourceRect: { x: 200, y: 200, w: 80, h: 60 }, lensOrigin: { x: 400, y: 400 }, factor }
    const result = magnifier.validateMagnifier(raw)
    assert.equal(result.ok, false, `factor ${String(factor)} must be rejected`)
    assert.ok(result.errors.some((error) => error.code === 'bad-factor'))
  }
  // 载入路径宽容：非法倍率回落到 2×，而不是留下一个 undefined 让渲染层算不出镜头。
  assert.equal(magnifier.normalizeMagnifier({ factor: 'nope' }).factor, 2)
})

test('§7.1 the magnifier never persists a lens size, so the two can never contradict each other', () => {
  const value = makeMagnifier()
  const normalized = magnifier.normalizeMagnifier(Object.assign({}, value, {
    lensWidth: 999,
    lensHeight: 999,
    lensOrigin: { x: 400, y: 400 }
  }))
  // 未知字段（含"持久化的镜头尺寸"）一律丢弃。
  assert.equal(normalized.lensWidth, undefined)
  assert.equal(normalized.lensHeight, undefined)
  const report = magnifier.validateMagnifier(Object.assign({}, value, { lensWidth: 999 }))
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((error) => error.code === 'unknown-field'))
  // 镜头矩形永远是 sourceRect × factor。
  assert.deepEqual(magnifier.lensRect(normalized), { x: 400, y: 400, w: 240, h: 180 })
})

test('§7.1 changing the factor is anchored on the lens centre', () => {
  const base = makeMagnifier({ factor: 2 })
  const before = magnifier.lensCenter(base)
  const tripled = magnifier.withFactor(base, 3)
  const after = magnifier.lensCenter(tripled)
  assert.equal(tripled.factor, 3)
  assert.ok(Math.abs(before.x - after.x) < 1e-9)
  assert.ok(Math.abs(before.y - after.y) < 1e-9)
  // 尺寸按倍率变化。
  assert.equal(magnifier.lensRect(tripled).w, 240)
  // 同一个倍率是 no-op（不产生新的撤销步骤素材）。
  assert.deepEqual(magnifier.withFactor(base, 2), base)
})

test('§7.1 the source rect and the lens move independently, and both return new objects', () => {
  const base = makeMagnifier()
  const movedLens = magnifier.translateLens(base, 40, -20)
  assert.deepEqual(movedLens.lensOrigin, { x: 440, y: 380 })
  assert.deepEqual(movedLens.sourceRect, base.sourceRect, 'moving the lens must not move the source')
  const movedSource = magnifier.translateSource(base, -10, 10)
  assert.deepEqual(movedSource.sourceRect, { x: 190, y: 210, w: 80, h: 60 })
  assert.deepEqual(movedSource.lensOrigin, base.lensOrigin, 'moving the source must not move the lens')
  // 原对象不被就地改动。
  assert.deepEqual(base.sourceRect, { x: 200, y: 200, w: 80, h: 60 })
  assert.deepEqual(base.lensOrigin, { x: 400, y: 400 })
  // 整体拖动两半一起走。
  const both = magnifier.translateMagnifier(base, 5, 5)
  assert.deepEqual(both.sourceRect, { x: 205, y: 205, w: 80, h: 60 })
  assert.deepEqual(both.lensOrigin, { x: 405, y: 405 })
})

test('§7.1 the bounds cover every drawn pixel: source rect, lens rect and nothing else', () => {
  const value = makeMagnifier({ sourceRect: { x: 200, y: 200, w: 80, h: 60 }, lensOrigin: { x: 500, y: 100 }, factor: 4 })
  const bounds = magnifier.magnifierBounds(value)
  // 源区 x:200..280, y:200..260；镜头 x:500..820, y:100..340。
  assert.deepEqual(bounds, { x: 200, y: 100, w: 620, h: 240 })
})

// ---------- §7.1 命中与拖动 ----------

test('§7.1 the lens wins the hit when it overlaps the source, and the union box is not clickable', () => {
  const value = makeMagnifier({ sourceRect: { x: 100, y: 100, w: 200, h: 200 }, lensOrigin: { x: 250, y: 250 }, factor: 2 })
  // 重叠区域（250..300, 250..300 同时在源区与镜头里）→ 镜头优先。
  assert.equal(magnifier.hitTestMagnifier(value, { x: 260, y: 260 }), 'lens')
  // 只在源区里。
  assert.equal(magnifier.hitTestMagnifier(value, { x: 120, y: 120 }), 'source')
  // 在并集盒子里但两边都不沾（右下角空白）→ 不命中。
  assert.equal(magnifier.hitTestMagnifier(value, { x: 130, y: 480 }), null)
  // 容差生效（描边外侧仍可点中）。
  assert.equal(magnifier.hitTestMagnifier(value, { x: 498, y: 300 }, 10), 'lens')
  // 完全在外面。
  assert.equal(magnifier.hitTestMagnifier(value, { x: 2000, y: 2000 }), null)
})

test('§7.1 the connector is only hit when it is enabled', () => {
  const value = makeMagnifier({ sourceRect: { x: 100, y: 100, w: 100, h: 100 }, lensOrigin: { x: 400, y: 100 }, factor: 2 })
  // 引线从源区中心 (150,150) 到镜头中心 (500,200)：中点是 (325,175)。
  const mid = { x: 325, y: 175 }
  assert.equal(magnifier.hitTestMagnifier(Object.assign({}, value, { connector: 'none' }), mid), null)
  assert.equal(magnifier.hitTestMagnifier(Object.assign({}, value, { connector: 'line' }), mid), 'connector')
  // 离引线很远的点仍不命中（容差不是无限大）。
  assert.equal(magnifier.hitTestMagnifier(Object.assign({}, value, { connector: 'line' }), { x: 325, y: 400 }), null)
})

test('§7.1 the annotation-geometry primitives delegate to the magnifier model', () => {
  const value = Object.assign(makeMagnifier(), { id: 7 })
  // 包围盒 = 并集（选择框与拖动 clamp 都用它）。
  assert.deepEqual(geometry.annotationBounds(value), magnifier.magnifierBounds(value))
  // 命中：镜头/源区/空白。
  assert.equal(geometry.hitTestAnnotation(value, { x: 410, y: 410 }), true)
  assert.equal(geometry.hitTestAnnotation(value, { x: 205, y: 205 }), true)
  assert.equal(geometry.hitTestAnnotation(value, { x: 2000, y: 2000 }), false)
  // 平移保持 id。
  const moved = geometry.translateAnnotation(value, 10, 0)
  assert.equal(moved.id, 7)
  assert.deepEqual(moved.sourceRect, { x: 210, y: 200, w: 80, h: 60 })
  assert.deepEqual(moved.lensOrigin, { x: 410, y: 400 })
})

test('§7.1 resizing a magnifier resizes its source rect and keeps the factor honest', () => {
  const value = Object.assign(makeMagnifier({ factor: 2 }), { id: 3 })
  const resized = geometry.resizeAnnotationToBox(value, { x: 300, y: 300, w: 160, h: 120 })
  assert.equal(resized.factor, 2)
  assert.deepEqual(resized.sourceRect, { x: 300, y: 300, w: 160, h: 120 })
  // 镜头尺寸 = 新源区 × factor，中心不变。
  const lens = magnifier.lensRect(resized)
  assert.equal(lens.w, 320)
  assert.equal(lens.h, 240)
  assert.equal(resized.id, 3)
})

// ---------- §7.1 裁剪相交规则 ----------

test('§7.1 a source rect inside the crop survives unchanged', () => {
  const result = magnifier.clipToCrop(makeMagnifier(), CROP)
  assert.equal(result.ok, true)
  assert.equal(result.adjusted, false)
  assert.deepEqual(result.magnifier.sourceRect, { x: 200, y: 200, w: 80, h: 60 })
})

test('§7.1 a partially clipped source rect is intersected and the lens keeps its centre', () => {
  // 源区 x:200..280 但 crop 从 x=250 开始 → 交集 x:250..280 (w=30)。
  const value = makeMagnifier({ sourceRect: { x: 200, y: 200, w: 80, h: 60 } })
  const centerBefore = magnifier.lensCenter(value)
  const result = magnifier.clipToCrop(value, { x: 250, y: CROP.y, w: 500, h: CROP.h })
  assert.equal(result.ok, true)
  assert.equal(result.adjusted, true)
  assert.equal(result.code, 'source-clipped')
  assert.deepEqual(result.magnifier.sourceRect, { x: 250, y: 200, w: 30, h: 60 })
  const centerAfter = magnifier.lensCenter(result.magnifier)
  assert.ok(Math.abs(centerBefore.x - centerAfter.x) < 1e-9)
  assert.ok(Math.abs(centerBefore.y - centerAfter.y) < 1e-9)
})

test('§7.1 a source rect with no intersection is REMOVED, never clamped to an edge sliver', () => {
  const value = makeMagnifier({ sourceRect: { x: 10, y: 10, w: 40, h: 40 } })
  const result = magnifier.clipToCrop(value, CROP)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'source-outside-crop')
  // 关键：不返回一个"贴边的 4px 小矩形" —— 那等于继续采样 crop 外的内容。
  assert.equal(result.magnifier.sourceRect.w, 40)
})

test('§7.1 clipAllToCrop reports what was dropped so one undo frame can restore it', () => {
  const inside = Object.assign(makeMagnifier({ sourceRect: { x: 200, y: 200, w: 80, h: 60 } }), { id: 1 })
  const outside = Object.assign(makeMagnifier({ sourceRect: { x: 10, y: 10, w: 40, h: 40 } }), { id: 2 })
  const partial = Object.assign(makeMagnifier({ sourceRect: { x: 200, y: 200, w: 300, h: 60 } }), { id: 3 })
  const result = magnifier.clipAllToCrop([inside, outside, partial], { x: 250, y: 100, w: 500, h: 600 })
  assert.equal(result.kept.length, 2)
  assert.equal(result.removed.length, 1)
  assert.equal(result.adjusted, true)
  assert.equal(result.removed[0].id, 2)
})

test('§7.1 the document-level clip helper reports removed ids for the undo frame', () => {
  const document = Object.assign(doc.createInitialDocument({ assetId: 'base-a', width: 800, height: 600 }), {
    crop: { x: 300, y: 300, w: 200, h: 200 }
  })
  const survivor = Object.assign(makeMagnifier({ sourceRect: { x: 320, y: 320, w: 40, h: 40 } }), { id: 'a' })
  const doomed = Object.assign(makeMagnifier({ sourceRect: { x: 10, y: 10, w: 40, h: 40 } }), { id: 'b' })
  document.annotations = [survivor, doomed]
  const result = doc.clipMagnifiersToCrop(document)
  assert.deepEqual(result.removedIds, ['b'])
  assert.equal(result.kept.length, 1)
  assert.equal(doc.resolveMagnifiers(document).length, 2, 'resolveMagnifiers is read-only')
})

// ---------- §3.3 对象预算 ----------

test('§3.3 a document may hold at most eight magnifiers', () => {
  assert.equal(magnifier.MAX_PER_DOCUMENT, 8)
  const document = doc.createInitialDocument({ assetId: 'base-a', width: 800, height: 600 })
  const make = (index) => Object.assign(makeMagnifier(), { id: `m${index}` })
  const atLimit = Object.assign({}, document, {
    annotations: Array.from({ length: 8 }, (_, index) => make(index))
  })
  assert.deepEqual(doc.validateDocument(atLimit), { ok: true, errors: [] })
  const overLimit = Object.assign({}, document, {
    annotations: Array.from({ length: 9 }, (_, index) => make(index))
  })
  const validation = doc.validateDocument(overLimit)
  assert.equal(validation.ok, false)
  assert.ok(validation.errors.some((error) => error.code === 'too-many-magnifiers'))
  assert.equal(magnifier.withinBudget(atLimit.annotations), true)
  assert.equal(magnifier.withinBudget(overLimit.annotations), false)
})

// ---------- §7.3 schema v3 集成 ----------

test('§7.3 schema v3 accepts a magnifier and rejects an illegal one', () => {
  assert.equal(doc.SCHEMA_VERSION, 3)
  const document = doc.createInitialDocument({ assetId: 'base-a', width: 800, height: 600 })
  document.annotations = [makeMagnifier()]
  assert.deepEqual(doc.validateDocument(document), { ok: true, errors: [] })
  // 非法倍率
  document.annotations = [Object.assign(makeMagnifier(), { factor: 5 })]
  const badFactor = doc.validateDocument(document)
  assert.equal(badFactor.ok, false)
  assert.ok(badFactor.errors.some((error) => error.code === 'bad-factor'))
  // 源区越界（crop 是整图 800×600，源区跑到图外）
  document.annotations = [makeMagnifier({ sourceRect: { x: 700, y: 500, w: 200, h: 200 } })]
  const badSource = doc.validateDocument(document)
  assert.equal(badSource.ok, false)
  assert.ok(badSource.errors.some((error) => error.code === 'source-outside-crop'))
})

test('§7.3 the annotation survives a serialize/parse round trip and keeps its derived lens', () => {
  const document = doc.createInitialDocument({ assetId: 'base-a', width: 800, height: 600 })
  document.annotations = [makeMagnifier({ factor: 4 })]
  const parsed = doc.parseDocument(doc.serializeDocument(document))
  assert.equal(parsed.ok, true)
  const restored = parsed.document.annotations[0]
  assert.equal(restored.type, 'magnifier')
  assert.equal(restored.factor, 4)
  assert.deepEqual(magnifier.lensRect(restored), { x: 400, y: 400, w: 320, h: 240 })
})

test('§7.3 a magnifier participates in the content fingerprint', () => {
  const document = doc.createInitialDocument({ assetId: 'base-a', width: 800, height: 600 })
  const base = doc.documentFingerprint(document)
  const withOne = doc.documentFingerprint(Object.assign({}, document, { annotations: [makeMagnifier()] }))
  assert.notEqual(base, withOne)
  // 移动镜头位置 = 内容变更（会把画面改掉）。
  const moved = Object.assign({}, document, {
    annotations: [magnifier.translateLens(makeMagnifier(), 40, 0)]
  })
  assert.notEqual(withOne, doc.documentFingerprint(moved))
  // id 不参与指纹（会话身份）。
  const withId = Object.assign({}, document, {
    annotations: [Object.assign(makeMagnifier(), { id: 'session-1' })]
  })
  assert.equal(withOne, doc.documentFingerprint(withId))
})

test('§7.3 the v1 -> v3 chain runs both migrations and lands on a valid document', () => {
  const v1 = {
    schemaVersion: 1,
    coordinateSpace: 'source-pixel',
    documentId: 'document-v1',
    revisionId: 'revision-1',
    baseImage: { assetId: 'base-a', width: 800, height: 600 },
    crop: { x: 0, y: 0, w: 800, h: 600 },
    annotations: [{ type: 'rect', x: 10, y: 10, x2: 100, y2: 100, width: 4, color: '#ff0000' }],
    captureAttachments: { cursor: null },
    captureMetadata: { sourceScaleFactor: 1 }
  }
  const parsed = doc.parseDocument(JSON.stringify(v1))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.document.schemaVersion, 3)
  assert.equal(parsed.migratedFrom, 1)
  assert.equal(parsed.document.outputStyle.enabled, false)
  assert.equal(parsed.document.annotations.length, 1)
  assert.equal(parsed.document.annotations[0].type, 'rect')
})

test('§7.3 v2 -> v3 rewrites nothing, so a v2 document keeps its content fingerprint', () => {
  const document = doc.createInitialDocument({ assetId: 'base-a', width: 800, height: 600 })
  const v2 = Object.assign({}, JSON.parse(JSON.stringify(document)), { schemaVersion: 2 })
  const migrated = doc.MIGRATIONS[2](v2)
  assert.equal(migrated.schemaVersion, 3)
  // 除版本号外一切不变。
  for (const field of ['baseImage', 'crop', 'annotations', 'captureAttachments', 'captureMetadata', 'outputStyle']) {
    assert.deepEqual(migrated[field], v2[field], `${field} must be untouched by the 2 -> 3 migration`)
  }
})

test('§7.3 an unknown annotation type is still rejected at v3 (no silent drop of future objects)', () => {
  const document = doc.createInitialDocument({ assetId: 'base-a', width: 800, height: 600 })
  document.annotations = [{ type: 'smartEraser', x: 10, y: 10 }]
  const validation = doc.validateDocument(document)
  assert.equal(validation.ok, false)
  assert.ok(validation.errors.some((error) => error.code === 'unknown-annotation-type'))
})

// ---------- §7.2 遮挡安全采样 ----------

test('§7.2 only blur objects produce occluders: highlight is not a secrecy tool', () => {
  const annotations = [
    { type: 'blur', x: 10, y: 10, x2: 110, y2: 60, width: 8 },
    { type: 'highlight', x: 10, y: 10, x2: 110, y2: 60, width: 8 },
    { type: 'rect', x: 10, y: 10, x2: 110, y2: 60 },
    { type: 'text', x: 10, y: 10, text: 'secret' }
  ]
  const occluders = occlusion.buildOccluders(annotations)
  assert.equal(occluders.length, 1)
  assert.equal(occluders[0].kind, 'rect')
})

test('§7.2 a rectangle blur masks its whole box plus a conservative margin', () => {
  const occluders = occlusion.buildOccluders([{ type: 'blur', x: 100, y: 50, x2: 200, y2: 150, width: 4 }])
  const bounds = occlusion.occluderBounds(occluders[0])
  assert.equal(occluders[0].margin, occlusion.CONSERVATIVE_MARGIN_PX)
  assert.deepEqual(bounds, {
    x: 100 - occlusion.CONSERVATIVE_MARGIN_PX,
    y: 50 - occlusion.CONSERVATIVE_MARGIN_PX,
    w: 100 + occlusion.CONSERVATIVE_MARGIN_PX * 2,
    h: 100 + occlusion.CONSERVATIVE_MARGIN_PX * 2
  })
})

test('§7.2 a freehand blur masks the full stroke width (half-width plus round caps)', () => {
  const stroke = { type: 'blur', width: 4, points: [{ x: 100, y: 100 }, { x: 300, y: 100 }] }
  const occluders = occlusion.buildOccluders([stroke])
  assert.equal(occluders[0].kind, 'polyline')
  // 笔刷全宽由 annotation-style 的公式给出（4 → 24），遮罩按全宽描边即覆盖半宽与端帽。
  assert.equal(occluders[0].width, occlusion.brushStrokeWidth(4))
  const bounds = occlusion.occluderBounds(occluders[0])
  const half = occluders[0].width / 2 + occlusion.CONSERVATIVE_MARGIN_PX
  assert.equal(bounds.y, 100 - half)
  assert.equal(bounds.h, half * 2)
  assert.equal(bounds.x, 100 - half)
  assert.equal(bounds.w, 200 + half * 2)
})

test('§7.2 the mask brush width matches the renderer, so the mask is never narrower than the ink', () => {
  // 与 capture/annotation-style.js 的 blurBrushWidth 同源：两处必须给出同一个数，否则会出现
  // "屏幕上的马赛克比识别遮罩宽"的泄漏缝。
  //
  // 注意这条只覆盖 scale = 1（两边都不缩放时的纯公式等价）。**真正会出错的是缩放维度**：
  // 先乘 widthScale 再量化 vs 先量化再乘 widthScale，在 scale != 1 上有 60 源像素/侧的差别。
  // 那条断言在 test/capture-magnifier-ui.test.js 的
  // "the lens mask width is never narrower than the mosaic the user actually sees"，
  // 那条是行为断言且带反向对照。这里保留公式同源检查，不要误以为它已经覆盖缩放。
  const styleApi = require('../capture/annotation-style.js')
  for (const width of [2, 4, 8]) {
    assert.equal(occlusion.brushStrokeWidth(width), styleApi.blurBrushWidth(width))
  }
})

test('§7.2 the occlusion plan is expressed in crop-relative source pixels and applied before scaling', () => {
  const plan = occlusion.buildOcclusionPlan({
    crop: { x: 100, y: 100, w: 200, h: 200 },
    annotations: [{ type: 'blur', x: 150, y: 150, x2: 250, y2: 250, width: 4 }]
  })
  assert.equal(plan.masked, true)
  const rect = plan.ops[0]
  assert.equal(rect.kind, 'rect')
  // 相对 crop 原点：150 - 100 - margin = 48。
  assert.equal(rect.x, 150 - 100 - occlusion.CONSERVATIVE_MARGIN_PX)
  assert.equal(rect.y, 150 - 100 - occlusion.CONSERVATIVE_MARGIN_PX)
  // 裁到 crop 边界为止（不越界绘制）。
  assert.ok(rect.x + rect.w <= 200)
  assert.ok(rect.y + rect.h <= 200)
})

test('§7.2 a blur entirely outside the crop produces no ops (it masks nothing sampled)', () => {
  const plan = occlusion.buildOcclusionPlan({
    crop: { x: 100, y: 100, w: 200, h: 200 },
    annotations: [{ type: 'blur', x: 500, y: 500, x2: 600, y2: 600, width: 4 }]
  })
  assert.equal(plan.masked, false)
  assert.deepEqual(plan.ops, [])
})

test('§7.2 deleting the blur is the ONLY thing that lifts protection', () => {
  const crop = { x: 0, y: 0, w: 400, h: 400 }
  const blur = { type: 'blur', x: 50, y: 50, x2: 150, y2: 150, width: 4 }
  assert.equal(occlusion.buildOcclusionPlan({ crop, annotations: [blur] }).masked, true)
  // 显示层的透明度/橡皮擦预览不是文档状态；这里传的是文档快照，因此只要对象还在就遮。
  // 只有对象被显式删除才解除。
  assert.equal(occlusion.buildOcclusionPlan({ crop, annotations: [] }).masked, false)
})

test('§7.2 the mask fingerprint changes with what is masked and not with unrelated fields', () => {
  const base = occlusion.buildOccluders([{ type: 'blur', x: 10, y: 10, x2: 100, y2: 100, width: 4 }])
  const fingerprint = occlusion.maskFingerprint(base)
  // 几何变化 → 变
  const moved = occlusion.buildOccluders([{ type: 'blur', x: 11, y: 10, x2: 100, y2: 100, width: 4 }])
  assert.notEqual(fingerprint, occlusion.maskFingerprint(moved))
  // 颜色/其它无关字段变化 → 不变（改颜色不改变被遮区域，不该让缓存失效）
  const recolored = occlusion.buildOccluders([{ type: 'blur', x: 10, y: 10, x2: 100, y2: 100, width: 4, color: '#00ff00' }])
  assert.equal(fingerprint, occlusion.maskFingerprint(recolored))
  // 数量变化 → 变
  const two = occlusion.buildOccluders([
    { type: 'blur', x: 10, y: 10, x2: 100, y2: 100, width: 4 },
    { type: 'blur', x: 200, y: 200, x2: 300, y2: 300, width: 4 }
  ])
  assert.notEqual(fingerprint, occlusion.maskFingerprint(two))
  // 空遮罩是一个稳定的指纹（可缓存）。
  assert.equal(occlusion.maskFingerprint([]), occlusion.maskFingerprint([]))
})

// ---------- §7.2 缓存键 ----------

test('§7.2 the sample cache key includes base image, crop, mask and source rect - but not the lens position', () => {
  const base = {
    baseImageId: 'base-a',
    crop: { x: 100, y: 100, w: 800, h: 600 },
    maskFingerprint: 'deadbeef',
    sourceRect: { x: 200, y: 200, w: 80, h: 60 },
    factor: 3
  }
  const key = magnifier.sampleCacheKey(base)
  // 移动镜头位置**不**重新采样底图（§7.2 明写）。
  const movedLens = magnifier.sampleCacheKey(Object.assign({}, base, { lensOrigin: { x: 900, y: 900 } }))
  assert.equal(key, movedLens)
  // 改源区 / 改倍率 / 改遮罩 / 换底图 / 改 crop 都必须失效。
  assert.notEqual(key, magnifier.sampleCacheKey(Object.assign({}, base, { sourceRect: { x: 201, y: 200, w: 80, h: 60 } })))
  assert.notEqual(key, magnifier.sampleCacheKey(Object.assign({}, base, { factor: 2 })))
  assert.notEqual(key, magnifier.sampleCacheKey(Object.assign({}, base, { maskFingerprint: 'cafebabe' })))
  assert.notEqual(key, magnifier.sampleCacheKey(Object.assign({}, base, { baseImageId: 'base-b' })))
  assert.notEqual(key, magnifier.sampleCacheKey(Object.assign({}, base, { crop: { x: 101, y: 100, w: 800, h: 600 } })))
})

test('§7.2 the document-level occlusion plan exposes the fingerprint the cache key needs', () => {
  const document = doc.createInitialDocument({ assetId: 'base-a', width: 800, height: 600 })
  document.annotations = [{ type: 'blur', x: 10, y: 10, x2: 110, y2: 110, width: 4 }]
  const plan = doc.resolveOcclusionPlan(document)
  assert.equal(typeof plan.fingerprint, 'string')
  assert.equal(plan.fingerprint.length, 16)
  assert.equal(plan.masked, true)
  // 同一份内容 → 同一个指纹；删除 blur → 变。
  assert.equal(doc.resolveOcclusionPlan(document).fingerprint, plan.fingerprint)
  document.annotations = []
  assert.notEqual(doc.resolveOcclusionPlan(document).fingerprint, plan.fingerprint)
})

// ---------- §7.1 创建流程 ----------

test('§7.1 creating from a dragged rect places the lens clear of the source, inside the crop', () => {
  const created = magnifier.createFromSourceRect({ x: 200, y: 200, w: 80, h: 60 }, { crop: CROP, factor: 3 })
  const lens = magnifier.lensRect(created)
  // 镜头默认在源区右下方，且不和源区重叠。
  assert.equal(magnifier.intersectRects(lens, created.sourceRect), null)
  // 完全在 crop 内（CROP 是 100..900 × 100..700，源区 200..280，镜头 240×180 放在右下可以放下）。
  assert.ok(lens.x + lens.w <= CROP.x + CROP.w)
  assert.ok(lens.y + lens.h <= CROP.y + CROP.h)
})

test('§7.1 creating from a rect with no crop intersection returns null instead of a broken object', () => {
  assert.equal(magnifier.createFromSourceRect({ x: 10, y: 10, w: 40, h: 40 }, { crop: CROP }), null)
})

test('§7.1 a tiny source rect is lifted to the minimum readable edge', () => {
  const created = magnifier.createFromSourceRect({ x: 200, y: 200, w: 1, h: 1 }, { crop: CROP, factor: 2 })
  assert.equal(created.sourceRect.w, magnifier.MIN_SOURCE_EDGE_PX)
  assert.equal(created.sourceRect.h, magnifier.MIN_SOURCE_EDGE_PX)
})

// ---------- §6.2.1 / §7.1 视口往返精度（真实缺陷回归） ----------

test('§7.1 the stroke width survives a viewport round trip at every zoom (no integer rounding, no lower clamp)', () => {
  // 这里钉的是一个真实缺陷：`normalizeMagnifier` 曾把 `stroke.widthPx` 四舍五入成整数并夹到
  // MIN_STROKE_PX。前者让 3 × 0.5 = 1.5 变成 2，除回去得 4（每次重开/缩放累加 1px 漂移）；
  // 后者让 1px 描边在 zoom 0.5 时变成 0.5 视口像素、再被抬到 1、除回去变成 2。
  //
  // 两个方向都会破坏 §6.2.1 "不能只转换端点而漏掉样式几何" —— 边框宽度是同一坐标系里的长度。
  const document = doc.createInitialDocument({ assetId: 'base-a', width: 800, height: 600 })
  const magnifierValue = {
    type: 'magnifier',
    sourceRect: { x: 100, y: 100, w: 80, h: 60 },
    lensOrigin: { x: 400, y: 400 },
    factor: 3,
    stroke: { color: '#ff3b30', widthPx: 3 }
  }
  for (const zoom of [0.25, 0.37, 0.5, 0.65, 0.8, 1, 1.5, 2, 3]) {
    const viewport = doc.resolveViewport({
      baseSize: { width: 800, height: 600 },
      crop: { x: 0, y: 0, w: 800, h: 600 },
      zoom,
      offsetX: 0,
      offsetY: 0
    })
    for (const widthPx of [1, 2, 3, 4, 7, 12.5, 24]) {
      const value = Object.assign({}, magnifierValue, { stroke: { color: '#ff3b30', widthPx } })
      const viewportAnnotations = doc.annotationsToViewport([value], viewport)
      const roundTripped = doc.annotationsFromViewport(viewportAnnotations, viewport)
      // 存源像素的值必须精确回来；视口中间值可以不是整数（0.5 描边是合法的视口长度）。
      assert.ok(
        Math.abs(roundTripped[0].stroke.widthPx - widthPx) < 1e-6,
        `zoom ${zoom}: widthPx ${widthPx} round-tripped to ${roundTripped[0].stroke.widthPx}`
      )
      // 视口值确实是缩放后的值（不是被夹回文档范围）。
      assert.ok(
        Math.abs(viewportAnnotations[0].stroke.widthPx - widthPx * zoom) < 1e-6,
        `zoom ${zoom}: viewport widthPx ${viewportAnnotations[0].stroke.widthPx} must equal ${widthPx * zoom}`
      )
    }
  }
  // 几何（源区/镜头/倍率/引线）本来就必须精确。
  const viewport = doc.resolveViewport({
    baseSize: { width: 800, height: 600 }, crop: { x: 100, y: 100, w: 400, h: 300 },
    zoom: 0.65, offsetX: 10, offsetY: 20
  })
  const roundTripped = doc.annotationsFromViewport(doc.annotationsToViewport([magnifierValue], viewport), viewport)
  assert.deepEqual(roundTripped[0].sourceRect, magnifierValue.sourceRect)
  assert.deepEqual(roundTripped[0].lensOrigin, magnifierValue.lensOrigin)
  assert.equal(roundTripped[0].factor, 3)
  assert.equal(roundTripped[0].connector, 'none')
  assert.equal(document.schemaVersion, doc.SCHEMA_VERSION)
})

test('§7.1 normalization quantises float noise without clamping the document range', () => {
  // 量化到 1/1000 的目的：`1 * 0.37 / 0.37` = 1.0000000000000002，若不量化，内容指纹会在每次
  // 重开后判成"有编辑"（§6.3 "打开不增版、不变脏"）。
  assert.equal(magnifier.normalizeMagnifier({ stroke: { widthPx: 1.0000000000000002 } }).stroke.widthPx, 1)
  assert.equal(magnifier.normalizeMagnifier({ stroke: { widthPx: 12.5 } }).stroke.widthPx, 12.5)
  // 但**不再**夹到文档范围：视口空间里 0.5 是合法长度，夹取会让往返丢值。
  assert.equal(magnifier.normalizeMagnifier({ stroke: { widthPx: 0.5 } }).stroke.widthPx, 0.5)
  assert.equal(magnifier.normalizeMagnifier({ stroke: { widthPx: 999 } }).stroke.widthPx, 999)
  // 范围是 validateMagnifier 的职责（只在判断"这是不是一份合法文档"时生效）。
  for (const widthPx of [0, 0.5, 25, 999]) {
    const report = magnifier.validateMagnifier({
      type: 'magnifier', sourceRect: { x: 200, y: 200, w: 80, h: 60 },
      lensOrigin: { x: 400, y: 400 }, factor: 2, stroke: { widthPx }
    })
    assert.equal(report.ok, false, `widthPx ${widthPx} must be rejected by validation`)
    assert.ok(report.errors.some((error) => error.code === 'out-of-range'))
  }
  for (const widthPx of [1, 2, 4, 24]) {
    assert.equal(magnifier.validateMagnifier({
      type: 'magnifier', sourceRect: { x: 200, y: 200, w: 80, h: 60 },
      lensOrigin: { x: 400, y: 400 }, factor: 2, stroke: { widthPx }
    }).ok, true, `widthPx ${widthPx} must be a legal document value`)
  }
  // 正数下限仍在，防止绘制端除零。
  assert.ok(magnifier.normalizeMagnifier({ stroke: { widthPx: -5 } }).stroke.widthPx > 0)
  assert.ok(magnifier.normalizeMagnifier({ stroke: { widthPx: 0 } }).stroke.widthPx > 0)
})
