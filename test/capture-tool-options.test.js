// B1/B2/B3/B5 契约（docs/plans/2026-10-14-capture-interaction-improvement-plan.md §4）：
// 两行工具栏容器与重摆位、第二行选项（填充/线型/圆角、箭头端点、高亮浓度、文字粗体）
// 的 DOM/接线/绘制分支。纯函数（预设表、归一、命中）的用例分别在
// capture-annotation-style.test.js 与 capture-annotation-geometry.test.js。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'capture', 'capture.html'), 'utf8')
const css = fs.readFileSync(path.join(root, 'capture', 'capture.css'), 'utf8')
const script = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')
const {
  FILL_PRESETS,
  DASH_PRESETS,
  RADIUS_PRESETS,
  ALPHA_PRESETS,
  TOOL_OPTION_FIELDS
} = require('../capture/annotation-style')

function sliceBetween(source, from, to) {
  const start = source.indexOf(from)
  const end = source.indexOf(to)
  assert.ok(start >= 0 && end > start, `could not slice ${from} .. ${to}`)
  return source.slice(start, end)
}

const optionsMarkup = html.slice(html.indexOf('<div id="toolOptions"'), html.indexOf('<div id="elementBar"'))
const drawSource = sliceBetween(script, 'function drawAnnotation(context, item', 'function renderOverlay()')

// ---------- B1：两行容器 + 重摆位 + 行序翻转 ----------

test('B1 (D5): the strip is a column container whose first row still carries every shipped control', () => {
  assert.match(html, /<div id="toolbar" class="toolbar hidden">\s*<!--[\s\S]{0,400}?-->\s*<div class="toolbar-row">/)
  assert.match(html, /<div id="toolOptions" class="toolbar-row hidden">/)
  // 外层 id/class 不变（test/capture-annotation-geometry.test.js:595 的钉死点）。
  assert.match(html, /id="toolbar" class="toolbar hidden"/)
  const mainRow = html.slice(html.indexOf('<div class="toolbar-row">'), html.indexOf('<div id="toolOptions"'))
  // 主行结构不动：宽度/颜色仍在第一行（D5 的取舍 —— 只装新选项，不搬迁旧控件）。
  assert.ok(mainRow.includes('id="widthGroup"'), 'width stays on row 1')
  assert.ok(mainRow.includes('id="colorButton"'), 'colour stays on row 1')
  assert.ok(mainRow.includes('class="tool-group"'), 'the tool group stays on row 1')
  assert.ok(html.indexOf('id="toolOptions"') < html.indexOf('id="elementBar"'), 'the options row is inside the strip, before the element bar')
  // 第二行不再是空壳：六个选项组都在里面。
  assert.equal((optionsMarkup.match(/data-option-group="/g) || []).length, 6)
})

test('B1 (D5/D6): the CSS makes the strip a column, keeps each row a flex row and flips the row order', () => {
  assert.match(css, /\.toolbar \{[\s\S]{0,240}?display: flex;\s*flex-direction: column;/)
  // flex-wrap：窗口比工具栏窄时（贴图重新标注的小图）换行而不是被窗口裁掉。
  assert.match(css, /\.toolbar-row \{ display: flex; align-items: center; flex-wrap: wrap; gap: 3px; \}/)
  assert.match(css, /\.toolbar\.above \{ flex-direction: column-reverse; \}/)
})

test('B1 (D6/R3): the toolbar size cache has exactly one invalidation helper with every size-changing call site', () => {
  assert.match(script, /const toolOptions = document\.getElementById\('toolOptions'\)/)
  assert.match(script, /function invalidateToolbarSize\(\) \{\s*toolbarSize = null\s*\}/)
  // 唯一写点：任何别处直接置 null 都会绕过失效纪律（R3 的"收敛为一个函数"）。
  assert.equal((script.match(/^\s+toolbarSize = null/gm) || []).length, 1, 'only invalidateToolbarSize() clears the cache')
  // 调用点 = 定义 + resize + 第二行可见性/换族 + 方案 2 的宽度上限变化 + 色板弹层开/关。
  //
  // 这条断言原来写的是"恰好 4 处"。计数约束不是行为约束：色板开关也会改变工具栏的绘制高度
  // （它 ~69px，比行高 ~63px 还高），必须同样走这个失效点，于是合法的改动会让计数变红。
  // 现在断言的是**真正的不变量**：这些会改变尺寸的位置每一个都必须调用失效函数。
  for (const [label, anchor] of [
    ['definition', 'function invalidateToolbarSize() {'],
    ['resize', 'function resizeCanvas() {'],
    ['row visibility', 'function syncToolOptionsRow() {'],
    ['width limit', 'function applyToolbarWidthLimit() {'],
    ['colour palette open', 'function openColorPalette() {'],
    ['colour palette close', 'function closeColorPalette() {']
  ]) {
    const start = script.indexOf(anchor)
    assert.ok(start > 0, `could not locate ${label} (${anchor})`)
    // The helper's own body contains the assignment, not a call; skip it for the definition case.
    const nextFunction = script.indexOf('\nfunction ', start + anchor.length)
    const body = script.slice(start, nextFunction > start ? nextFunction : start + 4000)
    if (label === 'definition') continue
    assert.match(body, /invalidateToolbarSize\(\)/, `${label} must drop the cached strip rect`)
  }
  assert.match(script, /function resizeCanvas\(\) \{[\s\S]{0,1200}?invalidateToolbarSize\(\)/)
  assert.match(script, /function syncToolOptionsRow\(\) \{[\s\S]{0,760}?invalidateToolbarSize\(\)\s*\n\s*render\(\)/)
  assert.match(script, /function applyToolbarWidthLimit\(\) \{[\s\S]{0,900}?invalidateToolbarSize\(\)/)
})

test('B1 (D6): placement measures the whole container and latches the above-the-region flip', () => {
  // 容器整体 rect（含第二行）—— 第二行展开后高度变化必须参与避让计算；落位规则本身
  // 收敛到纯函数（selection-utils.resolveFloatingPlacement，见 capture-floating-placement.test.js）。
  assert.match(script, /function toolbarPlacement\(\) \{[\s\S]{0,260}?toolbarSize \|\| \(toolbarSize = toolbar\.getBoundingClientRect\(\)\)/)
  assert.match(script, /function toolbarPlacement\(\) \{[\s\S]{0,520}?resolveFloatingPlacement\(\{[\s\S]{0,220}?anchor: selection,/)
  // A character window is a magic number that turns red whenever unrelated code is inserted
  // between the two anchors (feature C/D inserted ~1800 chars and broke the old {0,1400}).
  // What this assertion MEANS is "updateFloatingUi computes the strip placement itself", so
  // slice the function body by its neighbouring function definitions and search inside it.
  const floatingStart = script.indexOf('function updateFloatingUi() {')
  const floatingEnd = script.indexOf('function positionOcrResultBar() {')
  assert.ok(floatingStart > 0 && floatingEnd > floatingStart, 'could not locate the updateFloatingUi() body')
  const floatingBody = script.slice(floatingStart, floatingEnd)
  assert.ok(
    floatingBody.indexOf('const placement=toolbarPlacement()') > 0,
    'updateFloatingUi must compute the strip placement inside its own body'
  )
  assert.match(script, /toolbar\.classList\.toggle\('above',placement\.above\)/)
  // 元素条避让读同一个缓存 + 同一套落位（两条浮层不再各算一遍）。
  assert.match(script, /const toolbarRect = toolbarSize \|\| \(toolbarSize = toolbar\.getBoundingClientRect\(\)\)/)
  assert.match(script, /const toolbarPlace = resolveFloatingPlacement\(\{\s*anchor: selection,/)
})

test('B1/B2: the options row is a projection of the tool that owns options right now', () => {
  assert.match(script, /const TOOL_OPTION_GROUPS = Array\.from\(document\.querySelectorAll\('\[data-option-tools\]'\)\)/)
  assert.match(script, /function toolOptionGroups\(tool\) \{[\s\S]{0,220}?group\.dataset\.optionTools\.split\(' '\)\.includes\(tool\)/)
  // 有选项的选中项优先（select 工具下也能改矩形的填充/线型/圆角），否则跟随当前工具。
  assert.match(
    script,
    /function optionRowTool\(\) \{\s*const item = selectedAnnotationItem\(\)\s*if \(item && TOOL_OPTION_FIELDS\[item\.type\]\) return item\.type\s*return TOOL_OPTION_FIELDS\[currentTool\] \? currentTool : ''\s*\}/
  )
  assert.match(script, /function syncToolOptionsRow\(\) \{[\s\S]{0,520}?toolOptions\.classList\.toggle\('hidden', !rowVisible\)/)
  // 工具切换与选中变化都会重摆第二行。用函数切片而不是字符窗口：feature C/D3 各自往 setTool
  // 里加了一次面板同步，字符窗口会随之假红（和 updateFloatingUi 那条同一个教训）。
  const setToolSource = script.slice(script.indexOf('function setTool(tool)'), script.indexOf('// A1/A4: one place paints'))
  assert.ok(setToolSource.length > 0, 'setTool must be present')
  assert.match(setToolSource, /^function setTool\(tool\) \{[\s\S]*?syncToolOptionsRow\(\)/)
  assert.match(script, /function syncToolbarStyleFromSelection\(\) \{[\s\S]{0,700}?syncToolOptionsRow\(\)/)
})

// ---------- B2/B3/B5：第二行的内容 ----------

test('B2/B3/B5 (D9): every option group declares its owner tools and its preset levels', () => {
  const groups = {
    fill: { tools: 'rect ellipse', key: 'fill', values: FILL_PRESETS, group: 'capture.options.fill-group' },
    dash: { tools: 'rect ellipse line arrow', key: 'dash', values: DASH_PRESETS, group: 'capture.options.dash-group' },
    radius: { tools: 'rect', key: 'radius', values: RADIUS_PRESETS.map(String), group: 'capture.options.radius-group' },
    heads: { tools: 'arrow', key: 'startHead', values: ['true'], group: 'capture.options.head-group' },
    alpha: { tools: 'highlight', key: 'alpha', values: Object.keys(ALPHA_PRESETS), group: 'capture.options.alpha-group' },
    bold: { tools: 'text', key: 'bold', values: ['true'], group: 'capture.options.bold-group' }
  }
  for (const [name, spec] of Object.entries(groups)) {
    assert.match(
      optionsMarkup,
      new RegExp(`data-option-group="${name}" data-option-tools="${spec.tools}" role="group" data-i18n-aria-label="${spec.group.replace('.', '\\.')}"`),
      `${name} must declare its owner tools`
    )
  }
  // 每个按钮都自带 key/value/aria-pressed/i18n，接线因此不需要第二个监听器清单。
  for (const button of optionsMarkup.match(/<button[^>]*>/g) || []) {
    assert.match(button, /type="button"/)
    assert.match(button, /data-annotation-option="[a-zA-Z]+"/)
    assert.match(button, /data-annotation-option-value="[a-z0-9]+"/)
    assert.match(button, /aria-pressed="(?:true|false)"/)
    assert.match(button, /data-i18n-title="capture\.options\.[a-z-]+"/)
    // 2026-10-15：选项行也只留图标（汉字文字下沉），所以承载文案的标记是 aria-label。
    assert.match(button, /data-i18n-aria-label="capture\.options\.[a-z-]+"/)
    assert.doesNotMatch(button, /data-i18n="capture\.options\./, 'no visible text label any more')
  }
  // 每个选项按钮都必须带一个 mask 图标（图标行与 DOM 漂移会静默变成一个空白按钮）。
  const optionButtons = optionsMarkup.match(/<button[\s\S]*?<\/button>/g) || []
  assert.equal(optionButtons.length, 15, 'fifteen option buttons in the row')
  for (const button of optionButtons) {
    assert.match(
      button,
      /<span class="toolbar-icon" style="--icon:url\('icons\/[a-z-]+\.svg'\)" aria-hidden="true"><\/span>/,
      'every option button renders an icon'
    )
  }
  // 值集合必须与纯函数预设表逐字一致（DOM 与模型漂移会静默失效）。
  for (const value of FILL_PRESETS) assert.match(optionsMarkup, new RegExp(`data-annotation-option="fill" data-annotation-option-value="${value}"`))
  for (const value of DASH_PRESETS) assert.match(optionsMarkup, new RegExp(`data-annotation-option="dash" data-annotation-option-value="${value}"`))
  for (const value of RADIUS_PRESETS) assert.match(optionsMarkup, new RegExp(`data-annotation-option="radius" data-annotation-option-value="${value}"`))
  for (const value of Object.keys(ALPHA_PRESETS)) assert.match(optionsMarkup, new RegExp(`data-annotation-option="alpha" data-annotation-option-value="${value}"`))
  assert.match(optionsMarkup, /data-annotation-option="startHead" data-annotation-option-value="true" aria-pressed="false"/)
  assert.match(optionsMarkup, /data-annotation-option="endHead" data-annotation-option-value="true" aria-pressed="true"/)
  assert.match(optionsMarkup, /data-annotation-option="bold" data-annotation-option-value="true" aria-pressed="false"/)
  // 组内分节线由 CSS 从"可见的兄弟节点"推导，隐藏组不会留下孤立分隔线。
  assert.match(css, /\.option-group:not\(\.hidden\) ~ \.option-group:not\(\.hidden\) \{/)
})

test('B2/B3/B5: clicking an option writes the row tool memory and, when it matches, the selected item', () => {
  // 2026-10-19: the click hands the button itself over, because the boolean groups are
  // toggles that must invert what they currently display (see TOGGLE_OPTION_KEYS).
  assert.match(script, /toolOptions\.addEventListener\('click',\(event\)=>\{const button=event\.target\.closest\('\[data-annotation-option\]'\);if\(button\)setAnnotationOption\(button\.dataset\.annotationOption,button\.dataset\.annotationOptionValue,button\)\}\)/)
  assert.match(script, /const OPTION_VALUE_PARSERS = \{ radius: Number, startHead: \(value\) => value === 'true', endHead: \(value\) => value === 'true', bold: \(value\) => value === 'true' \}/)
  // A toggle group inverts the state it DISPLAYS (aria-pressed is written from the same
  // resolved options the next annotation uses), which is what makes "select, then
  // unselect" reachable at all; a radio group keeps its declarative value.
  assert.match(script, /const TOGGLE_OPTION_KEYS = new Set\(\['startHead', 'endHead', 'bold'\]\)/)
  assert.match(script, /function resolveOptionClickValue\(key, rawValue, button\) \{[\s\S]{0,420}?const displayed = button\?\.getAttribute\?\.\('aria-pressed'\) === 'true'[\s\S]{0,120}?return !displayed/)
  assert.match(
    script,
    /function setAnnotationOption\(key, rawValue, button\) \{[\s\S]{0,420}?const fields = TOOL_OPTION_FIELDS\[tool\]\s*if \(!fields \|\| !fields\.includes\(key\)\) return[\s\S]{0,420}?writeToolStyle\(tool, \{ \[key\]: value \}, true\)[\s\S]{0,260}?if \(item && item\.type === tool\) commitSelectedStyle\(\{ \[key\]: value \}\)/
  )
  assert.match(script, /function syncToolOptionControls\(\) \{[\s\S]{0,520}?String\(options\[key\]\) === button\.dataset\.annotationOptionValue[\s\S]{0,200}?button\.setAttribute\('aria-pressed', String\(active\)\)/)
  // 回显优先读选中项自己的选项（与 A4 同源：只改 UI，不压帧）。
  assert.match(
    script,
    /function rowToolOptions\(tool\) \{\s*const item = selectedAnnotationItem\(\)\s*if \(item && item\.type === tool\) return resolveToolOptions\(tool, item\)\s*return resolveToolOptions\(tool, toolStyles\[tool\]\)\s*\}/
  )
})

// ---------- B2/B3/B5：绘制分支与"缺省逐字节不变" ----------

test('B2/B3 (D9): the drawing entry keeps the pre-B2 output when no option field is present', () => {
  // solid/缺省不碰 setLineDash（旧标注逐字节不变），只有 dashed/dotted 才设置图案。
  assert.match(drawSource, /const dash = dashPattern\(item\.dash, width\)\s*\n\s*if \(dash\.length\) context\.setLineDash\(dash\)/)
  // fill === 'none'（或缺省）完全不画填充，矩形仍走 strokeRect。
  assert.match(drawSource, /const fill = resolveFill\(item\.fill\)[\s\S]{0,420}?if \(fill !== 'none'\) \{ context\.save\(\); if \(fill === 'translucent'\) context\.globalAlpha = FILL_ALPHA; context\.fillRect\(left, top, w, h\); context\.restore\(\) \}\s*\n\s*context\.strokeRect\(left, top, w, h\)/)
  // 圆角为 0（缺省）时绝不调用 roundRect。
  assert.match(drawSource, /const radius = resolveRadius\(item\.radius\) \* widthScale[\s\S]{0,160}?if \(radius > 0\) \{[\s\S]{0,260}?context\.roundRect\(left, top, w, h, corner\)/)
  // 反向拖动（负宽高）走同一个规范化 box，形状不变。
  assert.match(drawSource, /const left = Math\.min\(x, x \+ \(item\.x2-item\.x\)\*scaleX\), top = Math\.min\(y, y \+ \(item\.y2-item\.y\)\*scaleY\)/)
})

test('B3/B5 (D9): arrow heads, highlight opacity and bold text default to exactly the shipped rendering', () => {
  assert.match(script, /function drawArrow\(context, x1, y1, x2, y2, width, startHead = false, endHead = true\)/)
  assert.match(script, /if \(startHead\) \{ context\.beginPath\(\); context\.moveTo\(x1,y1\)/)
  assert.match(script, /if \(endHead\) \{ context\.beginPath\(\); context\.moveTo\(x2,y2\)/)
  // 缺省 = 只有终点箭头、.28 浓度、非粗体。
  assert.match(drawSource, /if \(item\.type === 'arrow'\) drawArrow\(context,x,y,x2,y2,width,item\.startHead === true,item\.endHead !== false\)/)
  assert.match(drawSource, /context\.globalAlpha=resolveAlpha\(item\.alpha\)/)
  assert.match(drawSource, /context\.font = `\$\{item\.bold === true \? 'bold ' : ''\}\$\{textFontSize\(baseWidth,widthScale\)\}px -apple-system,"Microsoft YaHei",sans-serif`/)
  // 画布状态仍按标注逐个 save/restore，虚线不会泄漏到下一个元素。
  assert.match(drawSource, /context\.save\(\); context\.strokeStyle = item\.color;[\s\S]*?context\.restore\(\)\s*\n\}/)
})

test('B2: the tools with no options never receive option fields', () => {
  // 只有声明过的工具才有选项字段；annotationStyle() 通过 resolveToolStyle 取（无声明 → 只有 color/width）。
  assert.match(script, /function annotationStyle\(\) \{\s*return resolveToolStyle\(currentTool, toolStyles\[currentTool\]\)\s*\}/)
  assert.equal(Object.hasOwn(TOOL_OPTION_FIELDS, 'pen'), false)
  assert.equal(Object.hasOwn(TOOL_OPTION_FIELDS, 'serial'), false)
  assert.doesNotMatch(script, /toolStyles\[currentTool\]\.(fill|dash|radius|alpha|bold)/)
})
