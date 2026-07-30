const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'capture', 'capture.html'), 'utf8')
const css = fs.readFileSync(path.join(root, 'capture', 'capture.css'), 'utf8')
const script = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')
const toolbarMarkup = html.match(/<div id="toolbar"[\s\S]*?<\/div>\s*(?=<div id="toolbarTooltip")/)?.[0] || ''

test('capture toolbar uses non-empty in-app tooltips instead of native title popups', () => {
  assert.ok(toolbarMarkup)
  assert.doesNotMatch(toolbarMarkup, /\stitle="/)
  assert.match(html, /id="toolbarTooltip"[^>]+role="tooltip"/)

  const interactiveControls = [...toolbarMarkup.matchAll(/<(button|label|select)\b([^>]*)>/g)]
  assert.ok(interactiveControls.length >= 24)
  for (const [, tag, attributes] of interactiveControls) {
    const tooltip = attributes.match(/\bdata-tooltip="([^"]+)"/)?.[1] || ''
    assert.ok(tooltip.trim(), `${tag} is missing tooltip text`)
  }

  assert.match(css, /\.toolbar-tooltip\s*\{[^}]*pointer-events:\s*none/)
  assert.match(script, /function showToolbarTooltip\(target\)/)
  assert.match(script, /toolbar\.addEventListener\('pointerover'/)
  assert.match(script, /toolbar\.addEventListener\('focusin'/)
  assert.match(script, /toolbarTooltip\.textContent = message/)
})
