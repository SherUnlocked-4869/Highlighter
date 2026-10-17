'use strict'
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const fixture = path.join(root, 'test/native/selection-clipboard')
function run(executable, args) {
  const result = spawnSync(executable, args, { cwd: root, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('Native clipboard policy test failed')
}
if (process.platform !== 'win32') throw new Error('Native clipboard test currently supports Windows only')
run(process.execPath, [require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild', '--directory', fixture])
run(path.join(fixture, 'build/Release/clipboard-policy-test.exe'), [])
