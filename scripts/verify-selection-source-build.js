'use strict'

// Rebuild only the vendored addon in an empty dependency tree. This deliberately
// does not reuse its checked-out build/ or any installed selection-hook prebuild.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd: root, windowsHide: true, stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Source build verification failed (${result.status})`)
}

function verify() {
  const scratch = path.join(root, '.tmp', 'clipboard-g0')
  fs.mkdirSync(scratch, { recursive: true })
  const fixture = fs.mkdtempSync(path.join(scratch, 'selection-clean-'))
  const source = path.join(fixture, 'vendor', 'selection-hook')
  fs.mkdirSync(source, { recursive: true })
  for (const name of ['src', 'scripts', 'index.js', 'index.d.ts', 'binding.gyp', 'LICENSE', 'package.json', 'PROVENANCE.md']) {
    fs.cpSync(path.join(root, 'vendor', 'selection-hook', name), path.join(source, name), { recursive: true })
  }
  const manifest = { name: 'highlighter-selection-source-verification', version: '1.0.0', private: true,
    dependencies: { 'selection-hook': 'file:vendor/selection-hook' } }
  const repositoryLock = require('../package-lock.json')
  const packages = { '': manifest }
  for (const name of ['node_modules/selection-hook', 'node_modules/node-addon-api', 'node_modules/node-gyp-build', 'vendor/selection-hook']) {
    if (!repositoryLock.packages[name]) throw new Error(`Missing locked dependency: ${name}`)
    packages[name] = repositoryLock.packages[name]
  }
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify(manifest, null, 2))
  fs.writeFileSync(path.join(fixture, 'package-lock.json'), JSON.stringify({ ...manifest, lockfileVersion: 3, requires: true, packages }, null, 2))
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!fs.existsSync(npmCli)) throw new Error('Run this verifier using npm or a Node installation with npm')
  run(process.execPath, [npmCli, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: fixture })
  run(process.execPath, [require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild', '--directory', source])

  const probe = path.join(fixture, 'probe.cjs')
  fs.writeFileSync(probe, `const assert = require('node:assert/strict')
const Hook = require('selection-hook')
assert.equal(Hook.nativeBuildId, require('./vendor/selection-hook/scripts/source-build-id').sourceBuildId())
const hook = new Hook()
assert.equal(hook.isRunning(), false)
hook.cleanup()
console.log(JSON.stringify({ host: process.versions.electron ? 'electron' : 'node', buildId: Hook.nativeBuildId }))
`)
  run(process.execPath, [probe], { cwd: fixture })
  run(require('electron'), [probe], { cwd: fixture, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  process.stdout.write(`Clean source build verified: ${fixture}\n`)
}

if (require.main === module) {
  try { verify() } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}

module.exports = { verify }
