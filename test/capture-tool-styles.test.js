// B4 契约：per-tool 样式记忆（docs/plans/2026-10-14-capture-interaction-improvement-plan.md §4 B4 / D7）。
//
// 设置模板 ↔ 渲染端状态 ↔ 持久化管道的三层一致性：模板枚举决定白名单（主进程），
// resolveToolStyle/resolveToolStyles 决定取值归一（渲染端纯函数），capture.js 只做接线。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { DEFAULT_SETTINGS } = require('../main/services/settings-defaults')
const { TOOL_STYLE_TOOLS, resolveToolStyles } = require('../capture/annotation-style')

const root = path.join(__dirname, '..')
const script = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')
const preload = fs.readFileSync(path.join(root, 'preload-capture.js'), 'utf8')

function sliceBetween(source, from, to) {
  const start = source.indexOf(from)
  const end = source.indexOf(to)
  assert.ok(start >= 0 && end > start, `could not slice ${from} .. ${to}`)
  return source.slice(start, end)
}

const applySource = sliceBetween(script, 'function applyAnnotationStyles(settings)', 'function applySmartCandidates(')
const writeSource = sliceBetween(script, 'function writeToolStyle(tool, patch, persist)', 'function annotationStylesPayload()')

test('B4: the shipped settings template is exactly the canonical style map', () => {
  const template = DEFAULT_SETTINGS.screenshot.annotationStyles
  const canonical = resolveToolStyles(undefined)
  assert.deepEqual(Object.keys(template).sort(), [...TOOL_STYLE_TOOLS].sort(), 'every remembered tool needs a template block')
  assert.deepEqual(template, canonical, 'the template must be the same shape the renderer normalises to')
})

test('B4: the whole map is persisted at once, never field by field', () => {
  assert.match(
    preload,
    /saveAnnotationStyles: \(annotationStyles\) => ipcRenderer\.invoke\('settings:update', \{ screenshot: \{ annotationStyles \} \}\)/
  )
  assert.match(script, /function annotationStylesPayload\(\) \{\s*return resolveToolStyles\(toolStyles\)\s*\}/)
  assert.match(script, /function persistToolStyles\(\) \{\s*window\.captureAPI\.saveAnnotationStyles\(annotationStylesPayload\(\)\)\.catch\(\(\) => \{\}\)\s*\}/)
  // 唯一写点：一处合并写入，绝无逐字段直接落到 store 的路径。
  assert.equal(script.match(/saveAnnotationStyles\(/g).length, 1, 'the persist helper is the only writer')
})

test('B4: a style write normalises into the tool block and persists only when asked', () => {
  assert.match(
    writeSource,
    /function writeToolStyle\(tool, patch, persist\) \{\s*if \(!tool\) return\s*toolStyles\[tool\] = Object\.assign\(resolveToolStyle\(tool, toolStyles\[tool\]\), patch\)\s*if \(persist\) persistToolStyles\(\)\s*\}/
  )
  // 点击类编辑（色板/线宽/选项）带 persist=true；回显与拖动绝不再写盘。
  assert.match(script, /writeToolStyle\(toolbarStyleTool\(\), \{ color: resolved \}, persist\)/)
  assert.match(script, /writeToolStyle\(toolbarStyleTool\(\), \{ width: resolved \}, persist\)/)
  assert.match(script, /writeToolStyle\(tool, \{ \[key\]: value \}, true\)/)
  assert.match(script, /function syncToolbarStyleFromSelection\(\) \{[\s\S]{0,700}?syncToolOptionsRow\(\)/)
  assert.doesNotMatch(script, /function syncToolbarStyleFromSelection\(\) \{[\s\S]{0,700}?persistToolStyles|function syncToolOptionsRow\(\) \{[\s\S]{0,900}?persistToolStyles/)
})

test('B4: the toolbar edits the selected element tool, otherwise the active tool', () => {
  assert.match(
    script,
    /function toolbarStyleTool\(\) \{\s*const item = selectedAnnotationItem\(\)\s*if \(item && TOOL_STYLE_TOOLS\.includes\(item\.type\)\) return item\.type\s*return TOOL_STYLE_TOOLS\.includes\(currentTool\) \? currentTool : ''\s*\}/
  )
  assert.match(script, /function currentToolStyle\(\) \{\s*return resolveToolStyle\(currentTool, toolStyles\[currentTool\]\)\s*\}/)
  // 回显的"恢复默认"读的是当前工具记忆（D4 的数据源切换），不是某个全局标量。
  assert.match(script, /function syncToolbarStyleFromSelection\(\) \{[\s\S]{0,260}?const fallback = currentToolStyle\(\)/)
})

test('B4: init loads the structured block and migrates the legacy scalars once', () => {
  assert.match(applySource, /const stored = settings\?\.screenshot\?\.annotationStyles/)
  assert.match(applySource, /const hasStructured = !!stored && typeof stored === 'object' && !Array\.isArray\(stored\)/)
  assert.match(applySource, /toolStyles = hasStructured \? Object\.assign\(\{\}, stored\) : \{\}/)
  // 旧键铺底：一次性、不写回（只在没有结构化键时执行）。
  assert.match(applySource, /const legacyColor = normalizeAnnotationColor\(settings\?\.screenshot\?\.annotationColor\)/)
  assert.match(applySource, /const legacyWidth = resolveAnnotationWidth\(settings\?\.screenshot\?\.annotationWidth\)/)
  assert.match(applySource, /if \(!hasStructured\) \{\s*TOOL_STYLE_TOOLS\.forEach\(\(tool\) => \{ toolStyles\[tool\] = \{ color: legacyColor, width: legacyWidth \} \}\)\s*\}/)
  // 铺底之后立刻回显（否则工具栏停在 HTML 的硬编码初值）。
  assert.match(applySource, /syncToolbarStyleFromSelection\(\)\s*\n\}/)
  assert.match(script, /applyAnnotationStyles\(data\.settings\)/)
  // 初始化不再是逐键回填（那会写到当前工具块上，语义错误）。
  assert.doesNotMatch(script, /setAnnotationWidth\(data\.settings/)
  assert.doesNotMatch(script, /setAnnotationColor\(data\.settings/)
})

test('B4: the legacy scalar keys keep being written for older builds', () => {
  assert.match(script, /window\.captureAPI\.saveAnnotationColor\(resolved\)\.catch\(\(\) => \{\}\)/)
  assert.match(script, /window\.captureAPI\.saveAnnotationWidth\(resolved\)\.catch\(\(\) => \{\}\)/)
  assert.match(script, /window\.captureAPI\.saveAnnotationWidth\(annotationWidth\)\.catch\(\(\) => \{\}\)/)
  // 滚轮的去抖收口同时落 annotationStyles（宽度的整表写入跟着去抖，不逐格写盘）。
  assert.match(script, /function scheduleAnnotationWidthPersist\(\) \{[\s\S]{0,420}?persistToolStyles\(\)/)
})

test('B4: a new capture reloads the style map instead of inheriting the previous one', () => {
  assert.match(script, /window\.captureAPI\.onInit\(\(data\)=>\{[\s\S]{0,2200}?resetAnnotationState\(\)[\s\S]{0,1200}?applyAnnotationStyles\(data\.settings\)/)
})
