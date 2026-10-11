'use strict'

// Locale table for Traditional Chinese (Taiwan).
//
// W0-4 (2026-10-10) lands the empty skeleton so the checker and the shared
// runtime exist before batch C; S1 (2026-10-11) fills it. The language identifier
// is `zh-TW`, not `zh-Hant` (decision D6).
globalThis.__LOCALES = globalThis.__LOCALES || {}
Object.assign(globalThis.__LOCALES['zh-TW'] = globalThis.__LOCALES['zh-TW'] || {}, {
  'common.button.ok': '確定',
  'common.button.cancel': '取消',
  'common.button.save': '儲存',
  'common.button.close': '關閉',
  'common.button.apply': '套用',
  'common.button.reset': '回復預設',
  'common.button.retry': '重試',
  'common.button.copy': '複製',
  'common.button.delete': '刪除',
  'common.button.confirm': '確認',
  'common.label.language': '介面語言',
  'common.label.loading': '載入中…',
  'common.label.empty': '尚無內容',
  'common.label.error': '發生錯誤',
  'common.language.zh': '简体中文',
  'common.language.en': 'English',
  'common.language.zh-hant': '繁體中文'
})
