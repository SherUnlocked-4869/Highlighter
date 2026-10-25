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
  'common.language.zh-hant': '繁體中文',
  // Feature A (plan §4.1/§4.2): the export result bar, shared by the capture and recognition
  // windows. It lives in the cross-window table because BOTH windows render it.
  'capture.export-result.saved': '已儲存：{fileName}',
  'capture.export-result.open': '開啟',
  'capture.export-result.copy-path': '位址',
  'capture.export-result.reveal': '開啟資料夾',
  'capture.export-result.copied': '路徑已複製',
  'capture.export-result.pending': '處理中…',
  'capture.export-result.open-failed': '檔案已儲存，但無法用預設應用程式開啟。',
  'capture.export-result.file-missing': '檔案已不在原來的位置，可能已被移動或刪除。',
  'capture.export-result.expired': '這筆匯出結果已失效，請重新匯出。',
  'capture.export-result.action-failed': '檔案已儲存，但操作失敗。',
})
