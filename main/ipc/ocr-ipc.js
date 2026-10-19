'use strict'

// The three OCR channels are registered here rather than through the capture
// controller so the OCR surface can be read, and tested, on its own. The
// dependencies stay injected for the same reason: this module never reaches for
// a global, so node:test can drive it with fakes.
const { convertImageToDocument } = require('../services/ai-document')

function createOcrIpcController({
  getSettings,
  getOcrService,
  imageDataToBuffer,
  recognizeWithPerformance,
  aiClient,
  resolveAiAssignment
}) {
  function readImage(payload) {
    const imageData = typeof payload === 'string' ? payload : payload?.imageBuffer ?? payload?.dataUrl
    const buffer = imageDataToBuffer(imageData)
    if (!buffer.length) throw new Error('OCR 图片数据为空')
    return buffer
  }

  function assertOcrEnabled() {
    if (!getSettings().plugins.ocr) throw new Error('请先在插件页面启用文本识别')
  }

  return {
    ocrStatus: () => getOcrService().getStatus(),

    ocr: async (_event, payload) => {
      assertOcrEnabled()
      const buffer = readImage(payload)
      const settings = getSettings()
      return recognizeWithPerformance(buffer, {
        scaleFactor: payload?.scaleFactor,
        detectAngle: settings.ocr.detectAngle,
        minConfidence: settings.ocr.minConfidence
      }, 'capture')
    },

    translate: async (_event, payload) => {
      assertOcrEnabled()
      const buffer = readImage(payload)
      const settings = getSettings()
      const ocrResult = await recognizeWithPerformance(buffer, {
        scaleFactor: payload?.scaleFactor,
        detectAngle: settings.ocr.detectAngle,
        minConfidence: settings.ocr.minConfidence
      }, 'capture-translate')
      const text = ocrResult.text.trim()
      if (!text) throw new Error('未识别到可翻译的文本')
      const textBlocks = (Array.isArray(ocrResult.textBlocks) ? ocrResult.textBlocks : [])
        .filter((block) => String(block?.text || '').trim())
      if (!textBlocks.length) throw new Error('未识别到可定位的翻译文本')
      const translations = await aiClient.translateOcrTextBlocks(
        resolveAiAssignment(settings, 'ocr-translate'),
        textBlocks.map((block) => String(block.text).trim()),
        'auto',
        settings.ai.targetLanguage
      )
      const translatedBlocks = textBlocks.map((block, index) => ({
        ...block,
        sourceText: String(block.text).trim(),
        text: translations[index]
      }))
      const translation = translations.join('\n')
      return {
        text,
        translation,
        ocrResult,
        translationResult: {
          ...ocrResult,
          text: translation,
          textBlocks: translatedBlocks
        }
      }
    },

    // Image → Markdown/HTML (2026-10-18 snow migration §6.2②).
    //
    // Lives on the OCR controller because it is the same kind of thing: take the
    // PNG the capture window already encoded, hand it to a model, return text. It
    // deliberately does NOT reuse the OCR sidecar even when a vision model is
    // configured - the OCR path is local and deterministic, this one is an AI
    // request that must be an explicit user action.
    convertImage: async (_event, payload = {}) => {
      const settings = getSettings()
      const buffer = readImage(payload)
      return convertImageToDocument(buffer, {
        output: payload?.output,
        settings,
        convertImage: aiClient.convertImage,
        directory: settings?.screenshot?.lastSaveDirectory || settings?.screenshot?.saveDirectory || '',
        makeName: (extension) => `${payload?.baseName || 'Highlighter_convert'}.${extension}`
      })
    }
  }
}

function registerOcrIpc({ ipcMain, controller }) {
  if (!ipcMain || !controller) throw new Error('OCR IPC requires ipcMain and controller')

  ipcMain.handle('ocr:status', controller.ocrStatus)
  ipcMain.handle('capture:ocr', controller.ocr)
  ipcMain.handle('capture:translate', controller.translate)
  ipcMain.handle('capture:convert-image', controller.convertImage)
}

module.exports = {
  createOcrIpcController,
  registerOcrIpc
}
