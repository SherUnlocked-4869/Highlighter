'use strict'

// Re-apply the UIA selection-extraction timeout patch onto node_modules/selection-hook
// and rebuild the native module for the current Electron target.

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.join(__dirname, '..')
const patchSource = path.join(root, 'patches', 'selection-hook', 'selection_hook.cc')
const targetSource = path.join(root, 'node_modules', 'selection-hook', 'src', 'windows', 'selection_hook.cc')
const rebuiltBinary = path.join(root, 'node_modules', 'selection-hook', 'build', 'Release', 'selection-hook.node')
const prebuildBinary = path.join(root, 'node_modules', 'selection-hook', 'prebuilds', 'win32-x64', 'selection-hook.node')

function fail(message) {
  console.error(message)
  process.exit(1)
}

if (!fs.existsSync(patchSource)) fail(`Missing patch source: ${patchSource}`)
if (!fs.existsSync(path.dirname(targetSource))) fail('selection-hook is not installed under node_modules')

fs.copyFileSync(patchSource, targetSource)
console.log('Patched', path.relative(root, targetSource))

const rebuild = spawnSync(
  process.execPath,
  [
    path.join(root, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js'),
    '-f',
    '-w',
    'selection-hook',
    '-m',
    path.join(root, 'node_modules', 'selection-hook'),
    '--arch',
    'x64'
  ],
  { cwd: root, stdio: 'inherit' }
)
if (rebuild.status !== 0) fail('electron-rebuild failed')

if (!fs.existsSync(rebuiltBinary)) fail(`Rebuild did not produce ${rebuiltBinary}`)
fs.copyFileSync(rebuiltBinary, prebuildBinary)
console.log('Updated prebuild', path.relative(root, prebuildBinary))
console.log('selection-hook UIA timeout patch applied')
