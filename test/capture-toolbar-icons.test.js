const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'capture', 'capture.html'), 'utf8')
const css = fs.readFileSync(path.join(root, 'capture', 'capture.css'), 'utf8')

const expectedIcons = [
  'select', 'rect', 'ellipse', 'arrow', 'line', 'pen', 'highlight', 'mosaic', 'text', 'serial',
  'undo', 'redo', 'long-capture', 'qr', 'table', 'ocr', 'translate', 'record', 'pin', 'save',
  'copy', 'close'
]

test('capture toolbar uses local SVG icons with current-color masking', () => {
  const iconPaths = [...html.matchAll(/--icon:url\('([^']+\.svg)'\)/g)].map((match) => match[1])

  assert.deepEqual(iconPaths, expectedIcons.map((name) => `icons/${name}.svg`))
  for (const iconPath of iconPaths) {
    assert.equal(fs.existsSync(path.join(root, 'capture', iconPath)), true, `${iconPath} should exist`)
  }
  assert.match(css, /\.toolbar-icon\s*\{[^}]*background:\s*currentColor/)
  assert.match(css, /-webkit-mask:\s*var\(--icon\)\s+center\/contain\s+no-repeat/)
})
