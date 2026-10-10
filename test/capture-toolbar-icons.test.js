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
    /id="save"[\s\S]*id="exportPdf"[^>]*title="导出 PDF"[^>]*aria-label="导出 PDF"[\s\S]*id="copy"/,
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
