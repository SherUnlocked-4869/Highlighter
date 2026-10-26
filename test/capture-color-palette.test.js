// A3 契约：预设色板 + 颜色持久化（docs/plans/2026-10-14-capture-interaction-improvement-plan.md §3 A3 / D3）。
//
// 结构照 test/capture-annotation-width.test.js 的写法：HTML 结构 → CSS → capture.js 接线 →
// preload 持久化管道。纯函数（预设表 / normalizeAnnotationColor）的用例在
// test/capture-annotation-style.test.js，设置键的类型契约在 test/settings-validation.test.js。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'capture', 'capture.html'), 'utf8')
const css = fs.readFileSync(path.join(root, 'capture', 'capture.css'), 'utf8')
const script = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')
const preload = fs.readFileSync(path.join(root, 'preload-capture.js'), 'utf8')

const PRESETS = [
  ['#ff3b30', 'red'],
  ['#ff9500', 'orange'],
  ['#ffcc00', 'yellow'],
  ['#34c759', 'green'],
  ['#1687ff', 'blue'],
  ['#111111', 'black'],
  ['#ffffff', 'white']
]

test('A3 (D3): the colour control is a swatch button with a popover, not a hidden native input', () => {
  assert.doesNotMatch(html, /<label class="color-wrap"/)
  assert.match(html, /<div class="color-wrap">/)
  assert.match(
    html,
    /id="colorButton"[^>]*aria-haspopup="true"[^>]*aria-expanded="false"[^>]*data-i18n-title="capture\.toolbar\.color"[^>]*data-i18n-aria-label="capture\.toolbar\.color"[^>]*><span id="colorSwatch"><\/span><\/button>/
  )
  assert.match(html, /id="colorPalette" class="color-palette hidden" role="group" data-i18n-aria-label="capture\.palette\.group"/)
  // 主行结构不变：色板仍然挂在 toolbar 里、宽度控件之前。
  assert.ok(html.indexOf('id="toolbar"') < html.indexOf('id="colorButton"'), 'the swatch lives on the tool strip')
  assert.ok(html.indexOf('id="colorButton"') < html.indexOf('id="widthGroup"'), 'the swatch stays before the width group')
  assert.ok(html.indexOf('id="colorPalette"') < html.indexOf('id="widthGroup"'), 'the popover is anchored to the swatch')
})

test('A3 (D3): the popover offers the recorder seven colours plus a custom slot and recents', () => {
  for (const [color, name] of PRESETS) {
    assert.match(
      html,
      new RegExp(
        `class="color-swatch" data-annotation-color="${color}" aria-pressed="false" style="--swatch:${color}" data-i18n-title="capture\\.palette\\.${name}" data-i18n-aria-label="capture\\.palette\\.${name}"`
      ),
      `${color} must ship as a labelled swatch`
    )
  }
  // 自定义入口：原生取色器只在显式点击"自定义"时弹出。
  assert.match(html, /<label class="color-custom" data-i18n-title="capture\.palette\.custom"><input id="color" type="color" value="#ff3b30"><span data-i18n="capture\.palette\.custom"><\/span><\/label>/)
  // 最近自定义色槽（会话内存，≤3）。
  assert.match(html, /id="recentColors" class="color-recent hidden" data-i18n-aria-label="capture\.palette\.recent"/)
  // 色板不得混进工具栏图标清单（capture-toolbar-icons.test.js 的精确 deepEqual）。
  const palette = html.slice(html.indexOf('<div class="color-wrap">'), html.indexOf('id="widthGroup"'))
  assert.doesNotMatch(palette, /--icon:url\(/)
})

test('A3 (D3): the palette CSS anchors the popover and separates hover from the latched state', () => {
  // Slice the actual `.color-palette { ... }` block instead of matching a fixed character window: a
  // window stops matching the moment a comment is added inside the rule (it did, when the upward
  // anchor was introduced), which turns the assertion into a comment-length check.
  const blockStart = css.indexOf('.color-palette {')
  const blockEnd = css.indexOf('}', blockStart)
  assert.ok(blockStart >= 0 && blockEnd > blockStart, 'the .color-palette rule must exist')
  const paletteBlock = css.slice(blockStart, blockEnd)
  assert.match(paletteBlock, /position: absolute/)
  assert.match(paletteBlock, /max-width: calc\(100vw - 20px\)/)
  // Anchored to the strip (which side is pinned by the regression test below).
  assert.match(paletteBlock, /(top|bottom):\s*calc\(100% \+ \d+px\)/)
  assert.match(css, /\.color-options button,?\s*\.color-recent button \{[\s\S]{0,200}?background: var\(--swatch\)/)
  assert.match(css, /\.color-options button:hover[\s\S]{0,160}?border-color: rgba\(255, 255, 255, \.55\)/)
  assert.match(css, /\.color-options button\.active[\s\S]{0,200}?border-color: #fff/)
  // D3 顺带修：hover 与 active 必须分成两条规则（.13 白 vs .18 白），不再共用一条。
  assert.match(css, /\.toolbar button:hover \{ color: #fff; background: rgba\(255, 255, 255, \.13\); \}/)
  assert.match(css, /\.toolbar button\.active \{ color: #fff; background: rgba\(255, 255, 255, \.18\); \}/)
  assert.match(css, /\.color-wrap > button span \{[\s\S]{0,240}?border-radius: 50%/)
})

test('A3: capture.js paints, toggles and persists the colour from one place', () => {
  assert.match(script, /const colorInput = document\.getElementById\('color'\)/)
  assert.match(script, /const colorPreview = document\.getElementById\('colorSwatch'\)/)
  assert.match(script, /const colorButton = document\.getElementById\('colorButton'\)/)
  assert.match(script, /const colorPalette = document\.getElementById\('colorPalette'\)/)
  assert.match(script, /const recentColorList = document\.getElementById\('recentColors'\)/)

  assert.match(
    script,
    /function applyToolbarColor\(color\) \{[\s\S]{0,260}?colorInput\.value = color[\s\S]{0,160}?colorPreview\.style\.background = color[\s\S]{0,320}?colorPalette\.querySelectorAll\('\[data-annotation-color\]'\)[\s\S]{0,200}?button\.setAttribute\('aria-pressed', String\(active\)\)/
  )
  // 点击色板 = 设该工具的默认色 + 持久化 + 双目标写入（选中项走离散帧）。
  assert.match(
    script,
    /function setAnnotationColor\(color, persist = false\) \{[\s\S]{0,120}?const resolved = normalizeAnnotationColor\(color\)[\s\S]{0,120}?annotationColor = resolved[\s\S]{0,120}?writeToolStyle\(toolbarStyleTool\(\), \{ color: resolved \}, persist\)[\s\S]{0,120}?applyToolbarColor\(resolved\)[\s\S]{0,120}?commitSelectedStyle\(\{ color: resolved \}\)[\s\S]{0,200}?window\.captureAPI\.saveAnnotationColor\(resolved\)\.catch\(\(\) => \{\}\)/
  )
  assert.match(script, /colorButton\.addEventListener\('click',\(event\)=>\{event\.stopPropagation\(\);toggleColorPalette\(\)\}\)/)
  assert.match(
    script,
    /colorPalette\.addEventListener\('click',\(event\)=>\{const button=event\.target\.closest\('\[data-annotation-color\]'\);if\(!button\)return;event\.stopPropagation\(\);setAnnotationColor\(button\.dataset\.annotationColor,true\)\}\)/
  )
  // 点外部关闭 + Esc 关闭 + 开合时同步 aria-expanded。
  assert.match(script, /document\.addEventListener\('click',\(event\)=>\{if\(colorPalette\.classList\.contains\('hidden'\)\)return;if\(colorPalette\.contains\(event\.target\)\|\|colorButton\.contains\(event\.target\)\)return;closeColorPalette\(\)\}\)/)
  assert.match(script, /else if\(!colorPalette\.classList\.contains\('hidden'\)\)closeColorPalette\(\)/)
  assert.match(script, /function openColorPalette\(\) \{[\s\S]{0,160}?colorButton\.setAttribute\('aria-expanded', 'true'\)/)
  assert.match(script, /function closeColorPalette\(\) \{[\s\S]{0,160}?colorButton\.setAttribute\('aria-expanded', 'false'\)/)
  // onInit 回填（B4 之后由 applyAnnotationStyles 整块加载，含旧键迁移）。
  assert.match(script, /applyAnnotationStyles\(data\.settings\)/)
})

test('A3: recents are session-only, capped at three, and never whitelist the custom colour', () => {
  assert.match(script, /const MAX_RECENT_COLORS = 3/)
  assert.match(script, /let recentAnnotationColors = \[\]/)
  assert.match(
    script,
    /function rememberRecentColor\(value\) \{[\s\S]{0,200}?const color = normalizeAnnotationColor\(value\)[\s\S]{0,200}?if \(!PRESET_COLORS\.some\(\(preset\) => preset\.color === color\)\)[\s\S]{0,200}?\.slice\(0, MAX_RECENT_COLORS\)/
  )
  assert.match(script, /function renderRecentColors\(\) \{[\s\S]{0,240}?recentColorList\.replaceChildren\(\)[\s\S]{0,400}?button\.style\.setProperty\('--swatch', color\)/)
  // capture 端不设颜色白名单：任何 #rrggbb 都能存能回显，PRESET_COLORS 只服务于"最近色不重复收录预设"。
  assert.equal(script.match(/PRESET_COLORS\./g).length, 1, 'the preset list is only consulted by the recents filter')
  assert.doesNotMatch(script, /annotationColor.*=.*PRESET_COLORS|PRESET_COLORS.*annotationColor =/)
})

test('A3: the colour rides the existing settings:update pipe with no new IPC channel', () => {
  assert.match(
    preload,
    /saveAnnotationColor: \(annotationColor\) => ipcRenderer\.invoke\('settings:update', \{ screenshot: \{ annotationColor \} \}\)/
  )
  assert.match(preload, /saveAnnotationWidth: \(annotationWidth\) => ipcRenderer\.invoke\('settings:update'/)
})

// Regression from a real device: "after I click a colour the toolbar refreshes into the colour and
// width pickers and I can no longer select a drawing tool (pen, rect, ...)".
//
// The palette is a positioned popover inside the strip. It used to open DOWNWARD
// (`top: calc(100% + 6px)`), so whenever the strip was docked near the bottom of the screen - which is
// exactly where the placement rule puts it when the region sits low - the popover landed on top of the
// strip and its buttons. A positioned element wins the hit test, so the covered tools stopped responding
// to clicks. Measured on the real device: strip 370..446, palette 413..482 (33px of overlap).
//
// The fix is to open UPWARD by default, with a measured flip back below only when there is no room above.
test('A3 the colour palette opens above the strip so it never covers the tool buttons', () => {
  // Slice ONLY the default `.color-palette { ... }` rule, so the `.below` fallback (which legitimately
  // opens downward) cannot satisfy or trip the assertions.
  const start = css.indexOf('.color-palette {')
  const end = css.indexOf('}', start)
  assert.ok(start >= 0 && end > start, 'the .color-palette rule must exist')
  const defaultRule = css.slice(start, end)
  // Above the strip: anchored to the strip's top edge, not below it.
  assert.match(defaultRule, /bottom:\s*calc\(100% \+ \d+px\)/)
  assert.match(defaultRule, /top:\s*auto/)
  assert.doesNotMatch(
    defaultRule,
    /(^|\n)\s*top:\s*calc\(100% \+ \d+px\)/,
    'opening downward by default is what covered the strip and made the tools unclickable'
  )
  // The escape hatch exists for a strip docked at the top of the screen, and it may open downward.
  assert.match(css, /\.color-palette\.below\s*\{[^}]*top:\s*calc\(100% \+ \d+px\)/)
  assert.match(css, /\.color-palette\.below\s*\{[^}]*bottom:\s*auto/)
})

test('A3 the palette visibility changes drop the cached strip rect and re-run placement', () => {
  const open = script.slice(script.indexOf('function openColorPalette()'), script.indexOf('function closeColorPalette()'))
  const close = script.slice(script.indexOf('function closeColorPalette()'), script.indexOf('function toggleColorPalette()'))
  // Opening/closing changes the strip's painted height, so the cached rect must be invalidated or the
  // placement rule keeps positioning the strip with the old size.
  assert.match(open, /invalidateToolbarSize\(\)/)
  assert.match(open, /invalidateToolbarSize\(\)[\s\S]*render\(\)/)
  assert.match(close, /invalidateToolbarSize\(\)/)
  // And the upward default has a measured escape hatch for a top-docked strip.
  assert.match(open, /ensureColorPaletteOnScreen\(\)/)
  const ensure = script.slice(script.indexOf('function ensureColorPaletteOnScreen()'), script.indexOf('function closeColorPalette()'))
  assert.match(ensure, /roomAbove/)
  assert.match(ensure, /roomBelow/)
  assert.match(ensure, /classList\.toggle\('below'/)
  // It must measure the LIVE rect, not a cached one (the cache is invalidated right before it).
  assert.match(ensure, /toolbar\.getBoundingClientRect\(\)/)
})
