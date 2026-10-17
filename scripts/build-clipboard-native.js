'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const nativeRoot = path.join(root, 'native', 'clipboard')

function sourceBuildId() {
  const files = ['Cargo.toml', 'Cargo.lock']
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(nativeRoot, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile()) files.push(child)
      else throw new Error('Native sources must be regular files')
    }
  }
  visit('src')
  const hash = crypto.createHash('sha256')
  for (const file of files.sort()) {
    const content = fs.readFileSync(path.join(nativeRoot, file), 'utf8').replace(/\r\n/g, '\n')
    hash.update(`${file}\0${Buffer.byteLength(content)}\0`).update(content)
  }
  return `hl_${hash.digest('hex')}`
}

function build() {
  if (process.platform !== 'win32') throw new Error('Clipboard native build currently supports Windows only')
  const buildId = sourceBuildId()
  const result = spawnSync('cargo', ['build', '--locked', '--release', '--manifest-path', path.join(nativeRoot, 'Cargo.toml')], {
    cwd: root, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, HL_CLIPBOARD_SOURCE_ID: buildId, CARGO_TARGET_DIR: path.join(nativeRoot, 'target') }
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('Clipboard native build failed')
  const output = path.join(nativeRoot, 'bin', 'HighlighterClipboard.exe')
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.copyFileSync(path.join(nativeRoot, 'target', 'release', 'highlighter-clipboard.exe'), output)
  fs.writeFileSync(path.join(nativeRoot, 'bin', 'build-info.json'), `${JSON.stringify({ protocolVersion: 1, nativeBuildId: buildId })}\n`)
  process.stdout.write(`${JSON.stringify({ output, buildId, sha256: crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex') })}\n`)
}

if (require.main === module) {
  try { build() } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
module.exports = { sourceBuildId, build }
