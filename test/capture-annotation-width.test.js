const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'capture', 'capture.html'), 'utf8')
const css = fs.readFileSync(path.join(root, 'capture', 'capture.css'), 'utf8')
const script = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')

test('screenshot toolbar shows three thickness levels instead of a native select', () => {
  assert.match(html, /id="widthGroup" class="width-group" role="group" data-i18n-aria-label="capture\.toolbar\.width-group"/)

  // P0-1-T4 (S11): the visible 细/中/粗 labels come from shared/locales/capture.js now,
  // so what this file pins is the width -> data-i18n key mapping, not the literal text.
  for (const [width, name] of [[2, 'thin'], [4, 'medium'], [8, 'thick']]) {
    assert.match(
      html,
      new RegExp(`data-annotation-width="${width}"[^>]*aria-pressed="(?:true|false)"[^>]*data-i18n="capture\\.toolbar\\.width-${name}"`)
    )
  }
  assert.match(html, /data-annotation-width="4" class="active"[^>]*aria-pressed="true"/)

  // The squeezed native control is what made thickness look unselectable.
  assert.doesNotMatch(html, /id="lineWidth"/)
  assert.doesNotMatch(html, /<option/)
  assert.doesNotMatch(html, /特粗/)
  assert.doesNotMatch(html, /"14"/)
})

test('capture styles size the three buttons instead of a shrunken select', () => {
  assert.doesNotMatch(css, /\.toolbar select/)
  assert.doesNotMatch(css, /\.toolbar button,\s*\.toolbar select/)
  assert.match(css, /\.width-group\s*\{[^}]*display:\s*flex/)
  assert.match(css, /\.width-group button\s*\{[^}]*min-width:\s*2[4-9]px/)
  assert.match(css, /\.width-group button\.active\s*\{/)
})

test('capture script drives thickness from the group and remembers the choice', () => {
  assert.match(script, /const lineWidthGroup = document\.getElementById\('widthGroup'\)/)
  assert.doesNotMatch(script, /getElementById\('lineWidth'\)/)
  assert.doesNotMatch(script, /lineWidthInput/)

  // A4（2026-10-14 方案 D4）+ B4（D7）：新建标注读当前工具的**记忆样式**（resolveToolStyle），
  // 不是工具栏回显（回显只改 UI 镜像，选中项的样式不得被下一笔继承）。
  assert.match(script, /function annotationStyle\(\) \{\s*return resolveToolStyle\(currentTool, toolStyles\[currentTool\]\)\s*\}/)
  assert.match(script, /function setAnnotationWidth\(width, persist = false\)/)
  assert.match(script, /resolveAnnotationWidth\(width\)/)
  assert.match(script, /button\.setAttribute\('aria-pressed', String\(active\)\)/)
  assert.match(script, /lineWidthGroup\.addEventListener\('click'[^)]*\)[^\n]*setAnnotationWidth\(button\.dataset\.annotationWidth,true\)/)
  assert.match(script, /window\.captureAPI\.saveAnnotationWidth\(annotationWidth\)\.catch\(\(\) => \{\}\)/)
  // B4（D7）：初始化不再逐键回填，而是整块加载 annotationStyles（含旧键迁移）。
  assert.match(script, /applyAnnotationStyles\(data\.settings\)/)
})

test('capture script keeps Enter from copying while the thickness picker has focus', () => {
  assert.match(script, /const focused=document\.activeElement/)
  assert.match(script, /focused\?\.closest\?\.\('#widthGroup'\)\)return/)
})

test('capture page loads the width module before the overlay scripts', () => {
  const styleIndex = html.indexOf('annotation-style.js')
  const selectionIndex = html.indexOf('selection-utils.js')
  // The controller, not the locale table: shared/locales/capture.js also contains the
  // substring "capture.js" and is loaded first (P0-1-T4 / S11).
  const captureIndex = html.indexOf('src="capture.js"')
  assert.ok(styleIndex >= 0, 'annotation-style.js is loaded')
  assert.ok(styleIndex < selectionIndex && selectionIndex < captureIndex, 'load order: style, selection, capture')
})
