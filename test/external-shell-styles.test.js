const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')

test('pin and action shells load external stylesheets instead of inline <style>', () => {
  for (const [htmlPath, cssName] of [
    ['pin/pin.html', 'pin.css'],
    ['action/action.html', 'action.css']
  ]) {
    const html = fs.readFileSync(path.join(root, htmlPath), 'utf8')
    const css = fs.readFileSync(path.join(root, path.dirname(htmlPath), cssName), 'utf8')
    assert.match(html, new RegExp(`<link rel="stylesheet" href="${cssName}">`))
    assert.doesNotMatch(html, /<style>/)
    assert.ok(css.trim().length > 20)
  }
})
