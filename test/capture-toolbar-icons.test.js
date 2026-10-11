const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'capture', 'capture.html'), 'utf8')
const css = fs.readFileSync(path.join(root, 'capture', 'capture.css'), 'utf8')

const expectedIcons = [
  'select', 'rect', 'ellipse', 'arrow', 'line-tool', 'pen', 'highlight', 'mosaic', 'text', 'serial', 'watermark',
  'undo', 'redo', 'long-capture', 'qr', 'table', 'ocr', 'translate', 'record', 'pin', 'save', 'print',
  'copy', 'close'
]

test('capture toolbar export-PDF button ships its icon in the same ordered list (P0-4-T7②)', () => {
  // The icon sequence above is an exact ordered deepEqual of what capture.html
  // references, so the button and its icon have to land together: adding the
  // button without this entry (or the reverse) fails right here.
  const iconPaths = [...html.matchAll(/--icon:url\('([^']+\.svg)'\)/g)].map((match) => match[1])
  const exportIndex = iconPaths.indexOf('icons/print.svg')
  assert.equal(exportIndex, iconPaths.indexOf('icons/save.svg') + 1, 'the export-PDF icon follows the save icon')
  assert.match(
    html,
    /id="save"[\s\S]*id="exportPdf"[^>]*data-i18n-title="capture\.toolbar\.export-pdf"[^>]*data-i18n-aria-label="capture\.toolbar\.export-pdf"[\s\S]*id="copy"/,
    'the export-PDF button sits between save and copy on the strip'
  )
})

test('capture toolbar uses local SVG icons with current-color masking', () => {
  const iconPaths = [...html.matchAll(/--icon:url\('([^']+\.svg)'\)/g)].map((match) => match[1])

  assert.deepEqual(iconPaths, expectedIcons.map((name) => `icons/${name}.svg`))
  for (const iconPath of iconPaths) {
    assert.equal(fs.existsSync(path.join(root, 'capture', iconPath)), true, `${iconPath} should exist`)
  }
  assert.match(css, /\.toolbar-icon\s*\{[^}]*background:\s*currentColor/)
  assert.match(css, /-webkit-mask:\s*var\(--icon\)\s+center\/contain\s+no-repeat/)
})

test('the element bar adds no toolbar icons and stays off the tool strip (P0-5 PR1)', () => {
  // The ordered list above is an exact deepEqual over every --icon:url() in the page,
  // not just the ones inside .toolbar, so the P0-5 element actions must not borrow the
  // mask-icon set: they are plain text buttons on their own floating surface.
  const iconPaths = [...html.matchAll(/--icon:url\('([^']+\.svg)'\)/g)].map((match) => match[1])
  assert.deepEqual(iconPaths, expectedIcons.map((name) => `icons/${name}.svg`))

  assert.match(html, /id="toolbar"[\s\S]*<\/div>\s*<div id="elementBar"/, 'the element bar is a sibling after the strip, not another button on it')
  const elementBar = html.slice(html.indexOf('<div id="elementBar"'), html.indexOf('id="watermarkPanel"'))
  assert.doesNotMatch(elementBar, /--icon:url\(/, 'element actions must not inflate the toolbar icon list')
  assert.match(css, /\.element-bar \{/)
})
