const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const html = fs.readFileSync(path.join(__dirname, '..', 'config', 'config.html'), 'utf8')
const script = fs.readFileSync(path.join(__dirname, '..', 'config', 'config.js'), 'utf8')

test('config app exposes the selection toolbar route and controls', () => {
  assert.match(html, /data-route="selection-toolbar"/)
  assert.match(script, /function renderSelectionToolbarSettings\(/)
  assert.match(script, /id="searchEngine"/)
  for (const action of ['copy', 'search', 'translate', 'explain']) {
    assert.match(script, new RegExp(`data-toolbar-button="${action}"`))
  }
})
