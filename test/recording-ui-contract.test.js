const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

test('recording runtime packages ffmpeg', () => {
  assert.match(packageJson.dependencies['ffmpeg-static'], /^\^5\./)
  assert.ok(packageJson.build.asarUnpack.includes('node_modules/ffmpeg-static/**/*'))
})
