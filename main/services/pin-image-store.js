'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DEFAULT_MEMORY_BUDGET = 32 * 1024 * 1024

function openSpillFile(bytes) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-pin-'))
  const file = path.join(directory, 'image')
  let fd
  try {
    try {
      fd = fs.openSync(file, 'wx+', 0o600)
      // Unlink the empty file before writing pixels. The descriptor keeps it
      // available to this process and Windows also reclaims it after a crash.
      fs.unlinkSync(file)
    } finally {
      fs.rmdirSync(directory)
    }
    fs.writeFileSync(fd, bytes)
    return fd
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd)
    throw error
  }
}

function createPinImageStore({ memoryBudget = DEFAULT_MEMORY_BUDGET } = {}) {
  const assets = new Map()
  let resident = 0
  let sequence = 0

  function add({ bytes, mime }) {
    const id = ++sequence
    if (resident + bytes.length <= memoryBudget) {
      assets.set(id, { mime, bytes })
      resident += bytes.length
    } else {
      assets.set(id, { mime, fd: openSpillFile(bytes), length: bytes.length })
    }
    return id
  }

  function read(id) {
    const asset = assets.get(id)
    if (!asset) throw new Error('贴图资源已释放')
    if (asset.bytes) return { bytes: asset.bytes, mime: asset.mime }
    const bytes = Buffer.allocUnsafe(asset.length)
    let offset = 0
    while (offset < bytes.length) {
      const count = fs.readSync(asset.fd, bytes, offset, bytes.length - offset, offset)
      if (count === 0) throw new Error('贴图资源读取不完整')
      offset += count
    }
    return { bytes, mime: asset.mime }
  }

  function release(id) {
    const asset = assets.get(id)
    if (!asset) return
    assets.delete(id)
    if (asset.bytes) resident -= asset.bytes.length
    else fs.closeSync(asset.fd)
  }

  return { add, read, release }
}

module.exports = { createPinImageStore }
