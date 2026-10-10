'use strict'

const fsDefault = require('node:fs')
const path = require('node:path')
const { ensureDirectory: ensureDirectoryDefault } = require('./fs-utils')
const { imageDataToBuffer: imageDataToBufferDefault } = require('./image-buffer')
const { CAPTURE_PREFIX, makeCaptureName: makeCaptureNameDefault } = require('./capture-naming')

const SAVE_TITLE = '保存截图'
const PNG_FILTER = Object.freeze({ name: 'PNG 图片', extensions: ['png'] })

// Directory comparison for the memory: resolve, and fold case on Windows, so a
// hand-typed `E:/shots` does not look different from the `E:\shots` the platform
// returns and trigger a settings write on every capture.
function comparableDirectory(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

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

// The whole save flow used to live in main.js: build a template-aware name with
// a uniqueness probe, resolve the target, write the file and remember the
// directory. Every collaborator has a real default, so main.js only supplies
// dialog/getSettings/log while tests can inject fakes.
function createImageFileSaver({
  dialog,
  fs = fsDefault,
  ensureDirectory = ensureDirectoryDefault,
  getPicturesDirectory,
  getSettings,
  makeCaptureName = makeCaptureNameDefault,
  imageDataToBuffer = imageDataToBufferDefault,
  rememberDirectory = () => {},
  log = () => {},
  resolveTarget
} = {}) {
  if (typeof fs?.existsSync !== 'function' || typeof fs?.promises?.writeFile !== 'function') {
    throw new TypeError('Image file saver requires a file system')
  }
  if (typeof getSettings !== 'function') throw new TypeError('Image file saver requires getSettings')
  if (typeof getPicturesDirectory !== 'function') throw new TypeError('Image file saver requires a pictures directory probe')
  if (typeof makeCaptureName !== 'function') throw new TypeError('Image file saver requires makeCaptureName')
  if (typeof imageDataToBuffer !== 'function') throw new TypeError('Image file saver requires imageDataToBuffer')
  const resolveImageTarget = resolveTarget || createImageTargetResolver({ dialog, ensureDirectory, getPicturesDirectory })

  return async function saveImageBuffer(imageBuffer, options = {}) {
    const settings = getSettings()
    const screenshot = settings.screenshot || {}
    // "Remember the directory" (P0-7B) means the last directory the user saved
    // into wins over the configured default; an explicit caller still wins over
    // both. Before this the key was write-only, so a save-as elsewhere never
    // changed where the next fast save landed.
    const memorized = typeof screenshot.lastSaveDirectory === 'string' ? screenshot.lastSaveDirectory.trim() : ''
    const preferredDirectory = options.directory || memorized || screenshot.saveDirectory
    const fast = options.fast === true
    // The fast path is the only branch that can silently overwrite, so the probe
    // only has to look at the directory it is about to write into; the dialog
    // branch lets the OS ask. The template rides on the extended naming
    // signature (P0-7-T1) and an empty template keeps the legacy shape.
    const fastDirectory = fast && preferredDirectory ? preferredDirectory : ''
    const defaultName = makeCaptureName(CAPTURE_PREFIX, 'png', {
      template: screenshot.nameTemplate,
      isTaken: (name) => fs.existsSync(path.join(fastDirectory || preferredDirectory || getPicturesDirectory(), name))
    })
    const filePath = await resolveImageTarget({ fast, directory: preferredDirectory, defaultName })
    if (!filePath) return null
    await fs.promises.writeFile(filePath, imageDataToBuffer(imageBuffer))
    const directory = path.dirname(filePath)
    // Only refresh the memory when it would actually change, so the common save
    // does not write (and broadcast) settings on every capture.
    const unchanged = Boolean(memorized) && comparableDirectory(directory) === comparableDirectory(memorized)
    if (directory && !unchanged) {
      try {
        rememberDirectory(directory)
      } catch (error) {
        log('Unable to remember the last save directory:', error.message)
      }
    }
    return filePath
  }
}

module.exports = { createImageTargetResolver, createImageFileSaver, PNG_FILTER, SAVE_TITLE }
