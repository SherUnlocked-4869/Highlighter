// B6（D8）多选 + mixed 态接线契约（docs/plans/2026-10-14-capture-interaction-improvement-plan.md §2 D8）。
//
// 与 test/capture-interaction.test.js 同一口径：纯函数在这里直接调用，capture.js 的部分钉
// **源码结构**（shift 落点、mixed 回显、批量一帧、elementBarSize 单一失效点）。单选中行为
// 必须与 B6 之前逐字等价 —— 那是这批用例最关心的不变量。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const script = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')
const html = fs.readFileSync(path.join(root, 'capture', 'capture.html'), 'utf8')
const css = fs.readFileSync(path.join(root, 'capture', 'capture.css'), 'utf8')
const { revalidateSelection, commonSelectionValue, rectsIntersect } = require('../capture/selection-utils')

function sliceBetween(source, from, to) {
  const start = source.indexOf(from)
  const end = source.indexOf(to)
  assert.ok(start >= 0 && end > start, `could not slice ${from} .. ${to}`)
  return source.slice(start, end)
}

const pointerdownSource = sliceBetween(script, "canvas.addEventListener('pointerdown'", "canvas.addEventListener('pointermove'")
const pointermoveSource = sliceBetween(script, "canvas.addEventListener('pointermove'", "canvas.addEventListener('pointerup'")
const pointerupSource = sliceBetween(script, "canvas.addEventListener('pointerup'", "canvas.addEventListener('pointercancel'")
const exportSource = sliceBetween(script, 'function exportSelectionCanvas(includeAnnotations = true)', 'function canvasPngBuffer(')
const quickSelectSource = sliceBetween(script, 'function quickSelectAnnotation(event, point)', "canvas.addEventListener('pointerdown'")
const echoSource = sliceBetween(script, 'function syncToolbarStyleFromSelection()', 'function setSelectedAnnotation(item)')

// ---------- 纯函数：集合存活 + mixed 判定 ----------

test('B6: revalidateSelection keeps only the ids that still exist and never throws', () => {
  const annotations = [{ id: 1 }, { id: 2 }, { id: 5 }]
  const alive = revalidateSelection(annotations, new Set([1, 2, 3, 9]))
  assert.deepEqual([...alive].sort(), [1, 2])
  // 快照还原后 id 不变、对象身份变 —— 这正是它按 id 而不是引用活下来的原因。
  const restored = annotations.map((item) => Object.assign({}, item))
  assert.deepEqual([...revalidateSelection(restored, new Set([2, 5]))].sort(), [2, 5])
  // 退化输入：空集合、非 Set/非数组、空标注、坏条目。
  assert.equal(revalidateSelection(annotations, new Set()).size, 0)
  assert.equal(revalidateSelection(annotations, null).size, 0)
  assert.equal(revalidateSelection(annotations, 'nope').size, 0)
  assert.equal(revalidateSelection([], new Set([1])).size, 0)
  assert.equal(revalidateSelection(null, new Set([1])).size, 0)
  assert.equal(revalidateSelection([null, undefined, { id: 1 }], new Set([1])).size, 1)
})

test('B6: commonSelectionValue returns the shared value, null for mixed and null for empty', () => {
  assert.equal(commonSelectionValue(['#ff3b30', '#ff3b30']), '#ff3b30')
  assert.equal(commonSelectionValue([4]), 4)
  assert.equal(commonSelectionValue([true, true]), true)
  // 不一致 = mixed（null）；null 与任何按钮值都不相等 → 控件没有 active 项。
  assert.equal(commonSelectionValue(['#ff3b30', '#1687ff']), null)
  assert.equal(commonSelectionValue([4, 8]), null)
  assert.equal(commonSelectionValue([false, true]), null)
  // 空输入也是 null（空选中集不得看起来像"一致值"）。
  assert.equal(commonSelectionValue([]), null)
  assert.equal(commonSelectionValue(null), null)
  assert.equal(commonSelectionValue(undefined), null)
})

// ---------- 状态模型：Set 是权威，anchor 保住全部单选中路径 ----------

test('B6: the selection set is authoritative and every replace path keeps it in step', () => {
  assert.match(script, /let selectedIds = new Set\(\)/)
  assert.match(script, /function selectedAnnotations\(\) \{\s*return annotations\.filter\(\(item\) => selectedIds\.has\(item\.id\)\)\s*\}/)
  // 单选退化：既有 15 个调用点继续读 anchor，行为与 B6 之前一致。
  assert.match(script, /function selectedAnnotationItem\(\) \{\s*return selectedAnnotation && annotations\.includes\(selectedAnnotation\) \? selectedAnnotation : null\s*\}/)
  assert.match(script, /function setSelectedAnnotation\(item\) \{\s*selectedAnnotation = item \|\| null\s*selectedIds = item \? new Set\(\[item\.id\]\) : new Set\(\)/)
  // 快照还原：集合与 anchor 都按 id 重解析。
  assert.match(script, /function syncSelectedAnnotation\(\) \{\s*selectedIds = revalidateSelection\(annotations, selectedIds\)\s*selectedAnnotation = reResolveSelectedAnnotation\(annotations, selectedIds, selectedAnnotation\)/)
  assert.match(script, /function reResolveSelectedAnnotation\(annotations, ids, current\) \{[\s\S]{0,400}?return ids\.size \? annotations\.filter\(\(item\) => ids\.has\(item\.id\)\)\.pop\(\) \|\| null : null/)
  // 新截图 / 清空 / 删除都清集合（否则锚点没了集合还留着死 id）。
  assert.match(script, /function resetAnnotationState\(\) \{[\s\S]{0,120}?selectedIds = new Set\(\)/)
  assert.match(script, /function deleteSelectedAnnotation\(\) \{[\s\S]{0,360}?selectedIds = new Set\(\)/)
  assert.match(script, /function clearAnnotationsForNewSelection\(\) \{[\s\S]{0,200}?selectedIds = new Set\(\)/)
})

test('B6: shift toggles one item, the anchor falls back to the topmost survivor, right-click only adds', () => {
  assert.match(script, /function addSelectedAnnotation\(item\) \{[\s\S]{0,200}?selectedIds = new Set\(selectedIds\)\.add\(item\.id\)[\s\S]{0,120}?selectedAnnotation = item/)
  assert.match(script, /function toggleSelectedAnnotation\(item\) \{[\s\S]{0,220}?if \(!selectedIds\.has\(item\.id\)\) \{ addSelectedAnnotation\(item\); return \}/)
  // 减掉最后一个 = 清空（走 setSelectedAnnotation(null)，集合与 anchor 同步）。
  assert.match(script, /if \(!remaining\.length\) \{ setSelectedAnnotation\(null\); return \}/)
  // 减掉 anchor：anchor 回退到最上层幸存项（数组末尾 = 最上层）。
  assert.match(script, /if \(!next\.has\(selectedAnnotation\?\.id\)\) selectedAnnotation = remaining\[remaining\.length - 1\]/)
})

// ---------- shift 落点：四个入口 ----------

test('B6: shift+click toggles at the hit, body and out-of-region branches; shift+right-click adds', () => {
  // 选区内命中
  assert.match(pointerdownSource, /if\(event\.shiftKey\)\{toggleSelectedAnnotation\(hit\);updateSelectionCursor\(point\);return\}/)
  // 已选中元素体内
  assert.match(pointerdownSource, /if\(bodyItem&&event\.shiftKey\)\{toggleSelectedAnnotation\(bodyItem\);updateSelectionCursor\(point\);return\}/)
  // 选区外命中（A5 分支）
  assert.match(pointerdownSource, /if\(event\.shiftKey\)\{toggleSelectedAnnotation\(outsideHit\);updateSelectionCursor\(point\);return\}/)
  // 右键快选：shift 只加不减
  assert.match(quickSelectSource, /if \(event\.shiftKey\) addSelectedAnnotation\(hit\)/)
  assert.doesNotMatch(quickSelectSource, /toggleSelectedAnnotation/)
  // 未命中仍是原来的语义（select 取消选中、绘图工具 no-op）。
  assert.match(quickSelectSource, /if \(currentTool === 'select'\) setSelectedAnnotation\(null\)/)
  // 空白处 shift 不会顺手拖走刚加进来的元素：shift 分支不进入 pendingMove。
  assert.doesNotMatch(pointerdownSource, /if\(event\.shiftKey\)\{[^}]*beginPendingMove/)
})

// ---------- mixed 回显 ----------

test('B6: a multi-selection echoes the shared value or an indeterminate control, still UI-only', () => {
  assert.match(script, /if \(selected\.length > 1\) \{\s*applyToolbarSelection\(selected\)\s*syncToolOptionsRow\(\)\s*return\s*\}/)
  assert.match(script, /function applyToolbarSelection\(selected\) \{[\s\S]{0,320}?commonSelectionValue\(selected\.map\(\(entry\) => normalizeAnnotationColor\(entry\.color\)\)\)/)
  assert.match(script, /commonSelectionValue\(selected\.map\(\(entry\) => resolveAnnotationWidth\(entry\.width\)\)\)/)
  assert.match(script, /if \(sharedColor === null\) applyToolbarMixedColor\(\)\s*else applyToolbarColor\(sharedColor\)/)
  assert.match(script, /if \(sharedWidth === null\) applyToolbarMixedWidth\(\)\s*else applyToolbarWidth\(sharedWidth\)/)
  // mixed 的两种表现：色块加 .mixed，宽度按钮全部灭活。
  assert.match(script, /function applyToolbarMixedColor\(\) \{\s*colorPreview\.classList\.add\('mixed'\)/)
  assert.match(script, /function applyToolbarMixedWidth\(\) \{[\s\S]{0,240}?button\.classList\.remove\('active'\)/)
  // 具体色值必须清掉 mixed（否则回显停在 indeterminate）。
  assert.match(script, /colorPreview\.classList\.remove\('mixed'\)/)
  // 回显依旧是 UI-only：不压帧、不写记忆样式。
  assert.doesNotMatch(echoSource, /commitSelectedStyle|stageSelectedStyle|snapshotAnnotations/)
  assert.doesNotMatch(echoSource, /annotationColor =|toolStyles\[/)
  // 纯 CSS/DOM 落点（没有新的 i18n 文案键）。
  assert.match(html, /id="colorSwatch"/)
  assert.match(css, /\.color-wrap > button span\.mixed \{/)
})

test('B6: the options row shows a shared value or nothing active for a mixed field', () => {
  assert.match(script, /function selectionToolOptions\(tool, selected\) \{[\s\S]{0,420}?options\[field\] = commonSelectionValue\(rows\.map\(\(row\) => row\[field\]\)\)/)
  assert.match(script, /const options = !tool \? \{\} : \(selected\.length > 1 \? selectionToolOptions\(tool, selected\) : rowToolOptions\(tool\)\)/)
  // 单选路径原样保留（rowToolOptions 的形态契约不动）。
  assert.match(script, /function rowToolOptions\(tool\) \{\s*const item = selectedAnnotationItem\(\)\s*if \(item && item\.type === tool\) return resolveToolOptions\(tool, item\)/)
})

// ---------- 批量编辑：一条补丁、一帧 ----------

test('B6: one patch crosses the whole selection as exactly one undo frame', () => {
  assert.match(script, /if \(selected\.length > 1\) return writeAnnotationStyles\(selected, patch, keys, true\)/)
  assert.match(script, /return writeAnnotationStyles\(\[item\], patch, keys, false\)/)
  // 类型归属过滤：混合选择集不会被塞进目标不拥有的字段。
  assert.match(script, /if \(field === 'color' \|\| field === 'width'\) return TOOL_STYLE_TOOLS\.includes\(tool\)/)
  assert.match(script, /const fields = TOOL_OPTION_FIELDS\[tool\]\s*return !!fields && fields\.includes\(field\)/)
  // 写回仍然只有一处；离散样式编辑（commitSelectedStyle）仍然只压一帧。
  const styleSource = sliceBetween(script, 'function applyStyleToSelectedAnnotation(patch)', 'function resetAnnotationState()')
  assert.equal(styleSource.match(/annotations\[index\] = /g).length, 1, 'one write-back site')
  const commitSource = sliceBetween(script, 'function commitSelectedStyle(patch)', 'function stageSelectedStyle(patch)')
  assert.equal(commitSource.match(/snapshotAnnotations\(\)/g).length, 1, 'one frame per discrete style edit')
  assert.equal(script.match(/function commitSelectedStyle\(patch\) \{/g).length, 1)
})

test('B6: Delete and the arrow keys cover the whole selection in one frame', () => {
  assert.match(script, /function deleteSelectedAnnotation\(\) \{\s*const targets = selectedAnnotations\(\)/)
  assert.match(script, /function nudgeSelectedAnnotation\(event\) \{[\s\S]{0,420}?const targets = selectedAnnotations\(\)/)
  assert.match(script, /targets\.forEach\(\(item\) => \{\s*const index = annotations\.indexOf\(item\)/)
  // 合并计时器仍然只有一个（连续按键合并成一帧的机制没变）。
  assert.equal(script.match(/nudgeTimer = setTimeout\(commitNudge, NUDGE_COMMIT_DELAY\)/g).length, 1)
  assert.equal(script.match(/nudgeDirty = true/g).length, 1)
})

// ---------- elementBar 计数 + 单一失效点 ----------

test('B6: the element bar reports the selection size and invalidates its cached rect once', () => {
  assert.match(html, /id="elementCount" class="element-count hidden"/)
  assert.match(script, /const elementCount = document\.getElementById\('elementCount'\)/)
  assert.match(script, /function syncElementBarCount\(\) \{[\s\S]{0,320}?t\('capture\.element\.selected-count', \{ count \}\)/)
  // 计数可见性变化 = 尺寸失效（否则落位继续用单选宽度）。
  assert.match(script, /if \(elementCount\.classList\.contains\('hidden'\) === visible\) \{\s*elementCount\.classList\.toggle\('hidden', !visible\)\s*invalidateElementBarSize\(\)\s*\}/)
  // 单一失效点：elementBarSize 全仓只有"声明 + invalidateElementBarSize() 里的置空"两处。
  assert.equal(script.match(/let elementBarSize = null/g).length, 1)
  assert.equal(script.match(/elementBarSize = null/g).length, 2, 'declaration + the single invalidation point')
  assert.match(script, /function invalidateElementBarSize\(\) \{\s*elementBarSize = null\s*\}/)
  assert.match(script, /function updateElementBar\(\) \{[\s\S]{0,900}?syncElementBarCount\(\)/)
  assert.match(script, /function resetAnnotationState\(\) \{[\s\S]{0,600}?invalidateElementBarSize\(\)/)
  assert.match(css, /\.element-bar \.element-count \{/)
})

test('B6: the counter wording exists in all three languages', () => {
  globalThis.__LOCALES = {}
  for (const name of ['zh-CN.js', 'en-US.js', 'zh-TW.js', 'capture.js']) {
    const file = path.join(root, 'shared', 'locales', name)
    delete require.cache[require.resolve(file)]
    require(file)
  }
  const tables = globalThis.__LOCALES
  for (const language of ['zh-CN', 'en-US', 'zh-TW']) {
    const value = tables[language]['capture.element.selected-count']
    assert.equal(typeof value, 'string', `${language} must define the counter key`)
    assert.match(value, /\{count\}/, `${language} must keep the count placeholder`)
  }
  assert.match(tables['zh-CN']['capture.element.selected-count'], /个元素/)
  assert.match(tables['zh-TW']['capture.element.selected-count'], /個元素/)
  assert.match(tables['en-US']['capture.element.selected-count'], /elements selected/)
})

// ---------- B6 wave 2（D8）：shift+拖框选 ----------

test('B6 wave 2: rectsIntersect is a closed-interval overlap that survives degenerate boxes', () => {
  assert.equal(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }), true)
  // 贴边算命中（"框到即选中"），差 1px 才算不中。
  assert.equal(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 }), true)
  assert.equal(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 11, y: 0, w: 5, h: 5 }), false)
  assert.equal(rectsIntersect({ x: 2, y: 2, w: 4, h: 4 }, { x: 0, y: 0, w: 10, h: 10 }), true, 'contained')
  assert.equal(rectsIntersect({ x: 20, y: 20, w: 5, h: 5 }, { x: 0, y: 0, w: 10, h: 10 }), false)
  // 退化盒（水平线的 h=0、单点 pen 的 w=h=0）不是空集：落在框里就能被框选到。
  assert.equal(rectsIntersect({ x: 5, y: 5, w: 0, h: 0 }, { x: 0, y: 0, w: 10, h: 10 }), true)
  assert.equal(rectsIntersect({ x: 5, y: 5, w: 8, h: 0 }, { x: 0, y: 0, w: 10, h: 10 }), true)
  // width/height 别名与非法输入。
  assert.equal(rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, w: 1, h: 1 }), true)
  assert.equal(rectsIntersect(null, { x: 0, y: 0, w: 1, h: 1 }), false)
  assert.equal(rectsIntersect({ x: 'a', y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 1, h: 1 }), false)
  assert.equal(rectsIntersect(undefined, undefined), false)
})

test('B6 wave 2: shift+drag on empty space marquees and only ever adds what it touches', () => {
  assert.match(script, /let marquee = null/)
  assert.match(script, /function beginMarquee\(point, event\) \{\s*marquee = \{ start: point, current: point \}/)
  assert.match(script, /function updateMarquee\(point\) \{[\s\S]{0,160}?marquee\.current = point/)
  // 阈值内 = 纯 shift 点击：保持原选中集，绝不误清空（这是与"shift 点空白清空"的取舍）。
  assert.match(script, /if \(!movedBeyondThreshold\(state\.start, point, MOVE_THRESHOLD\)\) \{ render\(\); return \}/)
  assert.match(script, /const hits = annotations\.filter\(\(item\) => rectsIntersect\(annotationBounds\(item\), rect\)\)/)
  assert.match(script, /const next = new Set\(selectedIds\)\s*hits\.forEach\(\(item\) => next\.add\(item\.id\)\)/)
  // anchor 取最上层命中项（数组末尾 = 最上层）。
  assert.match(script, /selectedAnnotation = hits\[hits\.length - 1\]/)
  // 空框不改选中集。
  assert.match(script, /if \(!hits\.length\) \{ render\(\); return \}/)
  // 框选本身不压帧（只改选中，不改标注）。
  const marqueeSource = sliceBetween(script, 'function beginMarquee(point, event)', '// A4 (D4): selection echo is UI-only')
  assert.doesNotMatch(marqueeSource, /snapshotAnnotations/)
})

test('B6 wave 2: the marquee is wired into pointerdown/move/up/cancel and drawn last', () => {
  // 空白处 shift 进入框选，且必须排在"取消选中 + 拖选区"兜底之前（框选是加选）。
  const marqueeDown = pointerdownSource.indexOf('if(event.shiftKey){beginMarquee(point,event);return}')
  assert.ok(marqueeDown >= 0, 'shift on empty space starts the marquee')
  assert.ok(marqueeDown < pointerdownSource.lastIndexOf('dragging=true'), 'the marquee runs before the plain region-drag fallback')
  assert.match(pointerdownSource, /if\(event\.shiftKey\)\{beginMarquee\(point,event\);return\}\s*setSelectedAnnotation\(null\)/)
  // Alt 逃生门仍在其之前（选区拖动优先级不变）。
  assert.ok(pointerdownSource.indexOf('if(event.altKey)') < marqueeDown)
  assert.match(pointermoveSource, /if \(marquee\) \{ updateMarquee\(point\); return \}/)
  assert.match(pointermoveSource, /if \(marquee&&event\.buttons===0\) \{ finishMarquee\(point\); updateSelectionCursor\(point\); return \}/)
  assert.match(pointerupSource, /if\(marquee\)\{const point=pointFromEvent\(event\);finishMarquee\(point\);updateSelectionCursor\(point\);return\}/)
  assert.match(script, /canvas\.addEventListener\('pointercancel',\(\)=>\{[\s\S]{0,300}?cancelMarquee\(\)/)
  // 绘制在最后（不被标注盖住），且绝不进入导出路径 / 不新增 i18n 文案。
  assert.match(script, /drawHandles\(\)\s*\/\/[\s\S]{0,160}?drawMarquee\(\)/)
  assert.doesNotMatch(exportSource, /marquee/)
  assert.match(script, /function resetAnnotationState\(\) \{[\s\S]{0,700}?marquee = null/)
  assert.doesNotMatch(html, /marquee/)
})

test('B6: every selected item draws the dashed outline, but the handles stay on the anchor', () => {
  const outlineSource = sliceBetween(script, 'function drawSelectionOutlineBox(box)', 'function drawSelectedHandles(bounds)')
  assert.match(outlineSource, /function drawSelectedOutline\(\) \{\s*const selected = selectedAnnotations\(\)/)
  assert.match(outlineSource, /selected\.forEach\(\(entry\) => drawSelectionOutlineBox\(entry === item \? bounds : annotationBounds\(entry\)\)\)/)
  assert.match(outlineSource, /drawSelectedHandles\(bounds\)/)
  // 手柄只有 anchor 一套（多选时其余项只画虚线框）—— 多的那一套没有落点语义。
  assert.equal(outlineSource.match(/drawSelectedHandles\(/g).length, 1)
  // 框选/多选不进入导出：导出仍只画标注本身。
  assert.doesNotMatch(exportSource, /drawSelectionOutlineBox|drawSelectedOutline/)
})

