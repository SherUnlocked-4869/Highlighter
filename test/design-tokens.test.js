const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const tokens = fs.readFileSync(path.join(root, 'shared/tokens.css'), 'utf8')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

test('shared design tokens define the canonical palette variables', () => {
  assert.match(tokens, /--primary:\s*#1677ff/)
  assert.match(tokens, /--radius:\s*8px/)
  assert.match(tokens, /--danger:/)
  assert.match(tokens, /--ok:/)
  assert.match(tokens, /--warn:/)
  assert.match(tokens, /--focus-ring:/)
})

test('core renderer shells load shared tokens before window CSS', () => {
  for (const [page, css] of [
    ['config/config.html', 'config.css'],
    ['capture/capture.html', 'capture.css'],
    ['search/search.html', 'search.css'],
    ['record/record.html', 'record.css'],
    ['action/action.html', 'action.css']
  ]) {
    const html = fs.readFileSync(path.join(root, page), 'utf8')
    const tokensIndex = html.indexOf('../shared/tokens.css')
    const cssIndex = html.indexOf(css)
    assert.ok(tokensIndex >= 0, `${page} links tokens.css`)
    assert.ok(cssIndex > tokensIndex, `${page} loads tokens before ${css}`)
  }
})

test('packaged builds include the shared token stylesheet', () => {
  assert.ok(packageJson.build.files.includes('shared/**/*'))
})
