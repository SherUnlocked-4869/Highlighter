// Brush plan（docs/plans/2026-10-19-brush-highlight-mosaic-interaction-design.md）接线契约。
//
// 纯函数（strokeBox / hasStrokePoints / 折线命中 / 笔迹缩放）的用例在
// capture-annotation-geometry.test.js 与 capture-annotation-style.test.js；本文件只钉
// capture.js 的接线：
//   ① 采样骨架（STROKE_TOOLS / coalesced / 最小点距 / 点集封顶）
//   ② drawAnnotation 的两条新分支（高亮折线、马赛克 mask）与"无 points 走旧分支"
//   ③ D6/D7 两处既有瑕疵的修复
//   ④ 补丁缓存的指纹与失效点（§5.2）
//   ⑤ §5.6 的 CSS px / 设备像素 / 导出 scale 三套坐标纪律
//
// 为什么这些断言按"字符窗口"写：capture.js 的既有契约测试就是这么钉的（§5.5），新逻辑
// 必须落在不挤爆既有窗口的位置；本文件反过来钉住"新逻辑该长什么样"。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const script = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')
const styleSource = fs.readFileSync(path.join(root, 'capture', 'annotation-style.js'), 'utf8')

function sliceBetween(source, from, to) {
  const start = source.indexOf(from)
  const end = source.indexOf(to)
  assert.ok(start >= 0 && end > start, `could not slice ${from} .. ${to}`)
  return source.slice(start, end)
}

const drawSource = sliceBetween(script, 'function drawAnnotation(context, item', 'function renderOverlay()')
const pointerdownSource = sliceBetween(script, "canvas.addEventListener('pointerdown'", "canvas.addEventListener('pointermove'")
const pointermoveSource = sliceBetween(script, "canvas.addEventListener('pointermove'", "canvas.addEventListener('pointerup'")
const appendSource = sliceBetween(script, 'function appendStrokePoint(point, event)', 'function finishStrokeAnnotation()')
const patchSource = sliceBetween(script, 'function buildMosaicPatch(item, deviceScale, sourceImage)', 'function drawMosaicStroke(')

// ---------- ① 采样骨架（§3.3） ----------

test('brush plan (§3.3): the brush tools sample a point set while pen keeps its own path', () => {
  // STROKE_TOOLS 来自几何模块的 STROKE_TYPES（单一事实来源，不在 capture.js 里重抄一遍）。
  assert.match(script, /const STROKE_TOOL_SET = new Set\(STROKE_TYPES\)/)
  assert.match(script, /const \{ STROKE_TYPES, hasStrokePoints, strokeWidth, strokeBox \} = window\.annotationGeometry/)
  // §6.2-B 红线：建对象的**前缀**逐字保留（capture-pen-continuation.test.js:72 用 indexOf 定位它），
  // 点集初始化改成按工具表判定。
  assert.match(script, /activeAnnotation=\{type:currentTool,x:point\.x,y:point\.y,x2:point\.x,y2:point\.y,\.\.\.style\}/)
  assert.match(script, /if \(STROKE_TOOL_SET\.has\(currentTool\)\) activeAnnotation\.points=\[\{x:point\.x,y:point\.y\}\]/)
  // pen 仍在该表里（它本来就有 points），所以建点集这一行对 pen 的行为不变。
  assert.ok(/['"]pen['"]/.test(fs.readFileSync(path.join(root, 'capture', 'annotation-geometry.js'), 'utf8')))
})

test('brush plan (§3.3/D5): coalesced events + a 1.5px minimum step, brush-only', () => {
  // 最小点距是 CSS px 口径的常量，不是散落的字面量。
  assert.match(script, /const STROKE_MIN_STEP = 1\.5/)
  // coalesced：拿得到就用它，拿不到退化为当前事件（旧环境不炸）。
  assert.match(script, /typeof event\.getCoalescedEvents === 'function' \? event\.getCoalescedEvents\(\) : null/)
  assert.match(script, /return collected\.length \? collected : \[point\]/)
  // 最小点距过滤只在笔刷工具上启用（pen 的形状不能变，D5 的显式取舍）。
  assert.match(appendSource, /STROKE_TOOL_SET\.has\(item\.type\) \? strokeSamples\(event, point\) : \[point\]/)
  assert.match(appendSource, /if \(tail && Math\.hypot\(sample\.x - tail\.x, sample\.y - tail\.y\) < STROKE_MIN_STEP\) continue/)
  // 点集封顶沿用 MAX_PEN_POINTS（与 pen 同一条不变量）。
  assert.match(appendSource, /item\.points\.length >= MAX_PEN_POINTS\) return/)
  // bbox 跟最后一个采样点走（点距过滤不会让 x2/y2 停在被丢弃的点上）。
  assert.match(appendSource, /const last = samples\[samples\.length - 1\]\s*item\.x2 = last\.x\s*item\.y2 = last\.y/)
  // 采样逻辑绝不做导出坐标换算（§8.3：点集一律屏幕 CSS 坐标）。
  assert.doesNotMatch(appendSource, /scaleX|scaleY/)
})

test('brush plan (§3.3): pointermove routes through the sampler instead of the old inline push', () => {
  // 旧的"只对 pen 累积"那一行必须已被泛化掉。
  assert.doesNotMatch(pointermoveSource, /if\(activeAnnotation\.type==='pen'&&activeAnnotation\.points\.length<MAX_PEN_POINTS\)activeAnnotation\.points\.push\(point\)/)
  assert.match(pointermoveSource, /if \(activeAnnotation\) \{ appendStrokePoint\(point, event\); render\(\) \}/)
})

// ---------- ② drawAnnotation 的两条新分支（§3.2） ----------

test('brush plan (§3.2.1): a freehand highlight is one round-capped polyline, a legacy one stays a segment', () => {
  // 有 points → 走共享的 traceStroke（圆头圆角、逐点 lineTo）。
  assert.match(drawSource, /if \(hasStrokePoints\(item\)\) \{\s*traceStroke\(context, offsetPoints\(item\.points, scaleX, scaleY, offsetX, offsetY\), highlightWidth\(baseWidth,widthScale\)\)/)
  // 无 points → 保持改造前的 moveTo/lineTo（逐字节不变）。
  assert.match(drawSource, /context\.lineWidth=highlightWidth\(baseWidth,widthScale\)\s*context\.beginPath\(\); context\.moveTo\(x,y\); context\.lineTo\(x2,y2\)/)
  // 浓度沿用既有的 resolveAlpha（不是新开一套）。
  assert.match(drawSource, /context\.globalAlpha=resolveAlpha\(item\.alpha\)/)
})

test('brush plan (§3.2.2): a freehand mosaic composites the pixelated layer with the stroke mask', () => {
  // 有 points → mask 分支；无 points → 原来的矩形重采样分支原样保留。
  assert.match(drawSource, /if \(hasStrokePoints\(item\)\) \{\s*drawMosaicStroke\(context,item,scaleX,scaleY,offsetX,offsetY,sourceImage\)/)
  assert.match(drawSource, /const left=Math\.min\(x,x2\), top=Math\.min\(y,y2\), w=Math\.abs\(x2-x\), h=Math\.abs\(y2-y\)/)
  // mask 用 destination-in：只保留笔迹覆盖的像素，轨迹外一个像素都不动。
  assert.match(patchSource, /patchCtx\.globalCompositeOperation = 'destination-in'/)
  assert.match(patchSource, /patchCtx\.globalCompositeOperation = 'source-over'/)
  // 像素化：先把源图缩成 1/cell 的小图，再关掉平滑放大回去。
  assert.match(patchSource, /tinyCtx\.imageSmoothingEnabled = true/)
  assert.match(patchSource, /patchCtx\.imageSmoothingEnabled = false/)
  // 网格相位锚定画布原点（不是笔迹自身 bbox），否则相邻笔迹重叠处出现"砖缝"（§7.2）。
  assert.match(patchSource, /const left = Math\.floor\(\(box\.x - pad\) \/ MOSAIC_CELL\) \* MOSAIC_CELL/)
  assert.match(patchSource, /const top = Math\.floor\(\(box\.y - pad\) \/ MOSAIC_CELL\) \* MOSAIC_CELL/)
  // cell 与笔宽都乘 scale：导出时的像素块必须跟着图一起放大（§7.4）。
  assert.match(patchSource, /const cell = MOSAIC_CELL \* deviceScale/)
  assert.match(patchSource, /const brush = blurBrushWidth\(item\.width\) \* deviceScale/)
})

test('brush plan (§3.2/§7.3): a single point traces a non-empty path so a tap inks', () => {
  // 单击必须落墨：零长度子路径在**旧版** Chromium 上不描边，所以 traceStroke 给单点补了
  // 0.01px 的线段。实测当前 Electron 43 的 `moveTo(p); lineTo(p)` 已经会画（见下），但这条
  // 补丁仍然要保留 —— 它是 §7.3 记录的跨版本保险，删掉就等于把"单击落墨"重新押在浏览器
  // 实现细节上。
  assert.match(script, /if \(points\.length === 1\) \{\s*context\.moveTo\(points\[0\]\.x, points\[0\]\.y\)\s*context\.lineTo\(points\[0\]\.x \+ 0\.01, points\[0\]\.y\)/)
  // 关键契约：单点分支必须**返回 true 并产生一条可描边的路径**，绝不能退化成空路径
  // （空路径 = 单击什么都不画，用户会以为工具坏了）。
  assert.match(script, /if \(!points\.length\) return false\s*if \(points\.length === 1\) \{/)
  // traceStroke 同时服务 pen / highlight / 马赛克 mask 三处。
  const uses = script.match(/traceStroke\(/g) || []
  assert.ok(uses.length >= 4, `traceStroke should be shared by pen, highlight and the mosaic mask (found ${uses.length} uses)`)
})

test('brush plan (D6): the pen branch gains the same dot patch it never had', () => {
  // D6：改造前 pen 单击什么都不画，高亮/马赛克却能点出圆点 —— 观感不一致，本次一并对齐。
  assert.match(drawSource, /if \(item\.type === 'pen'\) \{\s*\/\/[\s\S]{0,240}?traceStroke\(context, offsetPoints\(item\.points, scaleX, scaleY, offsetX, offsetY\), width\)/)
})

// ---------- ③ D7：pointerup 被吞掉时的自愈 ----------

test('brush plan (D7): a button-less pointermove settles the stroke instead of letting it follow the cursor', () => {
  // 与既有的 pendingMove / resizingAnnotation / marquee 三处自愈同构（同一个 event.buttons===0 判据）。
  assert.match(pointermoveSource, /if \(activeAnnotation && event\.buttons === 0 && activeAnnotation\.type !== 'watermark'\) \{ finishStrokeAnnotation\(\); updateSelectionCursor\(point\); return \}/)
  // 自愈只收口、不丢弃：走的是 commitAnnotation（pointercancel 才是丢弃）。
  assert.match(script, /function finishStrokeAnnotation\(\) \{\s*if \(!activeAnnotation \|\| activeAnnotation\.type === 'watermark'\) return\s*commitAnnotation\(activeAnnotation\)/)
})

// ---------- ④ 补丁缓存（§5.2） ----------

test('brush plan (§5.2): the patch cache is keyed by a fingerprint, not by object identity', () => {
  // 关键理由写进代码：translate/resize/style 全部返回新对象，按引用缓存会指向过期补丁。
  assert.match(script, /NOT by object identity/)
  // 指纹必须覆盖"影响渲染结果"的全部字段：笔宽、scale、bbox、点数、首末点。
  assert.match(script, /return \[item\.width, deviceScale, box\.x, box\.y, box\.w, box\.h, points\.length, first\.x, first\.y, last\.x, last\.y\]\.join\('\|'\)/)
  // WeakMap + 字节预算（§5.2 的 16MB 上限），超预算退化为不缓存但仍正确。
  assert.match(script, /let mosaicPatchCache = new WeakMap\(\)/)
  assert.match(script, /const MOSAIC_PATCH_BUDGET = 16 \* 1024 \* 1024/)
  assert.match(script, /if \(mosaicPatchBytes \+ bytes <= MOSAIC_PATCH_BUDGET\)/)
  // 活动笔迹不缓存（每帧重建才 1.6ms，缓存它反而要每帧重算指纹）。
  assert.match(script, /if \(item\.id && bytes <= MOSAIC_PATCH_BUDGET\)/)
})

test('brush plan (§5.2): every input that can stale a patch has an invalidation point', () => {
  // 六类失效点里真正必须的四个：新截图（reset）、撤销/重做（restore）、样式写回、舞台/DPR 变化。
  const resetSource = sliceBetween(script, 'function resetAnnotationState()', 'function commitAnnotation(item)')
  assert.match(resetSource, /invalidateMosaicPatches\(\)/)

  const restoreSource = sliceBetween(script, 'function restoreAnnotations(index)', 'function undoAnnotations()')
  assert.match(restoreSource, /annotations = cloneAnnotations\(annotationHistory\[historyIndex\]\)[\s\S]{0,160}?invalidateMosaicPatches\(\)/)

  const resizeSource = sliceBetween(script, 'function resizeCanvas()', 'function drawBackground()')
  assert.match(resizeSource, /invalidateMosaicPatches\(\)/)

  const styleWriteSource = sliceBetween(script, 'function writeAnnotationStyles(targets, patch, fields, ownership)', 'function commitSelectedStyle(patch)')
  assert.match(styleWriteSource, /mosaicPatchCache\.delete\(target\)/)

  // WeakMap 没有 clear()：失效实现为整表丢弃，所以必须 let 而不是 const。
  assert.match(script, /let mosaicPatchCache = new WeakMap\(\)/)
  assert.match(script, /function invalidateMosaicPatches\(\) \{\s*mosaicPatchCache = new WeakMap\(\)\s*mosaicPatchBytes = 0\s*\}/)
})

// ---------- ⑤ 坐标纪律（§5.6） ----------

test('brush plan (§5.6): the mosaic resolves device pixels from the context, never from a dpr guess', () => {
  // scale 是"目标像素/CSS 像素"的唯一桥梁；屏幕路径传 dpr、导出路径传 scaleX。
  assert.match(script, /function contextPixelScale\(context\)/)
  assert.match(script, /const deviceScale = Math\.max\(scaleX, scaleY\) \* contextPixelScale\(context\)/)
  // 采样源是**设备像素**的 sourceImage，所以要用 imageBounds 换算，而不是直接拿 CSS px 去采。
  assert.match(patchSource, /const sourceScaleX = \(sourceImage\.naturalWidth \|\| 1\) \/ Math\.max\(1, bounds\.w\)/)
  assert.match(patchSource, /const sourceScaleY = \(sourceImage\.naturalHeight \|\| 1\) \/ Math\.max\(1, bounds\.h\)/)
  // 补丁画回目标时用**调用方的单位**（经其自身的 transform），不再乘一次 dpr。
  assert.match(script, /context\.drawImage\(patch\.canvas, \(patch\.left - offsetX\) \* scaleX, \(patch\.top - offsetY\) \* scaleY, patch\.w \* scaleX, patch\.h \* scaleY\)/)
  // 这条纪律必须写进注释，否则维护者会踩第二次（方案原文要求）。
  assert.match(script, /§5\.6/)
})

test('brush plan (§3.2.2): the mosaic samples the image, so it must never read the overlay canvas', () => {
  // 马赛克取的是**背景截图**的像素：从 sourceImage 采样，绝不自引用目标画布。
  assert.doesNotMatch(patchSource, /drawImage\(context|drawImage\(canvas/)
  assert.match(patchSource, /sourceImage/)
  // 既有导出口径不变：renderOverlay 与 exportSelectionCanvas 仍共用 drawAnnotation。
  assert.match(script, /annotations\.forEach\(\(item\) => drawAnnotation\(ctx,item\)\)/)
  assert.match(script, /annotations\.forEach\(\(item\)=>drawAnnotation\(out,item,scaleX,scaleY,selection\.x,selection\.y,image\)\)/)
})

// ---------- ⑥ 线宽 / 样式记忆接线（§3.6 / D2-B'） ----------

test('brush plan (D2-B\'): blur is a width-bearing, style-remembering tool in the renderer too', () => {
  // 两处必须同时成立，否则就是"滚轮能调、松手即丢"的假功能（§3.6-3 的审计结论）。
  assert.match(script, /const WIDTH_TOOLS = new Set\(\['rect', 'ellipse', 'arrow', 'line', 'pen', 'highlight', 'text', 'serial', 'blur'\]\)/)
  assert.ok(styleSource.includes("'serial', 'blur'"), 'blur must be in TOOL_STYLE_TOOLS')
  // 渲染层的宽度函数来自 annotation-style 的解构（单一事实来源）。
  assert.match(script, /blurBrushWidth,\s*MOSAIC_CELL\s*\} = window\.annotationStyleUtils/)
})
