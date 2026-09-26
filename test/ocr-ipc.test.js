const test = require('node:test')
const assert = require('node:assert/strict')
const { createOcrIpcController } = require('../main/ipc/ocr-ipc')

function createHarness(overrides = {}) {
  const calls = { recognize: [], translateOcrTextBlocks: [] }
  const settings = {
    plugins: { ocr: true },
    ocr: { detectAngle: true, minConfidence: 0.4 },
    ai: { targetLanguage: '中文' }
  }
  const controller = createOcrIpcController({
    getSettings: () => settings,
    getOcrService: () => ({ getStatus: () => ({ running: true }) }),
    imageDataToBuffer: (value) => Buffer.from(String(value ?? '')),
    recognizeWithPerformance: (...args) => {
      calls.recognize.push(args)
      return overrides.recognize ? overrides.recognize(...args) : Promise.resolve({ text: 'hello', textBlocks: [] })
    },
    aiClient: {
      translateOcrTextBlocks: (...args) => {
        calls.translateOcrTextBlocks.push(args)
        return Promise.resolve(args[1].map((_, index) => (index === 0 ? '你好' : '世界')))
      }
    },
    resolveAiAssignment: (currentSettings, feature) => ({ feature, settings: currentSettings })
  })
  return { controller, calls, settings }
}

test('ocr status reports the shared OCR service state', () => {
  const { controller } = createHarness()
  assert.deepEqual(controller.ocrStatus(), { running: true })
})

test('ocr requires the plugin flag and a non-empty image buffer', async () => {
  const { controller, settings } = createHarness()
  settings.plugins.ocr = false
  await assert.rejects(() => controller.ocr(null, 'data'), /请先在插件页面启用文本识别/)

  settings.plugins.ocr = true
  await assert.rejects(() => controller.ocr(null, ''), /OCR 图片数据为空/)
})

test('ocr forwards the request scale factor and OCR settings under the capture source', async () => {
  const { controller, calls } = createHarness()
  await controller.ocr(null, { imageBuffer: 'bytes', scaleFactor: 2 })
  assert.equal(calls.recognize.length, 1)
  assert.deepEqual(calls.recognize[0][1], { scaleFactor: 2, detectAngle: true, minConfidence: 0.4 })
  assert.equal(calls.recognize[0][2], 'capture')
})

test('ocr accepts a bare string payload', async () => {
  const { controller, calls } = createHarness()
  await controller.ocr(null, 'raw-bytes')
  assert.equal(calls.recognize[0][0].toString(), 'raw-bytes')
})

test('translate rejects results with no text or no locatable blocks', async () => {
  const empty = createHarness({ recognize: () => Promise.resolve({ text: '   ', textBlocks: [] }) })
  await assert.rejects(() => empty.controller.translate(null, 'bytes'), /未识别到可翻译的文本/)

  const unlocatable = createHarness({ recognize: () => Promise.resolve({ text: 'ok', textBlocks: [{ text: '  ' }] }) })
  await assert.rejects(() => unlocatable.controller.translate(null, 'bytes'), /未识别到可定位的翻译文本/)
})

test('translate pairs each source block with its translation and rewrites the result text', async () => {
  const { controller, calls } = createHarness({
    recognize: () => Promise.resolve({
      text: 'hello',
      textBlocks: [{ text: 'hello', box: [0, 0, 1, 1] }, { text: ' world ', box: [2, 2, 3, 3] }]
    })
  })
  const result = await controller.translate(null, { dataUrl: 'bytes', scaleFactor: 1 })

  assert.deepEqual(calls.translateOcrTextBlocks[0][1], ['hello', 'world'])
  assert.equal(calls.translateOcrTextBlocks[0][2], 'auto')
  assert.equal(calls.translateOcrTextBlocks[0][3], '中文')
  assert.equal(result.text, 'hello')
  assert.equal(result.translation, '你好\n世界')
  assert.deepEqual(result.translationResult.textBlocks, [
    { text: '你好', box: [0, 0, 1, 1], sourceText: 'hello' },
    { text: '世界', box: [2, 2, 3, 3], sourceText: 'world' }
  ])
  assert.equal(result.translationResult.text, '你好\n世界')
})
