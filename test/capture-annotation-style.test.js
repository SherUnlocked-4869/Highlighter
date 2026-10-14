const test = require('node:test')
const assert = require('node:assert/strict')

const {
  WIDTH_PRESETS,
  WIDTHS,
  DEFAULT_WIDTH,
  PRESET_COLORS,
  DEFAULT_COLOR,
  FILL_PRESETS,
  DASH_PRESETS,
  RADIUS_PRESETS,
  ALPHA_PRESETS,
  FILL_ALPHA,
  TOOL_OPTION_FIELDS,
  DEFAULT_TOOL_OPTIONS,
  TOOL_STYLE_TOOLS,
  TOOL_DEFAULT_COLORS,
  resolveWidth,
  normalizeAnnotationColor,
  nextWidthPreset,
  resolveFill,
  resolveDash,
  resolveRadius,
  resolveAlpha,
  dashPattern,
  resolveToolOptions,
  resolveToolStyle,
  resolveToolStyles,
  scaleFactor,
  textFontSize,
  serialRadius,
  highlightWidth
} = require('../capture/annotation-style')

test('the thickness whitelist is exactly the three shipped levels', () => {
  assert.deepEqual(WIDTHS, [2, 4, 8])
  assert.deepEqual(WIDTH_PRESETS.map((preset) => preset.label), ['细', '中', '粗'])
  assert.equal(DEFAULT_WIDTH, 4)
})

test('resolveWidth keeps whitelisted values and falls back to medium', () => {
  for (const width of [2, 4, 8]) {
    assert.equal(resolveWidth(width), width)
    assert.equal(resolveWidth(String(width)), width)
  }
  for (const invalid of [0, 1, 3, 5, 9, 14, '', null, undefined, 'abc', NaN, Infinity, -4]) {
    assert.equal(resolveWidth(invalid), 4, `${String(invalid)} should fall back to 4`)
  }
})

test('tool mappings stay pixel-identical to the previous three levels', () => {
  assert.deepEqual([2, 4, 8].map((width) => textFontSize(width)), [14, 20, 40])
  // max(12, width*3): the 4px level is still clamped to the 12px floor.
  assert.deepEqual([2, 4, 8].map((width) => serialRadius(width)), [12, 12, 24])
  assert.deepEqual([2, 4, 8].map((width) => highlightWidth(width)), [14, 16, 32])
})

test('export scaling multiplies the mapped size instead of the whitelist match', () => {
  assert.equal(textFontSize(4, 1.5), 30)
  assert.equal(serialRadius(4, 1.5), 18)
  assert.equal(highlightWidth(8, 2), 64)
  // A scaled float must not be treated as an unknown width.
  assert.equal(resolveWidth(6), 4)
  assert.equal(textFontSize(2, 3), 30)
})

test('a missing or nonsensical scale is ignored', () => {
  assert.equal(scaleFactor(undefined), 1)
  assert.equal(scaleFactor(0), 1)
  assert.equal(scaleFactor(-2), 1)
  assert.equal(scaleFactor(NaN), 1)
  assert.equal(scaleFactor('2'), 2)
  assert.equal(textFontSize(4), 20)
  assert.equal(serialRadius(8, 0), 24)
})

// ---------- A3：色板预设与颜色归一（方案 D3） ----------

test('the palette ships the same seven colours as the region recorder', () => {
  const recorder = require('../record/annotation-utils')
  assert.deepEqual(
    PRESET_COLORS.map((preset) => preset.color),
    ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#1687ff', '#111111', '#ffffff']
  )
  // 刻意复制而不是 import（两模块加载环境不同）：两处色值必须逐字一致。
  assert.deepEqual(
    PRESET_COLORS.map((preset) => preset.color),
    [...recorder.ANNOTATION_COLORS]
  )
  assert.equal(DEFAULT_COLOR, '#ff3b30')
  assert.equal(new Set(PRESET_COLORS.map((preset) => preset.id)).size, PRESET_COLORS.length)
})

test('normalizeAnnotationColor keeps any #rrggbb and only rejects the shape', () => {
  // 自定义色必须能存能回显：capture 端不做预设白名单（与 record 的 cleanStyle 差异是刻意的）。
  assert.equal(normalizeAnnotationColor('#123456'), '#123456')
  assert.equal(normalizeAnnotationColor('#ABCDEF'), '#abcdef')
  assert.equal(normalizeAnnotationColor('  #FF3B30  '), '#ff3b30')
  for (const invalid of ['', 'red', '#fff', '#12345', '#1234567', 'ff3b30', null, undefined, 123, {}, '#12345g']) {
    assert.equal(normalizeAnnotationColor(invalid), DEFAULT_COLOR, `${String(invalid)} should fall back to the default`)
  }
})

test('nextWidthPreset steps one level and clamps at both ends instead of wrapping', () => {
  assert.equal(nextWidthPreset(2, 1), 4)
  assert.equal(nextWidthPreset(4, 1), 8)
  assert.equal(nextWidthPreset(8, 1), 8)
  assert.equal(nextWidthPreset(8, -1), 4)
  assert.equal(nextWidthPreset(4, -1), 2)
  assert.equal(nextWidthPreset(2, -1), 2)
  // 非预设的当前值先按 resolveWidth 归一（9 → 4），非法步长是 no-op 而不是 NaN。
  assert.equal(nextWidthPreset(9, 1), 8)
  assert.equal(nextWidthPreset('4', -1), 2)
  assert.equal(nextWidthPreset(4, 0), 4)
  assert.equal(nextWidthPreset(4, NaN), 4)
  assert.equal(nextWidthPreset(4, undefined), 4)
})

// ---------- B2/B3/B5：第二行选项的预设与归一（方案 D9） ----------

test('the option preset tables are exactly the levels the second row offers', () => {
  assert.deepEqual(FILL_PRESETS, ['none', 'translucent', 'solid'])
  assert.deepEqual(DASH_PRESETS, ['solid', 'dashed', 'dotted'])
  assert.deepEqual(RADIUS_PRESETS, [0, 4, 8])
  // 高亮浓度：medium(.28) 是改造前写死的值（drawAnnotation 的 globalAlpha）。
  assert.deepEqual(ALPHA_PRESETS, { light: 0.18, medium: 0.28, strong: 0.45 })
  assert.equal(FILL_ALPHA, 0.28)
  // 每个工具只声明自己的字段：cross-tool 字段污染会写进标注对象并进快照。
  assert.deepEqual(TOOL_OPTION_FIELDS.rect, ['fill', 'dash', 'radius'])
  assert.deepEqual(TOOL_OPTION_FIELDS.ellipse, ['fill', 'dash'])
  assert.deepEqual(TOOL_OPTION_FIELDS.line, ['dash'])
  assert.deepEqual(TOOL_OPTION_FIELDS.arrow, ['dash', 'startHead', 'endHead'])
  assert.deepEqual(TOOL_OPTION_FIELDS.highlight, ['alpha'])
  assert.deepEqual(TOOL_OPTION_FIELDS.text, ['bold'])
  for (const tool of ['pen', 'blur', 'serial', 'watermark', 'select']) {
    assert.equal(TOOL_OPTION_FIELDS[tool], undefined, `${tool} owns no options`)
  }
})

test('option resolvers keep whitelisted levels and fall back to the shipped rendering', () => {
  assert.equal(resolveFill('solid'), 'solid')
  assert.equal(resolveFill('translucent'), 'translucent')
  assert.equal(resolveFill('none'), 'none')
  for (const invalid of ['', 'filled', null, undefined, 1, {}]) assert.equal(resolveFill(invalid), 'none')

  assert.equal(resolveDash('dashed'), 'dashed')
  assert.equal(resolveDash('dotted'), 'dotted')
  for (const invalid of ['dash', '', null, undefined, 3]) assert.equal(resolveDash(invalid), 'solid')

  assert.equal(resolveRadius(4), 4)
  assert.equal(resolveRadius('8'), 8)
  for (const invalid of [1, 5, 12, -4, NaN, Infinity, '', null]) assert.equal(resolveRadius(invalid), 0)

  // resolveAlpha 直接给渲染层数值：缺省/非法一律回到 medium。
  assert.equal(resolveAlpha('light'), 0.18)
  assert.equal(resolveAlpha('strong'), 0.45)
  for (const invalid of ['medium-ish', '', null, undefined, 0.28, {}]) assert.equal(resolveAlpha(invalid), 0.28)
})

test('dashPattern scales with the stroke width and leaves "solid" to the canvas default', () => {
  // solid 返回空数组：调用方完全不碰 setLineDash，旧标注的渲染逐字节不变。
  assert.deepEqual(dashPattern('solid', 4), [])
  assert.deepEqual(dashPattern(undefined, 4), [])
  assert.deepEqual(dashPattern('weird', 4), [])
  assert.deepEqual(dashPattern('dashed', 4), [12, 8])
  assert.deepEqual(dashPattern('dotted', 4), [4, 6])
  // 导出坐标下 width 已经是缩放后的值（4 * 1.5），图案跟着缩放。
  assert.deepEqual(dashPattern('dashed', 6), [18, 12])
  // 极小/非法宽度兜底为 1，绝不产出 0 长度的虚线段。
  assert.deepEqual(dashPattern('dotted', 0), [1, 1.5])
  assert.deepEqual(dashPattern('dotted', -3), [1, 1.5])
  assert.deepEqual(dashPattern('dashed', undefined), [3, 2])
})

test('resolveToolOptions normalises one tool at a time and never invents a field', () => {
  assert.deepEqual(resolveToolOptions('rect', {}), { fill: 'none', dash: 'solid', radius: 0 })
  assert.deepEqual(resolveToolOptions('ellipse', undefined), { fill: 'none', dash: 'solid' })
  assert.deepEqual(resolveToolOptions('line', null), { dash: 'solid' })
  assert.deepEqual(resolveToolOptions('arrow', {}), { dash: 'solid', startHead: false, endHead: true })
  assert.deepEqual(resolveToolOptions('highlight', {}), { alpha: 'medium' })
  assert.deepEqual(resolveToolOptions('text', {}), { bold: false })
  // 无选项的工具恒为空对象（不进标注对象）。
  assert.deepEqual(resolveToolOptions('pen', { fill: 'solid' }), {})
  assert.deepEqual(resolveToolOptions('select', {}), {})
  // 选中项本身就是合法来源（A4 回显复用同一个函数）。
  assert.deepEqual(
    resolveToolOptions('rect', { type: 'rect', x: 1, y: 2, color: '#000', width: 4, fill: 'solid', dash: 'dashed', radius: 8 }),
    { fill: 'solid', dash: 'dashed', radius: 8 }
  )
  // 手改 store / 旧标注的脏值一律降级到 D9 默认，绝不透传到渲染层。
  assert.deepEqual(resolveToolOptions('rect', { fill: 'filled', dash: 'wavy', radius: 5 }), { fill: 'none', dash: 'solid', radius: 0 })
  assert.deepEqual(resolveToolOptions('rect', 'junk'), { fill: 'none', dash: 'solid', radius: 0 })
  assert.deepEqual(resolveToolOptions('text', { bold: 'yes' }), { bold: false })
  assert.deepEqual(resolveToolOptions('text', { bold: true }), { bold: true })
  assert.deepEqual(resolveToolOptions('arrow', { startHead: true, endHead: false }), { dash: 'solid', startHead: true, endHead: false })
  assert.deepEqual(resolveToolOptions('highlight', { alpha: 'strong' }), { alpha: 'strong' })
  // 返回新对象，绝不修改入参（与几何模块的"绝不就地改"契约一致）。
  const source = { fill: 'solid' }
  const resolved = resolveToolOptions('rect', source)
  resolved.fill = 'none'
  assert.deepEqual(source, { fill: 'solid' })
})

test('DEFAULT_TOOL_OPTIONS matches the pre-B2 rendering for every tool', () => {
  assert.deepEqual(DEFAULT_TOOL_OPTIONS.rect, { fill: 'none', dash: 'solid', radius: 0 })
  assert.deepEqual(DEFAULT_TOOL_OPTIONS.ellipse, { fill: 'none', dash: 'solid' })
  assert.deepEqual(DEFAULT_TOOL_OPTIONS.arrow, { dash: 'solid', startHead: false, endHead: true })
  // 每个有选项的工具都必须有默认值，否则 resolveToolOptions 会产出 undefined。
  for (const tool of Object.keys(TOOL_OPTION_FIELDS)) {
    assert.ok(DEFAULT_TOOL_OPTIONS[tool], `${tool} needs a default option set`)
    assert.deepEqual(Object.keys(DEFAULT_TOOL_OPTIONS[tool]).sort(), [...TOOL_OPTION_FIELDS[tool]].sort(), `${tool} defaults must cover its fields`)
  }
})

// ---------- B4：per-tool 样式归一与整表输出（方案 D7） ----------

test('B4: the remembered style table covers exactly the eight drawing tools', () => {
  assert.deepEqual(TOOL_STYLE_TOOLS, ['rect', 'ellipse', 'arrow', 'line', 'pen', 'highlight', 'text', 'serial'])
  // 高亮出厂是黄色（它自己的默认色），其余工具红。
  assert.deepEqual(TOOL_DEFAULT_COLORS, { highlight: '#ffcc00' })
})

test('B4: resolveToolStyle normalises colour, width and that tool options only', () => {
  assert.deepEqual(resolveToolStyle('pen', undefined), { color: '#ff3b30', width: 4 })
  assert.deepEqual(resolveToolStyle('highlight', {}), { color: '#ffcc00', width: 4, alpha: 'medium' })
  assert.deepEqual(resolveToolStyle('rect', {}), { color: '#ff3b30', width: 4, fill: 'none', dash: 'solid', radius: 0 })
  assert.deepEqual(resolveToolStyle('arrow', {}), { color: '#ff3b30', width: 4, dash: 'solid', startHead: false, endHead: true })
  assert.deepEqual(resolveToolStyle('text', {}), { color: '#ff3b30', width: 4, bold: false })
  // 存过什么就用什么（宽度走 2/4/8 白名单，颜色按 #rrggbb 小写化）。
  assert.deepEqual(resolveToolStyle('pen', { color: '#0A0B0C', width: 8 }), { color: '#0a0b0c', width: 8 })
  assert.deepEqual(resolveToolStyle('pen', { color: 'red', width: 9 }), { color: '#ff3b30', width: 4 })
  assert.deepEqual(
    resolveToolStyle('rect', { color: '#123456', width: 2, fill: 'solid', dash: 'dotted', radius: 8 }),
    { color: '#123456', width: 2, fill: 'solid', dash: 'dotted', radius: 8 }
  )
  // 脏值逐字段降级，未声明的字段绝不出现（pen 不吃 fill）。
  assert.deepEqual(resolveToolStyle('pen', { fill: 'solid', dash: 'dashed' }), { color: '#ff3b30', width: 4 })
  assert.deepEqual(resolveToolStyle('select', { fill: 'solid' }), { color: '#ff3b30', width: 4 })
  assert.deepEqual(resolveToolStyle('pen', 'junk'), { color: '#ff3b30', width: 4 })
  assert.deepEqual(resolveToolStyle('pen', []), { color: '#ff3b30', width: 4 })
})

test('B4: resolveToolStyles always returns the full canonical map for persistence', () => {
  const full = resolveToolStyles(undefined)
  assert.deepEqual(Object.keys(full), [...TOOL_STYLE_TOOLS])
  assert.deepEqual(full.pen, { color: '#ff3b30', width: 4 })
  assert.deepEqual(full.highlight, { color: '#ffcc00', width: 4, alpha: 'medium' })
  // 只写了一部分也能得到合法整表：未写的工具回到默认（避免半截对象落盘）。
  const partial = resolveToolStyles({ pen: { color: '#111111', width: 8 } })
  assert.deepEqual(partial.pen, { color: '#111111', width: 8 })
  assert.deepEqual(partial.rect, { color: '#ff3b30', width: 4, fill: 'none', dash: 'solid', radius: 0 })
  // 非对象（旧 store / 手改）不抛错。
  assert.deepEqual(Object.keys(resolveToolStyles('junk')), [...TOOL_STYLE_TOOLS])
  // 返回的是新对象：写入它不会污染入参。
  const source = { pen: { color: '#111111', width: 8 } }
  const resolved = resolveToolStyles(source)
  resolved.pen.width = 2
  assert.deepEqual(source.pen, { color: '#111111', width: 8 })
})
