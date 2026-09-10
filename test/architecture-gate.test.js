const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const root = path.join(__dirname, '..')

test('architecture gate keeps main.js assembled from domains', () => {
  const output = execFileSync(process.execPath, [path.join(root, 'scripts', 'check-architecture.js')], {
    encoding: 'utf8'
  })
  assert.match(output, /architecture-check: ok/)
  assert.equal(fs.existsSync(path.join(root, 'scripts', 'check-architecture.js')), true)
})
