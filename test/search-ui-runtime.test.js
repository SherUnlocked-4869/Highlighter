const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')

test('the search renderer keeps results, keyboard focus and IME submission consistent', { timeout: 30000 }, (t) => {
  const profile = fs.mkdtempSync(path.join(root, '.tmp-search-ui-'))
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }))
  const result = spawnSync(require('electron'), [path.join(root, 'scripts', 'probe-search-ui.js')], {
    cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true,
    env: { ...process.env, HIGHLIGHTER_SEARCH_PROBE_PROFILE: profile }
  })
  assert.equal(result.status, 0, `Search UI probe failed: ${result.error || ''}\n${result.stdout}\n${result.stderr}`)
})
