// H02 —— 马赛克画笔缓存预算计数器泄漏的回归用例。
//
// 评审报告（docs/reviews/2026-11-26-code-review-and-optimization-report.md「二、2」）：
// 旧实现是 `new WeakMap()`（以标注对象引用为键）+ `let mosaicPatchBytes`。拖拽/方向键/
// 缩放/改样式每帧替换 annotations[i] 的对象，WeakMap 丢掉旧键但计数器不扣字节，十几帧后
// 16 MiB 预算永久占满，所有马赛克笔触退化为每帧重建两个离屏 Canvas；涂抹中的
// activeAnnotation 又没有 id，因此完全不缓存。
//
// 本文件分两层：
//   行为层 —— 直接 require 新抽出的 capture/mosaic-patch-cache.js，覆盖"同一个 id 重复写
//             不增长 / 超预算 LRU 逐出且字节精确归零 / 删除扣减 / 不同 id 互不影响 /
//             访问刷新顺序 / 涂抹提交 rename"；并接上真实的 annotation-geometry 纯函数，
//             证明拖拽/缩放/样式生成的新对象确实保留 id。
//   结构层 —— 断言 capture.js 的调用点（拖拽、方向键、缩放、样式修改、涂抹中）确实走新的
//             账本 API，且旧的"永不扣减"路径已不存在。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  MOSAIC_PATCH_BUDGET,
  patchBytesOf,
  cacheKeyOf,
  createMosaicPatchCache
} = require('../capture/mosaic-patch-cache')
const {
  translateAnnotation,
  resizeAnnotationToBox,
  cloneAnnotations
} = require('../capture/annotation-geometry')

const root = path.join(__dirname, '..')
const script = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')
const html = fs.readFileSync(path.join(root, 'capture', 'capture.html'), 'utf8')
const moduleSource = fs.readFileSync(path.join(root, 'capture', 'mosaic-patch-cache.js'), 'utf8')

function sliceBetween(source, from, to) {
  const start = source.indexOf(from)
  const end = source.indexOf(to)
  assert.ok(start >= 0 && end > start, `could not slice ${from} .. ${to}`)
  return source.slice(start, end)
}

// 一个只带尺寸的假补丁：账本只读 canvas.width / canvas.height，不需要 DOM。
function patchOf(width, height, marker) {
  return { canvas: { width, height }, marker }
}

// 结构切面：每个切面正好是 ledger 的一个既定调用点。
const pointerdownSource = sliceBetween(script, "canvas.addEventListener('pointerdown'", "canvas.addEventListener('pointermove'")
const pointermoveSource = sliceBetween(script, "canvas.addEventListener('pointermove'", "canvas.addEventListener('pointerup'")
const pointercancelSource = sliceBetween(script, "canvas.addEventListener('pointercancel'", "canvas.addEventListener('wheel'")
const overlaySource = sliceBetween(script, 'function renderOverlay()', 'function render()')
const fingerprintSource = sliceBetween(script, 'function mosaicPatchKey(item, deviceScale)', 'function beginMosaicPatchIdentity()')
const identitySource = sliceBetween(script, 'function beginMosaicPatchIdentity()', 'function invalidateMosaicPatches()')
const invalidateSource = sliceBetween(script, 'function invalidateMosaicPatches()', '// §3.2.2')
const buildSource = sliceBetween(script, 'function buildMosaicPatch(item, deviceScale, sourceImage, reusable)', 'function drawMosaicStroke(')
const drawMosaicSource = sliceBetween(script, 'function drawMosaicStroke(context, item', 'function drawAnnotation(context, item')
const commitSource = sliceBetween(script, 'function commitAnnotation(item)', 'function clampSettingNumber(')
const penContinuationSource = sliceBetween(script, 'function beginPenContinuation(item, point, event)', '// pointercancel: the gesture never happened')
const moveSource = sliceBetween(script, 'function moveAnnotationTo(point)', 'function moveMagnifierPart(item, part, dx, dy)')
const nudgeSource = sliceBetween(script, 'function nudgeSelectedAnnotation(event)', 'function commitNudge()')
const resizeSource = sliceBetween(script, 'function resizeAnnotationTo(point)', 'function annotationWasResized(')
const styleSource = sliceBetween(script, 'function writeAnnotationStyles(targets, patch, fields, ownership)', 'function commitSelectedStyle(patch)')

// ---------- 行为层：账本本身 ----------

test('H02: repeated writes for one committed id never grow the ledger (the drag/nudge/resize regression)', () => {
  const cache = createMosaicPatchCache({ budget: MOSAIC_PATCH_BUDGET })
  // 300×300 的补丁是 360 000 bytes；旧实现拖拽 60 帧就会把 16 MiB 预算记账记满。
  const frameBytes = 300 * 300 * 4
  for (let frame = 0; frame < 60; frame += 1) {
    assert.equal(cache.put(7, `drag-frame:${frame}`, patchOf(300, 300, frame)), true)
    assert.equal(cache.size, 1, `frame ${frame} must overwrite, not append`)
    assert.equal(cache.bytes, frameBytes, `frame ${frame} must not accumulate the old entry's bytes`)
  }
  assert.deepEqual(cache.keys(), [7])
  assert.ok(cache.bytes < MOSAIC_PATCH_BUDGET)
})

test('H02: overwriting the same id deducts exactly, including a smaller or larger replacement', () => {
  const cache = createMosaicPatchCache({ budget: MOSAIC_PATCH_BUDGET })
  cache.put(1, 'small', patchOf(10, 10))
  assert.equal(cache.bytes, 400)
  cache.put(1, 'wide', patchOf(20, 10))
  assert.equal(cache.bytes, 800, 'the replacement must not leave the 400 bytes behind')
  cache.put(1, 'tiny', patchOf(5, 5))
  assert.equal(cache.bytes, 100)
  assert.equal(cache.size, 1)
  assert.equal(cache.get(1).fingerprint, 'tiny')
})

test('H02: over-budget inserts evict the least recently used entry and bytes go back to zero', () => {
  const cache = createMosaicPatchCache({ budget: 800 })
  const patch = () => patchOf(10, 10) // 400 bytes each
  assert.equal(cache.put(1, 'one', patch()), true)
  assert.equal(cache.put(2, 'two', patch()), true)
  assert.equal(cache.bytes, 800)
  // 第三条放不下：最旧的 id=1 被逐出并扣减，总量仍恰好等于预算。
  assert.equal(cache.put(3, 'three', patch()), true)
  assert.deepEqual(cache.keys(), [2, 3])
  assert.equal(cache.bytes, 800)
  assert.equal(cache.get(1), null, 'the evicted entry is gone')
  // 再放一条：最旧的 id=2 被逐出。
  cache.put(4, 'four', patch())
  assert.deepEqual(cache.keys(), [3, 4])
  assert.equal(cache.bytes, 800)
  // 逐条删除后账本精确归零（不是"接近 0"）。
  while (cache.size) cache.delete(cache.keys()[0])
  assert.equal(cache.bytes, 0)
  assert.deepEqual(cache.keys(), [])
  // 单个补丁本身超过整个预算：不入账，但也绝不把账本扣成负数。
  assert.equal(cache.put(5, 'huge', patchOf(40, 40)), false)
  assert.equal(cache.bytes, 0)
  assert.equal(cache.size, 0)
})

test('H02: delete(item) deducts exactly, per id, and never touches another id', () => {
  const cache = createMosaicPatchCache({ budget: MOSAIC_PATCH_BUDGET })
  cache.put(1, 'a', patchOf(10, 10)) // 400
  cache.put({ id: 2 }, 'b', patchOf(20, 10)) // 800
  cache.put(3, 'c', patchOf(4, 4)) // 64
  assert.equal(cache.bytes, 1264)
  // 样式写回传的是标注对象：账本按 item.id 解析，精确扣减这一条。
  assert.equal(cache.delete({ id: 2 }), true)
  assert.equal(cache.bytes, 464)
  assert.deepEqual(cache.keys(), [1, 3])
  assert.equal(cache.get(2), null)
  assert.equal(cache.delete(1), true)
  assert.equal(cache.bytes, 64)
  // 重复删除 / 不存在的 id / 非法键都是 no-op，绝不能把 bytes 变成负数。
  assert.equal(cache.delete(1), false)
  assert.equal(cache.delete(9), false)
  for (const invalid of [0, null, undefined, '', Number.NaN, true, {}]) {
    assert.equal(cache.delete(invalid), false, `invalid delete key ${String(invalid)}`)
  }
  assert.equal(cache.bytes, 64)
  cache.clear()
  assert.equal(cache.bytes, 0)
  assert.equal(cache.size, 0)
})

test('H02: LRU access refreshes the order, so a recently read entry survives the next eviction', () => {
  const cache = createMosaicPatchCache({ budget: 800 })
  const patch = () => patchOf(10, 10)
  cache.put(1, 'one', patch())
  cache.put(2, 'two', patch())
  assert.deepEqual(cache.keys(), [1, 2])
  // 访问 id=1 之后，最旧的是 id=2。
  assert.equal(cache.get(1).fingerprint, 'one')
  assert.deepEqual(cache.keys(), [2, 1])
  cache.put(3, 'three', patch())
  assert.deepEqual(cache.keys(), [1, 3])
  assert.equal(cache.get(2), null, 'the least recently used entry is the one evicted')
  assert.equal(cache.get(1).marker, undefined)
  // 未知键 / 非法键返回 null，不创建条目。
  assert.equal(cache.get(99), null)
  assert.equal(cache.get(null), null)
  assert.equal(cache.get(0), null)
  assert.equal(cache.size, 2)
})

test('H02: a live gesture reuses one entry and commit renames it to the committed id', () => {
  const cache = createMosaicPatchCache({ budget: MOSAIC_PATCH_BUDGET })
  // 涂抹中：同一个负数 draft id，每帧点集变长、补丁变大。
  cache.put(-1, 'draft:0', patchOf(10, 10))
  assert.equal(cache.bytes, 400)
  cache.put(-1, 'draft:1', patchOf(30, 10))
  assert.equal(cache.bytes, 1200, 'the gesture must only ever account one patch')
  assert.equal(cache.size, 1)
  const draftPatch = cache.get(-1).patch
  // 提交：临时 identity 移交到 item.id，条目本身（以及离屏 Canvas）被沿用，不重复记账。
  assert.equal(cache.rename(-1, 42), true)
  assert.equal(cache.get(-1), null)
  const committed = cache.get(42)
  assert.equal(committed.patch, draftPatch, 'the offscreen canvas survives the commit')
  assert.equal(committed.fingerprint, 'draft:1')
  assert.equal(cache.bytes, 1200)
  assert.deepEqual(cache.keys(), [42])
  // 提交之后拖拽：还是同一个 id，只是指纹变了；字节仍然是"一条补丁"。
  cache.put(42, 'move:0', patchOf(20, 20))
  assert.equal(cache.bytes, 1600)
  assert.equal(cache.size, 1)
  // rename 的边界：目标缺失 / 非法身份都是 no-op。
  assert.equal(cache.rename(-1, 99), false)
  assert.equal(cache.rename(42, 42), true)
  assert.equal(cache.rename(null, 5), false)
})

test('H02: patchBytesOf normalizes malformed canvases instead of poisoning the ledger', () => {
  assert.equal(patchBytesOf(patchOf(10, 20)), 800)
  assert.equal(patchBytesOf(patchOf(10.9, 2.1)), 80, 'canvas dimensions are floored integers')
  assert.equal(patchBytesOf({ canvas: { width: '10', height: '20' } }), 800)
  for (const broken of [null, undefined, {}, { canvas: null }, { canvas: { width: Number.NaN, height: 10 } }, { canvas: { width: -5, height: 4 } }]) {
    assert.equal(patchBytesOf(broken), 0, `broken patch ${JSON.stringify(broken)} costs 0`)
  }
  assert.equal(cacheKeyOf({ id: 12 }), 12)
  assert.equal(cacheKeyOf(-3), -3)
  assert.equal(cacheKeyOf('draft:1'), 'draft:1')
  for (const invalid of [0, null, undefined, Number.NaN, {}, { id: 0 }, '']) {
    assert.equal(cacheKeyOf(invalid), null)
  }
  assert.equal(MOSAIC_PATCH_BUDGET, 16 * 1024 * 1024)
  assert.equal(createMosaicPatchCache().budget, MOSAIC_PATCH_BUDGET)
})

test('H02: real geometry edits keep the id, so their new objects overwrite the same ledger entry', () => {
  // capture.js 的四个编辑点都靠"新对象 + 原 id"这层契约让账本成为覆盖写；这里用真实的
  // annotation-geometry 纯函数证明它不是"只有注释这么说"。
  const cache = createMosaicPatchCache({ budget: MOSAIC_PATCH_BUDGET })
  const original = {
    id: 42,
    type: 'blur',
    x: 100,
    y: 100,
    x2: 300,
    y2: 150,
    color: '#ff3b30',
    width: 4,
    points: [{ x: 100, y: 100 }, { x: 300, y: 150 }]
  }
  const fingerprintOf = (item) => [item.width, item.x, item.y, item.x2, item.y2, item.points.length].join('|')
  cache.put(original.id, fingerprintOf(original), patchOf(300, 100))
  assert.equal(cache.bytes, 120000)

  const moved = translateAnnotation(original, 10, -20)
  assert.equal(moved.id, 42, 'drag/render copies keep the stable id')
  cache.put(moved.id, fingerprintOf(moved), patchOf(310, 100))
  assert.equal(cache.size, 1)
  assert.equal(cache.bytes, 124000, 'a move replaces the bytes instead of accumulating them')

  const resized = resizeAnnotationToBox(moved, { x: 120, y: 90, w: 400, h: 200 })
  assert.equal(resized.id, 42, 'resize copies keep the stable id')
  cache.put(resized.id, fingerprintOf(resized), patchOf(410, 210))
  assert.equal(cache.size, 1)
  assert.equal(cache.bytes, 410 * 210 * 4)

  const styled = Object.assign({}, resized, { width: 8 })
  assert.equal(styled.id, 42, 'style writes keep the stable id')
  cache.put(styled.id, fingerprintOf(styled), patchOf(400, 200))
  const cloned = cloneAnnotations([styled])[0]
  assert.equal(cloned.id, 42, 'undo snapshots keep the stable id')
  assert.equal(cache.size, 1)
  assert.equal(cache.bytes, 400 * 200 * 4)
})

// ---------- 结构层：capture.js 的调用点 ----------

test('H02: capture.js instantiates the ledger module and the leaking WeakMap/counter is gone', () => {
  // 模块由 capture.html 在 capture.js 之前加载，capture.js 只在加载期读一次全局。
  const moduleIndex = html.indexOf('<script src="mosaic-patch-cache.js"></script>')
  assert.ok(moduleIndex > 0, 'capture.html must load capture/mosaic-patch-cache.js')
  assert.ok(moduleIndex > html.indexOf('src="annotation-geometry.js"'), 'the ledger loads with the other capture helpers')
  assert.ok(moduleIndex < html.indexOf('src="capture.js"'), 'the ledger must load BEFORE capture.js')
  assert.match(script, /const \{ createMosaicPatchCache, MOSAIC_PATCH_BUDGET \} = window\.mosaicPatchCache/)
  assert.match(script, /const mosaicPatchCache = createMosaicPatchCache\(\{ budget: MOSAIC_PATCH_BUDGET \}\)/)
  // 旧缺陷的两个载体必须彻底消失：对象身份 WeakMap 与永不扣减的裸计数器。
  assert.doesNotMatch(script, /new WeakMap\(\)/, 'the identity-keyed WeakMap must be gone')
  assert.doesNotMatch(script, /^let mosaicPatchBytes\b/m, 'the never-deducted byte counter must be gone')
  assert.doesNotMatch(script, /mosaicPatchBytes\s*[-+]?=/, 'the counter must not be read or written anywhere anymore')
  assert.doesNotMatch(script, /mosaicPatchCache\.set\(/, 'the old WeakMap .set path must be gone')
  assert.doesNotMatch(script, /if \(item\.id && bytes <= MOSAIC_PATCH_BUDGET\)/, 'the "only committed items, no deduction" gate must be gone')
  // 失效点仍是同一个函数，账本换成了有界 LRU 的 clear()。
  assert.match(invalidateSource, /function invalidateMosaicPatches\(\) \{\s*mosaicPatchCache\.clear\(\)\s*\}/)
  assert.doesNotMatch(invalidateSource, /mosaicPatchCache\s*=/)
})

test('H02: the draw path keys patches by stable identity and overwrites through the ledger', () => {
  // 指纹本身（像素/网格相位的输入）保持不变 —— H02 不碰渲染结果。
  assert.match(fingerprintSource, /return \[item\.width, deviceScale, box\.x, box\.y, box\.w, box\.h, points\.length, first\.x, first\.y, last\.x, last\.y\]\.join\('\|'\)/)
  // 已提交标注用 item.id，涂抹中的手势用稳定的 draft id。
  assert.match(identitySource, /function mosaicPatchIdentity\(item\) \{[\s\S]{0,220}?if \(item === activeAnnotation && activeMosaicPatchId\) return activeMosaicPatchId[\s\S]{0,160}?return typeof item\.id === 'number' && item\.id !== 0 \? item\.id : null/)
  // 绘制：get(identity) → 指纹不符则重建（拿旧补丁复用 Canvas）→ put(identity) 覆盖并精确扣旧字节。
  assert.match(drawMosaicSource, /const identity = mosaicPatchIdentity\(item\)/)
  assert.match(drawMosaicSource, /const cached = identity === null \? null : mosaicPatchCache\.get\(identity\)/)
  assert.match(drawMosaicSource, /let patch = cached && cached\.fingerprint === fingerprint \? cached\.patch : null/)
  assert.match(drawMosaicSource, /patch = buildMosaicPatch\(item, deviceScale, sourceImage, cached && cached\.patch\)/)
  assert.match(drawMosaicSource, /if \(identity !== null\) mosaicPatchCache\.put\(identity, fingerprint, patch\)/)
  assert.match(drawMosaicSource, /if \(identity !== null\) mosaicPatchCache\.delete\(identity\)/)
  // 复用的是同一组离屏 Canvas：旧代码对涂抹中每一帧都 createElement 两个。
  assert.match(buildSource, /const tiny = reusable && reusable\.tiny \? reusable\.tiny : document\.createElement\('canvas'\)/)
  assert.match(buildSource, /const patch = reusable && reusable\.canvas \? reusable\.canvas : document\.createElement\('canvas'\)/)
  assert.equal((buildSource.match(/document\.createElement\('canvas'\)/g) || []).length, 2, 'the only full allocations left are the two first-use fallbacks')
})

test('H02: the live gesture gets a draft identity before its first frame, commit renames it', () => {
  assert.match(identitySource, /function beginMosaicPatchIdentity\(\) \{[\s\S]{0,400}?activeMosaicPatchId = -\(\+\+mosaicDraftSeq\)/)
  assert.match(identitySource, /function settleMosaicPatchIdentity\(committedId\) \{[\s\S]{0,400}?if \(committedId\) mosaicPatchCache\.rename\(draftId, committedId\)[\s\S]{0,200}?else mosaicPatchCache\.delete\(draftId\)/)
  // pointerdown 在创建 activeAnnotation 之后、第一次 render 之前分配临时 identity。
  assert.match(pointerdownSource, /activeAnnotation=\{type:currentTool[\s\S]{0,400}?beginMosaicPatchIdentity\(\)/)
  const creationIndex = pointerdownSource.indexOf('activeAnnotation={type:currentTool')
  const identityIndex = pointerdownSource.lastIndexOf('beginMosaicPatchIdentity()')
  assert.ok(creationIndex >= 0 && identityIndex > creationIndex, 'the draft identity is allocated when the stroke object is created')
  // 续画同样进入涂抹态。
  assert.match(penContinuationSource, /activeAnnotation = Object\.assign\(\{\}, item, \{[\s\S]{0,500}?beginMosaicPatchIdentity\(\)/)
  // 提交：先落 id，再把账本条目 rename 到该 id（顺序不能反，否则 rename 拿不到已提交 id）。
  assert.match(commitSource, /item\.id = \+\+annotationSeq[\s\S]{0,200}?settleMosaicPatchIdentity\(item\.id\)/)
  assert.ok(
    commitSource.indexOf('item.id = ++annotationSeq') < commitSource.indexOf('settleMosaicPatchIdentity(item.id)'),
    'the committed id must be assigned before the ledger entry is renamed to it'
  )
  // 取消：丢弃手势 = 立即释放临时条目。
  assert.match(pointercancelSource, /settleMosaicPatchIdentity\(0\)/)
})

test('H02: every edit that replaces an annotation object still overwrites one ledger entry (drag/nudge/resize/style/active)', () => {
  // 拖拽：新副本写回数组，id 原样带过（账本因此把它识别为覆盖而不是新条目）。
  assert.match(moveSource, /const moved = clampAnnotationToStage\(/)
  assert.match(moveSource, /annotations\[index\] = moved/)
  assert.doesNotMatch(moveSource, /moved\.id\s*=/)
  // 方向键微调：同一套"每帧从 origin 重算的新副本"。
  assert.match(nudgeSource, /const next = clampAnnotationToStage\(/)
  assert.match(nudgeSource, /annotations\[index\] = next/)
  assert.doesNotMatch(nudgeSource, /next\.id\s*=/)
  // 元素缩放：新副本 + 原 id。
  assert.match(resizeSource, /const resized = resizeAnnotationToBox\(state\.origin, box\)/)
  assert.match(resizeSource, /annotations\[index\] = resized/)
  assert.doesNotMatch(resizeSource, /resized\.id\s*=/)
  // 样式修改：Object.assign({}, target) 保留 id，并显式扣掉旧补丁（宽度会改变补丁像素）。
  assert.match(styleSource, /const styled = Object\.assign\(\{\}, target\)/)
  assert.match(styleSource, /annotations\[index\] = styled/)
  assert.match(styleSource, /mosaicPatchCache\.delete\(target\)/)
  assert.doesNotMatch(styleSource, /styled\.id\s*=/)
  // 涂抹中：renderOverlay 也会绘制 activeAnnotation，所以它必须也已经带稳定 identity。
  assert.match(pointermoveSource, /if \(activeAnnotation\) \{ appendStrokePoint\(point, event\); render\(\) \}/)
  const committedDrawIndex = overlaySource.indexOf('annotations.forEach((item) => drawAnnotation(ctx,item))')
  const activeDrawIndex = overlaySource.indexOf('if (activeAnnotation) drawAnnotation(ctx,activeAnnotation)')
  assert.ok(committedDrawIndex >= 0 && activeDrawIndex > committedDrawIndex, 'the in-progress stroke is painted through the same drawAnnotation/drawMosaicStroke path')
  // 每个编辑点都在写回后重绘；重绘是落到账本的唯一入口（buildMosaicPatch / drawMosaicStroke
  // 各只有一个定义 + 一个调用点，没有第二条"绕开账本"的绘制路径）。
  const rendersAfter = (source, write) => {
    const writeIndex = source.indexOf(write)
    const renderIndex = source.indexOf('render()', writeIndex)
    return writeIndex >= 0 && renderIndex > writeIndex
  }
  assert.ok(rendersAfter(moveSource, 'annotations[index] = moved'), 'a drag repaints after the write-back, which is what reaches the ledger')
  assert.ok(rendersAfter(nudgeSource, 'annotations[index] = next'), 'a nudge repaints after the write-back')
  assert.ok(rendersAfter(resizeSource, 'annotations[index] = resized'), 'a resize repaints after the write-back')
  assert.ok(rendersAfter(styleSource, 'annotations[index] = styled'), 'a style edit repaints after the write-back')
  assert.equal((script.match(/buildMosaicPatch\(/g) || []).length, 2, 'one definition + one call: the ledger is the only patch producer')
  assert.equal((script.match(/drawMosaicStroke\(/g) || []).length, 2, 'one definition + one call: every mosaic pixel goes through the ledger-aware draw path')
})

test('H02: the ledger module is a pure UMD module the Node tests can require', () => {
  // 与 capture/annotation-geometry.js 同构：Node 下 module.exports，渲染层挂全局名。
  assert.match(moduleSource, /if \(typeof module === 'object' && module\.exports\) module\.exports = api/)
  assert.match(moduleSource, /else root\.mosaicPatchCache = api/)
  assert.match(moduleSource, /root\.mosaicPatchCache\s*=/)
  // 纯函数：不碰 DOM，否则 Node 端行为用例就不成立。
  assert.doesNotMatch(moduleSource, /document\./)
  assert.doesNotMatch(moduleSource, /window\./)
  assert.equal(typeof createMosaicPatchCache, 'function')
  assert.equal(typeof patchBytesOf, 'function')
  assert.equal(typeof cacheKeyOf, 'function')
})
