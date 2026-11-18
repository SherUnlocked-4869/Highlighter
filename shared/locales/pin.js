'use strict'

// Domain locale table: the pinned-image window (`pin/`).
//
// One file per domain, each file registering all three languages at once
// (layout decision 2026-10-11, Lead; plan §10.3), so this file owns `pin.*`
// alone and never shares a write target with another stream.
//
// The pin window is the one renderer that shipped visible copy without a domain
// table: `#clickThroughTag` renders the click-through state in the overlay.
// The zh-CN column is byte-identical to the pre-migration literal in pin.html
// (plan §10.4-T5), so the migration does not change the visible behaviour.
;(function () {
  const tables = (globalThis.__LOCALES = globalThis.__LOCALES || {})
  const add = (language, entries) => Object.assign((tables[language] = tables[language] || {}), entries)

  add('zh-CN', {
    'pin.click-through.label': '穿透中 · 悬停退出',
    'pin.click-through.title': '鼠标穿透中',
    'pin.opacity.title': '不透明度（Ctrl + 滚轮调整）',
    'pin.recognition.ocr': '文本识别',
    'pin.recognition.translate': '识别并翻译',
    'pin.recognition.translating': '正在翻译…',
    'pin.recognition.empty': '未识别到文字',
    'pin.recognition.failed': '文字识别失败，可右键重试',
    'pin.recognition.translation-failed': '翻译失败，已保留原文',
    'pin.recognition.plain-text': '纯文本',
    'pin.recognition.hide': '隐藏结果'
  })

  add('en-US', {
    'pin.click-through.label': 'Click-through · hover to exit',
    'pin.click-through.title': 'Click-through active',
    'pin.opacity.title': 'Opacity (Ctrl + wheel)',
    'pin.recognition.ocr': 'Recognise text',
    'pin.recognition.translate': 'Recognise and translate',
    'pin.recognition.translating': 'Translating…',
    'pin.recognition.empty': 'No text detected',
    'pin.recognition.failed': 'Recognition failed. Right-click to retry.',
    'pin.recognition.translation-failed': 'Translation failed. Original text kept.',
    'pin.recognition.plain-text': 'Plain text',
    'pin.recognition.hide': 'Hide result'
  })

  add('zh-TW', {
    'pin.click-through.label': '穿透中 · 懸停退出',
    'pin.click-through.title': '滑鼠穿透中',
    'pin.opacity.title': '不透明度（Ctrl + 滾輪調整）',
    'pin.recognition.ocr': '文字辨識',
    'pin.recognition.translate': '辨識並翻譯',
    'pin.recognition.translating': '正在翻譯…',
    'pin.recognition.empty': '未辨識到文字',
    'pin.recognition.failed': '文字辨識失敗，可按右鍵重試',
    'pin.recognition.translation-failed': '翻譯失敗，已保留原文',
    'pin.recognition.plain-text': '純文字',
    'pin.recognition.hide': '隱藏結果'
  })
})()
