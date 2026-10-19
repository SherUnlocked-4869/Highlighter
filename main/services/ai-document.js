'use strict'

// Image → Markdown / HTML document (2026-10-18 snow migration §6.2②).
//
// The AI layer (main/services/ai/client.js:convertImage) turns a screenshot into
// a document; this module owns everything around it that the renderer must not
// do itself: resolve the vision-capable provider from settings, run the request,
// then put the text on disk through a save dialog with a sane default name.
//
// Kept out of the capture domain on purpose: the capture controller is already a
// 700-line assembly of screenshot actions, and this feature has no capture state
// at all - it takes the already-encoded PNG the renderer produced.
//
// Every collaborator is injectable so this is unit-testable with no Electron:
//   settings     the resolved settings object
//   convertImage (provider, image, options) -> { text, format, model }
//   showSaveDialog(parentWindow, dialogOptions) -> { canceled, filePath }
//   writeFile(filePath, data)
//   makeName(ext) -> default file name

const fs = require('node:fs')
const path = require('node:path')
const { t } = require('./i18n-bootstrap')
const { resolveVisionAiProvider } = require('./ai-providers')
const { normalizeImageOutputFormat } = require('./ai-image-conversion')

const OUTPUT_EXTENSIONS = Object.freeze({ markdown: 'md', html: 'html' })
const OUTPUT_FILTERS = Object.freeze({
  markdown: Object.freeze({ name: 'Markdown', extensions: ['md'] }),
  html: Object.freeze({ name: 'HTML', extensions: ['html'] })
})

function defaultShowSaveDialog(parentWindow, dialogOptions) {
  const electron = require('electron')
  return parentWindow
    ? electron.dialog.showSaveDialog(parentWindow, dialogOptions)
    : electron.dialog.showSaveDialog(dialogOptions)
}

/**
 * Convert one screenshot into a Markdown/HTML file.
 *
 * @param {Buffer|Uint8Array|string} imageData PNG buffer, or a PNG data URL
 * @param {object} options
 *   output        'markdown' (default) | 'html'
 *   parentWindow  dialog parent
 *   settings      resolved settings (defaults to the injected getSettings())
 *   getSettings   () => settings, used when `settings` is omitted
 *   convertImage  injected AI call
 *   dialog / showSaveDialog / writeFile / makeName / fs / log
 * @returns {Promise<{ canceled: boolean, filePath?: string, format?: string, text?: string }>}
 */
async function convertImageToDocument(imageData, options = {}) {
  const output = normalizeImageOutputFormat(options.output)
  const settings = options.settings || (typeof options.getSettings === 'function' ? options.getSettings() : null)
  if (!settings) throw new Error(t('main.ai-document.settings-unavailable'))
  const provider = resolveVisionAiProvider(settings)
  if (!provider) throw new Error(t('main.ai-document.no-vision-model'))
  const convertImage = options.convertImage
  if (typeof convertImage !== 'function') throw new TypeError('Image conversion requires an AI client')
  const fileSystem = options.fs || fs
  const showSaveDialog = typeof options.showSaveDialog === 'function'
    ? options.showSaveDialog
    : (parentWindow, dialogOptions) => defaultShowSaveDialog(parentWindow, dialogOptions)
  const writeFile = typeof options.writeFile === 'function'
    ? options.writeFile
    : (filePath, data) => fileSystem.promises.writeFile(filePath, data, 'utf8')

  const dataUrl = typeof imageData === 'string' && imageData.startsWith('data:')
    ? imageData
    : (typeof imageData === 'string' ? imageData : undefined)
  const base64 = dataUrl ? undefined : Buffer.from(imageData || '').toString('base64')
  if (!dataUrl && !base64) throw new Error(t('main.ai-document.empty-image'))

  const result = await convertImage(provider, { dataUrl, base64, format: 'png' }, {
    output,
    maxTokens: Number(settings.ai?.maxTokens) || 4096,
    timeoutMs: options.timeoutMs
  })
  const text = String(result?.text || '')
  if (!text.trim()) throw new Error(t('main.ai-document.empty-result'))

  const extension = OUTPUT_EXTENSIONS[output]
  const defaultName = typeof options.makeName === 'function'
    ? options.makeName(extension)
    : `Highlighter_${Date.now()}.${extension}`
  const directory = options.directory || ''
  const dialogResult = await showSaveDialog(options.parentWindow || null, {
    title: t('main.ai-document.save-title'),
    defaultPath: directory ? path.join(directory, defaultName) : defaultName,
    filters: [OUTPUT_FILTERS[output]]
  })
  if (!dialogResult || dialogResult.canceled || !dialogResult.filePath) {
    return { canceled: true, format: output, text }
  }
  await writeFile(dialogResult.filePath, text)
  return { canceled: false, filePath: dialogResult.filePath, format: output, text }
}

module.exports = {
  OUTPUT_EXTENSIONS,
  OUTPUT_FILTERS,
  convertImageToDocument
}
