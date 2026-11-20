'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const sharp = require('sharp')

const SOURCE = path.join(__dirname, 'design-demos', 'app-icon', 'assets', 'highlighter-icon-source.png')
const ASSETS = path.join(__dirname, 'assets')
const ICO_SIZES = [256, 128, 96, 64, 48, 44, 40, 32, 24, 20, 16]

function createIco(frames) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2) // Icon container
  header.writeUInt16LE(frames.length, 4)

  let offset = header.length + frames.length * 16
  const entries = frames.map(({ size, png }) => {
    const entry = Buffer.alloc(16)
    entry[0] = entry[1] = size === 256 ? 0 : size
    entry.writeUInt16LE(1, 4) // Color planes
    entry.writeUInt16LE(32, 6) // RGBA
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += png.length
    return entry
  })
  return Buffer.concat([header, ...entries, ...frames.map(({ png }) => png)])
}

async function main() {
  const source = sharp(SOURCE)
  const { format, width, height, hasAlpha } = await source.metadata()
  if (format !== 'png' || !hasAlpha || width !== height || width < ICO_SIZES[0]) {
    throw new Error('The icon source must be a square PNG with alpha and at least 256 px per side')
  }

  const frames = await Promise.all(ICO_SIZES.map(async (size) => ({
    size,
    png: await source.clone().resize(size, size).png().toBuffer()
  })))
  const trayPng = frames[0].png
  await Promise.all([
    fs.writeFile(path.join(ASSETS, 'icon.ico'), createIco(frames)),
    fs.writeFile(path.join(ASSETS, 'icon.png'), trayPng),
    fs.writeFile(path.join(ASSETS, 'icon-dark.png'), trayPng)
  ])
  console.log(`Generated assets/icon.ico (${ICO_SIZES.join(', ')} px) and both 256 px tray PNGs.`)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
