'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const root = path.resolve(__dirname, '..')

function sourceBuildId() {
  const files = ['binding.gyp', 'index.js', 'index.d.ts', 'package.json', 'scripts/source-build-id.js']
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile()) files.push(child)
      else throw new Error('Native sources must be regular files')
    }
  }
  visit('src')
  const hash = crypto.createHash('sha256')
  for (const file of files.sort()) {
    // Normalize source checkout newlines so Git's Windows autocrlf does not
    // change the identity without a semantic source change.
    const content = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n')
    hash.update(`${file}\0${Buffer.byteLength(content)}\0`)
    hash.update(content)
  }
  return `hl_${hash.digest('hex')}`
}

if (require.main === module) process.stdout.write(sourceBuildId())
module.exports = { sourceBuildId }
