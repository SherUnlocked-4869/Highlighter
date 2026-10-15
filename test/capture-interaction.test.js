// A1/A2/A4/A5 接线契约（docs/plans/2026-10-14-capture-interaction-improvement-plan.md §3）。
//
// 这些用例钉的是 capture.js 的**源码结构**：pointerdown 的分支顺序、滚轮接线的落点、
// 选中回显与编辑路径的分离、以及选区外命中优先于"重划选区"。纯函数（阈值/步进/颜色归一）
// 的用例在 capture-annotation-geometry.test.js 与 capture-annotation-style.test.js。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const script = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')
const html = fs.readFileSync(path.join(root, 'capture', 'capture.html'), 'utf8')

function sliceBetween(source, from, to) {
  const start = source.indexOf(from)
  const end = source.indexOf(to)
  assert.ok(start >= 0 && end > start, `could not slice ${from} .. ${to}`)
  return source.slice(start, end)
}

const pointerdownSource = sliceBetween(script, "canvas.addEventListener('pointerdown'", "canvas.addEventListener('pointermove'")
const quickSelectSource = sliceBetween(script, 'function quickSelectAnnotation(event, point)', "canvas.addEventListener('pointerdown'")
const wheelSource = sliceBetween(script, "canvas.addEventListener('wheel'", "canvas.addEventListener('dblclick'")
const echoSource = sliceBetween(script, 'function syncToolbarStyleFromSelection()', 'function setSelectedAnnotation(item)')
const setSelectedSource = sliceBetween(script, 'function setSelectedAnnotation(item)', '// 提交一帧快照')

// ---------- A1：按键门控 + 右键快选 + 点击/拖动阈值 ----------

test('A1 (D1): pointerdown gates on event.button after the self-heal and before every tool branch', () => {
  // 自愈先跑（上一次手势没收到 pointerup），随后是按键门，门之后再进选区/工具分支。
  const healIndex = pointerdownSource.indexOf('if(pendingMove)finishMoveAnnotation()')
  const gateIndex = pointerdownSource.indexOf('if(event.button!==0)')
  const autoIndex = pointerdownSource.indexOf("if(selectState==='auto')")
  const handleIndex = pointerdownSource.indexOf('const resizeHandle=')
  assert.ok(healIndex >= 0, 'the pending move of a swallowed gesture is closed first')
  assert.ok(gateIndex > healIndex, 'the button gate runs after the self-heal')
  assert.ok(gateIndex < autoIndex, 'the gate runs before the smart-selection branch')
  assert.ok(gateIndex < handleIndex, 'the gate runs before the region/element branches')
  // 只有主键编辑：右键交给快选，其余按键（中键等）直接吞掉 —— 不再可能起绘。
  assert.match(pointerdownSource, /if\(event\.button!==0\)\{if\(event\.button===2\)quickSelectAnnotation\(event,point\);return\}/)
  // 右键手势与未来的原生菜单语义冲突，必须拦掉 contextmenu。
  assert.match(script, /canvas\.addEventListener\('contextmenu',\(event\)=>event\.preventDefault\(\)\)/)
})

test('A1 (D1): the right button quick-selects or deselects, and can never draw or re-run the region', () => {
  // 命中 → 选中 + 进入 pendingMove（与左键体内拖动同构）。
  assert.match(quickSelectSource, /const hit = findAnnotationAt\(annotations, point\)/)
  // B6（D8）：shift+右键是"加选"（右键是拿起即拖的手势，绝不从集合里移除）。
  assert.match(quickSelectSource, /if \(hit\) \{\s*\/\/[\s\S]{0,200}?if \(event\.shiftKey\) addSelectedAnnotation\(hit\)\s*else setSelectedAnnotation\(hit\)\s*beginPendingMove\(hit, point, event\)\s*return\s*\}/)
  // 未命中：select 工具取消选中；绘图工具 no-op。
  assert.match(quickSelectSource, /if \(currentTool === 'select'\) setSelectedAnnotation\(null\)/)
  assert.match(quickSelectSource, /if \(selectState === 'auto'\) return/)
  // 右键绝不创建标注、绝不重划选区、绝不移动选区。
  assert.doesNotMatch(quickSelectSource, /activeAnnotation/)
  assert.doesNotMatch(quickSelectSource, /commitAnnotation/)
  assert.doesNotMatch(quickSelectSource, /confirmDiscardAnnotations|clearAnnotationsForNewSelection/)
  assert.doesNotMatch(quickSelectSource, /dragging=true/)
})

test('A1 (T3): the element-bar hint documents the right-drag in all three languages', () => {
  assert.match(html, /data-i18n="capture\.element\.move-hint"/)
  assert.match(html, /data-i18n-title="capture\.element\.move-hint-tip"/)
  globalThis.__LOCALES = {}
  delete require.cache[require.resolve(path.join(root, 'shared', 'locales', 'capture.js'))]
  require(path.join(root, 'shared', 'locales', 'capture.js'))
  const tables = globalThis.__LOCALES
  assert.match(tables['zh-CN']['capture.element.move-hint'], /右键/)
  assert.match(tables['zh-TW']['capture.element.move-hint'], /右鍵/)
  assert.match(tables['en-US']['capture.element.move-hint'], /Right-drag/)
  for (const language of ['zh-CN', 'en-US', 'zh-TW']) {
    assert.match(tables[language]['capture.element.move-hint-tip'], /right[^.]*drag|drag[^.]*right|右鍵|右键/i)
  }
})

test('A1 (D2): a press only becomes a move once it crosses MOVE_THRESHOLD, and a click pushes no frame', () => {
  const beginSource = sliceBetween(script, 'function beginPendingMove(item, point, event)', '// 拖动中：从 origin')
  assert.match(beginSource, /pendingMove = \{ id: item\.id, origin: item, start: \{ x: point\.x, y: point\.y \}, thresholdPassed: false \}/)
  assert.match(beginSource, /try \{ canvas\.setPointerCapture\(event\.pointerId\) \} catch \{\}/)
  // 未过阈值绝不翻译对象（因此不得压帧、不得抖动）。
  assert.match(
    script,
    /function moveAnnotationTo\(point\) \{[\s\S]{0,240}?if \(!state\.thresholdPassed\) \{\s*if \(!movedBeyondThreshold\(state\.start, point, MOVE_THRESHOLD\)\) return\s*state\.thresholdPassed = true\s*\}/
  )
  // 松手时未过阈值 = 纯点击：选中保留，历史不动。
  assert.match(script, /function finishMoveAnnotation\(\) \{[\s\S]{0,240}?if \(!state\.thresholdPassed\) \{ render\(\); return \}/)
  // pointercancel 仍然回滚原对象（阈值分支不改变这条语义）。
  assert.match(script, /function cancelMoveAnnotation\(\) \{[\s\S]{0,200}?const state = pendingMove/)
  // 三个入口复用同一个创建点：左键体内、右键快选、选区外命中。
  assert.equal(script.match(/beginPendingMove\(/g).length, 4, 'one definition + three call sites')
  // B6（D8）：体内拖动覆盖任意选中项；shift 落在已选中项上改为减选。
  assert.match(pointerdownSource, /if\(bodyItem\)\{beginPendingMove\(bodyItem,point,event\);return\}/)
})

// ---------- A2：滚轮调笔画粗细 ----------

test('A2: the smart-selection stepper keeps priority and the wheel then steps the stroke width', () => {
  const smartIndex = wheelSource.indexOf("if(selectState==='auto')")
  const stepIndex = wheelSource.indexOf('nextWidthPreset(')
  assert.ok(smartIndex >= 0 && smartIndex < stepIndex, 'auto mode keeps the candidate stepper first')
  assert.match(wheelSource, /if\(!canStepAnnotationWidth\(\)\)return/)
  assert.match(wheelSource, /const width=nextWidthPreset\(displayedToolWidth\(\),event\.deltaY<0\?1:-1\)/)
  // 步进起点是"工具栏当前显示的宽度"（选中项优先，否则当前工具的记忆），不是旧键镜像。
  assert.match(script, /function displayedToolWidth\(\) \{\s*const item = selectedAnnotationItem\(\)\s*return item \? resolveAnnotationWidth\(item\.width\) : currentToolStyle\(\)\.width\s*\}/)
  assert.match(wheelSource, /setAnnotationWidth\(width\)/)
  // 正在绘制的笔迹实时跟随（一行赋值 + render）。
  assert.match(wheelSource, /if\(activeAnnotation&&activeAnnotation\.type!=='watermark'\)activeAnnotation\.width=width/)
  assert.match(wheelSource, /scheduleAnnotationWidthPersist\(\)/)
  assert.match(wheelSource, /render\(\)/)
  // 滚轮是 preventDefault + passive:false（改宽不能被页面滚动吞掉）。
  assert.match(wheelSource, /event\.preventDefault\(\)/)
  assert.match(script, /canvas\.addEventListener\('wheel',\(event\)=>\{[\s\S]*?\},\{passive:false\}\)/)
})

test('A2: a wheel burst trails its persistence and the step only runs when it is unambiguous', () => {
  assert.match(script, /const WIDTH_PERSIST_DELAY = 500/)
  assert.match(
    script,
    /function scheduleAnnotationWidthPersist\(\) \{[\s\S]{0,260}?window\.captureAPI\.saveAnnotationWidth\(annotationWidth\)\.catch\(\(\) => \{\}\)/
  )
  assert.match(script, /function cancelAnnotationWidthPersist\(\) \{[\s\S]{0,160}?clearTimeout\(widthPersistTimer\)/)
  // 新一次截图不得让上一张的写盘计时器落进这一次（与样式计时器同口径）。
  assert.match(script, /function resetAnnotationState\(\) \{[\s\S]{0,460}?cancelAnnotationWidthPersist\(\)/)
  // 支持宽度的工具集合 = 除 select / blur / watermark 之外的全部。
  assert.match(script, /const WIDTH_TOOLS = new Set\(\['rect', 'ellipse', 'arrow', 'line', 'pen', 'highlight', 'text', 'serial'\]\)/)
  assert.match(
    script,
    /function canStepAnnotationWidth\(\) \{[\s\S]{0,200}?if \(!selection \|\| selecting \|\| dragging \|\| resizing \|\| selectState === 'auto'\) return false[\s\S]{0,120}?return WIDTH_TOOLS\.has\(currentTool\) \|\| !!selectedAnnotationItem\(\)/
  )
})

// ---------- A4：选中项样式回显 ----------

test('A4 (D4): the selection echo is UI-only and never reaches the undo/commit paths', () => {
  assert.match(echoSource, /const item = selectedAnnotationItem\(\)/)
  // B4（D7）：无选中项时回到**当前工具的记忆样式**，而不是某个全局值。
  assert.match(echoSource, /const fallback = currentToolStyle\(\)/)
  assert.match(echoSource, /applyToolbarColor\(item \? normalizeAnnotationColor\(item\.color\) : fallback\.color\)/)
  assert.match(echoSource, /applyToolbarWidth\(item \? resolveAnnotationWidth\(item\.width\) : fallback\.width\)/)
  // 回显不压帧、不改任何记忆样式（否则选中就成了隐式样式编辑）。
  assert.doesNotMatch(echoSource, /commitSelectedStyle|stageSelectedStyle|snapshotAnnotations/)
  assert.doesNotMatch(echoSource, /annotationColor =|toolStyles\[/)
  // setSelectedAnnotation 只做"置变量 + 回显 + render"，不得混入编辑路径。
  assert.match(setSelectedSource, /selectedAnnotation = item \|\| null[\s\S]{0,120}?syncToolbarStyleFromSelection\(\)[\s\S]{0,60}?render\(\)/)
  assert.doesNotMatch(setSelectedSource, /commitSelectedStyle|stageSelectedStyle/)
})

test('A4: undo/redo, deletion and region reset all repaint the toolbar from the source of truth', () => {
  // 快照还原会换掉对象身份 → 按 id 重解析之后必须重新回显。
  assert.match(script, /function syncSelectedAnnotation\(\) \{[\s\S]{0,360}?syncToolbarStyleFromSelection\(\)/)
  assert.match(script, /function restoreAnnotations\(index\) \{[\s\S]{0,460}?syncSelectedAnnotation\(\)/)
  // 置 null 的路径回到全局默认色/宽度。
  assert.match(script, /function deleteSelectedAnnotation\(\) \{[\s\S]{0,360}?syncToolbarStyleFromSelection\(\)/)
  assert.match(script, /function clearAnnotationsForNewSelection\(\) \{[\s\S]{0,360}?syncToolbarStyleFromSelection\(\)/)
  assert.match(script, /function setTool\(tool\) \{[\s\S]{0,200}?setSelectedAnnotation\(null\)/)
  assert.match(script, /else if\(selectedAnnotationItem\(\)\)setSelectedAnnotation\(null\);else closeCaptureWindow\(\)/)
  assert.match(script, /document\.getElementById\('elementDeselect'\)\.onclick=\(\)=>setSelectedAnnotation\(null\)/)
})

// ---------- A5：选区外元素可选 ----------

test('A5 (D10): an out-of-region element hit wins over replacing the region', () => {
  assert.match(pointerdownSource, /const outsideSelection=currentTool==='select'&&!resizeHandle&&!insideSelection\(point\)/)
  // B6（D8）：选区外命中同样支持 shift 加减选；shift 分支不进入 pendingMove（刚加进来的
  // 元素不会被同一次手势拖走），普通命中路径逐字不变。
  assert.match(
    pointerdownSource,
    /if \(outsideSelection\) \{\s*const outsideHit=findAnnotationAt\(annotations,point\)\s*if\(outsideHit\)\{[\s\S]{0,320}?if\(event\.shiftKey\)\{toggleSelectedAnnotation\(outsideHit\);updateSelectionCursor\(point\);return\}\s*setSelectedAnnotation\(outsideHit\);beginPendingMove\(outsideHit,point,event\);return\s*\}\s*\}/
  )
  const outsideIndex = pointerdownSource.indexOf('const outsideHit=findAnnotationAt(annotations,point)')
  const reselectIndex = pointerdownSource.indexOf('if (!selection || outsideSelection)')
  const confirmIndex = pointerdownSource.indexOf('if(!confirmDiscardAnnotations())return')
  assert.ok(outsideIndex >= 0 && outsideIndex < reselectIndex, 'the hit test precedes the re-selection branch')
  assert.ok(outsideIndex < confirmIndex, 'a hit never reaches the discard confirmation')
  // 真空白仍然走 D4 的"先确认"路径（行为不回退）。
  assert.match(pointerdownSource, /if \(!selection \|\| outsideSelection\) \{\s*\/\/[\s\S]{0,160}?if\(!confirmDiscardAnnotations\(\)\)return/)
  // 选区手柄仍然优先：命中测试被 !resizeHandle 挡住。
  assert.match(pointerdownSource, /const outsideSelection=currentTool==='select'&&!resizeHandle&&!insideSelection\(point\)/)
})
