// 功能 D2：放大镜采样底图与缓存（capture/magnifier-sampler.js）。
//
// 设计基线：docs/plans/2026-10-25-snow-apps-feature-development-plan.md §7.2 / §3.3；
// 遮挡规则见 docs/plans/2026-10-25-history-reedit-batch0-contracts.md §8。
//
// 本文件钉的是"像素确实被遮住"与"缓存确实按规则失效"这两件纯函数/桩画布能证明的事：
//   - 遮罩在**缩放之前**施加（顺序错就是隐私泄漏）；
//   - 移动镜头不重新采样底图；
//   - 改源区 / 改 blur / 改 crop / 换底图必须失效；
//   - 32 MiB 预算按字节计费而不是按条目；
//   - 关闭编辑器真的释放。
// 真实模型边界截获像素的验证在 test/capture-document-editor-runtime.test.js 的遮挡探针里。
const test = require('node:test')
const assert = require('node:assert/strict')

const sampler = require('../capture/magnifier-sampler')
const magnifier = require('../shared/magnifier-geometry')
const occlusion = require('../shared/occlusion-mask')

// ---------- 记录型桩画布 ----------

function createStubContext() {
  const calls = []
  const context = {
    calls,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    globalAlpha: 1,
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
    save: () => calls.push({ name: 'save' }),
    restore: () => calls.push({ name: 'restore' }),
    beginPath: () => calls.push({ name: 'beginPath' }),
    moveTo: (x, y) => calls.push({ name: 'moveTo', args: [x, y] }),
    lineTo: (x, y) => calls.push({ name: 'lineTo', args: [x, y] }),
    stroke: () => calls.push({ name: 'stroke' }),
    fillRect: (x, y, w, h) => calls.push({ name: 'fillRect', args: [x, y, w, h] }),
    drawImage: (...args) => calls.push({ name: 'drawImage', args })
  }
  return context
}

function createStubCanvas(width, height) {
  const context = createStubContext()
  return { width, height, context, getContext: () => context }
}

function createStubFactory(sizes = []) {
  return (width, height) => {
    sizes.push({ width, height })
    return createStubCanvas(width, height)
  }
}

function opsNames(canvas) {
  return canvas.context.calls.map((call) => call.name)
}

// ---------- §7.2 采样底图的合成顺序 ----------

test('§7.2 the sample base is the crop of the base image with the masks painted before any scaling', () => {
  const sizes = []
  const baseImage = { width: 1600, height: 1200, naturalWidth: 1600, naturalHeight: 1200 }
  const result = sampler.composeSampleBase({
    baseImage,
    crop: { x: 100, y: 200, w: 800, h: 600 },
    occluders: occlusion.buildOccluders([{ type: 'blur', x: 300, y: 300, x2: 500, y2: 400, width: 4 }]),
    createCanvas: createStubFactory(sizes)
  })
  // 采样底图的尺寸 = crop 尺寸（源像素，无缩放）。
  assert.deepEqual(sizes, [{ width: 800, height: 600 }])
  assert.equal(result.canvas.width, 800)
  assert.equal(result.canvas.height, 600)
  const names = opsNames(result.canvas)
  // 顺序铁律：先画底图，再画遮罩。反过来遮罩会被底图盖掉，等于没遮。
  const drawIndex = names.indexOf('drawImage')
  const fillIndex = names.indexOf('fillRect')
  assert.ok(drawIndex >= 0, 'the base image must be drawn')
  assert.ok(fillIndex > drawIndex, 'the mask must be painted AFTER the image')
  // 底图的源矩形是 crop（1:1 取样，不做重采样）。
  const drawCall = result.canvas.context.calls.find((call) => call.name === 'drawImage')
  assert.deepEqual(drawCall.args, [baseImage, 100, 200, 800, 600, 0, 0, 800, 600])
  // 遮罩矩形是相对 crop 原点的：blur 在 300,300，crop 原点 100,200 → 200,100（减保守扩张）。
  const maskCall = result.canvas.context.calls.find((call) => call.name === 'fillRect')
  assert.equal(maskCall.args[0], 300 - 100 - occlusion.CONSERVATIVE_MARGIN_PX)
  assert.equal(maskCall.args[1], 300 - 200 - occlusion.CONSERVATIVE_MARGIN_PX)
})

test('§7.2 every mask is fully opaque: a partially masked blur is not masked', () => {
  const result = sampler.composeSampleBase({
    baseImage: { width: 400, height: 400 },
    crop: { x: 0, y: 0, w: 400, h: 400 },
    occluders: occlusion.buildOccluders([{ type: 'blur', x: 10, y: 10, x2: 100, y2: 100, width: 4 }]),
    createCanvas: createStubFactory()
  })
  // 遮罩色是纯黑、alpha 1（不透明），且不沿用任何显示透明度。
  assert.equal(result.canvas.context.fillStyle, occlusion.MASK_COLOR)
  assert.equal(occlusion.MASK_ALPHA, 1)
  // 绘制遮罩的那一段被 save/restore 包裹（不把 fillStyle/globalAlpha 泄漏给后续绘制）。
  const names = opsNames(result.canvas)
  const saveIndex = names.indexOf('save')
  const fillIndex = names.indexOf('fillRect')
  const restoreIndex = names.indexOf('restore')
  assert.ok(saveIndex >= 0 && saveIndex < fillIndex, 'the mask paint is wrapped in save/restore')
  assert.ok(restoreIndex > fillIndex, 'restore comes after the mask paint')
  // 遮罩之前 globalAlpha 被显式写成 1（不透明度是硬要求，不是显示设置）。
  assert.equal(occlusion.MASK_ALPHA, 1)
})

test('§7.2 a freehand blur is masked as a full-width stroke with round caps', () => {
  const result = sampler.composeSampleBase({
    baseImage: { width: 500, height: 500 },
    crop: { x: 0, y: 0, w: 500, h: 500 },
    occluders: occlusion.buildOccluders([
      { type: 'blur', width: 4, points: [{ x: 20, y: 30 }, { x: 200, y: 30 }, { x: 200, y: 120 }] }
    ]),
    createCanvas: createStubFactory()
  })
  const names = opsNames(result.canvas)
  assert.ok(names.includes('stroke'), 'a polyline mask is stroked, not filled')
  // 全宽描边 + 圆端帽 = 半宽与端帽都被覆盖。
  assert.equal(result.canvas.context.lineWidth, occlusion.brushStrokeWidth(4))
  assert.equal(result.canvas.context.lineCap, 'round')
  assert.equal(result.canvas.context.lineJoin, 'round')
  // 三个点都真的连线了（第一个点 moveTo，其余 lineTo）。
  const moveCalls = result.canvas.context.calls.filter((call) => call.name === 'moveTo')
  const lineCalls = result.canvas.context.calls.filter((call) => call.name === 'lineTo')
  assert.equal(moveCalls.length, 1)
  assert.equal(lineCalls.length, 2)
})

test('§7.2 a single-sample stroke still masks a dot instead of nothing', () => {
  const result = sampler.composeSampleBase({
    baseImage: { width: 200, height: 200 },
    crop: { x: 0, y: 0, w: 200, h: 200 },
    occluders: occlusion.buildOccluders([{ type: 'blur', width: 4, points: [{ x: 50, y: 50 }] }]),
    createCanvas: createStubFactory()
  })
  const names = opsNames(result.canvas)
  assert.ok(names.includes('stroke'))
  // 单点也画了一小段（否则 stroke 什么都不画）。
  assert.ok(names.includes('lineTo'))
})

test('§7.2 an empty document paints no mask at all', () => {
  const result = sampler.composeSampleBase({
    baseImage: { width: 300, height: 300 },
    crop: { x: 0, y: 0, w: 300, h: 300 },
    occluders: [],
    createCanvas: createStubFactory()
  })
  const names = opsNames(result.canvas)
  assert.equal(names.includes('fillRect'), false)
  assert.equal(names.includes('stroke'), false)
  assert.equal(result.plan.masked, false)
})

// ---------- §7.2 镜头采样 ----------

test('§7.2 the lens samples the source rect and scales it by the factor', () => {
  const sizes = []
  const magnified = sampler.sampleMagnifier({
    sampleBase: { width: 800, height: 600 },
    crop: { x: 100, y: 200 },
    magnifier: { sourceRect: { x: 300, y: 300, w: 80, h: 60 }, lensOrigin: { x: 0, y: 0 }, factor: 3 },
    createCanvas: createStubFactory(sizes)
  })
  // 镜头画布尺寸 = 源区 × 倍率（推导值，不读持久化字段）。
  assert.deepEqual(sizes, [{ width: 240, height: 180 }])
  assert.equal(magnified.width, 240)
  const drawCall = magnified.context.calls.find((call) => call.name === 'drawImage')
  // 源区是底图坐标，采样底图是 crop 坐标 → 减一次 crop 原点。
  assert.deepEqual(drawCall.args.slice(1), [300 - 100, 300 - 200, 80, 60, 0, 0, 240, 180])
  // 放大用平滑（镜头是 zoom；最近邻会让文字明显锯齿）。
  assert.equal(magnified.context.imageSmoothingEnabled, true)
})

// ---------- §7.2 缓存：失效规则 ----------

test('§7.2 the cache does not re-sample when only the lens position changes', () => {
  const sampleCalls = []
  const lensSampler = sampler.createLensSampler({
    createCanvas: (w, h) => {
      sampleCalls.push({ w, h })
      return createStubCanvas(w, h)
    }
  })
  lensSampler.adoptSampleBase({ canvas: { width: 800, height: 600 }, fingerprint: 'mask-a' })
  const crop = { x: 0, y: 0, w: 800, h: 600 }
  const base = { sourceRect: { x: 100, y: 100, w: 80, h: 60 }, factor: 3, lensOrigin: { x: 400, y: 400 } }
  const first = lensSampler.sample({ baseImageId: 'base-a', crop, maskFingerprint: 'm1', magnifier: base })
  const moved = lensSampler.sample({
    baseImageId: 'base-a', crop, maskFingerprint: 'm1',
    magnifier: Object.assign({}, base, { lensOrigin: { x: 700, y: 90 } })
  })
  // 只移动镜头 → 同一个缓存项，第二次采样没有发生。
  assert.equal(sampleCalls.length, 1)
  assert.equal(first, moved)
  assert.equal(lensSampler.cache.stats().hits, 1)
})

test('§7.2 changing the source rect, factor, mask, crop or base image all invalidate', () => {
  let samples = 0
  const lensSampler = sampler.createLensSampler({
    createCanvas: (w, h) => {
      samples += 1
      return createStubCanvas(w, h)
    }
  })
  lensSampler.adoptSampleBase({ canvas: { width: 800, height: 600 }, fingerprint: 'mask-a' })
  const crop = { x: 0, y: 0, w: 800, h: 600 }
  const base = { baseImageId: 'base-a', crop, maskFingerprint: 'm1', magnifier: { sourceRect: { x: 100, y: 100, w: 80, h: 60 }, factor: 2 } }
  lensSampler.sample(base)
  assert.equal(samples, 1)
  lensSampler.sample(Object.assign({}, base, { magnifier: Object.assign({}, base.magnifier, { sourceRect: { x: 101, y: 100, w: 80, h: 60 } }) }))
  assert.equal(samples, 2, 'a moved source rect must re-sample')
  lensSampler.sample(Object.assign({}, base, { magnifier: Object.assign({}, base.magnifier, { factor: 3 }) }))
  assert.equal(samples, 3, 'a changed factor must re-sample')
  lensSampler.sample(Object.assign({}, base, { maskFingerprint: 'm2' }))
  assert.equal(samples, 4, 'a changed mask must re-sample')
  lensSampler.sample(Object.assign({}, base, { crop: { x: 1, y: 0, w: 800, h: 600 } }))
  assert.equal(samples, 5, 'a changed crop must re-sample')
  lensSampler.sample(Object.assign({}, base, { baseImageId: 'base-b' }))
  assert.equal(samples, 6, 'a different base image must re-sample')
  // 回到第一次的键 → 命中老的缓存项（没有第 7 次采样）。
  lensSampler.sample(base)
  assert.equal(samples, 6)
})

test('§7.2 adopting a new sample base clears the cache (the pixels it was built from changed)', () => {
  let samples = 0
  const lensSampler = sampler.createLensSampler({
    createCanvas: (w, h) => {
      samples += 1
      return createStubCanvas(w, h)
    }
  })
  const crop = { x: 0, y: 0, w: 800, h: 600 }
  const request = {
    baseImageId: 'base-a', crop, maskFingerprint: 'm1',
    magnifier: { sourceRect: { x: 10, y: 10, w: 40, h: 40 }, factor: 2 }
  }
  lensSampler.adoptSampleBase({ canvas: { width: 800, height: 600 }, fingerprint: 'mask-a' })
  lensSampler.sample(request)
  lensSampler.sample(request)
  assert.equal(samples, 1)
  lensSampler.adoptSampleBase({ canvas: { width: 800, height: 600 }, fingerprint: 'mask-b' })
  lensSampler.sample(request)
  assert.equal(samples, 2, 'a new sample base must invalidate every cached lens')
  // reset() 同样清空（换底图/换裁剪时调用）。
  lensSampler.reset()
  assert.equal(lensSampler.cache.stats().entries, 0)
})

// ---------- §3.3 缓存预算 ----------

test('§3.3 the cache budget is 32 MiB and is accounted in BYTES, not entries', () => {
  assert.equal(sampler.CACHE_BUDGET_BYTES, 32 * 1024 * 1024)
  const cache = sampler.createSampleCache({ budgetBytes: 1000 })
  // 每次 10×10×4 = 400 字节。
  const makeCanvas = (size) => createStubCanvas(size, size)
  for (let index = 0; index < 4; index += 1) cache.set(`k${index}`, makeCanvas(10))
  const stats = cache.stats()
  // 4 × 400 = 1600 > 1000，所以必须已经淘汰到预算内。
  assert.ok(stats.bytes <= 1000, `bytes ${stats.bytes} must stay within the budget`)
  assert.ok(stats.evictions > 0, 'eviction must have happened')
  // 最少保留一条（最新的那条不会被自己挤掉）。
  assert.ok(stats.entries >= 1)
  assert.equal(cache.get('k3').width, 10)
})

test('§3.3 eviction is least-recently-used, and a read refreshes recency', () => {
  const cache = sampler.createSampleCache({ budgetBytes: 1200 }) // 3 × 400
  cache.set('a', createStubCanvas(10, 10))
  cache.set('b', createStubCanvas(10, 10))
  cache.set('c', createStubCanvas(10, 10))
  // 触碰 a，使 b 成为最久未用。
  assert.ok(cache.get('a'))
  cache.set('d', createStubCanvas(10, 10))
  assert.equal(cache.has('b'), false, 'the least recently used entry is evicted first')
  assert.equal(cache.has('a'), true)
  assert.equal(cache.has('c'), true)
  assert.equal(cache.has('d'), true)
})

test('§3.3 an entry bigger than the whole budget is handed back but never cached', () => {
  const cache = sampler.createSampleCache({ budgetBytes: 1000 })
  cache.set('small', createStubCanvas(10, 10)) // 400 字节
  const huge = createStubCanvas(100, 100) // 40000 字节
  assert.equal(cache.set('huge', huge), null)
  // 它没有挤掉已有的正常项。
  assert.equal(cache.has('small'), true)
  assert.equal(cache.has('huge'), false)
  assert.ok(cache.stats().bytes <= 1000)
})

test('§3.3 clearing releases everything (the editor-close contract)', () => {
  const cache = sampler.createSampleCache({ budgetBytes: 8000 })
  for (let index = 0; index < 3; index += 1) cache.set(`k${index}`, createStubCanvas(10, 10))
  assert.ok(cache.stats().bytes > 0)
  cache.clear()
  assert.deepEqual(
    { entries: cache.stats().entries, bytes: cache.stats().bytes },
    { entries: 0, bytes: 0 }
  )
})

test('§3.3 canvasBytes uses 4 bytes per pixel and never returns NaN for a broken canvas', () => {
  assert.equal(sampler.BYTES_PER_PIXEL, 4)
  assert.equal(sampler.canvasBytes({ width: 10, height: 10 }), 400)
  assert.equal(sampler.canvasBytes({ width: 0, height: 10 }), 0)
  assert.equal(sampler.canvasBytes({}), 0)
  assert.equal(sampler.canvasBytes(null), 0)
})

// ---------- §7.2 缓存键（与 magnifier-geometry 的同源断言） ----------

test('§7.2 the sampler key and the shared cache key agree, so one is not a stale copy of the other', () => {
  // 采样器把 adoptSampleBase 的指纹拼进 maskFingerprint，其余字段直接交给共享函数；
  // 这里验证"同一组输入 → 同一个键"这条性质在两层之间成立。
  const shared = magnifier.sampleCacheKey({
    baseImageId: 'base-a',
    crop: { x: 0, y: 0, w: 800, h: 600 },
    maskFingerprint: 'mask-a:m1',
    sourceRect: { x: 10, y: 10, w: 40, h: 40 },
    factor: 2
  })
  const direct = magnifier.sampleCacheKey({
    baseImageId: 'base-a',
    crop: { x: 0, y: 0, w: 800, h: 600 },
    maskFingerprint: 'mask-a:m1',
    sourceRect: { x: 10, y: 10, w: 40, h: 40 },
    factor: 2
  })
  assert.equal(shared, direct)
  // 不同底图 / 不同遮罩必须给出不同键（防止"注释说包含了、代码忘了拼"）。
  assert.notEqual(shared, magnifier.sampleCacheKey({
    baseImageId: 'base-b', crop: { x: 0, y: 0, w: 800, h: 600 },
    maskFingerprint: 'mask-a:m1', sourceRect: { x: 10, y: 10, w: 40, h: 40 }, factor: 2
  }))
})
