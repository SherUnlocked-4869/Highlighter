// 功能 C：成品样式（shared/capture-output-style.js）+ 合成器（capture/output-compositor.js）
// + 文档 schema v2 的成品几何契约。
//
// 设计基线：docs/plans/2026-10-25-snow-apps-feature-development-plan.md §6.1–§6.4。
// 这里钉的是"两端不可能给出不同答案"的那几条：原图等价、几何只算一次、预算在分配前检查、
// 参数参与内容指纹、v1 打开不变脏、v1→v2 迁移不猜字段。
//
// 纯函数 + 桩画布，不依赖 Electron，也不需要真实像素（渲染层的观感由实机清单负责）。
const test = require('node:test')
const assert = require('node:assert/strict')

const style = require('../shared/capture-output-style')
const compositor = require('../capture/output-compositor')
const doc = require('../shared/capture-document')

const CONTENT = { width: 800, height: 600 }

function cardStyle(overrides = {}) {
  return style.normalizeOutputStyle(Object.assign({
    enabled: true,
    paddingPx: 48,
    background: { color: '#f5f5f7', alpha: 1 },
    cornerRadiusPx: 16,
    border: { widthPx: 1, color: '#d8d8dd' },
    shadow: { enabled: true, blurPx: 32, offsetXPx: 0, offsetYPx: 12, color: '#000000', alpha: 0.18 }
  }, overrides))
}

// ---------- 录调用序列的桩画布 ----------

function createStubContext() {
  const calls = []
  const record = (name) => (...args) => { calls.push({ name, args }) }
  const context = {
    calls,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    imageSmoothingEnabled: true,
    save: record('save'),
    restore: record('restore'),
    beginPath: record('beginPath'),
    closePath: record('closePath'),
    clip: record('clip'),
    fill: record('fill'),
    stroke: record('stroke'),
    rect: record('rect'),
    roundRect: record('roundRect'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    arcTo: record('arcTo'),
    drawImage: record('drawImage')
  }
  return context
}

function createStubCanvas(width, height) {
  const context = createStubContext()
  return {
    width,
    height,
    context,
    getContext: () => context
  }
}

function createStubFactory(sizes = []) {
  const factory = (width, height) => {
    const canvas = createStubCanvas(width, height)
    sizes.push({ width, height })
    return canvas
  }
  return factory
}

// ---------- §6.1 三个预设 ----------

test('§6.1 three presets exist, are addressable by id, and the original preset is disabled', () => {
  assert.deepEqual([...style.PRESET_IDS], ['original', 'card-light', 'card-dark'])
  for (const id of style.PRESET_IDS) {
    const preset = style.OUTPUT_STYLE_PRESETS[id]
    assert.ok(preset, `preset ${id} must exist`)
    assert.equal(preset.id, id)
    // i18n key rather than a literal: the panel renders it, the module must not carry copy.
    assert.match(preset.labelKey, /^capture\.output\./)
    assert.equal(style.normalizeOutputStyle(preset.style).enabled, id !== 'original')
  }
  // 原图预设就是默认值本身，不是"另一份等价参数"。
  assert.deepEqual(style.presetStyle('original'), style.normalizeOutputStyle(style.DEFAULT_OUTPUT_STYLE))
  // 未知 id 回落到原图，而不是抛错（UI 偏好可能被手改成垃圾）。
  assert.deepEqual(style.presetStyle('does-not-exist'), style.presetStyle('original'))
})

test('§6.1 the card presets differ in background and shadow so the preview is visibly distinct', () => {
  const light = style.presetStyle('card-light')
  const dark = style.presetStyle('card-dark')
  assert.notEqual(light.background.color, dark.background.color)
  assert.ok(dark.shadow.alpha > light.shadow.alpha)
  // 两者的几何一致：预设切换只改外观，不改成品尺寸（否则同一张图不同预设会跳尺寸）。
  const geometryLight = style.resolveOutputGeometry({ ...CONTENT, outputStyle: light })
  const geometryDark = style.resolveOutputGeometry({ ...CONTENT, outputStyle: dark })
  assert.deepEqual(geometryLight, geometryDark)
})

// ---------- §6.2 原图等价：最重要的那条 ----------

test('§6.2 a disabled style is byte-identical to v1 geometry and ignores every other parameter', () => {
  const plain = style.resolveOutputGeometry({ ...CONTENT, outputStyle: { enabled: false } })
  assert.deepEqual(plain, { width: 800, height: 600, contentOffsetX: 0, contentOffsetY: 0 })
  // 即使把留白/圆角/阴影全都填上，禁用态也必须完全忽略它们 —— 这是 v1 提交校验
  // （结果尺寸 == crop）继续成立的前提。
  const loaded = style.resolveOutputGeometry({
    ...CONTENT,
    outputStyle: {
      enabled: false,
      paddingPx: 200,
      cornerRadiusPx: 100,
      border: { widthPx: 20, color: '#ff0000' },
      shadow: { enabled: true, blurPx: 128, offsetXPx: 40, offsetYPx: 40, color: '#000000', alpha: 1 }
    }
  })
  assert.deepEqual(loaded, plain)
})

test('§6.2 the plan for a disabled style has no decoration rectangles to draw', () => {
  const plan = style.planOutputComposite({ ...CONTENT, outputStyle: { enabled: false } })
  assert.equal(plan.enabled, false)
  assert.equal(plan.shadow, null)
  assert.equal(plan.border, null)
  assert.deepEqual(plan.content, { x: 0, y: 0, width: 800, height: 600, radius: 0 })
})

// ---------- §6.2 统一几何 ----------

test('§6.2 padding grows the card, the finite shadow bleed grows the canvas, and offsets shift it', () => {
  const geometry = style.resolveOutputGeometry({ ...CONTENT, outputStyle: cardStyle() })
  const bleed = Math.ceil(32 * style.SHADOW_BLEED_FACTOR)
  // 内容 800×600 + 2×48 留白 = 896×696 的板；阴影 blur 32 → 外扩 48（1.5×）。
  // 阴影向下偏移 12，所以下边外扩 = 48 + 12，上边只有 48。
  assert.equal(geometry.width, 896 + bleed * 2)
  assert.equal(geometry.height, 696 + bleed + (bleed + 12))
  assert.equal(geometry.contentOffsetX, bleed + 48)
  // 内容偏移只算上边（下边的额外 12px 是阴影自己的空间，内容不跟着动）。
  assert.equal(geometry.contentOffsetY, bleed + 48)
})

test('§6.2 a zero-blur shadow contributes no bleed, and a negative offset shifts only its own side', () => {
  const noBlur = style.normalizeOutputStyle({ enabled: true, shadow: { enabled: true, blurPx: 0, offsetYPx: 40 } })
  assert.deepEqual(style.shadowExtents(noBlur.shadow), { left: 0, top: 0, right: 0, bottom: 0, bleed: 0 })
  const plan = style.planOutputComposite({ ...CONTENT, outputStyle: noBlur })
  assert.equal(plan.width, 800)
  assert.equal(plan.height, 600)
  // Disabled shadow with a blur set is still no bleed: `enabled` gates it.
  const disabled = style.normalizeOutputStyle({ enabled: true, shadow: { enabled: false, blurPx: 64 } })
  assert.equal(style.shadowExtents(disabled.shadow).bleed, 0)
  // 负偏移只扩大左上，不扩大右下。
  const up = style.normalizeOutputStyle({ enabled: true, shadow: { enabled: true, blurPx: 20, offsetXPx: -10, offsetYPx: -10 } })
  const extents = style.shadowExtents(up.shadow)
  assert.equal(extents.left, 40)
  assert.equal(extents.top, 40)
  assert.equal(extents.right, 30)
  assert.equal(extents.bottom, 30)
})

test('§6.2 the corner radius is concentric: the card radius is the content radius plus the padding', () => {
  const plan = style.planOutputComposite({ ...CONTENT, outputStyle: cardStyle({ cornerRadiusPx: 16, paddingPx: 48 }) })
  assert.equal(plan.content.radius, 16)
  assert.equal(plan.card.radius, 64)
  // 半径永远不超过短边的一半（否则 canvas 的圆角几何会退化成怪异形状）。
  const huge = style.planOutputComposite({ ...CONTENT, outputStyle: cardStyle({ cornerRadiusPx: 512, paddingPx: 0 }) })
  assert.equal(huge.content.radius, 300)
})

test('§6.2 the same parameters always produce the same geometry (one function, no drift)', () => {
  const input = { ...CONTENT, outputStyle: cardStyle() }
  const first = style.resolveOutputGeometry(input)
  // 参数顺序不同、带多余未知字段、数字是字符串 —— 归一化后必须是同一个答案。
  const shuffled = style.resolveOutputGeometry({
    outputStyle: {
      shadow: { alpha: '0.18', offsetYPx: '12', blurPx: 32, enabled: true, color: '#000000', offsetXPx: 0 },
      border: { color: '#d8d8dd', widthPx: 1 },
      cornerRadiusPx: 16,
      background: { alpha: 1, color: '#f5f5f7' },
      paddingPx: 48,
      enabled: true,
      somethingFromTheFuture: 'ignored'
    },
    contentHeight: 600,
    contentWidth: 800
  })
  assert.deepEqual(shuffled, first)
})

// ---------- §3.3 预算在分配之前 ----------

test('§3.3 the pixel budget is checked before a canvas is allocated', () => {
  const budget = style.assertOutputBudget({ width: 800, height: 600 })
  assert.equal(budget.ok, true)
  assert.equal(budget.pixels, 480000)
  assert.equal(style.assertOutputBudget({ width: 0, height: 600 }).code, 'empty-output')
  // 超过单边上限
  const tall = style.assertOutputBudget({ width: 10, height: style.LIMITS.MAX_OUTPUT_EDGE_PX + 1 })
  assert.equal(tall.ok, false)
  assert.equal(tall.code, 'output-too-large')
  // 单边都不超但总量超
  const area = style.assertOutputBudget({ width: 12000, height: 12000 })
  assert.equal(area.ok, false)
  assert.equal(area.code, 'output-too-large')
  assert.ok(area.pixels > style.LIMITS.MAX_OUTPUT_PIXELS)
})

test('§3.3 the compositor refuses an over-budget style instead of silently shrinking it', () => {
  const content = createStubCanvas(16000, 16000)
  const sizes = []
  assert.throws(
    () => compositor.composeOutputCanvas({
      contentCanvas: content,
      outputStyle: { enabled: true, paddingPx: 512 },
      createCanvas: createStubFactory(sizes)
    }),
    (error) => error.code === 'output-too-large'
  )
  // 拒绝时一次画布分配都没有发生。
  assert.deepEqual(sizes, [])
})

// ---------- §6.1 合成器：调用顺序与内容层 ----------

test('§6.1 the compositor returns null for the original style so the shipped path is reused verbatim', () => {
  const content = createStubCanvas(800, 600)
  assert.equal(compositor.composeOutputCanvas({ contentCanvas: content, outputStyle: { enabled: false } }), null)
  assert.equal(compositor.composeOutputCanvas({ contentCanvas: content }), null)
})

test('§6.1 the compositor draws shadow, then card, then the clipped content, then the border', () => {
  const content = createStubCanvas(800, 600)
  const sizes = []
  const canvas = compositor.composeOutputCanvas({
    contentCanvas: content,
    outputStyle: cardStyle(),
    createCanvas: createStubFactory(sizes)
  })
  const geometry = style.resolveOutputGeometry({ ...CONTENT, outputStyle: cardStyle() })
  assert.deepEqual(sizes, [{ width: geometry.width, height: geometry.height }])
  assert.equal(canvas.width, geometry.width)
  assert.equal(canvas.height, geometry.height)
  const calls = canvas.context.calls
  const names = calls.map((call) => call.name)
  // 阴影填充必须早于背景板填充，背景板必须早于内容 drawImage，边框 stroke 最晚。
  const firstFill = names.indexOf('fill')
  const drawImageAt = names.indexOf('drawImage')
  const lastStroke = names.lastIndexOf('stroke')
  assert.ok(firstFill >= 0 && firstFill < drawImageAt, 'the shadow/card fills precede the content')
  assert.ok(drawImageAt < lastStroke, 'the border is stroked after the content')
  // 内容层被**裁切**后绘制：clip 必须出现在 drawImage 之前。
  assert.ok(names.indexOf('clip') >= 0 && names.indexOf('clip') < drawImageAt, 'content is clipped by its radius')
  // drawImage 的目标矩形就是 plan 的内容矩形。
  const drawCall = calls.find((call) => call.name === 'drawImage')
  assert.deepEqual(drawCall.args.slice(1), [
    geometry.contentOffsetX,
    geometry.contentOffsetY,
    800,
    600
  ])
  // 阴影属性确实来自 outputStyle，而不是硬编码。
  assert.equal(canvas.context.shadowBlur, 32)
  assert.equal(canvas.context.shadowOffsetY, 12)
  assert.match(canvas.context.shadowColor, /^rgba\(0,0,0,0\.18\)$/)
})

test('§6.1 the preview scale multiplies the canvas and every offset but not the source content', () => {
  const content = createStubCanvas(800, 600)
  const sizes = []
  const canvas = compositor.composeOutputCanvas({
    contentCanvas: content,
    outputStyle: cardStyle(),
    scale: 0.5,
    createCanvas: createStubFactory(sizes)
  })
  const full = style.resolveOutputGeometry({ ...CONTENT, outputStyle: cardStyle() })
  assert.deepEqual(sizes, [{ width: Math.round(full.width * 0.5), height: Math.round(full.height * 0.5) }])
  const drawCall = canvas.context.calls.find((call) => call.name === 'drawImage')
  // 偏移与尺寸都乘 scale —— 预览和导出是同一个函数，只是分辨率不同。
  assert.deepEqual(drawCall.args.slice(1), [
    full.contentOffsetX * 0.5,
    full.contentOffsetY * 0.5,
    400,
    300
  ])
  // 几何计算本身不受 scale 影响（源像素是唯一单位）。
  assert.deepEqual(compositor.composeOutputGeometry({
    contentWidth: 800, contentHeight: 600, outputStyle: cardStyle(), scale: 0.5
  }).width, Math.round(full.width * 0.5))
})

test('§6.1 composeOutputGeometry matches composeOutputCanvas for the same style and scale', () => {
  for (const scale of [1, 0.37, 2]) {
    const geometry = compositor.composeOutputGeometry({
      contentWidth: 1234, contentHeight: 777, outputStyle: cardStyle(), scale
    })
    const sizes = []
    const canvas = compositor.composeOutputCanvas({
      contentCanvas: createStubCanvas(1234, 777),
      outputStyle: cardStyle(),
      scale,
      createCanvas: createStubFactory(sizes)
    })
    assert.deepEqual(sizes, [{ width: geometry.width, height: geometry.height }])
    assert.equal(canvas.width, geometry.width)
    assert.equal(canvas.height, geometry.height)
  }
})

test('§6.1 an injected plan is honoured so preview geometry and export cannot drift', () => {
  const plan = style.planOutputComposite({ ...CONTENT, outputStyle: cardStyle() })
  const sizes = []
  const canvas = compositor.composeOutputCanvas({
    contentCanvas: createStubCanvas(800, 600),
    outputStyle: cardStyle(),
    plan,
    createCanvas: createStubFactory(sizes)
  })
  assert.deepEqual(sizes, [{ width: plan.width, height: plan.height }])
  assert.equal(canvas.width, plan.width)
})

test('§6.1 the compositor refuses to guess a canvas implementation in a DOM-less environment', () => {
  assert.throws(
    () => compositor.composeOutputCanvas({ contentCanvas: createStubCanvas(10, 10), outputStyle: cardStyle() }),
    /createCanvas/
  )
  // 原图模式不需要画布，所以在没有 DOM 的环境里也必须能安全返回 null。
  assert.equal(compositor.composeOutputCanvas({ contentCanvas: createStubCanvas(10, 10) }), null)
})

// ---------- §6.2 参数校验 ----------

test('§6.2 out-of-range and badly typed style parameters are rejected, not clamped', () => {
  assert.deepEqual(style.validateOutputStyle({ enabled: false }), { ok: true, errors: [] })
  const reports = [
    [{ enabled: 'yes' }, 'bad-enabled'],
    [{ enabled: true, paddingPx: 99999 }, 'out-of-range'],
    [{ enabled: true, paddingPx: 12.5 }, 'bad-number'],
    [{ enabled: true, cornerRadiusPx: -1 }, 'out-of-range'],
    [{ enabled: true, background: { color: 'red' } }, 'bad-color'],
    [{ enabled: true, background: { alpha: 2 } }, 'out-of-range'],
    [{ enabled: true, border: { widthPx: 100 } }, 'out-of-range'],
    [{ enabled: true, shadow: { blurPx: 4096 } }, 'out-of-range'],
    [{ enabled: true, shadow: { offsetXPx: -9999 } }, 'out-of-range'],
    [{ enabled: true, shadow: { color: '#zzz' } }, 'bad-color'],
    [{ enabled: true, fromTheFuture: 1 }, 'unknown-field']
  ]
  for (const [value, expectedCode] of reports) {
    const result = style.validateOutputStyle(value)
    assert.equal(result.ok, false, `${JSON.stringify(value)} must be rejected`)
    assert.ok(
      result.errors.some((error) => error.code === expectedCode),
      `${JSON.stringify(value)} should report ${expectedCode}, got ${result.errors.map((e) => e.code).join(',')}`
    )
  }
})

test('§6.2 normalization is the repair path and never produces NaN or an unbounded value', () => {
  const repaired = style.normalizeOutputStyle({
    enabled: 'true-ish',
    paddingPx: Number.NaN,
    cornerRadiusPx: Infinity,
    background: { color: 'not-a-color', alpha: Number.POSITIVE_INFINITY },
    shadow: { enabled: true, blurPx: -50, offsetXPx: 'nope', color: '#ABCDEF', alpha: 5 }
  })
  assert.equal(repaired.enabled, false)
  assert.equal(repaired.paddingPx, 0)
  assert.equal(repaired.cornerRadiusPx, 0)
  assert.equal(repaired.background.color, '#ffffff')
  assert.equal(repaired.background.alpha, 1)
  assert.equal(repaired.shadow.blurPx, 0)
  assert.equal(repaired.shadow.offsetXPx, 0)
  assert.equal(repaired.shadow.color, '#abcdef')
  assert.equal(repaired.shadow.alpha, 1)
  for (const value of Object.values(repaired)) {
    if (typeof value === 'number') assert.ok(Number.isFinite(value))
  }
})

test('§6.2 outputStyleEquals compares normalized structure, not preset identity', () => {
  assert.equal(style.outputStyleEquals({ enabled: true, paddingPx: 48 }, { enabled: true, paddingPx: '48' }), true)
  assert.equal(style.outputStyleEquals({ enabled: true, paddingPx: 48 }, { enabled: true, paddingPx: 49 }), false)
  assert.equal(style.outputStyleEquals(undefined, { enabled: false }), true)
})

// ---------- §6.2 / §6.3 文档侧：几何与指纹 ----------

test('§6.2 the document contract resolves the composite geometry from crop + outputStyle', () => {
  const document = doc.createInitialDocument({ assetId: 'base-a', width: 800, height: 600 })
  // 新文档 = 原图模式：结果尺寸就是 crop。
  assert.deepEqual(doc.resolveOutputGeometry(document), { width: 800, height: 600, contentOffsetX: 0, contentOffsetY: 0 })
  const styled = Object.assign({}, document, {
    schemaVersion: doc.SCHEMA_VERSION,
    crop: { x: 10, y: 20, w: 800, h: 600 },
    outputStyle: cardStyle()
  })
  const geometry = doc.resolveOutputGeometry(styled)
  assert.deepEqual(geometry, style.resolveOutputGeometry({ contentWidth: 800, contentHeight: 600, outputStyle: cardStyle() }))
  // crop 的原点**不**参与成品尺寸（成品只关心裁剪后的内容尺寸）。
  assert.equal(geometry.width, style.resolveOutputGeometry({ contentWidth: 800, contentHeight: 600, outputStyle: cardStyle() }).width)
  // plan 与 geometry 是同一次计算的两种视图。
  const plan = doc.resolveOutputPlan(styled)
  assert.deepEqual(style.geometryFromPlan(plan), geometry)
})

test('§6.3 the style participates in the content fingerprint, so a parameter change is a new version', () => {
  const base = doc.createInitialDocument({ assetId: 'base-a', width: 800, height: 600 })
  const styled = Object.assign({}, base, { outputStyle: cardStyle() })
  assert.notEqual(doc.documentFingerprint(base), doc.documentFingerprint(styled))
  // 只改一个滑块值也必须变指纹（"参数变化纳入内容指纹"）。
  const nudged = Object.assign({}, base, { outputStyle: cardStyle({ paddingPx: 49 }) })
  assert.notEqual(doc.documentFingerprint(styled), doc.documentFingerprint(nudged))
  // 反向：同一个参数、不同的书写形式 → 同一个指纹（否则每次保存都假 dirty）。
  const same = Object.assign({}, base, { outputStyle: cardStyle({ paddingPx: '48' }) })
  assert.equal(doc.documentFingerprint(styled), doc.documentFingerprint(same))
  // dirty 判定：相对基线。
  const clean = doc.documentFingerprint(base)
  assert.equal(doc.isDocumentDirty(base, clean), false)
  assert.equal(doc.isDocumentDirty(styled, clean), true)
})

test('§6.3 opening a v1 document does not dirty it: the migration and normalisation agree', () => {
  const v1 = {
    schemaVersion: 1,
    coordinateSpace: 'source-pixel',
    documentId: 'document-v1',
    revisionId: 'revision-v1',
    baseImage: { assetId: 'base-a', width: 800, height: 600 },
    crop: { x: 5, y: 6, w: 700, h: 500 },
    annotations: [{ type: 'arrow', x: 1, y: 2, x2: 3, y2: 4, width: 4, color: '#ff0000' }],
    captureAttachments: { cursor: null },
    captureMetadata: { sourceScaleFactor: 1 }
  }
  const parsed = doc.parseDocument(JSON.stringify(v1))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.migratedFrom, 1)
  assert.equal(parsed.document.schemaVersion, doc.SCHEMA_VERSION)
  // 迁移后的样式必须是禁用态：几何与 v1 相同。
  assert.equal(parsed.document.outputStyle.enabled, false)
  assert.deepEqual(doc.resolveOutputGeometry(parsed.document), {
    width: 700, height: 500, contentOffsetX: 0, contentOffsetY: 0
  })
  // 关键：迁移结果与"直接 normalize 同一内容"的指纹必须一致，否则编辑器一打开就是 dirty。
  const rendererSide = doc.normalizeDocument(Object.assign({}, v1, { schemaVersion: doc.SCHEMA_VERSION }))
  assert.equal(doc.documentFingerprint(parsed.document), doc.documentFingerprint(rendererSide))
  assert.equal(doc.isDocumentDirty(parsed.document, doc.documentFingerprint(rendererSide)), false)
})

test('§6.3 the v1 -> v2 migration adds nothing but the disabled style', () => {
  const v1 = {
    schemaVersion: 1,
    coordinateSpace: 'source-pixel',
    baseImage: { assetId: 'base-a', width: 800, height: 600 },
    crop: { x: 0, y: 0, w: 800, h: 600 },
    annotations: [],
    captureAttachments: { cursor: null },
    captureMetadata: { sourceScaleFactor: 1 }
  }
  const migrated = doc.MIGRATIONS[1](v1)
  assert.equal(migrated.schemaVersion, 2)
  assert.deepEqual(migrated.outputStyle, doc.normalizeDocument({}).outputStyle)
  // 迁移不得改动任何其它字段（尤其不能重写 crop、不能改标注、不能加 view/source）。
  for (const field of ['baseImage', 'crop', 'annotations', 'captureAttachments', 'captureMetadata']) {
    assert.deepEqual(migrated[field], v1[field], `${field} must be untouched by the migration`)
  }
  assert.equal(migrated.view, undefined)
  assert.equal(migrated.documentId, undefined)
})

test('§6.2 a v2 document without a style is rejected (absent content has no defined geometry)', () => {
  const missing = {
    schemaVersion: doc.SCHEMA_VERSION,
    coordinateSpace: 'source-pixel',
    baseImage: { assetId: 'base-a', width: 800, height: 600 },
    crop: { x: 0, y: 0, w: 800, h: 600 },
    annotations: [],
    captureAttachments: { cursor: null },
    captureMetadata: { sourceScaleFactor: 1 }
  }
  const validation = doc.validateDocument(missing)
  assert.equal(validation.ok, false)
  assert.ok(validation.errors.some((error) => error.code === 'missing-output-style'))
  // 载入路径给出 invalid-document，而不是"未来版本"（否则会走仅位图降级）。
  const parsed = doc.parseDocument(JSON.stringify(missing))
  assert.equal(parsed.ok, false)
  assert.equal(parsed.code, 'invalid-document')
  // 一个样式参数越界的 v2 文档同样走 invalid-document。
  const outOfRange = doc.parseDocument(JSON.stringify(Object.assign({}, missing, {
    outputStyle: { enabled: true, paddingPx: 99999 }
  })))
  assert.equal(outOfRange.ok, false)
  assert.equal(outOfRange.code, 'invalid-document')
})

test('§6.2 the lazily upgraded legacy bitmap always lands in the original style', () => {
  const upgraded = doc.createLegacyDocument({ assetId: 'base-old', width: 1200, height: 800 })
  // 底图里可能已经烘焙了装饰；升级路径再加一次框就是"累计叠加外框"（§6.3 明令禁止）。
  assert.equal(upgraded.document.outputStyle.enabled, false)
  assert.deepEqual(doc.resolveOutputGeometry(upgraded.document), {
    width: 1200, height: 800, contentOffsetX: 0, contentOffsetY: 0
  })
})

test('§6.2 a new document defaults to the disabled style, so a first save is decoration-free', () => {
  const created = doc.createInitialDocument({ assetId: 'base-a', width: 640, height: 480 })
  assert.deepEqual(created.outputStyle, doc.normalizeDocument({}).outputStyle)
  assert.deepEqual(doc.validateDocument(created), { ok: true, errors: [] })
  // 显式传入的样式会被保留（新截图也可以直接带用户偏好的预设）。
  const withStyle = doc.createInitialDocument({
    assetId: 'base-a', width: 640, height: 480, outputStyle: style.presetStyle('card-light')
  })
  assert.equal(withStyle.outputStyle.enabled, true)
  assert.deepEqual(doc.validateDocument(withStyle), { ok: true, errors: [] })
})

test('§6.2 the style survives a serialize/parse round trip unchanged', () => {
  const document = doc.createInitialDocument({ assetId: 'base-a', width: 800, height: 600 })
  document.outputStyle = cardStyle()
  const parsed = doc.parseDocument(doc.serializeDocument(document))
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.document.outputStyle, cardStyle())
  assert.equal(doc.documentFingerprint(parsed.document), doc.documentFingerprint(document))
})
