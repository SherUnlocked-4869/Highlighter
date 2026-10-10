'use strict'

const path = require('node:path')

const SAVE_TITLE = '保存截图'
const PNG_FILTER = Object.freeze({ name: 'PNG 图片', extensions: ['png'] })

// Resolves the destination path of a saved image: fast-save writes straight into
// the remembered directory, otherwise the native dialog decides (returning null
// when the user cancels). Extracted from main.js saveImageBuffer so the branch
// logic is unit-testable with a fake dialog and a fake directory creator.
function createImageTargetResolver({ dialog, ensureDirectory, getPicturesDirectory, filters = [PNG_FILTER] } = {}) {
  if (!dialog || typeof dialog.showSaveDialog !== 'function') throw new TypeError('Image target resolution requires a dialog')
  if (typeof ensureDirectory !== 'function') throw new TypeError('Image target resolution requires ensureDirectory')
  if (typeof getPicturesDirectory !== 'function') throw new TypeError('Image target resolution requires a pictures directory probe')

  return async function resolveImageTarget({ fast = false, directory = '', defaultName }) {
    if (typeof defaultName !== 'string' || !defaultName) throw new TypeError('Image target resolution requires a default file name')
    if (fast && directory) {
      ensureDirectory(directory)
      return path.join(directory, defaultName)
    }
    const result = await dialog.showSaveDialog({
      title: SAVE_TITLE,
      defaultPath: path.join(directory || getPicturesDirectory(), defaultName),
      filters
    })
    if (!result || result.canceled || !result.filePath) return null
    return result.filePath
  }
}

module.exports = { createImageTargetResolver, PNG_FILTER, SAVE_TITLE }
